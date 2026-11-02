import type { Call, Graph, Surface } from "./model.js";
import { firstLiteral, HOLE, methodsMatch, pathsMatch, segments } from "./paths.js";

import type { Config } from "./config.js";

/**
 * Components whose router ranks matching routes by how specific they are, so that of several routes a request fits,
 * one is chosen regardless of order: Spring MVC. Express, Fastify, Nest and FastAPI follow registration order, which
 * the code read here does not settle, so every route a request fits stays a target there.
 */
export function rankedComponents(config: Pick<Config, "routes">): Set<string> {
  return new Set(config.routes.filter((r) => (r.styles ?? []).includes("spring")).map((r) => r.component));
}

/**
 * Spring's order of path patterns, least specific last: catch-alls (`**`, `{*rest}`), then more URI variables, then
 * more single wildcards, then a shorter pattern. Lower sorts first.
 */
function springRank(path: string): number[] {
  const segs = segments(path);
  const catchAll = segs.filter((s) => s === "**" || s.startsWith("{*")).length;
  const variables = segs.filter((s) => (s.startsWith("{") && !s.startsWith("{*")) || s.startsWith(":")).length;
  const wildcards = segs.filter((s) => s === "*").length;
  return [catchAll, variables, wildcards, -path.length];
}

function compare(a: number[], b: number[]): number {
  for (let i = 0; i < Math.max(a.length, b.length); i++) if ((a[i] ?? 0) !== (b[i] ?? 0)) return (a[i] ?? 0) - (b[i] ?? 0);
  return 0;
}

/**
 * The routes a request reaches. For a component whose router ranks routes, and a request whose path is fully known,
 * only the route its router picks for each method; otherwise every route it fits, since which one serves it is not known.
 */
function reached(call: Call, candidates: Array<{ surface: Surface; index: number }>, ranked: Set<string>): Array<{ surface: Surface; index: number }> {
  if (!ranked.has(call.to) || call.path.includes(HOLE)) return candidates;
  const byMethod = new Map<string, Array<{ surface: Surface; index: number; rank: number[] }>>();
  for (const c of candidates) {
    const list = byMethod.get(c.surface.method) ?? byMethod.set(c.surface.method, []).get(c.surface.method)!;
    list.push({ ...c, rank: springRank(c.surface.path) });
  }
  const out: Array<{ surface: Surface; index: number }> = [];
  for (const list of byMethod.values()) {
    const best = list.reduce((top, c) => (compare(c.rank, top) < 0 ? c.rank : top), list[0]!.rank);
    for (const c of list) if (compare(c.rank, best) === 0) out.push({ surface: c.surface, index: c.index });
  }
  return out.sort((a, b) => a.index - b.index);
}

export interface Matches {
  /** Calls that reach each surface, keyed by the surface's index. */
  callersOf: Map<number, Call[]>;
  /** Surfaces each call reaches, keyed by the call's index. */
  targetsOf: Map<number, Surface[]>;
}

export function matchCalls(graph: Pick<Graph, "surfaces" | "calls">, ranked: Set<string> = new Set()): Matches {
  const callersOf = new Map<number, Call[]>();
  const targetsOf = new Map<number, Surface[]>();
  graph.calls.forEach((call, ci) => {
    const candidates: Array<{ surface: Surface; index: number }> = [];
    graph.surfaces.forEach((surface, si) => {
      if (surface.component !== call.to) return;
      if (pathsMatch(surface.path, call.path) && methodsMatch(surface.method, call.method)) candidates.push({ surface, index: si });
    });
    for (const { surface, index: si } of reached(call, candidates, ranked)) {
      (callersOf.get(si) ?? callersOf.set(si, []).get(si)!).push(call);
      (targetsOf.get(ci) ?? targetsOf.set(ci, []).get(ci)!).push(surface);
    }
  });
  return { callersOf, targetsOf };
}

/**
 * Whether a string a call site holds is plausibly a request to its target:
 * it joins a base address, or its first fixed segment is one the target serves.
 */
export function plausibleRequest(graph: Graph, call: Call): boolean {
  if (call.based) return true;
  const first = firstLiteral(call.path);
  return graph.surfaces.some((s) => s.component === call.to && firstLiteral(s.path) === first);
}
