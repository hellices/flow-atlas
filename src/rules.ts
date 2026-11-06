import type { Config } from "./config.js";
import { ruleEnabled } from "./config.js";
import { matchCalls, plausibleRequest, rankedComponents } from "./match.js";
import type { Finding, Graph } from "./model.js";
import { surfaceId } from "./model.js";

/** Titles only. What to do about a finding is decided by whoever reads it; guidance lives with the skill. */
export const RULES: Record<Finding["rule"], { title: string }> = {
  FA001: { title: "surface with no caller in the repository" },
  FA002: { title: "call that no surface serves" },
  FA003: { title: "boundary call or cycle the declarations do not state" },
  FA004: { title: "registry entry with no producer or no consumer" },
  FA006: { title: "contract version that is neither active nor referenced" },
  FA007: { title: "flow description that the code does not bear out" },
};

function finding(rule: Finding["rule"], key: string, message: string, at: Finding["at"]): Finding {
  return { rule, key: `${rule}|${key}`, title: RULES[rule].title, message, at };
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

/** Findings for a graph. What the rules could not settle completely is added to `limits`. */
export function evaluate(graph: Graph, config: Config, limits: string[] = []): Finding[] {
  const out: Finding[] = [];
  const { callersOf, targetsOf } = matchCalls(graph, rankedComponents(config));
  const isPublic = surfacePattern(config.publicSurfaces);

  if (ruleEnabled(config, "FA001")) {
    const called = new Set(config.calls.map((c) => c.to));
    // A component's own API document is read by tools and people, not by the components the configuration lists.
    const documents = new Set(graph.apiDocuments.filter((d) => d.kind === "served").map((d) => `${d.component}|${d.location}`));
    graph.surfaces.forEach((s, i) => {
      if (s.implicit || !called.has(s.component) || documents.has(`${s.component}|${s.path}`)) return;
      const id = surfaceId(s);
      if (isPublic(id) || callersOf.has(i)) return;
      out.push(finding("FA001", id, `${s.method} ${s.path} (${s.component}) has no caller among the configured call sites.`, [s.at]));
    });
  }

  if (ruleEnabled(config, "FA002")) {
    // Components whose routes are configured: a call to one is checked even when none of its routes is left.
    const served = new Set(config.routes.map((r) => r.component));
    graph.calls.forEach((c, i) => {
      if (targetsOf.has(i) || !served.has(c.to) || !plausibleRequest(graph, c)) return;
      out.push(
        finding("FA002", `${c.from}->${c.to}|${c.method} ${c.path}`, `${c.from} calls ${c.method} ${c.path} on ${c.to}, which serves no matching route.`, [c.at]),
      );
    });
  }

  if (ruleEnabled(config, "FA003")) {
    const declared = new Set(graph.declared.map((e) => `${e.from}->${e.to}`));
    const actual = new Map<string, Finding["at"]>();
    graph.calls.forEach((c, i) => {
      if (!targetsOf.has(i)) return;
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

  if (ruleEnabled(config, "FA006")) {
    const latest = new Map<string, number>();
    for (const v of graph.versions) latest.set(v.family, Math.max(latest.get(v.family) ?? 0, v.version));
    for (const v of graph.versions) {
      if (v.references.length > 0) continue;
      const live = v.active === undefined ? v.version === latest.get(v.family) : v.active;
      if (live) continue;
      out.push(finding("FA006", v.id, `${v.id} is not active and nothing outside generated code references it.`, [v.at]));
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
