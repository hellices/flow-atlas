import type { Call, Graph, Surface } from "./model.js";
import { firstLiteral, HOLE, methodsMatch, narrowedPath, pathCovers, pathsMatch, segments, slashRedirectPath } from "./paths.js";

import type { Config } from "./config.js";

/**
 * Components whose router ranks matching routes by how specific they are, so that of several routes a request fits,
 * one is chosen regardless of order: Spring MVC, which ranks the routes that accept the method, and Next.js, which
 * picks the route file by its path alone and answers 405 when that file lacks the method. Express, Fastify, Nest and
 * FastAPI follow registration order, which the code read here does not settle, so every route a request fits stays a
 * target there.
 */
export type Ranking = "spring" | "next";

export function rankedComponents(config: Pick<Config, "routes">): Map<string, Ranking> {
  const out = new Map<string, Ranking>();
  for (const r of config.routes) {
    if ((r.styles ?? []).includes("spring")) out.set(r.component, "spring");
    else if ((r.styles ?? []).includes("next")) out.set(r.component, "next");
  }
  return out;
}

/** Next.js's order at each segment: a static name, then `[x]`, then `[...x]` (`{x}/**`), then `[[...x]]` (`{*x}`). */
function nextRank(path: string): number[] {
  const segs = segments(path);
  const out: number[] = [];
  segs.forEach((s, i) => {
    if (s === "**") return;
    if (s.startsWith("{*")) out.push(3);
    else if (s.startsWith("{")) out.push(segs[i + 1] === "**" ? 2 : 1);
    else out.push(0);
  });
  return out;
}

/**
 * Spring's `PathPattern.SPECIFICITY_COMPARATOR`, lower first: a pattern with a catch-all (`**`, `{*rest}`) after one
 * without; of two catch-alls, the longer first; then the score, one per URI variable and a hundred per wildcard; then
 * the longer pattern. Length is normalized, each variable counted as one character.
 */
function springRank(path: string): number[] {
  const segs = segments(path);
  const catchAll = segs.some((s) => s === "**" || s.startsWith("{*")) ? 1 : 0;
  const variables = segs.filter((s) => (s.startsWith("{") && !s.startsWith("{*")) || s.startsWith(":")).length;
  // Every `*` outside a variable counts, inside a segment too (`*.txt`); a catch-all is counted above instead.
  const wildcards = segs.filter((s) => s !== "**" && !s.startsWith("{*")).reduce((n, s) => n + (s.replace(/\{[^}]*\}/g, "").match(/\*/g)?.length ?? 0), 0);
  const normalizedLength = path.replace(/\{[^}]*\}/g, "?").length;
  return [catchAll, catchAll ? -normalizedLength : 0, variables + 100 * wildcards, -normalizedLength];
}

function compare(a: number[], b: number[]): number {
  for (let i = 0; i < Math.max(a.length, b.length); i++) if ((a[i] ?? 0) !== (b[i] ?? 0)) return (a[i] ?? 0) - (b[i] ?? 0);
  return 0;
}

/**
 * The routes a request reaches. For a component whose router ranks routes, and a request whose path is fully known,
 * only the route its router picks; otherwise every route it fits, since which one serves it is not known. Spring
 * compares every mapping that accepts the request: the more specific path first, then one that names the method over
 * one that accepts any, and for HEAD, which a GET mapping serves too, a HEAD mapping over a GET one. For a request whose
 * method is not known, each method it may have picks its own route.
 */
function reached(call: Call, candidates: Array<{ surface: Surface; index: number }>, ranked: Map<string, Ranking>): Array<{ surface: Surface; index: number }> {
  if (ranked.get(call.to) !== "spring" || call.path.includes(HOLE)) return candidates;
  const best = (group: Array<{ surface: Surface; index: number }>) => {
    const rank = (c: { surface: Surface }) => [...springRank(c.surface.path), c.surface.method === "*" ? 1 : 0, c.surface.method === "GET" ? 1 : 0];
    const top = group.reduce((t, c) => (compare(rank(c), t) < 0 ? rank(c) : t), rank(group[0]!));
    return group.filter((c) => compare(rank(c), top) === 0);
  };
  // An unknown method may be any the mappings name, or another one only the any-method mappings accept.
  const named = [...new Set(candidates.map((c) => c.surface.method).filter((m) => m !== "*"))];
  const methods = call.method === "*" ? [...named, "*"] : [call.method.toUpperCase()];
  const out = new Map<number, { surface: Surface; index: number }>();
  for (const method of methods) {
    const group = candidates.filter((c) => c.surface.method === method || c.surface.method === "*" || (method === "HEAD" && c.surface.method === "GET"));
    if (group.length) for (const c of best(group)) out.set(c.index, c);
  }
  return [...out.values()].sort((a, b) => a.index - b.index);
}

/** Whether an OpenAPI 3 document describes a surface, so that the document's own matching rule applies to it. */
const describedByOpenApi3 = (s: Surface): boolean => s.describedVersion !== undefined && s.describedVersion !== "2.0";

const templated = (path: string): boolean => segments(path).some((s) => s.includes("{") || s.includes("*"));

/**
 * OpenAPI 3 (Paths Object): "When matching URLs, concrete (non-templated) paths would be matched before their templated
 * counterparts." Of the routes of one method that a fully known request fits, a templated one the document describes
 * gives way to a concrete one it describes; a route read only from code keeps its place, since its router's order is
 * not read. Two templated paths stay ambiguous, as the specification leaves them.
 */
function concreteFirst(call: Call, candidates: Array<{ surface: Surface; index: number }>): Array<{ surface: Surface; index: number }> {
  if (call.path.includes(HOLE)) return candidates;
  const concrete = new Set(candidates.filter((c) => describedByOpenApi3(c.surface) && !templated(c.surface.path)).map((c) => c.surface.method));
  return candidates.filter((c) => !(concrete.has(c.surface.method) && describedByOpenApi3(c.surface) && templated(c.surface.path)));
}

/**
 * Whether the path a route's document describes ends with a `/`. A server path or Swagger `basePath` before the root
 * key `/` puts the slash after it (`/api/`); the root itself has none to leave out.
 */
const slashEnds = (s: Surface): boolean => !!s.describedPath?.endsWith("/") && s.path !== "/";

/** Whether a request reaches a route its document describes only if the server forgives a trailing slash. */
const aliased = (call: Call, s: Surface): boolean => s.describedPath !== undefined && slashEnds(s) !== !!call.slash;

/**
 * Starlette's router (adding or removing a trailing slash) and Django's CommonMiddleware (adding one) redirect a
 * request only when no route matches the path as written. Of the routes of one method a fully known request fits, those whose document writes
 * the path as the request does come first; the ones it reaches only by such a redirect give way to them.
 */
function exactFirst(call: Call, candidates: Array<{ surface: Surface; index: number }>): Array<{ surface: Surface; index: number }> {
  if (call.path.includes(HOLE)) return candidates;
  const exact = new Set(candidates.filter((c) => c.surface.describedPath !== undefined && !aliased(call, c.surface)).map((c) => c.surface.method));
  return candidates.filter((c) => !(exact.has(c.surface.method) && aliased(call, c.surface)));
}

/**
 * Whether a request reaches a route only if the server forgives a missing trailing slash: the route's document writes
 * its path with a `/` at the end, the call does not, and the method is neither GET nor HEAD. Django's APPEND_SLASH
 * redirects such a request, which may lose a POST's body (and raises in DEBUG for DELETE, POST, PUT and PATCH),
 * Starlette's redirect_slashes redirects it with its method kept, and Express ignores the slash, so which one happens
 * depends on the framework. A GET or HEAD, which those redirects serve, still reaches the route.
 */
function slashLeftOut(call: Call, surface: Surface): boolean {
  return !call.slash && slashEnds(surface) && surface.method !== "GET" && surface.method !== "HEAD";
}

export interface Matches {
  /** Calls that reach each surface, keyed by the surface's index. */
  callersOf: Map<number, Call[]>;
  /** Surfaces each call reaches, keyed by the call's index. */
  targetsOf: Map<number, Surface[]>;
  /**
   * Calls whose method is not read and whose routes take different methods, keyed by the call's index, with the
   * surfaces they fit: which of them a call reaches depends on its method, so it is matched to none.
   */
  unsettled: Map<number, Surface[]>;
  /**
   * Calls that leave out the trailing `/` their routes' document writes, by a method other than GET or HEAD, keyed by
   * the call's index, with those routes: whether such a request reaches them depends on the framework, so it is
   * matched to none of them.
   */
  slashless: Map<number, Surface[]>;
}

export function matchCalls(graph: Pick<Graph, "surfaces" | "calls">, ranked: Map<string, Ranking> = new Map()): Matches {
  const callersOf = new Map<number, Call[]>();
  const targetsOf = new Map<number, Surface[]>();
  const unsettled = new Map<number, Surface[]>();
  const slashless = new Map<number, Surface[]>();
  graph.calls.forEach((call, ci) => {
    const candidates: Array<{ surface: Surface; index: number }> = [];
    // Next.js settles the route by the path first; the method is checked on that route only. Each request a call stands
    // for goes to the most specific path that fits it, so a call with interpolations reaches every path down to the
    // first that takes any value they may hold, and none after it. A path is not reached either where a more specific
    // one takes every request the call and it share: `/{a}/new` meets `/editor/{id}` only in `/editor/new`.
    let paths: Set<string> | undefined;
    if (ranked.get(call.to) === "next") {
      const fits = [...new Set(graph.surfaces.filter((s) => s.component === call.to && pathsMatch(s.path, call.path)).map((s) => s.path))];
      fits.sort((a, b) => compare(nextRank(a), nextRank(b)));
      const covering = fits.findIndex((p) => pathCovers(p, call.path));
      const before = covering < 0 ? fits : fits.slice(0, covering + 1);
      paths = new Set(before.filter((p, i) => !fits.slice(0, i).some((q) => pathCovers(q, narrowedPath(p, call.path)))));
    }
    // Starlette redirects a path no route matches, by any method, to the same path with a `/` added; a route ending in
    // `{name:path}` takes that with the segment empty. A call with interpolations may name the path the redirect
    // serves, as the route spells it where the call does not; only a route that surely matches that path keeps it from
    // being redirected.
    const redirected = (surface: Surface): boolean => {
      const bare = slashRedirectPath(surface.path);
      if (bare === undefined || !pathsMatch(bare, call.path)) return false;
      const served = narrowedPath(bare, call.path);
      return !graph.surfaces.some((s) => s.component === call.to && pathCovers(s.path, served));
    };
    // Spring serves a HEAD request with a GET mapping when no HEAD mapping fits better (`RequestMethodsRequestCondition`).
    const headByGet = ranked.get(call.to) === "spring" && call.method.toUpperCase() === "HEAD";
    graph.surfaces.forEach((surface, si) => {
      if (surface.component !== call.to) return;
      if (paths && !paths.has(surface.path)) return;
      // What the framework answers by itself beside a GET (HEAD, OPTIONS) is reached only by a request that names that
      // method; a file it serves with no handler is reached by GET as a route is.
      if (surface.implicit && surface.method !== "GET" && call.method.toUpperCase() !== surface.method) return;
      if (!methodsMatch(surface.method, call.method) && !(headByGet && surface.method === "GET")) return;
      if (pathsMatch(surface.path, call.path) || redirected(surface)) candidates.push({ surface, index: si });
    });
    const reach = reached(call, ranked.has(call.to) ? candidates : concreteFirst(call, exactFirst(call, candidates)), ranked);
    // A method that is not read would pick among routes that take different ones; which it picks is not read either.
    if (call.method === "*" && new Set(reach.map((c) => c.surface.method)).size > 1) {
      unsettled.set(ci, reach.map((c) => c.surface));
      return;
    }
    for (const { surface, index: si } of reach) {
      if (slashLeftOut(call, surface)) {
        (slashless.get(ci) ?? slashless.set(ci, []).get(ci)!).push(surface);
        continue;
      }
      (callersOf.get(si) ?? callersOf.set(si, []).get(si)!).push(call);
      (targetsOf.get(ci) ?? targetsOf.set(ci, []).get(ci)!).push(surface);
    }
  });
  return { callersOf, targetsOf, unsettled, slashless };
}

/** What `unsettled` holds, as limits: the call, where it is, and the methods of the routes it fits. */
export function unsettledLimits(graph: Pick<Graph, "calls">, unsettled: Matches["unsettled"]): string[] {
  return [...unsettled].map(([ci, fits]) => {
    const c = graph.calls[ci]!;
    const methods = [...new Set(fits.map((s) => (s.method === "*" ? "any method" : s.method)))].sort();
    const list = methods.length > 1 ? `${methods.slice(0, -1).join(", ")} and ${methods[methods.length - 1]}` : methods[0];
    return `calls ${c.from}->${c.to}: * ${c.path} at ${c.at.file}:${c.at.line} fits routes of ${list}; its method is not read, so it is matched to none of them`;
  });
}

/** What `slashless` holds, as limits: the call, where it is, and the paths its routes' document writes. */
export function slashlessLimits(graph: Pick<Graph, "calls">, slashless: Matches["slashless"]): string[] {
  return [...slashless].map(([ci, routes]) => {
    const c = graph.calls[ci]!;
    const paths = [...new Set(routes.map((s) => s.describedPath))].join(", ");
    return `calls ${c.from}->${c.to}: ${c.method} ${c.path} at ${c.at.file}:${c.at.line} leaves out the trailing / the route's document writes (${paths}); whether it reaches the route depends on the framework (Django's APPEND_SLASH redirects it and may lose its body, Starlette redirects it, Express serves it), so it is matched to none`;
  });
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
