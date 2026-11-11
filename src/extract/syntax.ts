import type { Source } from "../source.js";

/**
 * The path syntax of the routers the express and nest styles read, each as its own source reads a path:
 *
 * - `path-to-regexp`: path-to-regexp 8, which Express 5 (through `router` 2) and @koa/router 14 and later compile each
 *   path with (`parse`, `flatten`, `toRegExpSource`): `:name` and `:"quoted name"` take the text up to the next `/`,
 *   `*name` one character or more, `/` included, `{...}` is optional (one path with it and one without), `\` escapes
 *   the next character, and `}()[]+?!` are rejected.
 * - `path-to-regexp-0.1`: Express 4's, which writes the path into a regular expression (see `readPathToRegexp01`).
 * - `express`: Express of a version not read, where its two syntaxes agree (see `readExpress`).
 * - `nest`: Nest on Express 5, whose adapter converts a path ending in `*`, `(.*)` or `+` first
 *   (`LegacyRouteConverter.tryConvert`) and hands it to path-to-regexp 8.
 * - `find-my-way`: Fastify's router (`Router.prototype.on` and `_on`): `:name` ends at `(`, `-`, `.` or `/`, `(...)`
 *   after it is a regexp its text must match within the segment, text after it up to the next `:` or `/` is static,
 *   `::` is a colon, `*` as the last character takes the rest of the path, none included, and a last `/:name?` is
 *   optional.
 * - `hono`: Hono's default router (SmartRouter of RegExpRouter and TrieRouter, `splitRoutingPath`, `getPattern`,
 *   `checkOptionalParameter`): a segment `:name` or `:name{regexp}` is a parameter, a `*` segment takes one segment,
 *   a final `/*` the rest of the path, none included, and a last `:name?` is optional.
 * - `plain`: a router whose syntax is not read; only literal text and whole segments `:name`, which every one of them
 *   reads alike, are read, and `why` says what is not.
 */
export type Syntax = { kind: "path-to-regexp" | "path-to-regexp-0.1" | "express" | "nest" | "find-my-way" | "hono" } | { kind: "plain"; why: string };

/**
 * A route path as atlas writes it, with the regular expression each parameter named in `patterns` must match, and
 * `trailing` where the path as written ends with a `/` (`/abcd/`): one without a wildcard is served with it, and one
 * ending in a wildcard that takes none or more segments after that `/` (`/x/*`) serves the path before the wildcard
 * only with it (see `Dispatch.trailing`).
 */
export interface RoutePath {
  path: string;
  patterns?: Record<string, string>;
  trailing?: "slash";
}

/** The paths a registration serves, or why it is not read; `rejected` where the router itself throws on the path. */
export type ReadPath = { paths: RoutePath[] } | { why: string; rejected?: true };

type Piece = { text: string } | { param: string; pattern?: string } | { star: true };
/** The end of a path that takes the rest of it: one segment or more (`min: 1`), or none or more. */
type Rest = { name?: string; min: 0 | 1 };
interface Variant {
  segments: Piece[][];
  rest?: Rest;
}
type Built = Variant | { why: string; rejected?: true };

const quote = (s: string): string => `\`${s}\``;

/** The most paths one registration is written as: path-to-regexp 8's limit on the combinations of a path. */
const MAX_PATHS = 256;

/**
 * The template a variant stands for: `{name}` for a parameter, wherever it stands in its segment; a final rest as
 * `{name}/**` (one segment or more), `{*name}` (none or more) or `**` (none or more, unnamed). Text that would read as
 * template syntax (`{`, `}`, `*`, `?`, or a `:` starting a segment) is not written.
 */
function write(v: Variant): RoutePath | { why: string } {
  // A Map, so a parameter named `constructor` or `__proto__` is a name like any other.
  const patterns = new Map<string, string>();
  const parts: string[] = [];
  const name = (n: string): string | undefined => (/^[^{}/:*?\s]+$/.test(n) ? undefined : `its parameter name ${quote(n)} cannot be written in a path template`);
  for (const seg of v.segments) {
    let out = "";
    for (const p of seg) {
      if ("text" in p) {
        if (/[{}*?]/.test(p.text) || (out === "" && p.text.startsWith(":"))) return { why: `its text ${quote(p.text)} would read as path syntax` };
        out += p.text;
      } else if ("param" in p) {
        const bad = name(p.param);
        if (bad) return { why: bad };
        if (p.pattern !== undefined) {
          if (patterns.has(p.param) && patterns.get(p.param) !== p.pattern) return { why: `two parameters named ${quote(p.param)} take different regexps` };
          patterns.set(p.param, p.pattern);
        }
        out += `{${p.param}}`;
      } else out += "*";
    }
    if (out) parts.push(out);
  }
  // Text that ends with a `/` (`/abcd/`, or the `/x/` before find-my-way's `*`) leaves an empty last segment.
  const slash = parts.length > 0 && v.segments.length > 1 && empty(v);
  if (v.rest) {
    const bad = v.rest.name === undefined ? undefined : name(v.rest.name);
    if (bad) return { why: bad };
    parts.push(v.rest.name === undefined ? "**" : v.rest.min === 1 ? `{${v.rest.name}}/**` : `{*${v.rest.name}}`);
  }
  return {
    path: `/${parts.join("/")}`,
    ...(patterns.size ? { patterns: Object.fromEntries(patterns) } : {}),
    ...(slash && (!v.rest || v.rest.min === 0) ? { trailing: "slash" as const } : {}),
  };
}

/**
 * The paths of all variants, each once: a path and the same path with a rest of one segment or more after it are one
 * path with a rest of none or more (`{/*rest}` is `{*rest}`).
 */
function finish(variants: Built[]): ReadPath {
  const written: RoutePath[] = [];
  for (const v of variants) {
    if ("why" in v) return v;
    const w = write(v);
    if ("why" in w) return w;
    const same = written.find((x) => x.path === w.path);
    // A path written with and without its trailing `/` is served at both: `trailing` is left out.
    if (!same) written.push(w);
    else if (same.trailing !== w.trailing) delete same.trailing;
  }
  const absorbed = new Set<string>();
  const out = written.map((w): RoutePath => {
    const m = /^(.*)\/\{([^{}*]+)\}\/\*\*$/.exec(w.path);
    const parent = m ? m[1] || "/" : undefined;
    const bare = written.find((x) => x.path === parent);
    if (!m || !bare) return w;
    absorbed.add(bare.path);
    const patterns = { ...bare.patterns, ...w.patterns };
    // The path without the rest is served as the bare path is: only with a `/` where that one is (`abcd/{*path}`).
    return { path: `${m[1]}/{*${m[2]}}`, ...(Object.keys(patterns).length ? { patterns } : {}), ...(bare.trailing ? { trailing: bare.trailing } : {}) };
  });
  return { paths: out.filter((w) => !absorbed.has(w.path)) };
}

/** Text split at `/` into the variant: what is before the first `/` joins the current segment. */
function addText(v: Variant, text: string): void {
  text.split("/").forEach((part, i) => {
    if (i > 0) v.segments.push([]);
    if (part) v.segments[v.segments.length - 1]!.push({ text: part });
  });
}

const empty = (v: Variant): boolean => v.segments[v.segments.length - 1]!.length === 0;

// path-to-regexp 8 (src/index.ts): the identifier characters of a parameter name.
const ID_START = /^[$_\p{ID_Start}]$/u;
const ID_CONTINUE = /^[$\u200c\u200d\p{ID_Continue}]$/u;

type Token = { type: "text"; value: string } | { type: "param" | "wildcard"; name: string } | { type: "group"; tokens: Token[] };

/** path-to-regexp 8's `parse`, with the errors it throws given as why the path is not read. */
function parseP2R(str: string): Token[] | { why: string; rejected: true } {
  const chars = [...str];
  let index = 0;
  const fail = (message: string) => ({ why: `path-to-regexp 8 rejects ${message}`, rejected: true as const });
  const until = (end: string): Token[] | { why: string; rejected: true } => {
    const output: Token[] = [];
    let path = "";
    const flush = () => {
      if (path) output.push({ type: "text", value: path });
      path = "";
    };
    while (index < chars.length) {
      const value = chars[index++]!;
      if (value === end) {
        flush();
        return output;
      }
      if (value === "\\") {
        if (index === chars.length) return fail("a `\\` at the end");
        path += chars[index++];
        continue;
      }
      if (value === ":" || value === "*") {
        let name = "";
        if (ID_START.test(chars[index] ?? "")) {
          do name += chars[index++];
          while (ID_CONTINUE.test(chars[index] ?? ""));
        } else if (chars[index] === '"') {
          let closed = false;
          while (index < chars.length) {
            if (chars[++index] === '"') {
              index++;
              closed = true;
              break;
            }
            if (chars[index] === "\\") index++;
            name += chars[index] ?? "";
          }
          if (!closed) return fail("an unterminated quote");
        }
        if (!name) return fail(`a ${quote(value)} with no parameter name`);
        flush();
        output.push({ type: value === ":" ? "param" : "wildcard", name });
        continue;
      }
      if (value === "{") {
        flush();
        const tokens = until("}");
        if (!Array.isArray(tokens)) return tokens;
        output.push({ type: "group", tokens });
        continue;
      }
      if ("})([]+?!".includes(value)) return fail(`an unexpected ${quote(value)}`);
      path += value;
    }
    if (end) return fail(`a ${quote("{")} not closed`);
    flush();
    return output;
  };
  return until("");
}

/**
 * path-to-regexp 8's `flatten`: each sequence of tokens a path's optional groups make. `pathToRegexp` throws on the
 * 257th ("Too many path combinations"), so the walk stops there: undefined.
 */
function flatten(tokens: Token[]): Array<Array<Exclude<Token, { type: "group" }>>> | undefined {
  const out: Array<Array<Exclude<Token, { type: "group" }>>> = [];
  let overflow = false;
  const walk = (list: Token[], index: number, result: Array<Exclude<Token, { type: "group" }>>, done: (r: Array<Exclude<Token, { type: "group" }>>) => void): void => {
    while (index < list.length && !overflow) {
      const token = list[index++]!;
      if (token.type === "group") {
        // The sequences with the group first, then the loop goes on without it.
        const len = result.length;
        const after = index;
        walk(token.tokens, 0, result, (seq) => walk(list, after, seq, done));
        result.length = len;
        continue;
      }
      result.push(token);
    }
    if (!overflow) done(result);
  };
  walk(tokens, 0, [], (seq) => {
    if (out.length >= MAX_PATHS) overflow = true;
    else out.push([...seq]);
  });
  return overflow ? undefined : out;
}

/**
 * A path in path-to-regexp 8's syntax. A wildcard is read where it is the whole end of the path, after a `/`: one
 * segment or more. Elsewhere it takes text across segments, which no template holds.
 */
export function readPathToRegexp(path: string): ReadPath {
  const tokens = parseP2R(path);
  if (!Array.isArray(tokens)) return tokens;
  const sequences = flatten(tokens);
  if (!sequences) return { why: `path-to-regexp 8 rejects more than ${MAX_PATHS} combinations of optional groups`, rejected: true };
  return finish(
    sequences.map((seq): Built => {
      const v: Variant = { segments: [[]] };
      let captured = false;
      let backtrack = "";
      for (let i = 0; i < seq.length; i++) {
        const t = seq[i]!;
        if (t.type === "text") {
          addText(v, t.value);
          backtrack += t.value;
          continue;
        }
        // `toRegExpSource`: a parameter or wildcard right after another, with no text between, is rejected.
        if (captured && !backtrack) return { why: `path-to-regexp 8 rejects ${quote(t.type === "param" ? `:${t.name}` : `*${t.name}`)} with no text before it`, rejected: true };
        captured = true;
        backtrack = "";
        if (t.type === "param") v.segments[v.segments.length - 1]!.push({ param: t.name });
        else if (i === seq.length - 1 && empty(v)) v.rest = { name: t.name, min: 1 };
        else return { why: `its wildcard ${quote(`*${t.name}`)} takes text across segments, not the whole end of the path` };
      }
      return v;
    }),
  );
}

/**
 * A path as Express 4 reads it (path-to-regexp 0.1, `index.js`), which writes the path into a regular expression with
 * only `:name` (`\\w+`), `.`, `*` and `\\` turned into their own: `/:name?` makes its segment optional, a final `/*`
 * takes the rest of the path, none included, and parameters may share a segment with text (`:from-:to`). Any other
 * character that means something in a regular expression (`?`, `+`, `(`, `[`, `{`, `|`, `^`, `$`) is read as one, and
 * a path holding one is not read; nor is a `*` elsewhere, or a parameter with its own regexp (`:id(\\d+)`).
 */
export function readPathToRegexp01(path: string): ReadPath {
  const why = { why: "Express 4 (path-to-regexp 0.1) writes it into a regular expression, which is not read" };
  const segs = path.split("/").slice(1);
  let variants: Variant[] = [{ segments: [] }];
  for (let i = 0; i < segs.length; i++) {
    const seg = segs[i]!;
    if (seg === "") continue;
    if (seg === "*" && i === segs.length - 1) {
      // The `/` before the `*` is text of the regular expression: `/files/*` takes `/files/`, not `/files`.
      variants = variants.map((v) => ({ segments: [...v.segments, []], rest: { min: 0 } }));
      continue;
    }
    const optional = /^:(\w+)\?$/.exec(seg);
    if (optional) {
      // Express compiles one regular expression; atlas writes a path per combination, as many as path-to-regexp 8 allows.
      if (variants.length * 2 > MAX_PATHS) return { why: `its optional segments make more than ${MAX_PATHS} paths, which atlas does not write` };
      variants = variants.flatMap((v) => [{ segments: [...v.segments, [{ param: optional[1]! }]] }, v]);
      continue;
    }
    const pieces: Piece[] = [];
    for (const part of seg.split(/(:\w+)/)) {
      if (!part) continue;
      if (part.startsWith(":")) pieces.push({ param: part.slice(1) });
      else if (/[?+*()[\]{}|^$\\:]/.test(part)) return why;
      else pieces.push({ text: part });
    }
    variants = variants.map((v) => ({ segments: [...v.segments, pieces] }));
  }
  return finish(variants.map((v) => (v.segments.length ? v : { ...v, segments: [[]] })));
}

const sameReading = (a: RoutePath[], b: RoutePath[]): boolean => {
  const key = (list: RoutePath[]) => JSON.stringify(list.map((p) => [p.path, p.patterns ?? {}]).sort());
  return key(a) === key(b);
};

/**
 * A path on Express of a version no package.json gives: as both Express 4 and 5 read it where they agree; as Express 4
 * reads it where Express 5 (path-to-regexp 8) throws on it, since the application starts only on Express 4 then.
 */
export function readExpress(path: string): ReadPath {
  const five = readPathToRegexp(path);
  const four = readPathToRegexp01(path);
  if ("why" in five && five.rejected) return four;
  if ("paths" in five && "paths" in four && sameReading(five.paths, four.paths)) return five;
  return { why: "Express 4 and 5 read it differently (path-to-regexp 0.1 and 8), and no package.json above it gives one major version of express" };
}

/**
 * Nest's `LegacyRouteConverter.tryConvert` (@nestjs/core 11 and 12) for a path ending in a legacy wildcard, which the
 * Express adapter applies before path-to-regexp 8: `(.*)` and `*` become `{*path}`, `/+` becomes `/*path`. Its
 * conversion of a `*` segment before the end differs between versions, so such a path is not read.
 */
export function readNest(route: string): ReadPath {
  const converted = nestConverted(route);
  return typeof converted === "string" ? readPathToRegexp(converted) : converted;
}

/** The path `LegacyRouteConverter.tryConvert` hands to path-to-regexp 8 (see `readNest`). */
function nestConverted(route: string): string | { why: string } {
  const lead = route.startsWith("/") ? route : `/${route}`;
  const normalized = route.endsWith("/") ? lead : `${lead}/`;
  if (normalized.endsWith("/(.*)/")) return route.replace("(.*)", "{*path}");
  if (normalized.endsWith("/*/")) return route.replace("*", "{*path}");
  if (normalized.endsWith("/+/")) return route.replace("/+", "/*path");
  if (normalized.includes("/*/")) return { why: "Nest converts a `*` segment before the end of a path differently by version" };
  return route;
}

/**
 * The kind of each segment of a path Nest serves on Express, as its specificity sort ranks them (@nestjs/core 12,
 * `RouteConflictDetector.tokenizePath` and `classifySegment`, `RouteSpecificitySorter.SEGMENT_KIND_RANK`): the path the
 * adapter normalizes (`nestConverted`) parsed by path-to-regexp 8, a group's tokens kept as optional, split at each `/`
 * of its text, empty segments left out; a segment starting with a wildcard is 4, one of text only 0, one whose only
 * required token (or only token) is a parameter 3, any other 2. Undefined where the path is not read.
 */
export function nestSpecificity(route: string): number[] | undefined {
  const converted = nestConverted(route);
  const tokens = typeof converted === "string" ? parseP2R(converted) : undefined;
  if (!tokens || !Array.isArray(tokens)) return undefined;
  type Part = { token: Exclude<Token, { type: "group" }>; optional: boolean };
  const flat = (list: Token[], optional: boolean): Part[] => list.flatMap((t) => (t.type === "group" ? flat(t.tokens, true) : [{ token: t, optional }]));
  const segs: Part[][] = [[]];
  for (const part of flat(tokens, false)) {
    if (part.token.type !== "text") {
      segs[segs.length - 1]!.push(part);
      continue;
    }
    part.token.value.split("/").forEach((text, i) => {
      if (i > 0) segs.push([]);
      if (text) segs[segs.length - 1]!.push({ token: { type: "text", value: text }, optional: part.optional });
    });
  }
  return segs
    .filter((parts) => parts.length > 0)
    .map((parts) => {
      if (parts[0]!.token.type === "wildcard") return 4;
      if (parts.every((p) => p.token.type === "text")) return 0;
      const required = parts.filter((p) => !p.optional);
      const [only, ...others] = required.length ? required : parts;
      return !others.length && only!.token.type === "param" ? 3 : 2;
    });
}

/** find-my-way's `getClosingParenthensePosition`: the `)` closing the `(` at `at`, past escaped characters. */
function closingParen(path: string, at: number): number | undefined {
  let depth = 1;
  for (let i = at + 1; i < path.length; i++) {
    if (path[i] === "\\") {
      i++;
      continue;
    }
    if (path[i] === ")") depth--;
    else if (path[i] === "(") depth++;
    if (!depth) return i;
  }
  return undefined;
}

/** find-my-way's `trimRegExpStartAndEnd`: a `^` after the `(` and a `$` before the `)` are dropped. */
const trimRegExp = (re: string): string => {
  let out = re;
  if (out[1] === "^") out = out.slice(0, 1) + out.slice(2);
  if (out[out.length - 2] === "$") out = out.slice(0, -2) + out.slice(-1);
  return out;
};

const compiles = (re: string): boolean => {
  try {
    new RegExp(re);
    return true;
  } catch {
    return false;
  }
};

const FMW_OPTIONAL = /(\/:[^/()]*?)\?(\/?)/;

/** A path in find-my-way's syntax (Fastify). */
export function readFindMyWay(path: string): ReadPath {
  const optional = FMW_OPTIONAL.exec(path);
  if (!optional) return finish([fmwVariant(path)]);
  if (path.length !== optional.index + optional[0].length) return { why: "find-my-way rejects an optional parameter before the end of the path" };
  return finish([fmwVariant(path.replace(FMW_OPTIONAL, "$1$2")), fmwVariant(path.replace(FMW_OPTIONAL, "$2") || "/")]);
}

/** One path find-my-way registers, as `_on` reads it. */
function fmwVariant(path: string): Built {
  const v: Variant = { segments: [[]] };
  let text = "";
  const flush = () => {
    if (text) v.segments[v.segments.length - 1]!.push({ text });
    text = "";
  };
  for (let i = 0; i < path.length; ) {
    const c = path[i]!;
    if (c === ":" && path[i + 1] === ":") {
      text += ":";
      i += 2;
      continue;
    }
    if (c === "/") {
      flush();
      v.segments.push([]);
      i++;
      continue;
    }
    if (c === "*") {
      if (i !== path.length - 1) return { why: "find-my-way rejects a wildcard that is not the last character of the path" };
      flush();
      if (!empty(v)) return { why: "its wildcard `*` takes text across segments, not the whole end of the path" };
      v.rest = { min: 0 };
      i++;
      continue;
    }
    if (c !== ":") {
      text += c;
      i++;
      continue;
    }
    flush();
    // One node: parameters, each with its regexp, and the static text between them, up to the next `/`. In a node with
    // a regexp or static text (a regex node), a parameter without its own regexp takes `(.*?)`, or after another such
    // parameter, anything up to the static text before it (`isParamSafe`, `backtrack`), empty text included.
    const regexps: string[] = [];
    const node: Piece[] = [];
    let regexNode = false;
    let safe = true;
    let backtrack = "";
    let start = i + 1;
    let j = start;
    for (;;) {
      const ch = path[j];
      const isRegex = ch === "(";
      const isStatic = ch === "-" || ch === ".";
      const isEnd = ch === "/" || j >= path.length;
      if (!isRegex && !isStatic && !isEnd) {
        j++;
        continue;
      }
      const name = path.slice(start, j);
      regexNode ||= isRegex || isStatic;
      let pattern: string;
      if (isRegex) {
        const close = closingParen(path, j);
        if (close === undefined) return { why: "find-my-way rejects a regexp that is not closed" };
        pattern = trimRegExp(path.slice(j, close + 1));
        j = close + 1;
        safe = true;
        node.push({ param: name, pattern });
      } else {
        pattern = safe ? "(.*?)" : `(${backtrack}|(?:(?!${backtrack}).)*)`;
        safe = false;
        node.push({ param: name, pattern });
      }
      regexps.push(pattern);
      const from = j;
      for (; j < path.length; j++) {
        if (path[j] === "/") break;
        if (path[j] === ":") {
          if (path[j + 1] === ":") j++;
          else break;
        }
      }
      const stat = path.slice(from, j).replaceAll("::", ":");
      if (stat) {
        node.push({ text: stat });
        regexps.push((backtrack = stat.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
      }
      if (j >= path.length || path[j] === "/") break;
      start = j + 1;
      j = start;
    }
    if (!compiles(`^${regexps.join("")}$`)) return { why: "find-my-way rejects a regexp that is not a valid regular expression" };
    // A parameter that is its node whole has no regexp: it takes the segment.
    for (const p of node) v.segments[v.segments.length - 1]!.push("param" in p && !regexNode ? { param: p.param } : p);
    i = j;
  }
  flush();
  return v;
}

/**
 * Whether a JavaScript regular expression surely matches no `/`: no `.`, no negated class, no class or escape that
 * holds one (`\D`, `\W`, `\S`, `\/`, a range across it), and no escape that may name a character (`\u`, `\x`, `\c`, a
 * back reference). Any other is taken as one that may.
 */
export function slashFree(source: string): boolean {
  const risky = (e: string | undefined) => e === undefined || /[DWS/uxcpPk0-9]/.test(e);
  // The character a class escape stands for (`\t` is U+0009, `\b` a backspace in a class), null for `\d`, `\w`, `\s`.
  const CONTROL: Record<string, number> = { t: 0x09, n: 0x0a, v: 0x0b, f: 0x0c, r: 0x0d, b: 0x08 };
  const escaped = (e: string): number | null => (/[dws]/.test(e) ? null : Object.hasOwn(CONTROL, e) ? CONTROL[e]! : e.codePointAt(0)!);
  for (let i = 0; i < source.length; i++) {
    const c = source[i]!;
    if (c === "\\") {
      if (risky(source[i + 1])) return false;
      i++;
      continue;
    }
    if (c === "." || c === "/") return false;
    if (c !== "[") continue;
    if (source[i + 1] === "^") return false;
    // Each member's code point (null for a class escape), and whether it is an unescaped `-`, which makes a range.
    const members: Array<{ code: number | null; dash: boolean }> = [];
    let j = i + 1;
    for (; j < source.length && source[j] !== "]"; j++) {
      if (source[j] === "\\") {
        const e = source[j + 1];
        if (risky(e)) return false;
        members.push({ code: escaped(e!), dash: false });
        j++;
      } else members.push({ code: source.codePointAt(j)!, dash: source[j] === "-" });
    }
    if (j >= source.length) return false;
    for (let k = 0; k < members.length; k++) {
      const m = members[k]!;
      if (m.code === 0x2f) return false;
      const from = members[k - 1]?.code;
      const to = members[k + 1]?.code;
      if (m.dash && k > 0 && k < members.length - 1 && from != null && to != null && from <= 0x2f && to >= 0x2f) return false;
    }
    i = j;
  }
  return true;
}

/** Hono's `checkOptionalParameter`: a path ending in `?` with a parameter is each path its optional ones make. */
function honoOptional(path: string): string[] | undefined {
  if (!path.endsWith("?") || !path.includes(":")) return undefined;
  const results: string[] = [];
  let base = "";
  for (const segment of path.split("/")) {
    if (segment !== "" && !segment.includes(":")) base += `/${segment}`;
    else if (segment.includes(":")) {
      if (segment.endsWith("?")) {
        results.push(results.length === 0 && base === "" ? "/" : base);
        base += `/${segment.slice(0, -1)}`;
        results.push(base);
      } else base += `/${segment}`;
    }
  }
  return [...new Set(results)];
}

/**
 * Hono's `splitRoutingPath`: the segments of a path, a `{...}` kept whole though it holds a `/`; each is marked `@<at>`
 * while the path is split and put back into the last segment that holds its mark, as Hono does.
 */
function honoSegments(path: string): string[] {
  const groups: Array<[string, string]> = [];
  const marked = path.replace(/\{[^}]+\}/g, (match, at: number) => {
    groups.push([`@${at}`, match]);
    return `@${at}`;
  });
  const paths = marked.split("/");
  if (paths[0] === "") paths.shift();
  for (let i = groups.length - 1; i >= 0; i--) {
    const [mark, group] = groups[i]!;
    for (let j = paths.length - 1; j >= 0; j--) {
      if (paths[j]!.includes(mark)) {
        paths[j] = paths[j]!.replace(mark, group);
        break;
      }
    }
  }
  return paths;
}

/** A path in Hono's syntax, as its default router reads it. */
export function readHono(path: string): ReadPath {
  let body = path;
  let rest: Rest | undefined;
  if (path.endsWith("*")) {
    if (!path.endsWith("/*")) return { why: "its `*` at the end of a segment's text takes text across segments" };
    body = path.slice(0, -2) || "/";
    rest = { min: 0 };
  }
  const paths = (rest ? undefined : honoOptional(body)) ?? [body];
  const variants = paths.map((p): Built => {
    const v: Variant = { segments: [], ...(rest ? { rest } : {}) };
    for (const label of honoSegments(p)) {
      if (label === "") continue;
      if (label === "*") {
        v.segments.push([{ star: true }]);
        continue;
      }
      const m = /^:([^{}]+)(?:\{(.+)\})?$/.exec(label);
      if (m) {
        const pattern = m[2];
        if (pattern !== undefined && !compiles(pattern)) return { why: `the regexp of ${quote(`:${m[1]}`)} is not a valid regular expression` };
        if (pattern !== undefined && !slashFree(pattern)) return { why: `the regexp of ${quote(`:${m[1]}`)} may take a \`/\`, so its parameter may span segments` };
        v.segments.push([{ param: m[1]!, ...(pattern !== undefined ? { pattern } : {}) }]);
        continue;
      }
      // RegExpRouter starts a parameter at any `:`, TrieRouter only at the start of a segment.
      if (/[:{}*]/.test(label)) return { why: `its segment ${quote(label)} is read differently by Hono's RegExpRouter and TrieRouter` };
      v.segments.push([{ text: label }]);
    }
    if (!v.segments.length) v.segments.push([]);
    return v;
  });
  return finish(variants);
}

/**
 * Literal text and whole segments `:name`, which every router the express style reads takes alike; any other syntax
 * is not read, for `why`.
 */
export function readPlain(path: string, why: string): ReadPath {
  const v: Variant = { segments: [] };
  for (const seg of path.split("/").filter(Boolean)) {
    const m = /^:([A-Za-z_][A-Za-z0-9_]*)$/.exec(seg);
    if (m) v.segments.push([{ param: m[1]! }]);
    else if (/[:{}()*?+!\\[\]]/.test(seg)) return { why };
    else v.segments.push([{ text: seg }]);
  }
  if (!v.segments.length) v.segments.push([]);
  return finish([v]);
}

/** The paths a registration serves in a syntax, or why it is not read. */
export function readRoutePath(path: string, syntax: Syntax): ReadPath {
  switch (syntax.kind) {
    case "path-to-regexp":
      return readPathToRegexp(path);
    case "path-to-regexp-0.1":
      return readPathToRegexp01(path);
    case "express":
      return readExpress(path);
    case "nest":
      return readNest(path);
    case "find-my-way":
      return readFindMyWay(path);
    case "hono":
      return readHono(path);
    case "plain":
      return readPlain(path, syntax.why);
  }
}

/**
 * The major version a package.json range admits, where it admits one only: `^5.1.0`, `~4.18`, `5`, `5.x`, `=5.0.1`,
 * or alternatives (`||`) that agree. A range open above (`>=4`), a tag, a URL or a workspace link admits no one major.
 */
export function rangeMajor(range: string): number | undefined {
  const majors = range.split("||").map((alt) => /^\s*(?:\^|~|=|v)?\s*(\d+)(?:\.(?:\d+|x|X|\*)){0,2}(?:-[0-9A-Za-z.-]+)?\s*$/.exec(alt)?.[1]);
  if (majors.some((m) => m === undefined) || new Set(majors).size !== 1) return undefined;
  return Number(majors[0]);
}

const DEPENDENCIES = ["dependencies", "devDependencies", "peerDependencies", "optionalDependencies"];

/**
 * The version range a file's package depends on a package at: that of the nearest package.json above the file that
 * names the package, which is the one its install resolves from; undefined where none names it.
 */
export function packageRanges(source: Pick<Source, "read">): (file: string, pkg: string) => string | undefined {
  const parsed = new Map<string, Record<string, unknown> | null>();
  const manifest = (dir: string): Record<string, unknown> | null => {
    if (!parsed.has(dir)) {
      const text = source.read(dir ? `${dir}/package.json` : "package.json");
      let json: unknown = null;
      try {
        if (text !== undefined) json = JSON.parse(text);
      } catch {
        // A package.json that does not parse names no version.
      }
      parsed.set(dir, json && typeof json === "object" ? (json as Record<string, unknown>) : null);
    }
    return parsed.get(dir)!;
  };
  return (file, pkg) => {
    const parts = file.split("/").slice(0, -1);
    for (let n = parts.length; n >= 0; n--) {
      const json = manifest(parts.slice(0, n).join("/"));
      for (const field of DEPENDENCIES) {
        const deps = json?.[field];
        if (deps && typeof deps === "object" && Object.hasOwn(deps, pkg)) {
          // A value that is no string names the package at no version, as a range that admits no one major does.
          const range = (deps as Record<string, unknown>)[pkg];
          return typeof range === "string" ? range : "*";
        }
      }
    }
    return undefined;
  };
}

/** The first major version of each package whose path syntax atlas reads, and the syntax it reads from there. */
const SYNTAXES: Record<string, { name: string; since: number; kind: "path-to-regexp" | "find-my-way" | "hono"; before: string }> = {
  "@koa/router": { name: "@koa/router", since: 14, kind: "path-to-regexp", before: "path-to-regexp 6" },
  "koa-router": { name: "koa-router", since: 14, kind: "path-to-regexp", before: "an earlier path-to-regexp" },
  fastify: { name: "Fastify", since: 4, kind: "find-my-way", before: "an earlier find-my-way" },
  hono: { name: "Hono", since: 4, kind: "hono", before: "an earlier router" },
};

/**
 * The syntax a router created from `pkg` reads paths in, with the range the file's package.json gives that package:
 * Express 5 and later path-to-regexp 8, Express 4 and earlier path-to-regexp 0.1, either where the version is not given.
 * An unknown router, version or Hono preset (`hono/quick`, `hono/tiny`, another router) is read plain.
 */
export function syntaxOf(pkg: string | undefined, range: string | undefined): Syntax {
  if (pkg === undefined) return { kind: "plain", why: "its router is not traced to Express, @koa/router, Fastify or Hono, which read path syntax differently" };
  const major = range === undefined ? undefined : rangeMajor(range);
  if (pkg === "express") return { kind: major === undefined ? "express" : major >= 5 ? "path-to-regexp" : "path-to-regexp-0.1" };
  const known = SYNTAXES[pkg];
  if (!known) return { kind: "plain", why: `the path syntax of ${pkg} is not read` };
  if (major === undefined) return { kind: "plain", why: `no package.json above it gives one major version of ${pkg}, whose path syntax differs between versions` };
  if (major < known.since) return { kind: "plain", why: `${known.name} ${major} reads it with ${known.before}, which is not read` };
  return { kind: known.kind };
}

/**
 * The syntax a Nest application reads paths in, by the version of `@nestjs/platform-express`: Nest 11 and later on
 * Express 5, earlier ones on Express 4, where no Fastify adapter is installed beside it; any other is read plain.
 */
export function nestSyntax(range: (pkg: string) => string | undefined): Syntax {
  if (range("@nestjs/platform-fastify") !== undefined) return { kind: "plain", why: "@nestjs/platform-fastify is installed, and which adapter, Express or Fastify, serves the routes is not read" };
  const given = range("@nestjs/platform-express");
  const major = given === undefined ? undefined : rangeMajor(given);
  if (major === undefined) return { kind: "plain", why: "no package.json above it gives one major version of @nestjs/platform-express, whose path syntax differs between versions" };
  // Before Nest 11 the adapter hands the path to Express 4 as it is.
  return { kind: major < 11 ? "path-to-regexp-0.1" : "nest" };
}
