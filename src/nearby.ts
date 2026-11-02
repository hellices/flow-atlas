import type { Finding, Graph, Place } from "./model.js";
import { surfaceId } from "./model.js";
import { HOLE, segments } from "./paths.js";

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
}

/** Calls or surfaces whose path is close to the one a finding is about: the facts that tell a typo from a missing piece. */
export function nearby(graph: Graph, finding: Finding, limit = 5): Candidate[] {
  const out: Candidate[] = [];
  if (finding.rule === "FA001") {
    const [component, request] = finding.key.split("|").slice(1) as [string, string];
    const [method, path] = request.split(" ", 2) as [string, string];
    for (const c of graph.calls) {
      if (c.to !== component) continue;
      const score = similarity(path, c.path) + (c.method === method ? 1 : 0);
      if (score > 0) out.push({ what: `${c.from} calls ${c.method} ${c.path}${c.scope ? ` in ${c.scope}` : ""}`, at: c.at, score });
    }
  } else if (finding.rule === "FA002") {
    const [edge, request] = finding.key.split("|").slice(1) as [string, string];
    const to = edge.split("->")[1]!;
    const [method, path] = request.split(" ", 2) as [string, string];
    for (const s of graph.surfaces) {
      if (s.component !== to) continue;
      const score = similarity(s.path, path) + (s.method === method ? 1 : 0);
      if (score > 0) out.push({ what: `${surfaceId(s)}`, at: s.at, score });
    }
  }
  return out.sort((a, b) => b.score - a.score || a.what.localeCompare(b.what)).slice(0, limit);
}
