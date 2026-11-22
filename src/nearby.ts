import type { Finding, Graph, Place } from "./model.js";
import { surfaceId } from "./model.js";
import { HOLE, methodsMatch, pathsMatch, segments } from "./paths.js";

const isParam = (s: string): boolean => s.includes(HOLE) || s.startsWith(":") || s.startsWith("{") || s === "*";

/** Shared fixed segments in the same positions, less the difference in length. Zero when no fixed segment is shared. */
export function similarity(a: string, b: string): number {
  const x = segments(a);
  const y = segments(b);
  let literal = 0;
  let loose = 0;
  for (let i = 0; i < Math.min(x.length, y.length); i++) {
    if (isParam(x[i]!) || isParam(y[i]!)) loose++;
    else if (x[i] === y[i]) literal++;
  }
  if (literal === 0) return 0;
  return literal * 2 + loose - Math.abs(x.length - y.length);
}

export interface Candidate {
  what: string;
  at: Place;
  score: number;
  /** What sets it apart from the finding where its path fits: the method alone. */
  note?: string;
}

/**
 * Calls or surfaces whose path is close to the one a finding is about: the facts that tell a typo from a missing piece.
 * Those of a method that fits come first, then those whose path fits under another method (noted so); within each,
 * those whose path fits, then by how close the path is. `limit` cuts the list.
 */
export function nearby(graph: Graph, finding: Finding, limit = 5): Candidate[] {
  const out: Candidate[] = [];
  const tiers = new Map<Candidate, number>();
  const add = (what: string, at: Place, close: number, fits: boolean, sameMethod: boolean) => {
    if (close <= 0 && !fits) return;
    const candidate: Candidate = { what, at, score: close, ...(fits && !sameMethod ? { note: "path fits, method differs" } : {}) };
    tiers.set(candidate, sameMethod ? (fits ? 0 : 1) : fits ? 2 : 3);
    out.push(candidate);
  };
  if (finding.rule === "FA001") {
    const [component, request] = finding.key.split("|").slice(1) as [string, string];
    const [method, path] = request.split(" ", 2) as [string, string];
    for (const c of graph.calls) {
      if (c.to !== component) continue;
      add(`${c.from} calls ${c.method} ${c.path}${c.scope ? ` in ${c.scope}` : ""}`, c.at, similarity(path, c.path), pathsMatch(path, c.path), methodsMatch(c.method, method));
    }
  } else if (finding.rule === "FA002") {
    const [edge, request] = finding.key.split("|").slice(1) as [string, string];
    const to = edge.split("->")[1]!;
    const [method, path] = request.split(" ", 2) as [string, string];
    for (const s of graph.surfaces) {
      if (s.component !== to) continue;
      add(surfaceId(s), s.at, similarity(s.path, path), pathsMatch(s.path, path), methodsMatch(s.method, method));
    }
  }
  return out.sort((a, b) => tiers.get(a)! - tiers.get(b)! || b.score - a.score || a.what.localeCompare(b.what)).slice(0, limit);
}

/** Why `nearby` has nothing for a finding: what was searched, so an empty list is not read as an answer. */
export function nothingNearby(graph: Graph, finding: Finding): string | undefined {
  if (finding.rule === "FA001") {
    const [component, request] = finding.key.split("|").slice(1) as [string, string];
    if (!graph.calls.some((c) => c.to === component)) return `No configured call goes to ${component}, so there is no call to compare ${request} with.`;
    return `No call to ${component} shares a fixed segment, in the same position, with ${request.split(" ", 2)[1]}.`;
  }
  if (finding.rule === "FA002") {
    const [edge, request] = finding.key.split("|").slice(1) as [string, string];
    const to = edge.split("->")[1]!;
    if (!graph.surfaces.some((s) => s.component === to)) return `No route of ${to} is read, so there is no surface to compare ${request} with.`;
    return `No surface of ${to} shares a fixed segment, in the same position, with ${request.split(" ", 2)[1]}.`;
  }
  return undefined;
}
