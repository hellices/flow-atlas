import type { Config } from "./config.js";
import { extractApiDocuments, resolveApiDescriptions } from "./extract/apidocs.js";
import { extractCalls, serves, withoutSpan, type ReadCall } from "./extract/calls.js";
import { extractComponents } from "./extract/components.js";
import { Reach } from "./extract/reach.js";
import { extractRegistries } from "./extract/registries.js";
import { extractRoutes, type Redirects } from "./extract/routes.js";
import { Spans } from "./extract/spans.js";
import { matchCalls, rankedComponents, unsettledLimits, type Ranking } from "./match.js";
import { API_VERSION, type Call, type Coverage, type Draft, type Edge, type Graph, type Surface } from "./model.js";
import { callPath } from "./paths.js";
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
 * lead to: a call the handler's code runs (evidence `static`), or one held in a method the handler calls by name
 * (evidence `name`). `spans[i]` are the offsets of the expression holding `calls[i]`'s URL; the handler runs the call
 * when it hands a call an expression starting there (`executed`). A link on the same line, or one whose address is
 * built from a request's result, starts elsewhere. A call in a page's template is reached by the routes that render it,
 * one relative to the page only by the routes of the path it was resolved against; `redirected` gives, by call index,
 * the routes whose replies redirect to it (evidence `text`, `via` redirect). A call whose method is not read and whose
 * routes take different methods has no edge; `limits` names it.
 */
export function edgesOf(
  graph: Pick<Graph, "surfaces" | "calls">,
  executed?: Map<string, Set<string>>,
  ranked?: Map<string, Ranking>,
  spans: Array<[number, number] | undefined> = [],
  limits: string[] = [],
  redirected: Map<number, string[]> = new Map(),
): Edge[] {
  const edges: Edge[] = [];
  const { targetsOf, unsettled } = matchCalls(graph, ranked);
  limits.push(...unsettledLimits(graph, unsettled));
  graph.calls.forEach((c, i) => {
    for (const s of targetsOf.get(i) ?? []) edges.push({ kind: "match", from: c.id, to: s.id, evidence: c.evidence });
  });
  const replies = new Map<string, number[]>();
  for (const [i, from] of redirected) for (const s of from) (replies.get(s) ?? replies.set(s, []).get(s)!).push(i);
  for (const s of graph.surfaces) {
    const reached = new Set(s.reaches ?? []);
    const runs = executed?.get(s.id);
    const sent = replies.get(s.id) ?? [];
    if (!reached.size && !runs?.size && !sent.length) continue;
    const rendered = new Map([...(runs ?? [])].filter((r) => r.includes(":*")).map((r) => [r.slice(0, r.indexOf(":*")), r.slice(r.indexOf(":*") + 2)]));
    const runsIn = (i: number, file: string): boolean => {
      const span = spans[i];
      return !!span && !!runs?.has(`${file}@${span[0]}`);
    };
    for (const [i, c] of graph.calls.entries()) {
      if (rendered.has(c.at.file)) {
        if (c.page === undefined || c.page === s.path) edges.push({ kind: "reach", from: s.id, to: c.id, evidence: "name", via: `view ${rendered.get(c.at.file)}` });
        continue;
      }
      if (c.from !== s.component) continue;
      if (runsIn(i, c.at.file)) edges.push({ kind: "reach", from: s.id, to: c.id, evidence: "static", via: c.scope ?? "handler" });
      else if (c.scope && reached.has(c.scope)) edges.push({ kind: "reach", from: s.id, to: c.id, evidence: "name", via: c.scope });
    }
    for (const i of sent) edges.push({ kind: "reach", from: s.id, to: graph.calls[i]!.id, evidence: "text", via: "redirect" });
  }
  return edges;
}

/** Per template, the paths of the routes whose views render it (`executed` holds `<template>:*<view>`). */
function renderedPages(surfaces: Surface[], executed: Map<string, Set<string>>): Map<string, string[]> {
  const pages = new Map<string, string[]>();
  for (const s of surfaces) {
    for (const run of executed.get(s.id) ?? []) {
      const at = run.indexOf(":*");
      if (at < 0) continue;
      const paths = pages.get(run.slice(0, at)) ?? pages.set(run.slice(0, at), []).get(run.slice(0, at))!;
      if (!paths.includes(s.path)) paths.push(s.path);
    }
  }
  for (const paths of pages.values()) paths.sort();
  return pages;
}

/**
 * The requests redirects lead to, one per place and path, with the routes whose replies send each. A browser follows
 * the 302 Spring's RedirectView sends with a GET when the request was a GET or a POST, and with a HEAD after a HEAD
 * (Fetch, "HTTP-redirect fetch"); after any other method the client may keep it, so the method is not read.
 */
function redirectCalls(surfaces: Surface[], redirects: Redirects): Array<{ call: ReadCall; from: string[] }> {
  const out = new Map<string, { call: ReadCall; from: string[] }>();
  for (const s of surfaces) {
    const served = serves(surfaces.filter((r) => r.component === s.component));
    for (const r of redirects.get(s.id) ?? []) {
      const parsed = callPath(r.path, served);
      if (!parsed) continue;
      const method = s.method === "HEAD" ? "HEAD" : ["GET", "POST"].includes(s.method) ? "GET" : "*";
      const key = `${s.component}|${method} ${parsed.path}@${r.at.file}:${r.at.line}`;
      const entry = out.get(key) ?? out.set(key, { call: { from: s.component, to: s.component, method, path: parsed.path, based: false, at: r.at, evidence: "text" }, from: [] }).get(key)!;
      entry.from.push(s.id);
    }
  }
  return [...out.values()];
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
  const spans = new Spans();
  const redirects: Redirects = new Map();
  const surfaces = extractRoutes(source, config, new Reach(source), coverage, limits, executed, spans, redirects);
  const apiDocuments = extractApiDocuments(source, config, components, surfaces, limits);
  const read = extractCalls(source, config, coverage, spans, limits, { surfaces, pages: renderedPages(surfaces, executed) });
  const replies = redirectCalls(surfaces, redirects);
  const calls = assignCallIds([...read, ...replies.map((r) => r.call)].map(withoutSpan));
  const redirected = new Map(replies.map((r, k) => [read.length + k, r.from]));
  const edges = edgesOf({ surfaces, calls }, executed, rankedComponents(config), read.map((c) => c.span), limits, redirected);
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
    registries: extractRegistries(source, config, coverage),
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
