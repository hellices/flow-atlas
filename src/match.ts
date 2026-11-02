import type { Call, Graph, Surface } from "./model.js";
import { firstLiteral, methodsMatch, pathsMatch } from "./paths.js";

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
    graph.surfaces.forEach((surface, si) => {
      if (surface.component !== call.to) return;
      if (!pathsMatch(surface.path, call.path) || !methodsMatch(surface.method, call.method)) return;
      (callersOf.get(si) ?? callersOf.set(si, []).get(si)!).push(call);
      (targetsOf.get(ci) ?? targetsOf.set(ci, []).get(ci)!).push(surface);
    });
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
