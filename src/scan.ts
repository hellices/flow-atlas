import type { Config } from "./config.js";
import { extractApiDocuments, resolveApiDescriptions } from "./extract/apidocs.js";
import { extractCalls } from "./extract/calls.js";
import { extractComponents } from "./extract/components.js";
import { Reach } from "./extract/reach.js";
import { extractRegistries, extractVersions } from "./extract/registries.js";
import { extractRoutes } from "./extract/routes.js";
import { matchCalls, rankedComponents } from "./match.js";
import { API_VERSION, type Call, type Coverage, type Draft, type Edge, type Graph } from "./model.js";
import { select, type Source } from "./source.js";
import { codeDependency, configDependency, provenance } from "./provenance.js";

/** Stable call ids: the enclosing function names a call better than its line, which moves with every edit above it. */
export function assignCallIds(drafts: Draft<Call>[]): Call[] {
  const seen = new Map<string, number>();
  return drafts.map((c) => {
    const base = `${c.from}->${c.to}|${c.method} ${c.path}@${c.at.file}${c.scope ? `#${c.scope}` : `:${c.at.line}`}`;
    const n = (seen.get(base) ?? 0) + 1;
    seen.set(base, n);
    return { id: n === 1 ? base : `${base}~${n}`, ...c };
  });
}

/**
 * `match` edges from calls to the surfaces they reach; `reach` edges from surfaces to the outbound calls their handlers
 * lead to: a call the handler's code runs (its line is in `executed`, evidence `static`), or one held in a method the
 * handler calls by name (evidence `name`).
 */
export function edgesOf(graph: Pick<Graph, "surfaces" | "calls">, executed?: Map<string, Set<string>>, ranked?: Set<string>): Edge[] {
  const edges: Edge[] = [];
  const { targetsOf } = matchCalls(graph, ranked);
  graph.calls.forEach((c, i) => {
    for (const s of targetsOf.get(i) ?? []) edges.push({ kind: "match", from: c.id, to: s.id, evidence: c.evidence });
  });
  for (const s of graph.surfaces) {
    const reached = new Set(s.reaches ?? []);
    const runs = executed?.get(s.id);
    if (!reached.size && !runs?.size) continue;
    const rendered = new Map([...(runs ?? [])].filter((r) => r.includes(":*")).map((r) => [r.slice(0, r.indexOf(":*")), r.slice(r.indexOf(":*") + 2)]));
    for (const c of graph.calls) {
      if (rendered.has(c.at.file)) {
        edges.push({ kind: "reach", from: s.id, to: c.id, evidence: "name", via: `view ${rendered.get(c.at.file)}` });
        continue;
      }
      if (c.from !== s.component) continue;
      if (runs?.has(`${c.at.file}:${c.at.line}`)) edges.push({ kind: "reach", from: s.id, to: c.id, evidence: "static", ...(c.scope ? { via: c.scope } : {}) });
      else if (c.scope && reached.has(c.scope)) edges.push({ kind: "reach", from: s.id, to: c.id, evidence: "name", via: c.scope });
    }
  }
  return edges;
}

/** `root` names the configuration relative to the repository; `requested` is the revision as the caller gave it. */
export function scan(source: Source, config: Config, context: { root?: string; requested?: string } = {}): Graph {
  const { components, declared, limits } = extractComponents(source, config);
  const known = new Set(components.map((c) => c.name));
  for (const r of config.routes) if (!known.has(r.component)) limits.push(`routes name component ${r.component}, which is not declared`);
  for (const c of config.calls) {
    if (!known.has(c.from)) limits.push(`calls name component ${c.from}, which is not declared`);
    if (!known.has(c.to)) limits.push(`calls name component ${c.to}, which is not declared`);
  }
  // Handlers are followed into the rest of their component; load those files in one batch.
  const serving = new Set(config.routes.map((r) => r.component));
  const paths = components.filter((c) => serving.has(c.name) && c.path).map((c) => `${c.path}/**/*.{ts,tsx}`);
  if (paths.length) select(source, paths, config.exclude);

  const coverage: Coverage[] = [];
  const executed = new Map<string, Set<string>>();
  const surfaces = extractRoutes(source, config, new Reach(source), coverage, limits, executed);
  const apiDocuments = extractApiDocuments(source, config, components, surfaces);
  const calls = assignCallIds(extractCalls(source, config, coverage));
  const edges = edgesOf({ surfaces, calls }, executed, rankedComponents(config));
  const graph: Graph = {
    apiVersion: API_VERSION,
    kind: "Graph",
    provenance: provenance("Graph", { ref: context.requested ?? source.ref }, [
      codeDependency("code", source.ref),
      ...configDependency(config, context.root),
    ]),
    components,
    surfaces,
    calls,
    edges,
    declared,
    registries: extractRegistries(source, config),
    versions: extractVersions(source, config),
    apiDocuments,
    apiDescriptions: resolveApiDescriptions(apiDocuments, surfaces, config),
    coverage,
    limits,
  };

  const matched = new Set(edges.filter((e) => e.kind === "match").map((e) => e.from));
  const linked = new Set(edges.filter((e) => e.kind === "reach").map((e) => e.to));
  for (const entry of coverage) {
    if (!entry.source.startsWith("calls ")) continue;
    const [from, to] = entry.source.slice("calls ".length).split("->") as [string, string];
    const own = calls.filter((c) => c.from === from && c.to === to);
    entry.matched = own.filter((c) => matched.has(c.id)).length;
    if (serving.has(from)) entry.linked = own.filter((c) => linked.has(c.id)).length;
  }
  for (const entry of coverage) {
    if (entry.files === 0) limits.push(`${entry.source}: the configured files match nothing`);
    else if (entry.items === 0) limits.push(`${entry.source}: ${entry.files} files read, nothing extracted`);
  }
  return graph;
}
