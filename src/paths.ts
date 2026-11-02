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
  const absolute = s.match(/^https?:\/\/[^/]+(\/.*)$/);
  if (absolute?.[1]) {
    s = absolute[1];
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

/** A call segment with an interpolation, as a pattern: `{}` matches any text, the fixed text around it must match. */
function holePattern(seg: string): RegExp {
  const body = seg
    .split(HOLE)
    .map((part) => part.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"))
    .join(".*");
  return new RegExp(`^${body}$`);
}

/** A route segment `:id`/`{id}` matches anything; a call segment's interpolations match any text, its fixed text must agree. */
export function pathsMatch(routePath: string, call: string): boolean {
  const r = segments(routePath);
  const c = segments(call);
  if (r.length !== c.length) return false;
  return r.every((seg, i) => {
    const part = c[i]!;
    if (isParam(seg) || seg === part) return true;
    return isHole(part) && holePattern(part).test(seg);
  });
}

export function methodsMatch(a: string, b: string): boolean {
  return a === "*" || b === "*" || a.toUpperCase() === b.toUpperCase();
}

export function firstLiteral(path: string): string | undefined {
  return segments(path).find((s) => !isParam(s) && !isHole(s));
}
