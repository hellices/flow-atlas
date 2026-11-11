/**
 * The paths Django's URL patterns match, read from their text as Django 6.1 compiles it: a `path()` route
 * (`_route_to_regex`: its text as written, each `<converter:name>` its converter's regex) and a `re_path()` regex, read
 * as Python's `re` parses it, in the subset whose shape is certain: text, groups that capture a parameter, optional and
 * alternative parts. Each pattern of a chain of included URLconfs matches its part of the path in turn
 * (`URLResolver.resolve`), so the chain is read as their texts joined.
 */

/** A node of a Python regular expression, as `re` parses the part of its syntax atlas reads. */
export type Rx =
  | { t: "char"; c: string }
  | { t: "set"; has: (c: string) => boolean; js: string; any?: true }
  | { t: "group"; name?: string; capture: boolean; alts: Rx[][] }
  | { t: "rep"; min: number; max: number; lazy: boolean; item: Rx }
  | { t: "anchor"; a: string };

class Unread extends Error {}

const DIGIT = /^\p{Nd}$/u;
// Python's `\w` in a str pattern: what `str.isalnum()` takes, and `_`.
const WORD = /^[\p{L}\p{N}_]$/u;
// Python's `\s` in a str pattern also takes the separators U+001C to U+001F.
const SPACE = (c: string) => /^\s$/u.test(c) || "\u001c\u001d\u001e\u001f\u0085".includes(c);
const CATEGORIES: Record<string, { has: (c: string) => boolean; js: string }> = {
  d: { has: (c) => DIGIT.test(c), js: "\\d" },
  D: { has: (c) => !DIGIT.test(c), js: "\\D" },
  w: { has: (c) => WORD.test(c), js: "\\w" },
  W: { has: (c) => !WORD.test(c), js: "\\W" },
  s: { has: (c) => SPACE(c), js: "\\s" },
  S: { has: (c) => !SPACE(c), js: "\\S" },
};
const CONTROL: Record<string, string> = { n: "\n", t: "\t", r: "\r", f: "\f", v: "\v", a: "\x07" };

/**
 * A Python regular expression parsed as `re._parser` parses it, for the syntax atlas reads: text, escapes, classes,
 * `.`, groups (capturing, named, non-capturing), alternatives, repeats and anchors. Why not, for any other syntax
 * (look-arounds, back references, inline flags, atomic groups and possessive repeats), or one Python refuses.
 */
export function parseRegex(src: string): { alts: Rx[][] } | { why: string } {
  let i = 0;
  const fail = (why: string): never => {
    throw new Unread(why);
  };
  const point = (c: string) => c.codePointAt(0)!;
  /** One character an escape stands for, inside a class or out; `i` at the backslash. */
  const escaped = (inClass: boolean): string => {
    const n = src[i + 1];
    if (n === undefined) fail("a \\ at its end");
    const hex = (len: number) => {
      const digits = src.slice(i + 2, i + 2 + len);
      if (!new RegExp(`^[0-9a-fA-F]{${len}}$`).test(digits)) fail(`an escape Python refuses (\\${n})`);
      i += 2 + len;
      return String.fromCodePoint(parseInt(digits, 16));
    };
    if (n === "x") return hex(2);
    if (n === "u") return hex(4);
    if (n === "U") return hex(8);
    if (inClass && n === "b") {
      i += 2;
      return "\b";
    }
    if (CONTROL[n!] !== undefined) {
      i += 2;
      return CONTROL[n!]!;
    }
    if (/[0-9]/.test(n!)) fail(`a back reference or octal escape (\\${n})`);
    if (/[A-Za-z]/.test(n!)) fail(`an escape atlas does not read (\\${n})`);
    i += 2;
    return n!;
  };
  const jsClassChar = (c: string) => (/[\\\][^-]/.test(c) ? `\\${c}` : c === "\n" ? "\\n" : c);
  const charClass = (): Rx => {
    i++;
    let negate = false;
    if (src[i] === "^") {
      negate = true;
      i++;
    }
    const tests: Array<(c: string) => boolean> = [];
    let js = "";
    let first = true;
    for (;;) {
      if (i >= src.length) fail("a [ it does not close");
      if (src[i] === "]" && !first) {
        i++;
        break;
      }
      first = false;
      let lo: string;
      if (src[i] === "\\") {
        const category = CATEGORIES[src[i + 1] ?? ""];
        if (category) {
          tests.push(category.has);
          js += category.js;
          i += 2;
          continue;
        }
        lo = escaped(true);
      } else lo = src[i++]!;
      if (src[i] === "-" && src[i + 1] !== undefined && src[i + 1] !== "]") {
        i++;
        let hi: string;
        if (src[i] === "\\") {
          if (CATEGORIES[src[i + 1] ?? ""]) fail("a range to a class");
          hi = escaped(true);
        } else hi = src[i++]!;
        const [a, b] = [point(lo), point(hi)];
        if (b < a) fail(`a range out of order (${lo}-${hi})`);
        tests.push((c) => point(c) >= a && point(c) <= b);
        js += `${jsClassChar(lo)}-${jsClassChar(hi)}`;
      } else {
        const own = lo;
        tests.push((c) => c === own);
        js += jsClassChar(lo);
      }
    }
    return { t: "set", has: (c) => tests.some((t) => t(c)) !== negate, js: `[${negate ? "^" : ""}${js}]` };
  };
  const atom = (): Rx => {
    const c = src[i]!;
    if (c === "(") {
      i++;
      let name: string | undefined;
      let capture = true;
      if (src.startsWith("?:", i)) {
        capture = false;
        i += 2;
      } else if (src.startsWith("?P<", i)) {
        const m = /^\?P<([^>]*)>/.exec(src.slice(i));
        if (!m || !/^[\p{L}_][\p{L}\p{N}_]*$/u.test(m[1]!)) fail("a group name Python refuses");
        name = m![1]!;
        i += m![0].length;
      } else if (src[i] === "?") fail(`a group atlas does not read ((${src.slice(i, i + 3)}...)`);
      const alts = alternatives();
      if (src[i] !== ")") fail("a ( it does not close");
      i++;
      return { t: "group", ...(name !== undefined ? { name } : {}), capture, alts };
    }
    if (c === "[") return charClass();
    if (c === ".") {
      i++;
      return { t: "set", has: (x) => x !== "\n", js: ".", any: true };
    }
    if (c === "^" || c === "$") {
      i++;
      return { t: "anchor", a: c };
    }
    if (c === "\\") {
      const n = src[i + 1] ?? "";
      const category = CATEGORIES[n];
      if (category) {
        i += 2;
        return { t: "set", ...category };
      }
      if ("AZbB".includes(n) && n) {
        i += 2;
        return { t: "anchor", a: `\\${n}` };
      }
      return { t: "char", c: escaped(false) };
    }
    if ("*+?".includes(c)) fail(`a ${c} with nothing to repeat`);
    if (c === ")") fail("a ) that opens nothing");
    i += c.length;
    return { t: "char", c };
  };
  const quantifier = (): { min: number; max: number } | undefined => {
    const c = src[i];
    if (c === "*" || c === "+" || c === "?") {
      i++;
      return { min: c === "+" ? 1 : 0, max: c === "?" ? 1 : Infinity };
    }
    const m = /^\{(\d*)(,?)(\d*)\}/.exec(src.slice(i));
    if (!m || (!m[1] && !m[2] && !m[3]) || (!m[2] && !m[1])) return undefined;
    i += m[0].length;
    const min = m[1] ? Number(m[1]) : 0;
    const max = m[2] ? (m[3] ? Number(m[3]) : Infinity) : min;
    if (max < min) fail(`a repeat out of order (${m[0]})`);
    return { min, max };
  };
  const sequence = (): Rx[] => {
    const out: Rx[] = [];
    while (i < src.length && src[i] !== "|" && src[i] !== ")") {
      let item = atom();
      const q = quantifier();
      if (q) {
        if (item.t === "anchor") fail(`a repeated anchor (${item.a})`);
        let lazy = false;
        if (src[i] === "?") {
          lazy = true;
          i++;
        } else if (src[i] === "+") fail("a possessive repeat");
        if (quantifier()) fail("a repeat of a repeat");
        item = { t: "rep", ...q, lazy, item };
      }
      out.push(item);
    }
    return out;
  };
  const alternatives = (): Rx[][] => {
    const alts = [sequence()];
    while (src[i] === "|") {
      i++;
      alts.push(sequence());
    }
    return alts;
  };
  try {
    const alts = alternatives();
    if (i < src.length) fail("a ) that opens nothing");
    return { alts };
  } catch (e) {
    if (e instanceof Unread) return { why: e.message };
    throw e;
  }
}

/** The fewest characters a node matches. */
function minLength(alts: Rx[][]): number {
  const one = (r: Rx): number => (r.t === "char" || r.t === "set" ? 1 : r.t === "anchor" ? 0 : r.t === "group" ? minLength(r.alts) : r.min * one(r.item));
  return Math.min(...alts.map((seq) => seq.reduce((n, r) => n + one(r), 0)));
}

/** Whether some text the expression matches holds the character `c`. */
export function mayTake(alts: Rx[][], c: string): boolean {
  const one = (r: Rx): boolean => (r.t === "char" ? r.c === c : r.t === "set" ? r.has(c) : r.t === "anchor" ? false : r.t === "group" ? mayTake(r.alts, c) : r.max > 0 && one(r.item));
  return alts.some((seq) => seq.some(one));
}

/** Whether the expression repeats lazily anywhere (`+?`), which matches as little as it may. */
function lazy(alts: Rx[][]): boolean {
  const one = (r: Rx): boolean => (r.t === "rep" ? r.lazy || one(r.item) : r.t === "group" ? lazy(r.alts) : false);
  return alts.some((seq) => seq.some(one));
}

/** `.*` or `.+` (lazy or not, in a group or not): any text, of at least `min` characters. */
function anyText(alts: Rx[][]): number | undefined {
  if (alts.length !== 1 || alts[0]!.length !== 1) return undefined;
  const r = alts[0]![0]!;
  if (r.t === "group") return anyText(r.alts);
  return r.t === "rep" && r.item.t === "set" && r.item.any && r.max === Infinity && r.min <= 1 ? r.min : undefined;
}

/** The expression as a JavaScript regular expression that takes the same text, or why not (an anchor inside it). */
function jsOf(alts: Rx[][]): string {
  const quant = (min: number, max: number) =>
    min === 0 && max === Infinity ? "*" : min === 1 && max === Infinity ? "+" : min === 0 && max === 1 ? "?" : max === min ? `{${min}}` : max === Infinity ? `{${min},}` : `{${min},${max}}`;
  const one = (r: Rx): string => {
    if (r.t === "char") return r.c.replace(/[\\^$.|?*+()[\]{}/]/g, "\\$&").replace(/\n/g, "\\n");
    if (r.t === "set") return r.js;
    if (r.t === "group") return `(?:${jsOf(r.alts)})`;
    if (r.t === "rep") return `${one(r.item)}${quant(r.min, r.max)}${r.lazy ? "?" : ""}`;
    throw new Unread(`an anchor (${r.a}) inside a parameter`);
  };
  return alts.map((seq) => seq.map(one).join("")).join("|");
}

/** A parameter of a pattern: its regex, and what it takes. */
export interface Param {
  name: string;
  alts: Rx[][];
  /** The JavaScript regex of what it takes; undefined for any text of one segment (`[^/]+`, the `str` converter's). */
  js?: string;
  slash: boolean;
  empty: boolean;
  /** Any text of at least this many characters, slashes included (`.*`, `.+`, the `path` converter's). */
  rest?: number;
  lazy: boolean;
  /** A converter the files register whose `to_python` may refuse a value: its name. */
  unread?: string;
  why?: string;
}

function param(name: string, alts: Rx[][], unread?: string): Param {
  const out: Param = { name, alts, slash: mayTake(alts, "/"), empty: minLength(alts) === 0, lazy: lazy(alts) };
  const rest = anyText(alts);
  if (rest !== undefined) out.rest = rest;
  if (unread !== undefined) out.unread = unread;
  try {
    const js = jsOf(alts);
    if (js !== "[^/]+") out.js = js;
  } catch (e) {
    if (!(e instanceof Unread)) throw e;
    out.why = e.message;
  }
  return out;
}

export type Part = { t: "text"; s: string } | { t: "param"; p: Param };
export type Node = Part | { t: "choice"; options: Node[][] };

/** A converter of `path()`: its regex, and whether its `to_python` may refuse a value the regex takes. */
export interface Converter {
  regex: string;
  refuses: boolean;
}

export const DJANGO_CONVERTERS: Record<string, Converter> = {
  int: { regex: "[0-9]+", refuses: false },
  path: { regex: ".+", refuses: false },
  slug: { regex: "[-a-zA-Z0-9_]+", refuses: false },
  str: { regex: "[^/]+", refuses: false },
  uuid: { regex: "[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}", refuses: false },
};

const textNodes = (s: string): Node[] => (s ? [{ t: "text", s }] : []);

/**
 * A `path()` route as `_route_to_regex` reads it: text as written, and each `<converter:name>` (`str` where none is
 * named) the converter's regex. Why not, where Django refuses it or a converter is not one it knows.
 */
export function routeNodes(route: string, converter: (name: string) => Converter | undefined): Node[] | { why: string } {
  const out: Node[] = [];
  let last = 0;
  for (const m of route.matchAll(/<(?:([^>:]+):)?([^>]+)>/g)) {
    if (/\s/.test(m[0])) return { why: `the route ${JSON.stringify(route)} has whitespace in ${m[0]}, which Django refuses` };
    const name = m[2]!;
    if (!/^[\p{L}_][\p{L}\p{N}_]*$/u.test(name)) return { why: `the route ${JSON.stringify(route)} names the parameter ${name}, which Django refuses` };
    const conv = m[1] ?? "str";
    const c = converter(conv);
    if (!c) return { why: `the route ${JSON.stringify(route)} names the converter ${conv}, which is neither Django's nor one the files register` };
    const parsed = parseRegex(c.regex);
    if ("why" in parsed) return { why: `the route ${JSON.stringify(route)} names the converter ${conv}, whose regex has ${parsed.why}` };
    out.push(...textNodes(route.slice(last, m.index)), { t: "param", p: param(name, parsed.alts, c.refuses ? conv : undefined) });
    last = (m.index ?? 0) + m[0].length;
  }
  out.push(...textNodes(route.slice(last)));
  return out;
}

const describe = (r: Rx): string =>
  r.t === "set" ? `the class ${r.js}` : r.t === "rep" ? "a repeat" : r.t === "anchor" ? `the anchor ${r.a}` : r.t === "group" ? "a group" : JSON.stringify(r.c);

/**
 * A `re_path()` regex read as text and parameters: it starts with `^` (Django searches any other anywhere in the path)
 * and, for a view's pattern, ends with `$` or `\Z` (any other takes any text after it); each capturing group is a
 * parameter (an unnamed one named `_0`, `_1`, ... as Django's `normalize` names them), and an optional part or
 * alternatives are each a form of the path. Why not, for anything else outside a group.
 */
export function regexNodes(src: string, endpoint: boolean): Node[] | { why: string } {
  const parsed = parseRegex(src);
  const what = `the regex ${JSON.stringify(src)}`;
  if ("why" in parsed) return { why: `${what} has ${parsed.why}` };
  if (parsed.alts.length > 1) return { why: `${what} has a | outside a group, which takes any of its sides as the whole path` };
  const items = [...parsed.alts[0]!];
  if (src !== "") {
    const first = items[0];
    if (first?.t !== "anchor" || first.a !== "^") return { why: `${what} does not start with ^, so Django finds it anywhere in the path` };
    items.shift();
  }
  const last = items[items.length - 1];
  const ended = last?.t === "anchor" && (last.a === "$" || last.a === "\\Z");
  if (ended) items.pop();
  if (endpoint && !ended) return { why: `${what} does not end with $ or \\Z, so it takes any text after it` };
  if (!endpoint && ended) return { why: `${what} is included but ends with $, so only the patterns it includes that match nothing are reached` };
  let unnamed = 0;
  const convert = (seq: Rx[]): Node[] => {
    const out: Node[] = [];
    seq.forEach((r) => {
      if (r.t === "char") out.push({ t: "text", s: r.c });
      else if (r.t === "group" && r.capture) {
        out.push({ t: "param", p: param(r.name ?? `_${unnamed++}`, r.alts) });
      } else if (r.t === "group") {
        const options = r.alts.map((alt) => convert(alt));
        out.push(...(options.length === 1 ? options[0]! : [{ t: "choice" as const, options }]));
      } else if (r.t === "rep" && r.min === 0 && r.max === 1 && (r.item.t === "char" || r.item.t === "group")) {
        const inner = r.item;
        const options = inner.t === "char" ? [[{ t: "text" as const, s: inner.c }]] : inner.capture ? [convert([inner])] : inner.alts.map((alt) => convert(alt));
        out.push({ t: "choice", options: [...options, []] });
      } else throw new Unread(`${what} has ${describe(r)} outside a group, which atlas does not read as text or a parameter`);
    });
    return out;
  };
  try {
    return convert(items);
  } catch (e) {
    if (e instanceof Unread) return { why: e.message };
    throw e;
  }
}

/** Each form a pattern's nodes stand for, an optional part left in and out; undefined past `cap` forms. */
export function formsOf(nodes: Node[], cap = 64): Part[][] | undefined {
  let forms: Part[][] = [[]];
  for (const node of nodes) {
    if (node.t !== "choice") {
      for (const f of forms) f.push(node);
      continue;
    }
    const next: Part[][] = [];
    for (const option of node.options) {
      const inner = formsOf(option, cap);
      if (!inner) return undefined;
      for (const f of forms) for (const o of inner) next.push([...f, ...o]);
      if (next.length > cap) return undefined;
    }
    forms = next;
  }
  return forms;
}

/** atlas's names for Starlette's convertors (paths.ts): a converter of one of these names would be read as Starlette's. */
const STARLETTE_NAMES = new Set(["str", "int", "float", "uuid", "path"]);

export interface FormPath {
  path: string;
  patterns: Map<string, string>;
  trailing?: "slash" | "both";
}

/**
 * The path a form matches, in atlas's form, from the request path after its leading `/` (Django's resolver strips it
 * with `^/`): its text split at each `/`, a parameter `{name}` with its regex as its pattern, one that takes any text
 * at the end the rest of the path (`{name}/**` for `.+`, `**` for `.*`, which also takes the path before it with its
 * `/`), and a `/` at the end kept as `trailing`. Why not, where atlas's form cannot say it.
 */
export function formPath(form: Part[], what: string): FormPath | { why: string } {
  const segments: Part[][] = [[]];
  let rest: Param | undefined;
  for (let k = 0; k < form.length; k++) {
    const part = form[k]!;
    if (part.t === "text") {
      for (const ch of part.s) {
        if (ch === "/") segments.push([]);
        else {
          const seg = segments[segments.length - 1]!;
          const prev = seg[seg.length - 1];
          if (prev?.t === "text") prev.s += ch;
          else seg.push({ t: "text", s: ch });
        }
      }
      continue;
    }
    const p = part.p;
    if (p.why) return { why: `${what} has a parameter ${p.name} with ${p.why}` };
    if (p.slash) {
      if (p.rest === undefined) return { why: `${what} has a parameter ${p.name} whose regex takes some slashes, which atlas's path form does not hold` };
      if (k !== form.length - 1 || segments[segments.length - 1]!.length) return { why: `${what} has a parameter ${p.name} that takes slashes before its end or beside other text, which atlas's path form does not hold` };
      if (p.unread !== undefined) return { why: `${what} has a parameter ${p.name} whose converter ${p.unread} takes slashes and may refuse a value` };
      rest = p;
      continue;
    }
    segments[segments.length - 1]!.push(part);
  }
  const patterns = new Map<string, string>();
  const names = new Set<string>();
  let trailing: "slash" | undefined;
  if (rest) segments.pop();
  else if (segments.length > 1 && !segments[segments.length - 1]!.length) {
    segments.pop();
    trailing = "slash";
  }
  if (segments.length === 1 && !segments[0]!.length) segments.pop();
  const written: string[] = [];
  for (const seg of segments) {
    if (!seg.length) return { why: `${what} has an empty segment (//), which atlas's path form does not hold` };
    let out = "";
    for (const part of seg) {
      if (part.t === "text") {
        if (/[{}*?]/.test(part.s) || (!out && part.s.startsWith(":"))) return { why: `${what} has text atlas's path form would read as a parameter (${part.s})` };
        out += part.s;
        continue;
      }
      const p = part.p;
      if (names.has(p.name)) return { why: `${what} names the parameter ${p.name} twice` };
      names.add(p.name);
      if (seg.length === 1 && p.empty) return { why: `${what} has a parameter ${p.name} that takes an empty segment, which atlas's path form does not hold` };
      if (p.unread !== undefined) {
        if (seg.length !== 1) return { why: `${what} has a parameter ${p.name} whose converter ${p.unread} may refuse a value, beside other text in its segment` };
        if (STARLETTE_NAMES.has(p.unread)) return { why: `${what} has a parameter ${p.name} whose converter ${p.unread} atlas would read as a built-in one` };
        out += `{${p.name}:${p.unread}}`;
        continue;
      }
      if (p.js !== undefined) patterns.set(p.name, p.js);
      out += `{${p.name}}`;
    }
    written.push(out);
  }
  if (rest) {
    if (names.has(rest.name)) return { why: `${what} names the parameter ${rest.name} twice` };
    if (rest.rest! >= 1) written.push(`{${rest.name}}`, "**");
    else {
      written.push("**");
      // `media/(?P<path>.*)` takes `media/` but not `media`.
      if (written.length > 1) trailing = "slash";
    }
  }
  return { path: `/${written.join("/")}`, patterns, ...(trailing ? { trailing } : {}) };
}

/** A pattern of a chain: a `path()` route or a `re_path()` regex, and whether it is a view's (the chain's last). */
export interface Piece {
  type: "route" | "regex";
  text: string;
}

/** Whether an expression has alternatives anywhere (`a|b`), of which Python's `re` takes the first that matches. */
function alternates(alts: Rx[][]): boolean {
  const one = (r: Rx): boolean => (r.t === "group" ? alternates(r.alts) : r.t === "rep" ? one(r.item) : false);
  return alts.length > 1 || alts.some((seq) => seq.some(one));
}

/**
 * Why an include's pattern, `nodes` from `start` to `end`, may match other text than the joined regex takes, or
 * undefined where it cannot: each of its forms has as many `/` as the others, ends with one, and has no parameter that
 * takes one, so it matches up to that `/` in the path whichever way it matches; or, without optional parts, each
 * parameter stops at a character it does not take, which the text after it starts with.
 */
function prefixWhy(nodes: Node[], start: number, end: number): string | undefined {
  const own = nodes.slice(start, end);
  const params = (list: Node[]): Param[] => list.flatMap((n) => (n.t === "param" ? [n.p] : n.t === "choice" ? n.options.flatMap(params) : []));
  const forms = formsOf(own);
  if (forms && !params(own).some((p) => p.slash)) {
    const slashes = forms.map((f) => f.reduce((n, part) => n + (part.t === "text" ? part.s.split("/").length - 1 : 0), 0));
    const ended = forms.every((f) => {
      const last = f[f.length - 1];
      return last?.t === "text" && last.s.endsWith("/");
    });
    if (ended && slashes.every((n) => n === slashes[0])) return undefined;
  }
  for (let i = start; i < end; i++) {
    const node = nodes[i]!;
    if (node.t === "text") continue;
    if (node.t === "choice") return "a part that may be left out or written otherwise";
    const after = nodes[i + 1];
    if (node.p.lazy || alternates(node.p.alts) || after?.t !== "text" || mayTake(node.p.alts, after.s[0]!)) return `a parameter ${node.p.name}`;
  }
  return undefined;
}

/**
 * The paths a chain of patterns matches, joined as `URLResolver.resolve` matches them, each its part of the path in
 * turn, the forms of one path served with and without a trailing `/` merged (`both`). An include's pattern matches the
 * first text its regex finds and leaves the rest to the patterns it includes, which never make it try another: it is
 * read only where that text is the one the joined regex would take, that is where each of its parameters is followed by
 * text that starts with a character the parameter does not take, and has no alternatives or lazy repeats, and the
 * pattern has no optional or alternative part.
 */
export function chainPaths(pieces: Piece[], converter: (name: string) => Converter | undefined): FormPath[] | { why: string } {
  const nodes: Node[] = [];
  const ends: number[] = [];
  const what = `${pieces.map((p) => (p.type === "route" ? JSON.stringify(p.text) : `r${JSON.stringify(p.text)}`)).join(" + ")}`;
  for (let k = 0; k < pieces.length; k++) {
    const piece = pieces[k]!;
    const read = piece.type === "route" ? routeNodes(piece.text, converter) : regexNodes(piece.text, k === pieces.length - 1);
    if ("why" in read) return read;
    nodes.push(...read);
    if (k < pieces.length - 1) ends.push(nodes.length);
  }
  let start = 0;
  for (const end of ends) {
    const why = prefixWhy(nodes, start, end);
    if (why) return { why: `${what} includes patterns after ${why}, which Django matches before the patterns it includes, and never again, so it may take what they would` };
    start = end;
  }
  // A parameter that ends the path with an optional `/` (DRF's `(?P<format>\.[a-z0-9]+/?)` after a route that has
  // none): the `/` is the path's trailing one, which a parameter of one segment holds as atlas's form does.
  const last = nodes[nodes.length - 1];
  const body = last?.t === "param" && last.p.alts.length === 1 ? last.p.alts[0]! : undefined;
  const tail = body?.[body.length - 1];
  if (last?.t === "param" && body && tail?.t === "rep" && tail.min === 0 && tail.max === 1 && tail.item.t === "char" && tail.item.c === "/" && !mayTake([body.slice(0, -1)], "/")) {
    nodes.splice(nodes.length - 1, 1, { t: "param", p: param(last.p.name, [body.slice(0, -1)], last.p.unread) }, { t: "choice", options: [[{ t: "text", s: "/" }], []] });
  }
  const forms = formsOf(nodes);
  if (!forms) return { why: `${what} stands for more than 64 paths` };
  const out = new Map<string, FormPath>();
  for (const form of forms) {
    const read = formPath(form, what);
    if ("why" in read) return read;
    const key = JSON.stringify([read.path, [...read.patterns]]);
    const known = out.get(key);
    if (!known) out.set(key, read);
    else if (known.trailing !== read.trailing) known.trailing = "both";
  }
  return [...out.values()];
}
