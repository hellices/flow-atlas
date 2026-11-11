import type { Call, Dispatch, Graph, Surface } from "./model.js";
import {
  firstLiteral,
  HOLE,
  isCatchAll,
  isFixed,
  isParam,
  isStarletteRest,
  joinRoute,
  methodsMatch,
  narrowedPath,
  paramName,
  pathCovers,
  pathsMatch,
  patternOf,
  segments,
  slashRedirectPath,
  takesEmpty,
} from "./paths.js";

import type { Config } from "./config.js";

/**
 * Components whose router ranks matching routes by how specific they are, so that of several routes a request fits,
 * one is chosen regardless of order: Spring MVC, which ranks the routes that accept the method, and Next.js, which
 * picks the route file by its path alone and answers 405 when that file lacks the method. The routers of the other
 * styles pick by what each route's `dispatch` says (registration order, find-my-way's precedence); where it says
 * nothing, every route a request fits stays a target.
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
  // Each URI variable counts, several in one segment too (`{name}-{version}`).
  const variables = segs.reduce((n, s) => n + (s.startsWith(":") ? 1 : (s.match(/\{(?!\*)[^{}]*\}/g)?.length ?? 0)), 0);
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

type Candidate = { surface: Surface; index: number };

/**
 * The form `trailingSlash: true` serves a Next.js path at (load-custom-routes.js, its two internal redirects): a file's
 * (a last segment ending in `.` and word characters) without the `/`, any other whose last segment has no `.` with it;
 * a path under `/.well-known/`, and one whose last segment has a `.` otherwise, as written. Undefined for either form.
 */
const addedForm = (path: string): boolean | undefined => {
  const segs = segments(path);
  const last = segs[segs.length - 1] ?? "";
  if (segs[0] === ".well-known" || last.includes(HOLE)) return undefined;
  if (/\.\w+$/.test(last)) return false;
  return last.includes(".") ? undefined : true;
};

/**
 * Whether a route takes a request path, written with or without a `/` at its end (`slash`), as its router's `slashes`
 * rule says (`Dispatch`). A wildcard at the end takes the rest of the path, a `/` at its end included; the path before
 * it alone is taken without the `/` only where the route's syntax writes none there (`trailing`, and Starlette's
 * `{name:path}`, which takes the text after a `/`). Otherwise `ignored` takes either form; `strict`, `redirected` and
 * `removed` the form the route is served at, find-my-way also giving the empty text after a last `/` to a parameter;
 * `added` the form `addedForm` gives.
 */
export function takes(s: Surface, path: string, slash: boolean): boolean {
  const r = segments(s.path);
  const c = segments(path);
  const last = r[r.length - 1];
  const d = s.dispatch ?? {};
  // Next.js redirects a request to the form it serves before it picks a route, whatever the route.
  if (d.slashes === "added" || d.slashes === "removed") return (!c.length || nextForm(d, path, slash)) && pathsMatch(s.path, path, s.patterns);
  if (isCatchAll(last) || isStarletteRest(last)) {
    if (c.length !== r.length - 1) return pathsMatch(s.path, path, s.patterns);
    if (!pathsMatch(joinRoute(...r.slice(0, -1)), path, s.patterns)) return false;
    return slash || (d.trailing !== "slash" && !isStarletteRest(last));
  }
  if (pathsMatch(s.path, path, s.patterns)) {
    if (d.slashes === undefined || d.slashes === "ignored" || !c.length) return true;
    return d.trailing === "both" || (d.trailing === "slash") === slash;
  }
  return (
    slash &&
    d.picks === "find-my-way" &&
    d.slashes === "strict" &&
    d.trailing === undefined &&
    r.length === c.length + 1 &&
    takesEmpty(last!, s.patterns) &&
    pathsMatch(joinRoute(...r.slice(0, -1)), path, s.patterns)
  );
}

/**
 * The form Next.js serves a path at: without the `/` (`removed`), or as `addedForm` says (`added`). A last segment with
 * a value in it may name a file or not, so either form is taken there.
 */
function nextForm(d: Dispatch, path: string, slash: boolean): boolean {
  if (d.slashes === "removed") return !slash;
  const form = addedForm(path);
  return form === undefined || form === slash;
}

/** The slash rules under which a router answers a request no route takes as written with a redirect to the other form. */
const REDIRECTING = new Set<Dispatch["slashes"]>(["redirected", "removed", "added"]);

/**
 * Whether route `a` comes before route `b` in registration order: within the same sequence of registrations at the
 * first step where they differ. Undefined where atlas knows no order between them.
 */
function before(a: Dispatch["order"], b: Dispatch["order"]): boolean | undefined {
  if (!a || !b) return undefined;
  for (let i = 0; i < Math.min(a.length, b.length); i++) {
    if (a[i]!.router !== b[i]!.router) return undefined;
    if (a[i]!.at !== b[i]!.at) return a[i]!.at < b[i]!.at;
  }
  return undefined;
}

/**
 * find-my-way's order of what a segment starts with (lib/node.js `getNextNode`, `createParametricChild`): static text
 * (0, or 1 with a parameter after it), a parameter with a regexp (2), one without (3), the wildcard (4). Two segments of
 * one kind with different keys sit on different nodes, whose order atlas does not settle.
 */
function fmwSegments(s: Surface): Array<{ kind: number; key: string }> {
  return segments(s.path).map((seg) => {
    if (isCatchAll(seg)) return { kind: 4, key: "" };
    if (isFixed(seg)) return { kind: 0, key: seg };
    if (isParam(seg)) {
      const own = patternOf(s.patterns, paramName(seg));
      return own === undefined ? { kind: 3, key: "" } : { kind: 2, key: own };
    }
    return seg.startsWith("{") ? { kind: 2, key: seg } : { kind: 1, key: seg };
  });
}

/** Below zero where find-my-way tries route `a` before `b` for a request both take, zero where that is not settled. */
function fmwCompare(a: Surface, b: Surface): number {
  const x = fmwSegments(a);
  const y = fmwSegments(b);
  for (let i = 0; i < Math.min(x.length, y.length); i++) {
    if (x[i]!.kind !== y[i]!.kind) return x[i]!.kind - y[i]!.kind;
    if (x[i]!.key !== y[i]!.key) return 0;
  }
  return 0;
}

/**
 * Whether a route takes every request a call stands for: by its path, or where find-my-way gives the empty text after
 * the call's last `/` to the route's last parameter, by the path before that parameter.
 */
function covers(d: Surface, call: Call): boolean {
  if (pathCovers(d.path, call.path, d.patterns)) return true;
  const r = segments(d.path);
  return !!call.slash && r.length === segments(call.path).length + 1 && takes(d, call.path, true) && pathCovers(joinRoute(...r.slice(0, -1)), call.path, d.patterns);
}

/**
 * Nest's `RouteSpecificitySorter.comparePathSpecificity` (@nestjs/core 12): segment by segment, the lower kind first
 * (see `nestSpecificity`); where one path has no segment left, it counts as `end` (1), or as `missing` (5) where it has
 * a wildcard. Undefined where either route's kinds are not read.
 */
function nestCompare(a: number[] | undefined, b: number[] | undefined): number | undefined {
  if (!a || !b) return undefined;
  const endOf = (k: number[]) => (k.includes(4) ? 5 : 1);
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    const x = a[i] ?? endOf(a);
    const y = b[i] ?? endOf(b);
    if (x !== y) return x - y;
  }
  return 0;
}

/**
 * Werkzeug's order of two rules a request both fits (routing/matcher.py `StateMachineMatcher.match`): part by part, as
 * the matcher walks its states, the static text of a part before its variables, and parts with variables by their
 * weight (`Weighting`, sorted in `update`), the same part (one regex and weight) sharing its state. Below zero where `a`
 * comes first, above where `b` does, zero where they share every part read or the order is not settled: two parts of
 * one weight with other regexes are tried in the order their rules were added, which atlas does not read.
 */
export function werkzeugCompare(a: Dispatch["parts"], b: Dispatch["parts"]): number {
  if (!a || !b) return 0;
  for (let i = 0; i < Math.min(a.length, b.length); i++) {
    const x = a[i]!;
    const y = b[i]!;
    if (typeof x === "string" || typeof y === "string") {
      if (typeof x === "string" && typeof y === "string" && x === y) continue;
      return typeof x === "string" && typeof y === "string" ? 0 : typeof x === "string" ? -1 : 1;
    }
    if (x.regex === y.regex && JSON.stringify(x.weight) === JSON.stringify(y.weight)) continue;
    return x.weight && y.weight ? compare(x.weight, y.weight) : 0;
  }
  return 0;
}

/**
 * Whether route `d` comes before route `c` for a request both take, where both are picked by one rule: find-my-way's
 * precedence; Werkzeug's; Nest's specificity, then its declaration order; or registration order. A route that may pass
 * the request on comes before none.
 */
function first(d: Surface, c: Surface): boolean {
  const a = d.dispatch;
  const b = c.dispatch;
  if (!a?.picks || a.picks !== b?.picks) return false;
  if (a.picks === "find-my-way") return fmwCompare(d, c) < 0;
  if (a.picks === "werkzeug") return werkzeugCompare(a.parts, b.parts) < 0;
  if (a.passes) return false;
  if (a.picks === "specificity") {
    const k = nestCompare(a.rank, b.rank);
    if (k === undefined) return false;
    if (k !== 0) return k < 0;
  }
  return before(a.order, b.order) === true;
}

/**
 * Whether a route surely takes a call in the form it is written: where its router's rule for a trailing `/` is read,
 * as `takes` found; where it is not, only a call without one to a route written without one, which every rule serves.
 */
const formSettled = (d: Surface, call: Call): boolean => d.dispatch?.slashes !== undefined || (!call.slash && !d.dispatch?.trailing);

/** Whether route `d` answers every request a call stands for that route `c` also takes, so that `c` is never reached by it. */
function beats(d: Surface, c: Surface, call: Call): boolean {
  return covers(d, call) && formSettled(d, call) && first(d, c);
}

/**
 * Of the routes a request fits, those its router may pick, by registration order or find-my-way's precedence where
 * each route's `dispatch` says so, for each method a request of unknown method may have.
 */
function picked(call: Call, candidates: Candidate[]): Candidate[] {
  if (!candidates.some((c) => c.surface.dispatch?.picks)) return candidates;
  const named = [...new Set(candidates.map((c) => c.surface.method).filter((m) => m !== "*"))];
  const methods = call.method === "*" ? [...named, "*"] : [call.method.toUpperCase()];
  const out = new Map<number, Candidate>();
  for (const method of methods) {
    const group = candidates.filter((c) => c.surface.method === method || c.surface.method === "*");
    for (const c of group) if (!group.some((d) => d !== c && beats(d.surface, c.surface, call))) out.set(c.index, c);
  }
  return [...out.values()].sort((a, b) => a.index - b.index);
}

/**
 * Routes no request reaches, by index, with the route that takes their requests: one of the same router, of the same
 * method or any, that comes first (`first`) and takes every request the later one fits (`/users/:id` registered before
 * `/users/me`). Only a route of literal segments and plain parameters is weighed.
 */
export function shadowedRoutes(surfaces: Surface[]): Map<number, Surface> {
  const out = new Map<number, Surface>();
  surfaces.forEach((s, i) => {
    const d = s.dispatch;
    if ((d?.picks !== "registration" && d?.picks !== "specificity") || !d.order) return;
    const segs = segments(s.path);
    const plain = (seg: string) => isParam(seg) && seg !== "*" && paramName(seg) !== undefined && patternOf(s.patterns, paramName(seg)) === undefined;
    if (!segs.every((seg) => isFixed(seg) || plain(seg))) return;
    const request = joinRoute(...segs.map((seg) => (isFixed(seg) ? seg : HOLE)));
    const forms = d.slashes === undefined || d.slashes === "ignored" ? [false] : d.trailing === "both" ? [false, true] : [d.trailing === "slash"];
    const by = surfaces.find(
      (t) =>
        t !== s &&
        t.component === s.component &&
        (t.method === s.method || t.method === "*") &&
        t.dispatch?.slashes !== undefined &&
        first(t, s) &&
        forms.every((f) => takes(t, request, f)) &&
        pathCovers(t.path, request, t.patterns),
    );
    if (by) out.set(i, by);
  });
  return out;
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
  /**
   * Calls their router answers with a redirect to the same path with the `/` at its end added or removed (Next.js's
   * `trailingSlash`, Starlette's `redirect_slashes`), keyed by the call's index, with the path redirected to and the
   * routes that serve it: the request reaches them only as the client follows the redirect, so it is not matched to
   * them. A call with interpolations may also reach routes directly, for the values a route takes as written.
   */
  redirected: Map<number, { path: string; slash: boolean; surfaces: Surface[] }>;
  /**
   * Calls that fit routes their router takes only where the request's headers meet a constraint (Fastify's
   * `constraints`), keyed by the call's index, with those routes: a call's headers are not read, so it is matched to none
   * of them.
   */
  constrained: Map<number, Surface[]>;
}

export function matchCalls(graph: Pick<Graph, "surfaces" | "calls">, ranked: Map<string, Ranking> = new Map()): Matches {
  const callersOf = new Map<number, Call[]>();
  const targetsOf = new Map<number, Surface[]>();
  const unsettled = new Map<number, Surface[]>();
  const slashless = new Map<number, Surface[]>();
  const redirected = new Map<number, { path: string; slash: boolean; surfaces: Surface[] }>();
  const constrained = new Map<number, Surface[]>();
  const push = <T>(map: Map<number, T[]>, key: number, value: T) => (map.get(key) ?? map.set(key, []).get(key)!).push(value);
  const appending = new Set(graph.surfaces.filter((s) => s.dispatch?.slashes === "appended").map((s) => s.component));
  graph.calls.forEach((call, ci) => {
    // Next.js settles the route by the path first; the method is checked on that route only. Each request a call stands
    // for goes to the most specific path that fits it, so a call with interpolations reaches every path down to the
    // first that takes any value they may hold, and none after it. A path is not reached either where a more specific
    // one takes every request the call and it share: `/{a}/new` meets `/editor/{id}` only in `/editor/new`.
    let paths: Set<string> | undefined;
    if (ranked.get(call.to) === "next") {
      const fits = [...new Set(graph.surfaces.filter((s) => s.component === call.to && pathsMatch(s.path, call.path, s.patterns)).map((s) => s.path))];
      fits.sort((a, b) => compare(nextRank(a), nextRank(b)));
      const covering = fits.findIndex((p) => pathCovers(p, call.path));
      const before = covering < 0 ? fits : fits.slice(0, covering + 1);
      paths = new Set(before.filter((p, i) => !fits.slice(0, i).some((q) => pathCovers(q, narrowedPath(p, call.path)))));
    }
    // Where a route's router rule is not read: Starlette redirects a path no route matches, by any method, to the same
    // path with a `/` added; a route ending in `{name:path}` takes that with the segment empty. A call with
    // interpolations may name the path the redirect serves, as the route spells it where the call does not; only a
    // route that surely matches that path keeps it from being redirected.
    const redirectedTo = (surface: Surface): boolean => {
      const bare = slashRedirectPath(surface.path);
      if (bare === undefined || !pathsMatch(bare, call.path, surface.patterns)) return false;
      const served = narrowedPath(bare, call.path);
      return !graph.surfaces.some((s) => s.component === call.to && pathCovers(s.path, served, s.patterns));
    };
    // A wildcard's required `/` (`trailing`) holds whether or not the router's own rule for a trailing `/` is read.
    const fits = (surface: Surface, slash: boolean): boolean =>
      surface.dispatch?.slashes || surface.dispatch?.trailing ? takes(surface, call.path, slash) : pathsMatch(surface.path, call.path, surface.patterns) || redirectedTo(surface);
    // Spring serves a HEAD request with a GET mapping when no HEAD mapping fits better (`RequestMethodsRequestCondition`).
    const headByGet = ranked.get(call.to) === "spring" && call.method.toUpperCase() === "HEAD";
    const candidatesAt = (slash: boolean): Candidate[] => {
      const out: Candidate[] = [];
      graph.surfaces.forEach((surface, si) => {
        if (surface.component !== call.to) return;
        if (paths && !paths.has(surface.path)) return;
        // What the framework answers by itself beside a GET (HEAD, OPTIONS) is reached only by a request that names that
        // method; a route it serves with no handler of the app's (a file, its error page) is reached as any route is.
        if (surface.implicit && (surface.method === "HEAD" || surface.method === "OPTIONS") && call.method.toUpperCase() !== surface.method) return;
        if (!methodsMatch(surface.method, call.method) && !(headByGet && surface.method === "GET")) return;
        if (fits(surface, slash)) out.push({ surface, index: si });
      });
      return out;
    };
    const slash = !!call.slash;
    let candidates = candidatesAt(slash);
    // Werkzeug answers a request without a trailing `/` with a redirect to the path with it, where a route written with
    // one takes that (`strict_slashes`), as its matcher reaches the state of the path without the `/`: unless a route of
    // that same path takes the request, or one the matcher tries earlier does (`StateMachineMatcher.match` raises
    // `SlashRequired`, which ends the walk). A call with values may be redirected for some and served for others.
    if (!slash && call.path !== "/" && appending.has(call.to)) {
      const branches = candidatesAt(true).filter((c) => c.surface.dispatch?.slashes === "appended" && c.surface.dispatch.trailing === "slash");
      if (branches.length) {
        const sameMethod = (a: Surface, b: Surface) => a.method === b.method || a.method === "*" || b.method === "*";
        // Which the matcher reaches first: the redirect (true), the route (false), or not settled (undefined).
        const redirectFirst = (b: Surface, d: Surface): boolean | undefined => {
          if (d.dispatch?.picks !== "werkzeug") return undefined;
          const k = werkzeugCompare(b.dispatch!.parts, d.dispatch.parts);
          if (k) return k < 0;
          return JSON.stringify(b.dispatch!.parts) === JSON.stringify(d.dispatch.parts) && b.dispatch!.parts ? false : undefined;
        };
        const redirects = branches.filter((b) => !candidates.some((d) => sameMethod(b.surface, d.surface) && covers(d.surface, call) && redirectFirst(b.surface, d.surface) === false));
        candidates = candidates.filter((d) => !branches.some((b) => sameMethod(b.surface, d.surface) && pathCovers(b.surface.path, call.path, b.surface.patterns) && redirectFirst(b.surface, d.surface) === true));
        if (redirects.length) {
          const to = picked({ ...call, slash: true }, redirects);
          redirected.set(ci, { path: call.path, slash: true, surfaces: to.map((c) => c.surface) });
        }
        if (!candidates.length) return;
      }
    }
    // A router that redirects answers a request no route of it takes as written, by any method, with a redirect to the
    // path with the `/` added or removed, where a route of it takes that path.
    const redirecting = graph.surfaces.filter((s) => s.component === call.to && REDIRECTING.has(s.dispatch?.slashes));
    // A call with interpolations may hold values a route takes as written and others none does, which are redirected.
    const direct = redirecting.length && call.path !== "/" ? graph.surfaces.filter((s) => s.component === call.to && fits(s, slash)) : undefined;
    if (direct && !direct.some((s) => pathCovers(s.path, call.path, s.patterns))) {
      const other = candidatesAt(!slash).filter((c) => REDIRECTING.has(c.surface.dispatch?.slashes));
      const reach = picked(call, other.filter((c) => !c.surface.dispatch?.constrained));
      if (reach.length) redirected.set(ci, { path: call.path, slash: !slash, surfaces: reach.map((c) => c.surface) });
      if (!direct.length) return;
    }
    // A route taken only with a header atlas does not read is not a target, nor does it keep another from being one.
    const held = candidates.filter((c) => c.surface.dispatch?.constrained);
    if (held.length) {
      constrained.set(ci, held.map((c) => c.surface));
      candidates = candidates.filter((c) => !c.surface.dispatch?.constrained);
    }
    // The rules a document gives apply to routes whose router's rules are not read.
    const coded = candidates.some((c) => c.surface.dispatch);
    const reach = ranked.get(call.to) === "spring" ? reached(call, candidates, ranked) : coded || ranked.has(call.to) ? picked(call, candidates) : concreteFirst(call, exactFirst(call, candidates));
    // A method that is not read would pick among routes that take different ones; which it picks is not read either.
    if (call.method === "*" && new Set(reach.map((c) => c.surface.method)).size > 1) {
      unsettled.set(ci, reach.map((c) => c.surface));
      return;
    }
    for (const { surface, index: si } of reach) {
      if (!surface.dispatch?.slashes && slashLeftOut(call, surface)) {
        push(slashless, ci, surface);
        continue;
      }
      push(callersOf, si, call);
      push(targetsOf, ci, surface);
    }
  });
  return { callersOf, targetsOf, unsettled, slashless, redirected, constrained };
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

/** What `redirected` holds, as limits: the call, where it is, the path it is redirected to and the routes there. */
export function redirectedLimits(graph: Pick<Graph, "calls">, redirected: Matches["redirected"]): string[] {
  return [...redirected].map(([ci, { path, slash, surfaces }]) => {
    const c = graph.calls[ci]!;
    const to = slash ? `${path}/` : path;
    const routes = [...new Set(surfaces.map((s) => `${s.method === "*" ? "any method" : s.method} ${s.path}`))].join(", ");
    return `calls ${c.from}->${c.to}: ${c.method} ${c.path}${c.slash ? "/" : ""} at ${c.at.file}:${c.at.line} is answered with a redirect to ${to}, which ${routes} serves; it reaches that route only as its client follows the redirect, so it is matched to none`;
  });
}

/** What `constrained` holds, as limits: the call, where it is, and the routes that take it only with a header. */
export function constrainedLimits(graph: Pick<Graph, "calls">, constrained: Matches["constrained"]): string[] {
  return [...constrained].map(([ci, surfaces]) => {
    const c = graph.calls[ci]!;
    const routes = [...new Set(surfaces.map((s) => `${s.method === "*" ? "any method" : s.method} ${s.path} (${s.at.file}:${s.at.line})`))].join(", ");
    return `calls ${c.from}->${c.to}: ${c.method} ${c.path}${c.slash ? "/" : ""} at ${c.at.file}:${c.at.line} fits ${routes}, which its router takes only where the request's headers meet the constraints the route's options give (or may give, where they are not spelled out); the call's headers are not read, so it is not matched to them`;
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
