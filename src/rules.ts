import type { Config } from "./config.js";
import { ruleEnabled } from "./config.js";
import { matchCalls, plausibleRequest } from "./match.js";
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
    const body = e.replace(/[.+?^${}()|[\]\\]/g, "\\$&").replace(/\*\*/g, "\u0000").replace(/\*/g, "[^/]*").replace(/\u0000/g, ".*");
    return new RegExp(`^${body}$`);
  });
  return (id) => patterns.some((p) => p.test(id));
}

export function evaluate(graph: Graph, config: Config): Finding[] {
  const out: Finding[] = [];
  const { callersOf, targetsOf } = matchCalls(graph);
  const isPublic = surfacePattern(config.publicSurfaces);

  if (ruleEnabled(config, "FA001")) {
    const called = new Set(config.calls.map((c) => c.to));
    // A component's own API document is read by tools and people, not by the components the configuration lists.
    const documents = new Set(graph.apiDocuments.filter((d) => d.kind === "served").map((d) => `${d.component}|${d.location}`));
    graph.surfaces.forEach((s, i) => {
      if (!called.has(s.component) || documents.has(`${s.component}|${s.path}`)) return;
      const id = surfaceId(s);
      if (isPublic(id) || callersOf.has(i)) return;
      out.push(finding("FA001", id, `${s.method} ${s.path} (${s.component}) has no caller among the configured call sites.`, [s.at]));
    });
  }

  if (ruleEnabled(config, "FA002")) {
    const served = new Set(graph.surfaces.map((s) => s.component));
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
    if (graph.declared.length > 0) {
      for (const [edge, places] of actual) {
        if (declared.has(edge)) continue;
        const [from, to] = edge.split("->");
        out.push(finding("FA003", `undeclared|${edge}`, `${from} calls ${to}, but no declaration lets ${from} consume what ${to} provides.`, places.slice(0, 5)));
      }
    }
    if (config.rules.FA003?.cycles !== false) {
      const edges = new Set([...declared, ...actual.keys()]);
      for (const cycle of cycles(edges)) {
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

/** Elementary cycles, each reported once from its smallest member. */
export function cycles(edges: Set<string>): string[][] {
  const next = new Map<string, string[]>();
  for (const e of edges) {
    const [a, b] = e.split("->") as [string, string];
    (next.get(a) ?? next.set(a, []).get(a)!).push(b);
  }
  const found = new Map<string, string[]>();
  const nodes = [...next.keys()].sort();
  for (const start of nodes) {
    const stack: Array<[string, string[]]> = [[start, [start]]];
    while (stack.length) {
      const [node, path] = stack.pop()!;
      for (const n of next.get(node) ?? []) {
        if (n === start) {
          const min = path.reduce((m, x) => (x < m ? x : m));
          if (min !== start) continue;
          found.set(path.join("->"), path);
        } else if (!path.includes(n) && n > start && path.length < 12) {
          stack.push([n, [...path, n]]);
        }
      }
    }
  }
  return [...found.values()];
}
