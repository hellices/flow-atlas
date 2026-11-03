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
 * A leading interpolation followed by `/` is taken as a base address (`${baseUrl}/orders`).
 */
export function callPath(text: string): CallPath | undefined {
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
  if (!PATHLIKE.test(s) || FILE_EXT.test(s)) return undefined;
  if (s.split("/").filter(Boolean).every((seg) => seg === HOLE)) return undefined;
  return { path: s.replace(/\/+$/, ""), based };
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

/** A route segment `:id`/`{id}` matches anything; a call segment's interpolations match any text, its fixed text must agree. */
/** A last route segment that takes the rest of the path, none or many segments: Spring's `{*rest}` and `**`. */
const isCatchAll = (seg: string | undefined): boolean => seg === "**" || (!!seg && seg.startsWith("{*") && seg.endsWith("}"));

/** A segment with a wildcard inside it (`*.txt`, `v*`): `*` stands for any text within the segment, `{x}` for some. */
function segmentPattern(seg: string): RegExp {
  const body = seg
    .split(/(\{[^}]*\}|\*)/)
    .map((p) => (p === "*" ? "[^/]*" : p.startsWith("{") ? "[^/]+" : p.replace(/[.+?^$()|[\]\\]/g, "\\$&")))
    .join("");
  return new RegExp(`^${body}$`);
}

export function pathsMatch(routePath: string, call: string): boolean {
  let r = segments(routePath);
  let c = segments(call);
  if (isCatchAll(r[r.length - 1])) {
    r = r.slice(0, -1);
    if (c.length < r.length) return false;
    c = c.slice(0, r.length);
  }
  if (r.length !== c.length) return false;
  return r.every((seg, i) => {
    const part = c[i]!;
    if (isParam(seg) || seg === part) return true;
    if (isHole(part)) return holeMatches(part, seg);
    return seg.includes("*") && segmentPattern(seg).test(part);
  });
}

export function methodsMatch(a: string, b: string): boolean {
  return a === "*" || b === "*" || a.toUpperCase() === b.toUpperCase();
}

export function firstLiteral(path: string): string | undefined {
  return segments(path).find((s) => !isParam(s) && !isHole(s));
}
