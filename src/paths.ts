import { isIP } from "node:net";

/** Placeholder written where a call site interpolates a value into a path. */
export const HOLE = "{}";

const PATHLIKE = /^\/[A-Za-z0-9_\-.~{}:@%]*(\/[A-Za-z0-9_\-.~{}:@%]*)*\/?$/;
const FILE_EXT = /\.(ts|tsx|js|mjs|cjs|json|ya?ml|md|png|jpe?g|svg|gif|webp|css|html|kt|kts|py|txt|xml|gradle|log)$/i;

export interface CallPath {
  path: string;
  based: boolean;
  /** The text ends its path with a `/`, which `path` leaves out. */
  slash?: true;
}

/**
 * Turns a string a call site builds into a request path, or rejects it.
 * A leading interpolation followed by `/` is taken as a base address (`${baseUrl}/orders`).
 * The root path `/` is read only with `root`, where the string's place makes it a request: anywhere else a lone `/` is
 * a separator far more often than a URL. A path ending in a file extension names a file, unless `served` says a route
 * of the target serves it (`@GetMapping("/vets.html")`).
 */
export function callPath(text: string, root = false, served?: (path: string) => boolean): CallPath | undefined {
  let s = text.trim();
  let based = false;
  const lead = s.match(/^(?:\{\})+(?=\/)/);
  if (lead) {
    s = s.slice(lead[0].length);
    based = true;
  }
  // The authority ends at the first /, ? or #, so a query or fragment that holds a slash is not taken for the path.
  const absolute = s.match(/^https?:\/\/[^/?#]+(.*)$/);
  if (absolute) {
    s = absolute[1]!;
    based = true;
  }
  s = s.split("?")[0]!.split("#")[0]!;
  if (root && s === "/") return { path: "/", based };
  if (!s.startsWith("/") || s === "/" || s.startsWith("//")) return undefined;
  if (!PATHLIKE.test(s) || (FILE_EXT.test(s) && !served?.(s))) return undefined;
  if (s.split("/").filter(Boolean).every((seg) => seg === HOLE)) return undefined;
  return { path: s.replace(/\/+$/, ""), based, ...(s.endsWith("/") ? { slash: true as const } : {}) };
}

/**
 * A path written relative to a client's base, without a leading `/` (`users/${id}`), read as `callPath` reads a
 * root-relative one, with `relative` set; undefined for any other text. A path that starts with a value may be an
 * absolute URL, and one whose first segment holds a `:` is one (`mailto:`, RFC 3986 section 4.2), so neither is read.
 */
export function relativePath(text: string, served?: (path: string) => boolean): (CallPath & { relative: true }) | undefined {
  const s = text.trim().split("?")[0]!.split("#")[0]!;
  if (!s || s.startsWith("/") || s.startsWith(HOLE) || s.split("/")[0]!.includes(":")) return undefined;
  const parsed = callPath(`/${s}`, false, served);
  return parsed && !parsed.based ? { ...parsed, relative: true } : undefined;
}

/**
 * How a client joins a path to its base URL. `append`: the base's path, one `/`, and the path with its leading `/`
 * dropped, as axios's `combineURLs`, Ky's `prefix` and RTK Query's `joinUrls` write it. `resolve`: as RFC 3986 (section
 * 5.2) resolves a reference against the base, as `new URL(path, base)`, .NET's `Uri`, OkHttp's `HttpUrl.resolve`
 * (Retrofit) and Python's `urljoin` do: a path that starts with `/` replaces the base's path, any other replaces what
 * follows its last `/`.
 */
export type Join = "resolve" | "append";

/** A client's base: the path of its base URL as written, a trailing `/` kept, and how a path joins it. */
export interface Base {
  path: string;
  join: Join;
}

/**
 * The path a request goes to, written `path` (relative to the base where `relative`, else from the root) on a client
 * with `base`. Dot segments are removed either way, as parsing the URL that results does.
 */
export function onBase(base: Base, path: string, relative = false): string {
  const written = relative ? path.replace(/^\/+/, "") : path;
  if (base.join === "append") return resolveReference("/", joinRoute(base.path, written));
  return resolveReference(base.path.startsWith("/") ? base.path : `/${base.path}`, written);
}

/**
 * The host (with its port, lower-cased, default ports dropped) an absolute `http` or `https` URL names literally;
 * undefined for any other text, and for a host that is a value written into the URL (`https://${host}/x`). A literal
 * host the URL standard rejects (`127.999.999.999`) is returned as written, lower-cased: it names no server.
 */
export function hostOf(text: string): string | undefined {
  const m = text.trim().match(/^(https?):\/\/(?:[^/?#@]*@)?([^/?#]+)/i);
  if (!m || m[2]!.includes(HOLE)) return undefined;
  try {
    return new URL(`${m[1]}://${m[2]}`).host;
  } catch {
    return m[2]!.toLowerCase();
  }
}

/** Whether a host is a loopback address, the machine the client runs on: `localhost`, 127.0.0.0/8 or `[::1]`. */
export function isLoopback(host: string): boolean {
  const name = host.replace(/:\d+$/, "");
  return name === "localhost" || name === "[::1]" || (isIP(name) === 4 && name.startsWith("127."));
}

/**
 * A relative reference resolved against the path of the page it is on, as RFC 3986 (section 5.2) resolves one: an empty
 * path is the page's own, one starting with `/` is the path itself, any other replaces the page path's last segment,
 * and `.` and `..` segments are removed. A query or fragment after the path is kept.
 */
export function resolveReference(page: string, reference: string): string {
  const end = reference.search(/[?#]/);
  const path = end < 0 ? reference : reference.slice(0, end);
  const rest = end < 0 ? "" : reference.slice(end);
  if (!path) return `${page}${rest}`;
  const merged = (path.startsWith("/") ? path : `${page.slice(0, page.lastIndexOf("/") + 1)}${path}`).split("/").slice(1);
  const out: string[] = [];
  merged.forEach((seg, i) => {
    const last = i === merged.length - 1;
    if (seg === "..") out.pop();
    if (seg === "." || seg === "..") {
      if (last) out.push("");
    } else out.push(seg);
  });
  return `/${out.join("/")}${rest}`;
}

export function joinRoute(...parts: string[]): string {
  const joined = parts
    .map((p) => p.replace(/^\/+|\/+$/g, ""))
    .filter(Boolean)
    .join("/");
  return `/${joined}`;
}

/**
 * A route as an OpenAPI path template: `:id` and `:id?` become `{id}`, so the same route reads the same whether Nest,
 * Express, Fastify or FastAPI registered it, and joins an OpenAPI `paths` key or a normalized OpenTelemetry `http.route`.
 */
export function routeTemplate(path: string): string {
  return path
    .split("/")
    .map((seg) => seg.replace(/^:([A-Za-z_][A-Za-z0-9_]*)\??$/, "{$1}"))
    .join("/");
}

/** A segment that is one parameter whole: `:id`, `{id}`, `{id:int}`, or a lone `*`; `{from}-{to}` is a pattern of its own. */
export const isParam = (seg: string): boolean => seg.startsWith(":") || /^\{[^{}]*\}$/.test(seg) || seg === "*";
const isHole = (seg: string): boolean => seg.includes(HOLE);

export function segments(path: string): string[] {
  return path.split("/").filter(Boolean);
}

/**
 * Whether a call segment with interpolations matches a route segment: each `{}` stands for any text, and the fixed
 * pieces must appear in order, the first at the start and the last at the end. Taking each middle piece at its leftmost
 * place is enough for `*`-only patterns, so the check never backtracks.
 */
export function holeMatches(pattern: string, text: string): boolean {
  const parts = pattern.split(HOLE);
  const first = parts[0]!;
  const last = parts[parts.length - 1]!;
  if (text.length < first.length + last.length || !text.startsWith(first) || !text.endsWith(last)) return false;
  let at = first.length;
  const end = text.length - last.length;
  for (const part of parts.slice(1, -1)) {
    const found = text.indexOf(part, at);
    if (found === -1 || found + part.length > end) return false;
    at = found + part.length;
  }
  return true;
}

/** A last route segment that takes the rest of the path, none or many segments: Spring's `{*rest}` and `**`. */
export const isCatchAll = (seg: string | undefined): boolean => seg === "**" || (!!seg && seg.startsWith("{*") && seg.endsWith("}"));

/**
 * A last route segment Starlette's `path` converter takes: `.*` after the `/` written before it, so any text, none
 * included, after that `/`. A mount is compiled as its path with `/{path:path}` joined. A route with one before its end
 * is not read.
 */
export const isStarletteRest = (seg: string | undefined): boolean => !!seg && /^\{\w+:path\}$/.test(seg);

/** The regex of each of Starlette's one-segment convertors (`starlette/convertors.py`). */
const CONVERTORS: Record<string, RegExp> = {
  str: /^[^/]+$/,
  int: /^[0-9]+$/,
  float: /^[0-9]+(\.[0-9]+)?$/,
  uuid: /^[0-9a-fA-F]{8}-?[0-9a-fA-F]{4}-?[0-9a-fA-F]{4}-?[0-9a-fA-F]{4}-?[0-9a-fA-F]{12}$/,
};

/** The convertor a Starlette parameter names (`{id:int}`), or undefined for a parameter that names none. */
const convertorOf = (seg: string): string | undefined => /^\{\w+:(\w+)\}$/.exec(seg)?.[1];

/** Whether a parameter names a convertor that is not read: one registered elsewhere (`register_url_convertor`). */
const unreadConvertor = (seg: string): boolean => {
  const convertor = convertorOf(seg);
  return convertor !== undefined && convertor !== "path" && !Object.hasOwn(CONVERTORS, convertor);
};

/** The name of a parameter that is a segment whole, `{id}`; undefined for a convertor's (`{id:int}`) or a catch-all. */
export const paramName = (seg: string): string | undefined => /^\{([^{}:*]+)\}$/.exec(seg)?.[1];

/** The regular expressions a route's parameters must match, by name (`Surface.patterns`). */
export type Patterns = Record<string, string> | undefined;

/** The regexp a parameter must match, read as an own property only: `constructor` names a parameter, not a method. */
export const patternOf = (patterns: Patterns, name: string | undefined): string | undefined =>
  patterns && name !== undefined && Object.hasOwn(patterns, name) ? patterns[name] : undefined;

/** A regular expression of a route, compiled once; one the runtime cannot compile settles nothing. */
const compiled = new Map<string, RegExp | null>();
function regexOf(source: string): RegExp | null {
  if (!compiled.has(source)) {
    try {
      compiled.set(source, new RegExp(source));
    } catch {
      compiled.set(source, null);
    }
  }
  return compiled.get(source)!;
}

/**
 * Whether a route parameter takes a call segment: a fixed one by its convertor's regex or the regexp its router tests
 * it with; one with interpolations, or any against a convertor registered elsewhere, which is not read, may be taken.
 */
function paramTakes(seg: string, part: string, patterns: Patterns): boolean {
  if (isHole(part)) return true;
  const own = patternOf(patterns, paramName(seg));
  if (own !== undefined) return regexOf(`^(?:${own})$`)?.test(part) ?? true;
  const convertor = convertorOf(seg);
  if (convertor === undefined || !Object.hasOwn(CONVERTORS, convertor)) return true;
  return CONVERTORS[convertor]!.test(part);
}

/** Whether a route segment takes every segment an interpolation may hold: not a parameter its router tests by a regexp. */
const takesAny = (seg: string, patterns: Patterns): boolean =>
  isCatchAll(seg) ||
  isStarletteRest(seg) ||
  (isParam(seg) && (convertorOf(seg) === undefined || convertorOf(seg) === "str") && patternOf(patterns, paramName(seg)) === undefined);

/**
 * The path a route ending in Starlette's `{name:path}` serves with that segment left out, with a `/` after it, or
 * undefined for any other route. Starlette's router redirects a path no route matches to the same path with a `/`
 * added, when a route matches that (FastAPI's `redirect_slashes`, on by default), so a request without the `/`
 * reaches it only then.
 */
export function slashRedirectPath(routePath: string): string | undefined {
  const r = segments(routePath);
  return isStarletteRest(r[r.length - 1]) ? joinRoute(...r.slice(0, -1)) : undefined;
}

/**
 * The requests a call stands for that also fit a route path it matches: each segment of the call with interpolations
 * where the route spells out the segment, as the route spells it.
 */
export function narrowedPath(routePath: string, call: string): string {
  const r = segments(routePath);
  return joinRoute(...segments(call).map((seg, i) => (isHole(seg) && r[i] !== undefined && isFixed(r[i]) ? r[i] : seg)));
}

/** A route segment written as plain text: no parameter, wildcard or brace pattern; a colon inside one is text. */
export const isFixed = (seg: string): boolean => !isParam(seg) && !/[{}*?]/.test(seg);

/**
 * Whether a route matches every request a call's path stands for, not only some: where the call interpolates a
 * segment, the route must take any segment there, and a convertor that is not read settles no segment.
 */
export function pathCovers(routePath: string, call: string, patterns?: Patterns): boolean {
  if (!pathsMatch(routePath, call, patterns)) return false;
  const c = segments(call);
  return segments(routePath).every((seg, i) => {
    const part = c[i];
    if (part === undefined) return true;
    return isHole(part) ? takesAny(seg, patterns) : !unreadConvertor(seg) && !unsettledPattern(seg, patterns);
  });
}

/**
 * Whether a route segment names a parameter whose regexp this runtime cannot compile (one written for another
 * engine): `pathsMatch` lets it take a segment, which may not be so, so it settles none.
 */
const unsettledPattern = (seg: string, patterns: Patterns): boolean =>
  [...seg.matchAll(/\{([^{}]*)\}/g)].some((m) => {
    const own = patternOf(patterns, m[1]);
    return own !== undefined && regexOf(`^(?:${own})$`) === null;
  });

/**
 * A segment that mixes text with a wildcard or parameters (`*.txt`, `t?st.html`, `{from}-{to}`): `*` stands for any
 * text within the segment, Spring's `?` for one character, `{x}` for some text, or what the regexp its router tests it
 * with takes. Where the regexp cannot be compiled here, the segment is not settled: undefined.
 */
function segmentPattern(seg: string, patterns: Patterns): RegExp | undefined {
  let unsettled = false;
  const body = seg
    .split(/(\{[^{}]*\}|\*|\?)/)
    .map((p) => {
      if (p === "*") return "[^/]*";
      if (p === "?") return "[^/]";
      if (!p.startsWith("{")) return p.replace(/[.+?^$()|[\]\\{}*]/g, "\\$&");
      const own = patternOf(patterns, p.slice(1, -1));
      if (own === undefined) return "[^/]+";
      if (!regexOf(own)) unsettled = true;
      return `(?:${own})`;
    })
    .join("");
  return unsettled ? undefined : (regexOf(`^${body}$`) ?? undefined);
}

/**
 * A route segment `:id`/`{id}` matches anything, `{id:int}` what its convertor's regex takes, and a parameter in
 * `patterns` what its regexp takes; a call segment's interpolations match any text, its fixed text must agree.
 */
export function pathsMatch(routePath: string, call: string, patterns?: Patterns): boolean {
  let r = segments(routePath);
  let c = segments(call);
  if (isCatchAll(r[r.length - 1])) {
    r = r.slice(0, -1);
    if (c.length < r.length) return false;
    c = c.slice(0, r.length);
  } else if (isStarletteRest(r[r.length - 1])) {
    r = r.slice(0, -1);
    if (c.length <= r.length) return false;
    c = c.slice(0, r.length);
  }
  if (r.length !== c.length) return false;
  return r.every((seg, i) => {
    const part = c[i]!;
    if (isParam(seg)) return paramTakes(seg, part, patterns);
    if (seg === part) return true;
    const compound = /[*?]|\{[^{}]*\}/.test(seg);
    if (isHole(part)) return compound ? endsMeet(seg, part) : holeMatches(part, seg);
    // A wildcard or a variable inside a segment (`*.txt`, `{name}.txt`) matches the text around it.
    if (!compound) return false;
    return segmentPattern(seg, patterns)?.test(part) ?? true;
  });
}

/**
 * Whether a route segment that mixes text with variables or wildcards may take a call segment with interpolations:
 * the fixed text each starts with must agree as far as both go, and so must the fixed text each ends with
 * (`{}.jpg` meets no `*.png`, `ICN-{}` meets `{from}-{to}`). What lies between is not compared, so it may.
 */
function endsMeet(seg: string, part: string): boolean {
  const route = seg.split(/\{[^{}]*\}|\*|\?/);
  const call = part.split(HOLE);
  const agree = (a: string, b: string, at: "start" | "end") => (at === "start" ? a.startsWith(b) || b.startsWith(a) : a.endsWith(b) || b.endsWith(a));
  return agree(route[0]!, call[0]!, "start") && agree(route[route.length - 1]!, call[call.length - 1]!, "end");
}

/**
 * Whether a parameter segment takes an empty segment, as find-my-way gives the empty text after a last `/` to a
 * parameter (`/users/:id` takes `/users/`): a parameter that is the segment whole, with no regexp or one that takes
 * empty text.
 */
export function takesEmpty(seg: string, patterns?: Patterns): boolean {
  if (!isParam(seg) || seg === "*" || convertorOf(seg) !== undefined) return false;
  const own = patternOf(patterns, paramName(seg) ?? (seg.startsWith(":") ? seg.slice(1) : undefined));
  return own === undefined || (regexOf(`^(?:${own})$`)?.test("") ?? false);
}

export function methodsMatch(a: string, b: string): boolean {
  return a === "*" || b === "*" || a.toUpperCase() === b.toUpperCase();
}

export function firstLiteral(path: string): string | undefined {
  return segments(path).find((s) => !isParam(s) && !isHole(s) && !/\{[^{}]*\}/.test(s));
}
