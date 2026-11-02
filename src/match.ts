import type { Call, Graph, Surface } from "./model.js";
import { firstLiteral, HOLE, methodsMatch, pathsMatch, segments } from "./paths.js";

const isParamSegment = (seg: string): boolean => seg.startsWith(":") || (seg.startsWith("{") && seg.endsWith("}")) || seg === "*" || seg === "**";

/**
 * How specifically a route matches a call, segment by segment from the left: where the call names a fixed segment, a
 * route that names it too ranks above one that takes a parameter there, as routers choose (`/movies/search` over
 * `/movies/{id}`). Where the call's segment is interpolated, it cannot tell them apart.
 */
function specificity(route: string, call: string): number[] {
  const c = segments(call);
  return segments(route).map((seg, i) => (c[i]!.includes(HOLE) ? 0 : isParamSegment(seg) ? 0 : 1));
}

function compare(a: number[], b: number[]): number {
  for (let i = 0; i < Math.max(a.length, b.length); i++) if ((a[i] ?? 0) !== (b[i] ?? 0)) return (a[i] ?? 0) - (b[i] ?? 0);
  return 0;
}

/** Of the routes a call matches, the most specific for each method. */
function mostSpecific(call: Call, candidates: Array<{ surface: Surface; index: number }>): Array<{ surface: Surface; index: number }> {
  const byMethod = new Map<string, Array<{ surface: Surface; index: number; rank: number[] }>>();
  for (const c of candidates) {
    const list = byMethod.get(c.surface.method) ?? byMethod.set(c.surface.method, []).get(c.surface.method)!;
    list.push({ ...c, rank: specificity(c.surface.path, call.path) });
  }
  const out: Array<{ surface: Surface; index: number }> = [];
  for (const list of byMethod.values()) {
    const best = list.reduce((top, c) => (compare(c.rank, top) > 0 ? c.rank : top), list[0]!.rank);
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

export function matchCalls(graph: Pick<Graph, "surfaces" | "calls">): Matches {
  const callersOf = new Map<number, Call[]>();
  const targetsOf = new Map<number, Surface[]>();
  graph.calls.forEach((call, ci) => {
    const candidates: Array<{ surface: Surface; index: number }> = [];
    graph.surfaces.forEach((surface, si) => {
      if (surface.component !== call.to) return;
      if (pathsMatch(surface.path, call.path) && methodsMatch(surface.method, call.method)) candidates.push({ surface, index: si });
    });
    for (const { surface, index: si } of mostSpecific(call, candidates)) {
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
