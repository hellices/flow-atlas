import type { Config } from "./config.js";
import { routedComponents, ruleEnabled } from "./config.js";
import { matchCalls, plausibleRequest, rankedComponents, shadowedRoutes, takes } from "./match.js";
import type { Finding, Graph } from "./model.js";
import { isRedirect, surfaceId } from "./model.js";
import { HOLE, isFixed, methodsMatch, pathCovers, segments } from "./paths.js";

/** Titles only. What to do about a finding is decided by whoever reads it; guidance lives with the skill. */
export const RULES: Record<Finding["rule"], { title: string }> = {
  FA001: { title: "surface with no caller in the repository" },
  FA002: { title: "call that no surface serves" },
  FA003: { title: "boundary call or cycle the declarations do not state" },
  FA004: { title: "registry entry with no producer or no consumer" },
  FA007: { title: "flow description that the code does not bear out" },
};

function finding(rule: Finding["rule"], key: string, message: string, at: Finding["at"]): Finding {
  return { rule, key: `${rule}|${key}`, title: RULES[rule].title, message, at };
}

/** Whether a call fits a route's fixed text only where a whole segment of the call is an interpolated value (`/x/${id}` and `/x/summary`), not where the call writes the text (`/x/summary${query}`). */
function byValueOnly(routePath: string, call: string): boolean {
  const r = segments(routePath);
  return segments(call).some((part, i) => part === HOLE && r[i] !== undefined && isFixed(r[i]));
}

/**
 * Whether a route of the same component other than `s`, of a method the call may send and every method `s` serves,
 * fits every path the call stands for, segment for segment. A catch-all (`*path`, `/**`, an application's fallback)
 * fits every path there is, so it says nothing of which one the call means. Which of the two a request of the very
 * text `s` names reaches is its router's order; what is asserted is only that the call does not name `s`'s path.
 */
function coveredElsewhere(surfaces: Graph["surfaces"], s: Graph["surfaces"][number], c: Graph["calls"][number]): boolean {
  const length = segments(c.path).length;
  const catchAll = (path: string) => segments(path).some((seg) => seg === "*" || seg === "**" || seg.startsWith("{*") || /:path\}$/.test(seg));
  return surfaces.some(
    (o) =>
      o !== s &&
      o.component === s.component &&
      methodsMatch(o.method, c.method) &&
      (o.method === "*" || o.method.toUpperCase() === s.method.toUpperCase()) &&
      // A route taken only with headers the call may not send is not shown to take it.
      !o.dispatch?.constrained &&
      segments(o.path).length === length &&
      !catchAll(o.path) &&
      pathCovers(o.path, c.path, o.patterns) &&
      // As its router takes a request, trailing `/` included (strict routing, a path served only with the `/`).
      (!(o.dispatch?.slashes || o.dispatch?.trailing) || takes(o, c.path, !!c.slash)),
  );
}

/** `component|METHOD /path` entries; `*` matches within one segment, `**` across segments. */
export function surfacePattern(entries: string[]): (id: string) => boolean {
  const patterns = entries.map((e) => {
    // `**` first, then `*` in each piece, everything else literal: no character of the entry is taken for a marker.
    const literal = (text: string) => text.replace(/[.+?^${}()|[\]\\]/g, "\\$&");
    const body = e
      .split("**")
      .map((piece) => piece.split("*").map(literal).join("[^/]*"))
      .join(".*");
    return new RegExp(`^${body}$`);
  });
  return (id) => patterns.some((p) => p.test(id));
}

/**
 * What FA002 made of each call, by its index in `graph.calls`: it reaches a route (`matched`), FA002 reports it
 * (`unserved`), a `limit:` says why it is matched to none (`undecided`: an unread method fitting several routes, a
 * trailing slash, a redirect, a header constraint), it is not taken for a request to its target (`notRequest`), or
 * FA002 does not check it (`unchecked`: the target has no route source, or the rule is off).
 */
export type CallOutcome = "matched" | "unserved" | "undecided" | "notRequest" | "unchecked";

export function callOutcomes(graph: Graph, config: Config): CallOutcome[] {
  const { targetsOf, unsettled, slashless, redirected, constrained } = matchCalls(graph, rankedComponents(config));
  const served = routedComponents(config);
  const on = ruleEnabled(config, "FA002");
  return graph.calls.map((c, i) => {
    if (!on || !served.has(c.to)) return "unchecked";
    if (targetsOf.has(i)) return "matched";
    if (unsettled.has(i) || slashless.has(i) || redirected.has(i) || constrained.has(i)) return "undecided";
    return plausibleRequest(graph, c) ? "unserved" : "notRequest";
  });
}

/** Findings for a graph. What the rules could not settle completely is added to `limits`. */
export function evaluate(graph: Graph, config: Config, limits: string[] = []): Finding[] {
  const out: Finding[] = [];
  const { callersOf, targetsOf, unsettled, slashless, redirected, constrained } = matchCalls(graph, rankedComponents(config));
  // A call whose method is not read may reach any route it fits, one without the trailing slash its route's document
  // writes may reach that route, one answered with a redirect reaches its route once the client follows it, and one
  // that fits a route taken only with a header may send it: none of those routes is shown to lack a caller, nor any of
  // those calls to reach nothing.
  const mayBeCalled = new Set([...unsettled.values(), ...slashless.values(), ...constrained.values(), ...[...redirected.values()].map((r) => r.surfaces)].flat());
  const unmatched = (i: number) => !targetsOf.has(i) && !unsettled.has(i) && !slashless.has(i) && !redirected.has(i) && !constrained.has(i);
  const isPublic = surfacePattern(config.publicSurfaces);

  if (ruleEnabled(config, "FA001")) {
    const called = new Set(config.calls.map((c) => c.to));
    // A component's own API document is read by tools and people, not by the components the configuration lists.
    const documents = new Set(graph.apiDocuments.filter((d) => d.kind === "served").map((d) => `${d.component}|${d.location}`));
    // A route an earlier one of its router always takes the requests of is reached by none: the finding says which.
    const shadowed = shadowedRoutes(graph.surfaces);
    graph.surfaces.forEach((s, i) => {
      if (s.implicit || !called.has(s.component) || documents.has(`${s.component}|${s.path}`)) return;
      const id = surfaceId(s);
      if (isPublic(id) || mayBeCalled.has(s)) return;
      const callers = callersOf.get(i);
      if (callers) {
        // A call that fits this route only by the value of an interpolated segment, where another route takes every
        // value of it, names no path of this route: shown as the evidence, not counted as a caller.
        const byValue = callers.filter((c) => byValueOnly(s.path, c.path) && coveredElsewhere(graph.surfaces, s, c));
        if (byValue.length < callers.length) return;
        const list = byValue.slice(0, 3).map((c) => `${c.from} calls ${c.method} ${c.path} (${c.at.file}:${c.at.line})`).join(", ");
        const more = byValue.length > 3 ? ` and ${byValue.length - 3} more` : "";
        out.push(
          finding(
            "FA001",
            id,
            `${s.method} ${s.path} (${s.component}) has no caller among the configured call sites that names its path. Only calls with an interpolated segment fit it, and the path of another route fits every value of that segment: ${list}${more}; whether one sends this path is not in the code.`,
            [s.at, ...byValue.slice(0, 3).map((c) => c.at)],
          ),
        );
        return;
      }
      const by = shadowed.get(i);
      const why = by
        ? ` No request reaches it: ${by.method === "*" ? "any method" : by.method} ${by.path} (${by.at.file}:${by.at.line}), registered before it, takes every request it fits.`
        : "";
      out.push(finding("FA001", id, `${s.method} ${s.path} (${s.component}) has no caller among the configured call sites.${why}`, by ? [s.at, by.at] : [s.at]));
    });
  }

  if (ruleEnabled(config, "FA002")) {
    // Components whose routes are configured: a call to one is checked even when none of its routes is left, so a
    // change that takes them all away shows at its callers. The finding says when none was read.
    const served = routedComponents(config);
    const read = new Set(graph.surfaces.map((s) => s.component));
    // An edge none of whose calls is taken for a request to its target is more likely configured wrong (a prefix or
    // base left out, the wrong target) than written wrong everywhere; FA002 checks none of them, so a limit says so.
    const taken = new Map<string, { calls: number; taken: number }>();
    graph.calls.forEach((c, i) => {
      if (!served.has(c.to)) return;
      const edge = taken.get(`${c.from}->${c.to}`) ?? taken.set(`${c.from}->${c.to}`, { calls: 0, taken: 0 }).get(`${c.from}->${c.to}`)!;
      edge.calls++;
      if (!unmatched(i) || plausibleRequest(graph, c)) edge.taken++;
      if (!unmatched(i) || !plausibleRequest(graph, c)) return;
      const none = read.has(c.to) ? "" : ` No route of ${c.to} is read: its route sources yielded none (a limit says what they left out).`;
      out.push(
        finding("FA002", `${c.from}->${c.to}|${c.method} ${c.path}`, `${c.from} calls ${c.method} ${c.path} on ${c.to}, which serves no matching route.${none}`, [c.at]),
      );
    });
    for (const [edge, n] of taken) {
      if (n.calls === 0 || n.taken > 0) continue;
      const to = edge.split("->")[1];
      limits.push(
        n.calls === 1
          ? `calls ${edge}: its call joins no base address and does not start with a first segment ${to} serves, so FA002 does not check it; if it is a request, a prefix or base is missing from the configuration`
          : `calls ${edge}: none of its ${n.calls} calls joins a base address or starts with a first segment ${to} serves, so FA002 checks none of them; if they are requests, a prefix or base is missing from the configuration`,
      );
    }
  }

  if (ruleEnabled(config, "FA003")) {
    const declared = new Set(graph.declared.map((e) => `${e.from}->${e.to}`));
    const actual = new Map<string, Finding["at"]>();
    // The request a redirect leads to is the client's that followed it; the server does not call itself.
    const redirects = new Set(graph.edges.filter(isRedirect).map((e) => e.to));
    graph.calls.forEach((c, i) => {
      // Whichever route a call of unread method reaches, or one without its route's trailing slash, the component it
      // calls is known.
      if (unmatched(i) || redirects.has(c.id)) return;
      const k = `${c.from}->${c.to}`;
      (actual.get(k) ?? actual.set(k, []).get(k)!).push(c.at);
    });
    // With manifests configured, no declaration means none is allowed; without them there is nothing to compare.
    if (config.manifest) {
      for (const [edge, places] of actual) {
        if (declared.has(edge)) continue;
        const [from, to] = edge.split("->");
        out.push(finding("FA003", `undeclared|${edge}`, `${from} calls ${to}, but no declaration lets ${from} consume what ${to} provides.`, places.slice(0, 5)));
      }
    }
    if (config.rules.FA003?.cycles !== false) {
      // A component calling its own routes, as a browser bundle calls the server of the same app, is no cycle.
      const edges = new Set([...declared, ...actual.keys()].filter((e) => {
        const [from, to] = e.split("->");
        return from !== to;
      }));
      const search = cycleSearch(edges);
      if (!search.complete) limits.push(`FA003: stopped listing cycles after ${CYCLE_BUDGET} steps; every strongly connected group has one cycle reported, others may be missing`);
      for (const cycle of search.cycles) {
        out.push(finding("FA003", `cycle|${cycle.join("->")}`, `Components depend on each other in a cycle: ${[...cycle, cycle[0]].join(" -> ")}.`, []));
      }
    }
  }

  if (ruleEnabled(config, "FA004")) {
    for (const e of graph.registries) {
      if (e.producers.length === 0 && e.consumers.length > 0)
        out.push(finding("FA004", `${e.registry}|${e.key}|no-producer`, `${e.registry} ${e.key} is active and consumed in ${e.consumers.length} files, but no producer file names it.`, [e.at, ...e.consumers.slice(0, 3)]));
      else if (e.consumers.length === 0 && e.producers.length > 0)
        out.push(finding("FA004", `${e.registry}|${e.key}|no-consumer`, `${e.registry} ${e.key} is active and produced in ${e.producers.length} files, but no consumer file names it.`, [e.at, ...e.producers.slice(0, 3)]));
      else if (e.consumers.length === 0 && e.producers.length === 0)
        out.push(finding("FA004", `${e.registry}|${e.key}|unused`, `${e.registry} ${e.key} is active, but neither a producer nor a consumer file names it.`, [e.at]));
    }
  }

  return out.sort((a, b) => a.key.localeCompare(b.key));
}

const CYCLE_BUDGET = 200_000;

/** Elementary cycles, each reported once from its smallest member. */
export function cycles(edges: Set<string>): string[][] {
  return cycleSearch(edges).cycles;
}

/** Groups of nodes that reach each other (Tarjan), each with at least two nodes or a self-loop. */
function cyclicGroups(next: Map<string, string[]>): string[][] {
  const index = new Map<string, number>();
  const low = new Map<string, number>();
  const onStack = new Set<string>();
  const stack: string[] = [];
  const groups: string[][] = [];
  let counter = 0;
  for (const root of [...next.keys()].sort()) {
    if (index.has(root)) continue;
    const work: Array<[string, number]> = [[root, 0]];
    index.set(root, counter);
    low.set(root, counter++);
    stack.push(root);
    onStack.add(root);
    while (work.length) {
      const frame = work[work.length - 1]!;
      const [node, i] = frame;
      const succ = next.get(node) ?? [];
      if (i < succ.length) {
        frame[1]++;
        const n = succ[i]!;
        if (!index.has(n)) {
          index.set(n, counter);
          low.set(n, counter++);
          stack.push(n);
          onStack.add(n);
          work.push([n, 0]);
        } else if (onStack.has(n)) low.set(node, Math.min(low.get(node)!, index.get(n)!));
        continue;
      }
      work.pop();
      if (work.length) {
        const parent = work[work.length - 1]![0];
        low.set(parent, Math.min(low.get(parent)!, low.get(node)!));
      }
      if (low.get(node) === index.get(node)) {
        const group: string[] = [];
        let n: string;
        do {
          n = stack.pop()!;
          onStack.delete(n);
          group.push(n);
        } while (n !== node);
        if (group.length > 1 || (next.get(node) ?? []).includes(node)) groups.push(group.sort());
      }
    }
  }
  return groups;
}

/** The shortest cycle through `start` within a group, by breadth-first search. */
function shortestCycle(start: string, next: Map<string, string[]>, members: Set<string>): string[] {
  const parent = new Map<string, string>();
  const queue = [start];
  while (queue.length) {
    const node = queue.shift()!;
    for (const n of next.get(node) ?? []) {
      if (!members.has(n)) continue;
      if (n === start) {
        const path = [node];
        while (path[0] !== start) path.unshift(parent.get(path[0]!)!);
        return path;
      }
      if (!parent.has(n) && n !== start) {
        parent.set(n, node);
        queue.push(n);
      }
    }
  }
  return [start];
}

/**
 * Elementary cycles, searched within each group of mutually reachable nodes and without a length limit. The search
 * stops after a fixed number of steps; even then every group has at least its shortest cycle through its smallest node,
 * so a cyclic graph is never reported as free of cycles, and `complete` says whether the list is whole.
 */
export function cycleSearch(edges: Set<string>, budget = CYCLE_BUDGET): { cycles: string[][]; complete: boolean } {
  const next = new Map<string, string[]>();
  for (const e of edges) {
    const [a, b] = e.split("->") as [string, string];
    (next.get(a) ?? next.set(a, []).get(a)!).push(b);
    if (!next.has(b)) next.set(b, []);
  }
  for (const list of next.values()) list.sort();
  const found = new Map<string, string[]>();
  let steps = 0;
  let complete = true;
  for (const group of cyclicGroups(next)) {
    const members = new Set(group);
    for (const start of group) {
      const stack: Array<[string, string[]]> = [[start, [start]]];
      while (stack.length && complete) {
        const [node, path] = stack.pop()!;
        for (const n of next.get(node) ?? []) {
          if (++steps > budget) {
            complete = false;
            break;
          }
          if (n === start) found.set(path.join("->"), path);
          else if (members.has(n) && n > start && !path.includes(n)) stack.push([n, [...path, n]]);
        }
      }
    }
    const first = shortestCycle(group[0]!, next, members);
    found.set(first.join("->"), first);
  }
  return { cycles: [...found.values()], complete };
}
