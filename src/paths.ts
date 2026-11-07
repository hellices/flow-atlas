import { isIP } from "node:net";

/** Placeholder written where a call site interpolates a value into a path. */
export const HOLE = "{}";

const PATHLIKE = /^\/[A-Za-z0-9_\-.~{}:@%]*(\/[A-Za-z0-9_\-.~{}:@%]*)*\/?$/;
const FILE_EXT = /\.(ts|tsx|js|mjs|cjs|json|ya?ml|md|png|jpe?g|svg|gif|webp|css|html|kt|kts|py|txt|xml|gradle)$/i;

export interface CallPath {
  path: string;
  based: boolean;
}

/**
 * Turns a string a call site builds into a request path, or rejects it.
 * A leading interpolation followed by `/` is taken as a base address (`${baseUrl}/orders`). A path ending in a file
 * extension names a file, unless `served` says a route of the target serves it (`@GetMapping("/vets.html")`).
 */
export function callPath(text: string, served?: (path: string) => boolean): CallPath | undefined {
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
  if (!s.startsWith("/") || s === "/" || s.startsWith("//")) return undefined;
  if (!PATHLIKE.test(s) || (FILE_EXT.test(s) && !served?.(s))) return undefined;
  if (s.split("/").filter(Boolean).every((seg) => seg === HOLE)) return undefined;
  return { path: s.replace(/\/+$/, ""), based };
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

const isParam = (seg: string): boolean => seg.startsWith(":") || (seg.startsWith("{") && seg.endsWith("}")) || seg === "*";
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
const isCatchAll = (seg: string | undefined): boolean => seg === "**" || (!!seg && seg.startsWith("{*") && seg.endsWith("}"));

/**
 * A last route segment Starlette's `path` converter takes: `.*` after the `/` written before it, so any text, none
 * included, after that `/`. A mount is compiled as its path with `/{path:path}` joined. A route with one before its end
 * is not read.
 */
const isStarletteRest = (seg: string | undefined): boolean => !!seg && /^\{\w+:path\}$/.test(seg);

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

/**
 * Whether a route parameter takes a call segment: a fixed one by its convertor's regex; one with interpolations, or
 * any against a convertor registered elsewhere, which is not read, may be taken.
 */
function paramTakes(seg: string, part: string): boolean {
  const convertor = convertorOf(seg);
  if (convertor === undefined || isHole(part) || !Object.hasOwn(CONVERTORS, convertor)) return true;
  return CONVERTORS[convertor]!.test(part);
}

/** Whether a route segment takes every segment an interpolation may hold. */
const takesAny = (seg: string): boolean =>
  isCatchAll(seg) || isStarletteRest(seg) || (isParam(seg) && (convertorOf(seg) === undefined || convertorOf(seg) === "str"));

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
const isFixed = (seg: string): boolean => !isParam(seg) && !/[{}*]/.test(seg);

/**
 * Whether a route matches every request a call's path stands for, not only some: where the call interpolates a
 * segment, the route must take any segment there, and a convertor that is not read settles no segment.
 */
export function pathCovers(routePath: string, call: string): boolean {
  if (!pathsMatch(routePath, call)) return false;
  const c = segments(call);
  return segments(routePath).every((seg, i) => {
    const part = c[i];
    if (part === undefined) return true;
    return isHole(part) ? takesAny(seg) : !unreadConvertor(seg);
  });
}

/** A segment with a wildcard inside it (`*.txt`, `v*`): `*` stands for any text within the segment, `{x}` for some. */
function segmentPattern(seg: string): RegExp {
  const body = seg
    .split(/(\{[^}]*\}|\*)/)
    .map((p) => (p === "*" ? "[^/]*" : p.startsWith("{") ? "[^/]+" : p.replace(/[.+?^$()|[\]\\]/g, "\\$&")))
    .join("");
  return new RegExp(`^${body}$`);
}

/**
 * A route segment `:id`/`{id}` matches anything, `{id:int}` what its convertor's regex takes; a call segment's
 * interpolations match any text, its fixed text must agree.
 */
export function pathsMatch(routePath: string, call: string): boolean {
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
    if (isParam(seg)) return paramTakes(seg, part);
    if (seg === part) return true;
    if (isHole(part)) return holeMatches(part, seg);
    // A wildcard or a variable inside a segment (`*.txt`, `{name}.txt`) matches the text around it.
    return (seg.includes("*") || /\{[^}]*\}/.test(seg)) && segmentPattern(seg).test(part);
  });
}

export function methodsMatch(a: string, b: string): boolean {
  return a === "*" || b === "*" || a.toUpperCase() === b.toUpperCase();
}

export function firstLiteral(path: string): string | undefined {
  return segments(path).find((s) => !isParam(s) && !isHole(s));
}
