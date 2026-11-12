import { HOLE, hostOf, type Base } from "../paths.js";
import type { Argument, Frame, TextCalls } from "./calls.js";
import { parseGo } from "./golang.js";
import { blankStrings } from "./verbs.js";

/**
 * The URLs code read as text builds out of more than one literal, as each language and library documents building
 * them: the operands of a `+`, the interpolations of a string, a formatting call, a URL builder. Each value becomes a
 * hole, as a value in a TypeScript template does, and a URL that starts with a value is read as one that starts with
 * a base, unless that value is a constant of the file (its text taken) or one the call source names as holding the
 * client's base URL (`baseValues`, the configured base's path taken). A builder atlas knows but whose URL a call it does
 * not read may change is left unread, and says why.
 *
 * Each rule follows the language's or the library's documentation and source:
 * - interpolation: Kotlin's and Dart's `$name` and `${...}`, Swift's `\(...)`, C#'s `$"{...}"` (`{{` a brace),
 *   Python's f-strings;
 * - formatting: Go's `fmt.Sprintf` (`%s`, `%d`, `%v`; `%%` a percent sign), Java's and Kotlin's `String.format` and
 *   Kotlin's `"...".format(...)` (`%s`, `%d`, `%1$s`), C#'s `string.Format` (`{0}`), Python's `str.format` (`{}`,
 *   `{0}`, `{name}`) and `%` (`%s`, `%d`);
 * - joining: Go's `url.JoinPath` and `URL.JoinPath`, `path.Join`, `url.Parse` and `URL.String()`; Swift's
 *   `appendingPathComponent`, `appending(path:)` and `appending(component:)`, `URL(string:)`; Dart's `Uri.parse`;
 * - builders: OkHttp's `HttpUrl.Builder` (`addPathSegment` encodes a `/`, `addPathSegments` splits at it), Spring's
 *   `UriComponentsBuilder` (`path` appends as written, then `//` becomes `/`; `pathSegment` adds segments), and Ktor's
 *   `appendPathSegments` in a request's `url { }` block.
 */

export type Lang = "java" | "kotlin" | "go" | "python" | "dart" | "swift" | "csharp";

export function languageOf(file: string): Lang | undefined {
  if (/\.java$/.test(file)) return "java";
  if (/\.kts?$/.test(file)) return "kotlin";
  if (/\.go$/.test(file)) return "go";
  if (/\.pyi?$/.test(file)) return "python";
  if (/\.dart$/.test(file)) return "dart";
  if (/\.swift$/.test(file)) return "swift";
  if (/\.cs$/.test(file)) return "csharp";
  return undefined;
}

/**
 * Where the f-string replacement field whose text starts at `from` ends, after its `}`. In the expression, quoted strings
 * (`{'}'}`) and brackets hold their braces; after a top-level `:` comes the format spec, literal text in which only a
 * nested field (`{width}`) opens.
 */
export function fieldEnd(body: string, from: number, expression?: (start: number, end: number) => void): number {
  let depth = 0;
  let spec = false;
  for (let i = from; i < body.length; i++) {
    const c = body[i]!;
    if (spec) {
      if (c === "{") i = fieldEnd(body, i + 1, expression) - 1;
      else if (c === "}") return i + 1;
    } else if (c === "'" || c === '"') {
      const quote = body.startsWith(c.repeat(3), i) ? c.repeat(3) : c;
      for (i += quote.length; i < body.length && !body.startsWith(quote, i); i++) if (body[i] === "\\") i++;
      i += quote.length - 1;
    } else if (c === "(" || c === "[" || c === "{") depth++;
    else if (c === ")" || c === "]") depth--;
    else if (c === "}") {
      if (depth === 0) {
        expression?.(from, i);
        return i + 1;
      }
      depth--;
    } else if (c === ":" && depth === 0) {
      expression?.(from, i);
      spec = true;
    }
  }
  return body.length;
}

/** What a URL is built from: literal text, a value (by the name it is written with, where it is one), or one `/` between segments. */
type Piece = { text: string; constant?: number } | { value: string | null } | { sep: true };

/** A part of an expression, read: its pieces, where it ends, the literals it takes, and whether it builds (joins, formats). */
interface Read {
  pieces: Piece[];
  end: number;
  literals: number[];
  built: boolean;
  /** Spring's `path`, which writes `//` as `/` once the URL is built. */
  sanitize?: boolean;
  /** Why a builder atlas knows is not read. */
  unread?: string;
  /** The URL is a builder's, not a formatted string that may be none. */
  builder?: true;
}

type Atom =
  | { kind: "literal"; start: number; end: number; prefix: string }
  | { kind: "name"; name: string; created: boolean }
  | { kind: "paren"; frame: Frame };

interface Segment {
  name: string;
  call?: Frame;
  /** `[...]`, `!`, `!!`, a trailing lambda: no part of a URL atlas reads. */
  other?: "index" | "bang" | "block";
}

interface Chain {
  atom: Atom;
  /** A call made by the atom's name (`URL(string: x)`, `Builder()`). */
  call?: Frame;
  segs: Segment[];
  end: number;
}

/** A URL built in an expression of code read as text. */
export interface StringExpression {
  start: number;
  end: number;
  /** The URL, each value a hole. */
  text: string;
  /** Built on a value the call source names as the base URL: `text` starts with the configured base's path. */
  onBase?: true;
  /** The string literals it is built from, by where each starts (its opening quote). */
  literals: number[];
  /** The literals of the file's constants it takes the text of, which are no requests of their own. */
  constants?: number[];
  /** The call argument it is, whole, where it is one. */
  anchor?: Argument;
  /** Why atlas does not read the URL a builder it knows makes. */
  unread?: string;
  /** A builder of URLs made it, not a format that may make other text. */
  builder?: true;
  /** The method the request is sent with, where the builder states it (Ktor's `client.post { }`). */
  method?: string;
  /** Ktor's `client.request { }`: where its block opens, which may set the method. */
  block?: number;
}

/** A value declared with an expression (`val url = ...`, `u, err := ...`), and where that expression lies. */
interface Declaration {
  name: string;
  at: number;
  start: number;
  end: number;
}

/** The name a value is written with: a name alone, or the receiver's own member (`this.base`, `self.base_url`). */
function nameOf(expression: string): string | null {
  return /^\s*(?:(?:this|self)\s*\.\s*)?([A-Za-z_]\w*)\s*$/.exec(expression)?.[1] ?? null;
}

/** The holes code read as text has always taken in any string: `${x}`, `$x`, `%s`, `%d`, `{x}`. */
const LEGACY = /\$\{[^}]*\}|\$[A-Za-z_]\w*|%[sd]|\{[A-Za-z_]\w*\}/g;

/** The packages of Go read here, by the name each declares. */
const GO_PACKAGES = new Map([
  ["fmt", "fmt"],
  ["net/url", "url"],
  ["path", "path"],
]);

/** `HttpUrl.Builder`'s calls that leave the path as it is (OkHttp, HttpUrl.Builder). */
const OKHTTP_KEEPS = new Set([
  "username",
  "encodedUsername",
  "password",
  "encodedPassword",
  "query",
  "encodedQuery",
  "addQueryParameter",
  "addEncodedQueryParameter",
  "setQueryParameter",
  "setEncodedQueryParameter",
  "removeAllQueryParameters",
  "removeAllEncodedQueryParameters",
  "fragment",
  "encodedFragment",
]);

/** `UriComponentsBuilder`'s calls that leave the path as it is (Spring Framework, UriComponentsBuilder). */
const SPRING_KEEPS = new Set(["query", "replaceQuery", "queryParam", "queryParamIfPresent", "queryParams", "replaceQueryParam", "replaceQueryParams", "fragment", "uriVariables", "encode", "scheme", "port", "userInfo"]);

/** The calls that end a `UriComponentsBuilder` chain with the URL. */
const SPRING_ENDS = new Set(["build", "buildAndExpand", "toUriString", "toUri", "expand", "encode", "toString"]);

/** The members of a URL held in a value that read or set its query or fragment, not its path. */
const QUERY_MEMBERS: Partial<Record<Lang, Set<string>>> = {
  go: new Set(["Query", "RawQuery", "ForceQuery", "Fragment", "RawFragment"]),
  swift: new Set(["queryItems", "percentEncodedQueryItems", "query", "percentEncodedQuery", "fragment"]),
};

/** The members that give a URL held in a value as the URL a request takes: Go's `u.String()`, Swift's `components.url`. */
const ACCESSORS: Partial<Record<Lang, Set<string>>> = {
  go: new Set(["String"]),
  swift: new Set(["url", "absoluteString", "absoluteURL"]),
  kotlin: new Set(["toString"]),
  java: new Set(["toString"]),
  csharp: new Set(["ToString"]),
  dart: new Set(["toString"]),
};

export class StringExpressions {
  readonly lang: Lang | undefined;
  private readonly code: string;
  private readonly strings = new Map<number, number>();
  private readonly baseValues: Set<string>;
  private consts?: Map<string, { text: string; at: number } | null>;
  private goNames?: Map<string, string>;
  private inBrackets?: Uint8Array;
  private found?: { expressions: StringExpression[]; declarations: Declaration[] };

  constructor(
    file: string,
    private readonly text: string,
    private readonly scan: TextCalls,
    private readonly options: { baseValues?: string[]; base?: Base } = {},
  ) {
    this.lang = languageOf(file);
    for (const [start, end] of scan.strings) this.strings.set(start, end);
    this.code = blankStrings(text, scan.strings);
    this.baseValues = new Set(options.base ? (options.baseValues ?? []) : []);
  }

  /** The URLs the file builds from more than one literal, or from a constant or a base value, each literal in one. */
  expressions(): StringExpression[] {
    return this.scanned().expressions;
  }

  /** The text of the lone string literal that opens at `start`, each interpolation a hole. */
  literalText(start: number): string | undefined {
    const prefix = this.prefixBefore(start);
    const lit = this.literalAt(start - prefix.length);
    if (!lit || lit.start !== start) return undefined;
    return this.assemble(this.literalPieces(lit)).text;
  }

  /**
   * Where a URL written at [start, end) is held in a value declared with it (`val url = ...`, `u, err := url.Parse(...)`,
   * `var c = components(path: "/x")`), the requests that value is sent by: each use of it in the block after its
   * declaration is the whole argument of a call (as itself, or as Go's `u.String()` or Swift's `c.url`), or reads or sets
   * its query. The method those calls state, by `methodOf` (`*` where they differ), and their arguments, which place it;
   * `*` and none where a use is anything else, the value is assigned again, or a call states no method. Undefined where the URL is held in no
   * declared value, or that value is used by no call.
   */
  heldIn(start: number, end: number, methodOf: (a: Argument) => string | undefined): { method: string; anchors: Argument[] } | undefined {
    if (this.lang === "python") return undefined;
    const declaration = this.scanned().declarations.find((d) => d.start <= start && end <= d.end);
    if (!declaration) return undefined;
    // A URL in a lambda or a block of the expression is not the value's.
    for (const f of this.scan.frames.values()) if (f.open === "{" && f.at >= declaration.start && f.at < start && (f.close ?? Infinity) >= end) return undefined;
    if (!(declaration.start === start && declaration.end === end) && !this.argumentAt(start, end)) return undefined;
    const block = this.enclosing(declaration.at, "{");
    const stop = block?.close ?? this.text.length;
    const uses = [...this.code.slice(declaration.end, stop).matchAll(new RegExp(`(?<![\\w$.])${declaration.name}(?![\\w$])`, "g"))];
    const methods = new Set<string>();
    const anchors: Argument[] = [];
    const any = { method: "*", anchors: [] };
    for (const u of uses) {
      const at = declaration.end + u.index;
      let to = at + declaration.name.length;
      const after = this.code.slice(to, to + 200);
      if (/^\s*(?::=|=(?!=))/.test(after)) return any;
      const appended = /^\s*\+=\s*/.exec(after);
      if (appended) {
        // Text appended that starts a query (`path += "?" + q.Encode()`) leaves the path as it is.
        const lit = this.literalAt(to + appended[0].length);
        if (lit && this.text.slice(lit.start + 1, lit.end).startsWith("?")) continue;
        return any;
      }
      const member = /^\s*(?:\?\.|!!\.|!\.|\.)\s*([A-Za-z_]\w*)/.exec(after);
      if (member) {
        if (QUERY_MEMBERS[this.lang!]?.has(member[1]!)) continue;
        if (!ACCESSORS[this.lang!]?.has(member[1]!)) return any;
        to += member[0].length;
        const call = /^\s*\(\s*\)/.exec(this.code.slice(to, to + 20));
        if (call) to += call[0].length;
      }
      const bang = /^!!?(?![=])/.exec(this.code.slice(to, to + 2));
      if (bang) to += bang[0].length;
      const argument = this.argumentAt(at, to);
      const method = argument && methodOf(argument);
      if (!argument || method === undefined) return any;
      methods.add(method);
      anchors.push(argument);
    }
    if (methods.size === 0) return undefined;
    return { method: methods.size === 1 ? [...methods][0]! : "*", anchors };
  }

  /** The call argument [start, end) is, whole, past the name it may be given by; undefined where it is no call's. */
  argumentAt(start: number, end: number): Argument | undefined {
    const f = this.enclosing(start, "(");
    if (!f || f.name === undefined || (f.close ?? -1) < end) return undefined;
    const index = f.parts.findIndex((p) => p.start <= start && end <= p.end);
    const p = f.parts[index];
    if (!p) return undefined;
    const before = this.code.slice(p.start, start);
    const label = /^\s*(?:([A-Za-z_]\w*)\s*(?::(?!:)|=(?!=)))?\s*$/.exec(before);
    if (!label || this.code.slice(end, p.end).trim()) return undefined;
    return {
      start,
      end,
      name: f.name,
      method: !!f.method,
      ...(f.receiver ? { receiver: f.receiver } : {}),
      index,
      ...(label[1] ? { label: label[1] } : {}),
      ...(f.exception ? { exception: f.exception } : {}),
      call: f.at,
      ...(f.annotation ? { annotation: true as const } : {}),
    };
  }

  private scanned(): { expressions: StringExpression[]; declarations: Declaration[] } {
    if (this.found) return this.found;
    const candidates: StringExpression[] = [];
    const declarations: Declaration[] = [];
    if (!this.lang) return (this.found = { expressions: [], declarations });
    // The arguments of calls, past a name they are given by.
    for (const f of this.scan.frames.values()) {
      if (f.open !== "(" || f.name === undefined || f.annotation) continue;
      for (const p of f.parts) {
        const label = /^\s*(?:[A-Za-z_]\w*\s*(?::(?!:)|=(?!=)))?\s*/.exec(this.code.slice(p.start, p.end))!;
        const start = p.start + label[0].length;
        const read = this.parseSum(start, p.end, true);
        if (!read || this.code.slice(read.end, p.end).trim()) continue;
        const found = this.found1(read, start);
        if (found) candidates.push(found);
      }
    }
    // The values assigned at statement level.
    const brackets = this.brackets();
    for (const m of this.code.matchAll(/(?<![=!<>+\-*/%&|^:?.])(:=|=>|=(?![=>]))|(?<![\w$.])return(?=[ \t])/g)) {
      const at = m.index;
      if (brackets[at]) continue;
      let start = at + m[0].length;
      while (start < this.text.length && /[ \t]/.test(this.text[start]!)) start++;
      const read = this.parseSum(start, this.text.length, false);
      if (!read) continue;
      const rest = /^[ \t]*(?:$|[;\r\n})\],])/.exec(this.code.slice(read.end, read.end + 200));
      if (!rest) continue;
      const name = m[1] === "=" || m[1] === ":=" ? this.declared(this.code.slice(Math.max(0, at - 200), at + m[0].length)) : undefined;
      if (name) declarations.push({ name, at: at - name.length, start, end: read.end });
      const found = this.found1(read, start);
      if (found) candidates.push(found);
    }
    // Ktor's `url { appendPathSegments(...) }` in a request's block.
    candidates.push(...this.ktorBlocks());
    // The outermost expression takes its literals; one inside it is read as part of it.
    candidates.sort((a, b) => b.end - b.start - (a.end - a.start) || (b.anchor ? 1 : 0) - (a.anchor ? 1 : 0));
    const taken = new Set<number>();
    const spans: Array<[number, number]> = [];
    const expressions: StringExpression[] = [];
    for (const c of candidates) {
      if (c.literals.some((l) => taken.has(l)) || spans.some(([s, e]) => s <= c.start && c.end <= e)) continue;
      c.literals.forEach((l) => taken.add(l));
      spans.push([c.start, c.end]);
      expressions.push(c);
    }
    return (this.found = { expressions: expressions.sort((a, b) => a.start - b.start), declarations });
  }

  /** An expression read, as a URL: undefined where it builds none, or one a lone literal gives as well. */
  private found1(read: Read, start: number): StringExpression | undefined {
    if (read.unread) {
      const anchor = this.argumentAt(start, read.end);
      return { start, end: read.end, text: this.assemble(read.pieces).text, literals: read.literals, unread: read.unread, ...(read.builder ? { builder: true as const } : {}), ...(anchor ? { anchor } : {}) };
    }
    const assembled = this.assemble(read.pieces, read.sanitize);
    if (!assembled.literal) return undefined;
    if (!read.built && !assembled.resolved && !assembled.onBase) return undefined;
    const anchor = this.argumentAt(start, read.end);
    return {
      start,
      end: read.end,
      text: assembled.text,
      literals: read.literals,
      ...(assembled.consts.length ? { constants: assembled.consts } : {}),
      ...(assembled.onBase ? { onBase: true as const } : {}),
      ...(anchor ? { anchor } : {}),
    };
  }

  /**
   * The pieces as one URL: a constant's text in its place, the configured base's path in place of a base value that
   * starts it, a hole for any other value, and one `/` for each separator.
   */
  private assemble(pieces: Piece[], sanitize = false): { text: string; literal: boolean; resolved: boolean; onBase: boolean; consts: number[] } {
    let out = "";
    let literal = false;
    let resolved = false;
    let onBase = false;
    let separated = false;
    const consts: number[] = [];
    pieces.forEach((p, i) => {
      if ("sep" in p) {
        out = out.replace(/\/+$/, "");
        out += "/";
        separated = true;
        return;
      }
      let text: string;
      if ("text" in p) {
        text = p.text;
        literal = true;
        if (p.constant !== undefined) {
          consts.push(p.constant);
          resolved = true;
        }
      } else {
        if (i === 0 && p.value !== null && this.baseValues.has(p.value)) {
          text = this.options.base!.path;
          onBase = true;
        } else text = out.endsWith(HOLE) ? "" : HOLE;
      }
      if (separated) text = text.replace(/^\/+/, "");
      separated = false;
      out += text;
    });
    if (sanitize) out = cleanPath(out);
    return { text: out, literal, resolved, onBase, consts };
  }

  /** A value written by its name: a string constant of the file gives its text, already, so a builder encodes or checks that text. */
  private named(name: string | null): Piece {
    const c = name === null ? undefined : this.constant(name);
    return c ? { text: c.text, constant: c.at } : { value: name };
  }

  /** The operands of a `+` from `i`, each read; undefined where a part is no string expression atlas reads. */
  private parseSum(i: number, stop: number, inPart: boolean): Read | undefined {
    const lines = inPart || this.lang === "java" || this.lang === "csharp" || this.lang === "dart";
    const out: Read = { pieces: [], end: i, literals: [], built: false };
    let at = this.skip(i, true);
    for (;;) {
      const operand = this.parseOperand(at, stop, lines);
      if (!operand) return undefined;
      if (operand.unread) return operand;
      out.pieces.push(...operand.pieces);
      out.literals.push(...operand.literals);
      out.built ||= operand.built;
      out.sanitize ||= operand.sanitize;
      out.end = operand.end;
      const next = this.skip(operand.end, lines);
      if (next < stop && this.code[next] === "+" && !/[+=]/.test(this.code[next + 1] ?? "")) {
        out.built = true;
        at = this.skip(next + 1, true);
        continue;
      }
      return out;
    }
  }

  /** One operand: a literal (with Python's `%` after it), or a chain of names and calls. */
  private parseOperand(i: number, stop: number, lines: boolean): Read | undefined {
    const chain = this.parseChain(i, stop, lines);
    if (!chain) return undefined;
    if (this.lang === "python" && chain.atom.kind === "literal" && chain.segs.length === 0) {
      const percent = this.skip(chain.end, lines);
      if (this.code[percent] === "%" && this.code[percent + 1] !== "=") return this.percent(chain.atom, this.skip(percent + 1, lines), stop, lines);
    }
    const read = this.interpret(chain);
    if (read) return { ...read, end: chain.end };
    // Any other value: a hole, by the name it is written with where it is one.
    const name =
      chain.atom.kind === "name" && !chain.call && !chain.atom.created
        ? chain.segs.length === 0
          ? chain.atom.name
          : chain.segs.length === 1 && !chain.segs[0]!.call && !chain.segs[0]!.other && (chain.atom.name === "this" || chain.atom.name === "self")
            ? chain.segs[0]!.name
            : null
        : null;
    return { pieces: [this.named(name)], end: chain.end, literals: [], built: false };
  }

  /** An atom (a literal, a name, a parenthesized expression, a call by name) and the members, calls and indexes after it. */
  private parseChain(i: number, stop: number, lines: boolean): Chain | undefined {
    if (i >= stop) return undefined;
    let atom: Atom;
    let call: Frame | undefined;
    let j: number;
    const lit = this.literalAt(i);
    if (lit) {
      atom = { kind: "literal", ...lit };
      j = lit.end;
    } else if (this.code[i] === "(") {
      const frame = this.scan.frames.get(i);
      if (!frame || frame.close === undefined) return undefined;
      atom = { kind: "paren", frame };
      j = frame.close + 1;
    } else {
      const created = /^new\s+/.exec(this.code.slice(i, i + 8));
      const m = /^[A-Za-z_]\w*(?:\s*\.\s*[A-Za-z_]\w*)*/.exec(this.code.slice(created ? i + created[0].length : i, stop));
      if (!m) return undefined;
      // `new HttpUrl.Builder()`: the qualified name is the atom's, its call made by the last name.
      const names = m[0].split(/\s*\.\s*/);
      atom = { kind: "name", name: names[0]!, created: !!created };
      j = (created ? i + created[0].length : i) + m[0].length;
      const rest: Segment[] = names.slice(1).map((name) => ({ name }));
      const open = this.callAt(j);
      if (open && rest.length === 0) {
        call = open;
        j = open.close! + 1;
      } else if (open) {
        rest[rest.length - 1]!.call = open;
        j = open.close! + 1;
      }
      const chain = this.postfix({ atom, ...(call ? { call } : {}), segs: rest, end: j }, stop, lines);
      return chain;
    }
    return this.postfix({ atom, segs: [], end: j }, stop, lines);
  }

  /** The members, calls, indexes and unwrappings after a chain's atom, across lines where a `.` starts the next. */
  private postfix(chain: Chain, stop: number, lines: boolean): Chain | undefined {
    let j = chain.end;
    for (;;) {
      if (j >= stop) break;
      const ahead = this.skip(j, true);
      const dot = /^(?:\?\.|\.)(?!\.)/.exec(this.code.slice(ahead, ahead + 2));
      if (dot && (ahead === j || lines || this.lang !== "python")) {
        const k = this.skip(ahead + dot[0].length, true);
        const m = /^[A-Za-z_]\w*/.exec(this.code.slice(k, stop));
        if (!m) return undefined;
        j = k + m[0].length;
        const seg: Segment = { name: m[0] };
        const open = this.callAt(j);
        if (open) {
          seg.call = open;
          j = open.close! + 1;
        }
        chain.segs.push(seg);
        continue;
      }
      const c = this.code[j];
      if (c === "(" || c === "[") {
        const frame = this.scan.frames.get(j);
        if (!frame || frame.close === undefined) return undefined;
        chain.segs.push(c === "(" ? { name: "", call: frame } : { name: "", other: "index" });
        j = frame.close + 1;
      } else if (c === "!" && this.code[j + 1] !== "=") {
        chain.segs.push({ name: "", other: "bang" });
        j += this.code[j + 1] === "!" ? 2 : 1;
      } else {
        // A trailing lambda on the same line (`x.apply { }`) is part of the chain, whose URL atlas does not read.
        const brace = this.skip(j, false);
        if (this.code[brace] === "{" && (this.lang === "kotlin" || this.lang === "swift") && chain.segs.at(-1)?.call !== undefined) {
          const frame = this.scan.frames.get(brace);
          if (!frame || frame.close === undefined) return undefined;
          chain.segs.push({ name: "", other: "block" });
          j = frame.close + 1;
          continue;
        }
        break;
      }
    }
    chain.end = j;
    return chain;
  }

  /** The `(` of a call right after a name, its type arguments (`<T>`) skipped. */
  private callAt(j: number): Frame | undefined {
    let k = j;
    if (this.code[k] === "<") {
      const close = /^<[\w\s.,?<>[\]]*>(?=\s*\()/.exec(this.code.slice(k, k + 200));
      if (!close) return undefined;
      k += close[0].length;
    }
    while (this.code[k] === " " || this.code[k] === "\t") k++;
    if (this.code[k] !== "(") return undefined;
    const frame = this.scan.frames.get(k);
    return frame && frame.close !== undefined ? frame : undefined;
  }

  /** A chain read as a URL by its language's and libraries' rules; undefined where it is a value atlas does not read into. */
  private interpret(chain: Chain): Read | undefined {
    const { atom, segs } = chain;
    // Swift's `!` and Kotlin's `!!` unwrap the value they follow.
    if (segs.at(-1)?.other === "bang" && (this.lang === "swift" || this.lang === "kotlin")) return this.interpret({ ...chain, segs: segs.slice(0, -1) });
    if (segs.length === 0 && !chain.call) {
      if (atom.kind === "literal") return { pieces: this.literalPieces(atom), end: chain.end, literals: [atom.start], built: false };
      if (atom.kind === "paren") {
        const inner = this.parseSum(atom.frame.at + 1, atom.frame.close!, true);
        return inner && !this.code.slice(inner.end, atom.frame.close).trim() ? inner : undefined;
      }
      return undefined;
    }
    switch (this.lang) {
      case "go":
        return this.go(chain);
      case "java":
      case "kotlin":
        return this.jvm(chain);
      case "swift":
        return this.swift(chain);
      case "csharp":
        if (atom.kind === "name" && (atom.name === "string" || atom.name === "String") && segs.length === 1 && segs[0]!.name === "Format" && segs[0]!.call) return this.csharpFormat(segs[0]!.call);
        return undefined;
      case "python":
        if (atom.kind === "literal" && segs.length === 1 && segs[0]!.name === "format" && segs[0]!.call) return this.pythonFormat(atom, segs[0]!.call);
        return undefined;
      case "dart":
        if (atom.kind === "name" && atom.name === "Uri" && segs.length === 1 && segs[0]!.name === "parse" && segs[0]!.call?.parts.length === 1) return this.whole(segs[0]!.call, 0);
        return undefined;
      default:
        return undefined;
    }
  }

  /** The part `index` of a call, read whole as a string expression. */
  private whole(f: Frame, index: number): Read | undefined {
    const p = f.parts[index];
    if (!p) return undefined;
    const read = this.parseSum(p.start, p.end, true);
    return read && !this.code.slice(read.end, p.end).trim() ? read : undefined;
  }

  /** A part read as a string expression, or a hole for a value atlas does not read into. */
  private operandOf(f: Frame, index: number): Read {
    return this.whole(f, index) ?? { pieces: [this.named(nameOf(this.code.slice(f.parts[index]!.start, f.parts[index]!.end)))], end: f.parts[index]!.end, literals: [], built: false };
  }

  private go(chain: Chain): Read | undefined {
    const { atom, segs } = chain;
    const last = segs.at(-1);
    if (atom.kind === "name" && segs.length === 1 && last?.call) {
      const pkg = this.goPackage(atom.name);
      if (pkg === "fmt" && last.name === "Sprintf") return this.printf(last.call, "go");
      if (pkg === "net/url" && last.name === "JoinPath" && last.call.parts.length >= 1) return this.joined(this.operandOf(last.call, 0), last.call, 1, "url");
      if (pkg === "net/url" && (last.name === "Parse" || last.name === "ParseRequestURI") && last.call.parts.length === 1) return this.whole(last.call, 0);
      if (pkg === "path" && last.name === "Join") return this.joined(undefined, last.call, 0, "path");
    }
    if (!last?.call) return undefined;
    // A package's function (`url.JoinPath` where `url` is no package the file imports as `url`) is no URL's method.
    // A name a package of Go is known by (`url`), imported under another, is no URL either: atlas does not tell them apart.
    if (segs.length === 1 && atom.kind === "name" && (this.goImported(atom.name) || [...GO_PACKAGES.values()].includes(atom.name))) return undefined;
    if (segs.length === 1 && atom.kind !== "name") return undefined;
    const before = { ...chain, segs: segs.slice(0, -1) };
    // A *url.URL's own `String()` and `JoinPath(...)`.
    if (last.name === "String" && last.call.parts.length === 0) return this.interpret(before);
    if (last.name === "JoinPath") return this.joined(this.interpret(before) ?? this.valueOf(before), last.call, 0, "url");
    return undefined;
  }

  private jvm(chain: Chain): Read | undefined {
    const { atom, segs } = chain;
    const first = segs[0];
    if (atom.kind === "name" && atom.name === "String" && segs.length === 1 && first?.name === "format" && first.call) return this.printf(first.call, "java");
    if (this.lang === "kotlin" && atom.kind === "literal" && segs.length === 1 && first?.name === "format" && first.call) return this.printf(first.call, "java", atom);
    if (this.imports(/okhttp3\.(?:HttpUrl\b|\*)/)) {
      const okhttp = this.okhttp(chain);
      if (okhttp) return okhttp;
    }
    if (atom.kind === "name" && atom.name === "UriComponentsBuilder" && first?.call && this.imports(/org\.springframework\.web\.util\.(?:UriComponentsBuilder\b|\*)/)) return this.spring(chain);
    return undefined;
  }

  /**
   * An OkHttp `HttpUrl.Builder` chain ending in `build()`: a new builder (`HttpUrl.Builder()`), its path empty and its
   * host the one `host(...)` gives, or one made from a URL (`url.newBuilder()`, `"...".toHttpUrl().newBuilder()`), with
   * its path. `addPathSegment` adds one segment, a `/` in it encoded; `addPathSegments` adds each `/`-separated one;
   * the query, fragment, scheme and port leave the path as it is. Any other call (`setPathSegment`, `encodedPath`)
   * leaves the URL unread.
   */
  private okhttp(chain: Chain): Read | undefined {
    const { atom, segs } = chain;
    const fresh = atom.kind === "name" && atom.name === "HttpUrl" && segs[0]?.name === "Builder" && segs[0].call?.parts.length === 0 ? 1 : -1;
    const made = segs.findIndex((s) => s.name === "newBuilder" && s.call?.parts.length === 0);
    const from = fresh > 0 ? 1 : made >= 0 ? made + 1 : -1;
    if (from < 0) return undefined;
    let rest = segs.slice(from);
    if (rest.at(-1)?.name === "toString" && rest.at(-1)?.call?.parts.length === 0) rest = rest.slice(0, -1);
    if (rest.at(-1)?.name !== "build" || rest.at(-1)?.call?.parts.length !== 0) return undefined;
    rest = rest.slice(0, -1);
    let read: Read;
    // The last `scheme`, `host` and `port` set win, as a builder's setters do.
    const set = (name: string) => rest.filter((s) => s.name === name && s.call?.parts.length === 1).at(-1)?.call;
    const lone = (f: Frame | undefined) => {
      const r = f ? this.whole(f, 0) : undefined;
      return r && r.pieces.length === 1 && "text" in r.pieces[0]! && r.pieces[0].constant === undefined ? r.pieces[0].text : undefined;
    };
    // A builder left unread takes the literals written in its chain, its own calls'.
    const written: number[] = chain.atom.kind === "literal" ? [chain.atom.start] : [];
    for (const g of segs) if (g.call) this.literalsIn(g.call, written);
    const unread = (why: string): Read => ({ pieces: [], end: chain.end, literals: written, built: true, unread: `an OkHttp HttpUrl.Builder ${why}`, builder: true });
    if (fresh > 0) {
      const host = set("host");
      if (!host) return unread("builds a URL without a host");
      const name = host.parts.length === 1 && this.code.slice(host.parts[0]!.start, host.parts[0]!.end).trim().match(/^["']/) ? lone(host) : undefined;
      if (name === undefined) read = { pieces: [{ value: null }], end: chain.end, literals: [], built: true };
      else {
        // A host the code names is checked as an absolute URL's: with the scheme and the port the builder sets.
        const scheme = lone(set("scheme"));
        const port = set("port");
        const number = port ? /^\s*(\d+)\s*$/.exec(this.code.slice(port.parts[0]!.start, port.parts[0]!.end))?.[1] : "";
        if (scheme !== "http" && scheme !== "https") return unread("sets a host with a scheme atlas does not read");
        if (number === undefined) return unread("sets a host with a port atlas does not read");
        read = { pieces: [{ text: `${scheme}://${name}${number ? `:${number}` : ""}` }], end: chain.end, literals: [], built: true };
      }
    } else {
      if (set("host")) return unread("sets the host of the URL it is made from");
      let before: Chain = { ...chain, segs: segs.slice(0, made) };
      // `HttpUrl.get(url)`, `HttpUrl.parse(url)` and Kotlin's `url.toHttpUrl()` make the URL from a string.
      const tail = before.segs.at(-1);
      if (tail?.call && (tail.name === "toHttpUrl" || tail.name === "toHttpUrlOrNull") && tail.call.parts.length === 0) before = { ...before, segs: before.segs.slice(0, -1) };
      else if (atom.kind === "name" && atom.name === "HttpUrl" && before.segs.length === 1 && tail?.call?.parts.length === 1 && (tail.name === "get" || tail.name === "parse")) {
        const url = this.whole(tail.call, 0);
        read = { ...(url ?? this.valueOf(before)), built: true };
        if ((set("scheme") || set("port")) && hostOf(this.assemble(read.pieces).text) !== undefined) return unread("sets the scheme or the port of the URL it is made from");
        return this.okhttpPath(read, rest, chain);
      }
      if (before.segs.at(-1)?.other === "bang") before = { ...before, segs: before.segs.slice(0, -1) };
      read = { ...(this.interpret(before) ?? this.valueOf(before)), built: true };
    }
    // A scheme or a port set on a URL whose host the code names changes where it goes.
    if (fresh < 0 && (set("scheme") || set("port")) && hostOf(this.assemble(read.pieces).text) !== undefined) return unread("sets the scheme or the port of the URL it is made from");
    return this.okhttpPath(read, rest, chain);
  }

  private okhttpPath(start: Read, rest: Segment[], chain: Chain): Read {
    const out: Read = { pieces: [...start.pieces], end: chain.end, literals: [...start.literals], built: true };
    const unread = (why: string): Read => ({ ...out, unread: `an OkHttp HttpUrl.Builder ${why}`, builder: true });
    for (const s of rest) {
      if (!s.call) return unread(`calls ${s.name || "a value"}`);
      this.literalsIn(s.call, out.literals);
      if (s.name === "host" || s.name === "scheme" || s.name === "port" || OKHTTP_KEEPS.has(s.name)) continue;
      if ((s.name === "addPathSegment" || s.name === "addPathSegments") && s.call.parts.length === 1) {
        const one = s.name === "addPathSegment";
        const segment = this.operandOf(s.call, 0).pieces.map((p) => ("text" in p && one ? { ...p, text: p.text.replace(/\//g, "%2F") } : p));
        // OkHttp takes `.` and `..` as dot segments, and an empty segment (`addPathSegments("a//b")`) as a `/`.
        const written = segment.map((p) => ("text" in p ? p.text : HOLE)).join("");
        if (written.split("/").some((t) => t === "." || t === ".." || t === "")) return unread(`adds the segment ${JSON.stringify(written)}`);
        out.pieces.push({ sep: true }, ...segment);
        continue;
      }
      return unread(`calls ${s.name}`);
    }
    return out;
  }

  /**
   * A Spring `UriComponentsBuilder` chain: `fromUriString(url)` or `fromHttpUrl(url)` (the URL's path), `fromPath(path)`;
   * `path(p)` appends `p` as written, `pathSegment(a, b)` adds each as a segment after one `/`, and once the URL is
   * built `//` becomes `/` (`FullPathComponentBuilder`); the query, fragment and encoding leave the path as it is. The
   * chain ends in `build`, `buildAndExpand`, `toUriString` or `toUri`. Any other call leaves the URL unread.
   */
  private spring(chain: Chain): Read | undefined {
    const [first, ...rest] = chain.segs;
    if (!first?.call || first.call.parts.length !== 1 || !["fromUriString", "fromHttpUrl", "fromPath", "fromUri"].includes(first.name)) return undefined;
    let end = rest.length;
    while (end > 0 && rest[end - 1]!.call && SPRING_ENDS.has(rest[end - 1]!.name)) end--;
    if (end === rest.length || !rest.slice(end).some((s) => s.name !== "encode")) return undefined;
    const start = this.operandOf(first.call, 0);
    const out: Read = { pieces: [...start.pieces], end: chain.end, literals: [...start.literals], built: true, sanitize: true };
    for (const s of rest) {
      if (!s.call) return { ...out, unread: `a Spring UriComponentsBuilder reads ${s.name || "a value"}`, builder: true };
      this.literalsIn(s.call, out.literals);
    }
    // After segments, a path gets the `/` it does not start with.
    let segmented = false;
    for (const s of rest.slice(0, end)) {
      if (SPRING_KEEPS.has(s.name)) continue;
      if (s.name === "path" && s.call!.parts.length === 1) {
        const path = this.operandOf(s.call!, 0);
        if (segmented) out.pieces.push({ text: "/" });
        out.pieces.push(...path.pieces);
        segmented = false;
        continue;
      }
      if (s.name === "pathSegment") {
        for (let i = 0; i < s.call!.parts.length; i++) out.pieces.push({ sep: true }, ...this.operandOf(s.call!, i).pieces);
        segmented = s.call!.parts.length > 0 || segmented;
        continue;
      }
      return { ...out, unread: `a Spring UriComponentsBuilder calls ${s.name}`, builder: true };
    }
    return out;
  }

  /**
   * Swift: `URL(string: s)` is `s`; `appendingPathComponent(c)` and `appending(path: c)` put `c` after the URL with one
   * `/` between, a `/` in `c` kept; `appending(component: c)` encodes it (Foundation, URL).
   */
  private swift(chain: Chain): Read | undefined {
    const { atom, segs } = chain;
    if (segs.length === 0 && chain.call && atom.kind === "name" && atom.name === "URL" && chain.call.parts.length === 1) {
      const p = chain.call.parts[0]!;
      const label = /^\s*string\s*:\s*/.exec(this.code.slice(p.start, p.end));
      if (!label) return undefined;
      const read = this.parseSum(p.start + label[0].length, p.end, true);
      return read && !this.code.slice(read.end, p.end).trim() ? read : undefined;
    }
    const last = segs.at(-1);
    if (!last?.call || last.call.parts.length !== 1) return undefined;
    const p = last.call.parts[0]!;
    const label = /^\s*(?:([A-Za-z_]\w*)\s*:)?\s*/.exec(this.code.slice(p.start, p.end))!;
    const kind = last.name === "appendingPathComponent" && !label[1] ? "path" : last.name === "appending" && label[1] === "path" ? "path" : last.name === "appending" && label[1] === "component" ? "component" : undefined;
    if (!kind) return undefined;
    const before: Chain = { ...chain, segs: segs.slice(0, -1) };
    const base = this.interpret(before) ?? this.valueOf(before);
    const component = this.parseSum(p.start + label[0].length, p.end, true);
    const added = component && !this.code.slice(component.end, p.end).trim() ? component : this.valueOf(before, p);
    const pieces = kind === "component" ? added.pieces.map((q) => ("text" in q ? { text: q.text.replace(/\//g, "%2F") } : q)) : added.pieces;
    return { pieces: [...base.pieces, { sep: true }, ...pieces], end: chain.end, literals: [...base.literals, ...added.literals], built: true };
  }

  /** A value atlas does not read into: a hole, by its name where it is one. */
  private valueOf(chain: Chain, part?: { start: number; end: number }): Read {
    const name =
      part !== undefined
        ? nameOf(this.code.slice(part.start, part.end))
        : chain.atom.kind === "name" && !chain.call && !chain.atom.created && chain.segs.length === 0
          ? chain.atom.name
          : chain.atom.kind === "name" && (chain.atom.name === "this" || chain.atom.name === "self") && chain.segs.length === 1 && !chain.segs[0]!.call
            ? chain.segs[0]!.name
            : null;
    return { pieces: [this.named(name)], end: chain.end, literals: [], built: false };
  }

  /**
   * Go's `url.JoinPath(base, elem...)`, `URL.JoinPath(elem...)` and `path.Join(elem...)`: the elements after the base,
   * each after one `/`, empty ones left out, as `path.Join` cleans them. An element that is a `.` or `..` segment, or
   * holds an empty one, is left unread.
   */
  private joined(base: Read | undefined, f: Frame, from: number, by: "path" | "url"): Read {
    // path.Join cleans the whole path (JoinPath the base's path with the elements): `//` is `/`.
    const out: Read = { pieces: [...(base?.pieces ?? [])], end: f.close! + 1, literals: [...(base?.literals ?? [])], built: true, sanitize: true };
    for (let i = from; i < f.parts.length; i++) {
      const part = this.operandOf(f, i);
      out.literals.push(...part.literals);
      const texts = part.pieces.flatMap((p) => ("text" in p ? [p.text] : []));
      if (texts.some((t) => t.split("/").some((s) => s === "." || s === ".."))) return { ...out, unread: "url.JoinPath or path.Join cleans a . or .. segment", builder: true };
      if (part.pieces.length === 1 && "text" in part.pieces[0]! && part.pieces[0].text === "") continue;
      // path.Join's first element keeps a leading `/`, which makes the path the root's.
      if (out.pieces.length === 0) out.pieces.push(...part.pieces);
      else out.pieces.push({ sep: true }, ...part.pieces);
    }
    // path.Join leaves no trailing `/`; JoinPath keeps the one its last element ends in.
    const last = out.pieces.at(-1);
    if (by === "path" && last && "text" in last && /[^/]\/+$/.test(last.text)) out.pieces[out.pieces.length - 1] = { ...last, text: last.text.replace(/\/+$/, "") };
    return out;
  }

  /**
   * A printf-style format: Go's `fmt.Sprintf(format, a...)` and Java's `String.format([locale,] format, args...)`
   * (Kotlin's `format.format(args...)` with `literal`). `%s`, `%d` and `%v` (Go) take the next argument, Java's `%1$s`
   * the one it names; `%%` is a `%`. A verb that writes more than the value (a width, a flag, `%q`, `%x`), an index Go
   * names, or a missing argument leaves the URL unread.
   */
  private printf(f: Frame, style: "go" | "java", literal?: Atom & { kind: "literal" }): Read | undefined {
    const lit = literal ? undefined : (this.loneLiteral(f, 0) ?? (style === "java" ? this.loneLiteral(f, 1) : undefined));
    const format = literal ?? lit?.atom;
    if (!format) return undefined;
    const formatAt = lit ? lit.index : -1;
    const body = this.bodyOf(format);
    const args = literal ? 0 : formatAt + 1;
    const out: Read = { pieces: [], end: f.close! + 1, literals: [format.start], built: true };
    let next = 0;
    let at = 0;
    const verbs = style === "go" ? /%(%|[-+# 0]*(?:\[\d+\])?(?:\d+|\*)?(?:\.(?:\d+|\*)?)?(?:\[\d+\])?[a-zA-Z])/g : /%(%|n|(?:\d+\$)?[-#+ 0,(<]*\d*(?:\.\d+)?[a-zA-Z])/g;
    for (const m of body.matchAll(verbs)) {
      out.pieces.push({ text: body.slice(at, m.index) });
      at = m.index + m[0].length;
      const verb = m[1]!;
      if (verb === "%") {
        out.pieces.push({ text: "%" });
        continue;
      }
      const plain = style === "go" ? /^[sdv]$/.test(verb) : /^(?:(\d+)\$)?([sd])$/.exec(verb);
      if (!plain) return { ...out, unread: `a format verb (%${verb}) writes more than its value` };
      // Java's argument index counts from 1 (Formatter refuses `%0$s`).
      const named = style === "java" && Array.isArray(plain) && plain[1] !== undefined ? Number(plain[1]) : undefined;
      if (named === 0) return { ...out, unread: "a format names argument 0, which Java's Formatter refuses" };
      const index = named !== undefined ? named - 1 : next++;
      const part = args + index;
      if (part >= f.parts.length) return { ...out, unread: "a format has fewer arguments than verbs" };
      const operand = this.operandOf(f, part);
      out.pieces.push(...operand.pieces);
      out.literals.push(...operand.literals);
    }
    out.pieces.push({ text: body.slice(at) });
    return out;
  }

  /**
   * C#'s `string.Format([provider,] format, args...)`: `{0}` (with a `:format`) takes the argument it names, `{{` and
   * `}}` are braces; an alignment (`{0,8}`) pads, and leaves the URL unread.
   */
  private csharpFormat(f: Frame): Read | undefined {
    const lit = this.loneLiteral(f, 0) ?? this.loneLiteral(f, 1);
    if (!lit) return undefined;
    const body = this.bodyOf(lit.atom);
    const out: Read = { pieces: [], end: f.close! + 1, literals: [lit.atom.start], built: true };
    let at = 0;
    for (const m of body.matchAll(/\{\{|\}\}|\{(\d+)(,[^:}]*)?(?::[^}]*)?\}/g)) {
      out.pieces.push({ text: body.slice(at, m.index) });
      at = m.index + m[0].length;
      if (m[0] === "{{" || m[0] === "}}") {
        out.pieces.push({ text: m[0][0]! });
        continue;
      }
      if (m[2]) return { ...out, unread: "a format item pads its value" };
      const part = lit.index + 1 + Number(m[1]);
      if (part >= f.parts.length) return { ...out, unread: "a format has fewer arguments than items" };
      const operand = this.operandOf(f, part);
      out.pieces.push(...operand.pieces);
      out.literals.push(...operand.literals);
    }
    out.pieces.push({ text: body.slice(at) });
    return out;
  }

  /**
   * Python's `str.format(*args, **kwargs)`: `{}` takes the next positional argument, `{0}` the one it numbers, `{name}`
   * the keyword argument; `{{` and `}}` are braces. A field with an attribute, an index, a conversion or a spec is a
   * value; `*args` or `**kwargs`, or numbering both ways, leaves the URL unread.
   */
  private pythonFormat(literal: Atom & { kind: "literal" }, f: Frame): Read | undefined {
    if (/[fF]/.test(literal.prefix)) return undefined;
    const body = this.bodyOf(literal);
    const out: Read = { pieces: [], end: f.close! + 1, literals: [literal.start], built: true };
    const positional: number[] = [];
    const keywords = new Map<string, number>();
    for (let i = 0; i < f.parts.length; i++) {
      const p = f.parts[i]!;
      const text = this.code.slice(p.start, p.end);
      if (/^\s*\*/.test(text)) return { ...out, unread: "str.format takes *args or **kwargs" };
      const keyword = /^\s*([A-Za-z_]\w*)\s*=(?!=)/.exec(text);
      if (keyword) keywords.set(keyword[1]!, i);
      else positional.push(i);
    }
    let auto = 0;
    let numbered = false;
    let text = "";
    // The argument a field's name takes; undefined where it has none, null where it numbers fields both ways.
    const argument = (key: string): number | null | undefined => {
      if (key === "") {
        if (numbered) return null;
        return positional[auto++];
      }
      if (/^\d+$/.test(key)) {
        if (auto > 0) return null;
        numbered = true;
        return positional[Number(key)];
      }
      return keywords.get(key);
    };
    for (let i = 0; i < body.length; ) {
      const c = body[i]!;
      if ((c === "{" || c === "}") && body[i + 1] === c) {
        text += c;
        i += 2;
        continue;
      }
      if (c !== "{") {
        text += c;
        i++;
        continue;
      }
      // A field, its spec's nested fields (`{0:{1}}`) included, as Python's parser reads it.
      const names: Array<{ start: number; end: number }> = [];
      const end = fieldEnd(body, i + 1, (start, stop) => names.push({ start, end: stop }));
      const whole = body.slice(i + 1, end - 1);
      out.pieces.push({ text });
      text = "";
      i = end;
      const keys = names.map((n) => /^([A-Za-z_]\w*|\d*)/.exec(body.slice(n.start, n.end))![1]!);
      const indexes = keys.map(argument);
      if (indexes.includes(null)) return { ...out, unread: "str.format numbers its fields both ways" };
      if (indexes.length === 0 || indexes.includes(undefined)) return { ...out, unread: "str.format has no argument for a field" };
      const key = keys[0]!;
      // A field with an attribute, an index, a conversion or a spec writes a value of its own.
      if (whole !== key) out.pieces.push({ value: null });
      else {
        const value = keywords.has(key) ? this.keywordValue(f, indexes[0]!) : this.operandOf(f, indexes[0]!);
        out.pieces.push(...value.pieces);
        out.literals.push(...value.literals);
      }
    }
    out.pieces.push({ text });
    return out;
  }

  /** Python's `format % values`: `%s`, `%d` and `%i` take the next value of a tuple (or the one value), `%%` is a `%`. */
  private percent(literal: Atom & { kind: "literal" }, i: number, stop: number, lines: boolean): Read | undefined {
    const right = this.parseChain(i, stop, lines);
    if (!right || /[fF]/.test(literal.prefix)) return undefined;
    const body = this.bodyOf(literal);
    const out: Read = { pieces: [], end: right.end, literals: [literal.start], built: true };
    const tuple = right.atom.kind === "paren" && right.segs.length === 0 ? right.atom.frame : undefined;
    let next = 0;
    let at = 0;
    for (const m of body.matchAll(/%(.)/g)) {
      out.pieces.push({ text: body.slice(at, m.index) });
      at = m.index + m[0].length;
      if (m[1] === "%") {
        out.pieces.push({ text: "%" });
        continue;
      }
      if (!/[sdi]/.test(m[1]!)) return { ...out, unread: `a % format's conversion (%${m[1]}) writes more than its value` };
      const index = next++;
      if (tuple) {
        if (index >= tuple.parts.length) return { ...out, unread: "a % format has fewer values than conversions" };
        const operand = this.operandOf(tuple, index);
        out.pieces.push(...operand.pieces);
        out.literals.push(...operand.literals);
      } else if (index === 0) {
        const operand = this.interpret(right) ?? this.valueOf(right);
        out.pieces.push(...operand.pieces);
        out.literals.push(...operand.literals);
      }
      else return { ...out, unread: "a % format has fewer values than conversions" };
    }
    out.pieces.push({ text: body.slice(at) });
    return out;
  }

  /** A keyword argument's value (`name=value`), read. */
  private keywordValue(f: Frame, index: number): Read {
    const p = f.parts[index]!;
    const label = /^\s*[A-Za-z_]\w*\s*=\s*/.exec(this.code.slice(p.start, p.end))!;
    const read = this.parseSum(p.start + label[0].length, p.end, true);
    return read && !this.code.slice(read.end, p.end).trim() ? read : { pieces: [this.named(nameOf(this.code.slice(p.start + label[0].length, p.end)))], end: p.end, literals: [], built: false };
  }

  /** A call's part that is a lone string literal, at `index`. */
  private loneLiteral(f: Frame, index: number): { atom: Atom & { kind: "literal" }; index: number } | undefined {
    const p = f.parts[index];
    if (!p) return undefined;
    const i = this.skip(p.start, true);
    const lit = this.literalAt(i);
    if (!lit || this.code.slice(lit.end, p.end).trim() || lit.prefix) return undefined;
    return { atom: { kind: "literal", ...lit }, index };
  }

  /**
   * The string literals written right in a call's parentheses (or in the calls right in a block), which a builder that
   * reads the call takes: not those of a call nested in them, which runs, and may request, on its own.
   */
  private literalsIn(f: Frame, into: number[]): void {
    for (const a of this.scan.args) {
      if (a.call === f.at) into.push(a.start);
      else if (f.open === "{" && this.scan.frames.get(a.call)?.outer === f.at) into.push(a.start);
    }
  }

  /**
   * Ktor's request builder block, `client.get { url { appendPathSegments("orders", id) } }` (or after a URL,
   * `client.get("users") { ... }`): each `appendPathSegments` (`io.ktor.http`) adds its components as segments, each
   * split at `/`, after the URL's; a URL with no path is relative to the client's base, as `DefaultRequest` resolves it.
   * A block that writes the URL otherwise, or a `url` block with anything but segments and parameters, is not read.
   */
  private ktorBlocks(): StringExpression[] {
    if (this.lang !== "kotlin" || !this.imports(/io\.ktor\.http\.(?:appendPathSegments\b|\*)/)) return [];
    const out: StringExpression[] = [];
    for (const m of this.code.matchAll(/(?<![\w$.])([A-Za-z_]\w*)\s*\.\s*(get|post|put|patch|delete|head|options|request)\s*(\(|\{)/g)) {
      const open = m.index + m[0].length - 1;
      let call: Frame | undefined;
      let block: Frame | undefined;
      if (m[3] === "(") {
        call = this.scan.frames.get(open);
        const after = /^\s*\{/.exec(this.code.slice((call?.close ?? open) + 1));
        block = after && call?.close !== undefined ? this.scan.frames.get(call.close + after[0].length) : undefined;
      } else block = this.scan.frames.get(open);
      if (!block || block.close === undefined) continue;
      const body = block;
      const urls = [...this.scan.frames.values()].filter((f) => f.open === "{" && f.outer === body.at && /(?<![\w$.])url\s*$/.test(this.code.slice(Math.max(0, f.at - 40), f.at)));
      const appends = urls.flatMap((u) => [...this.scan.frames.values()].filter((f) => f.outer === u.at && f.name === "appendPathSegments"));
      if (appends.length === 0) continue;
      const start = m.index;
      const end = block.close + 1;
      const literals: number[] = [];
      for (const u of urls) this.literalsIn(u, literals);
      if (call) this.literalsIn(call, literals);
      const anchor: Argument = { start, end, name: m[2]!, method: true, receiver: m[1]!, index: 0, call: call?.at ?? block.at };
      const method = m[2] === "request" ? undefined : m[2]!.toUpperCase();
      const own = m[2] === "request" ? { block: block.at } : { method: method! };
      const all: number[] = [...literals];
      this.literalsIn(block, all);
      const unread = (why: string): StringExpression => ({ start, end, text: "", literals: all, anchor, ...own, unread: `a Ktor request's block ${why}`, builder: true });
      // Outside its `url { }` blocks, the request's block sets no other URL.
      let outside = this.code.slice(block.at + 1, block.close);
      for (const u of urls) outside = outside.slice(0, u.at - block.at - 1) + " ".repeat(u.close! - u.at + 1) + outside.slice(u.close! - block.at);
      if (/(?<![\w$.])url\s*(?:\(|\.|=)/.test(outside)) {
        out.push(unread("sets the URL otherwise"));
        continue;
      }
      let pieces: Piece[] = [];
      if (call && call.parts.length > 0) {
        const first = call.parts.length === 1 ? this.whole(call, 0) : undefined;
        if (!first || first.built) {
          out.push(unread("adds segments to a URL atlas does not read"));
          continue;
        }
        pieces = first.pieces;
      }
      let bad: string | undefined;
      for (const u of urls) {
        // Only segments and the query: each statement is `appendPathSegments(...)` or on `parameters`.
        let body = this.code.slice(u.at + 1, u.close);
        for (const f of this.scan.frames.values()) if (f.outer === u.at && f.open === "(" && f.close !== undefined && (f.name === "appendPathSegments" || f.receiver === "parameters")) body = body.slice(0, f.at - u.at - 1) + " ".repeat(f.close - f.at + 1) + body.slice(f.close - u.at);
        if (body.replace(/(?<![\w$.])appendPathSegments|(?<![\w$.])parameters\s*\.\s*\w+|[\s;]/g, "")) bad ??= "writes the URL in its url block otherwise";
      }
      for (const f of appends) {
        if (bad) break;
        if (f.parts.some((p) => /^\s*encodeSlash\s*=/.test(this.code.slice(p.start, p.end)))) {
          bad = "encodes a / in a segment";
          break;
        }
        // The components split at each `/`; an empty segment but a leading or a trailing one is a `//`.
        const parts = f.parts.map((_, i) => this.operandOf(f, i).pieces);
        const written = parts.map((part) => part.map((q) => ("text" in q ? q.text : HOLE)).join("")).join("/");
        if (written.split("/").slice(1, -1).some((t) => t === "")) bad = "adds an empty segment";
        for (const part of parts) {
          if (pieces.length) pieces.push({ sep: true });
          pieces.push(...part);
        }
      }
      if (bad) {
        out.push(unread(bad));
        continue;
      }
      const assembled = this.assemble(pieces);
      out.push({ start, end, text: assembled.text, literals, anchor, ...own });
    }
    return out;
  }

  /** A string constant of the file: `const string X = "..."` (C#), `static final String X` (Java), `const val X` (Kotlin), `const X` (Go, Dart), `static let X` (Swift). */
  private constant(name: string): { text: string; at: number } | undefined {
    if (!this.consts) {
      this.consts = new Map();
      const patterns: Partial<Record<Lang, RegExp>> = {
        csharp: /\bconst\s+string\s+([A-Za-z_]\w*)\s*=\s*(?=")/g,
        java: /\b(?:static\s+final|final\s+static)\s+String\s+([A-Za-z_]\w*)\s*=\s*(?=")/g,
        kotlin: /\bconst\s+val\s+([A-Za-z_]\w*)\s*(?::\s*String\s*)?=\s*(?=")/g,
        go: /\bconst\s+([A-Za-z_]\w*)\s*(?:string\s*)?=\s*(?=["`])/g,
        dart: /\bconst\s+(?:String\s+)?([A-Za-z_]\w*)\s*=\s*(?=['"])/g,
        swift: /\bstatic\s+let\s+([A-Za-z_]\w*)\s*(?::\s*String\s*)?=\s*(?=")/g,
      };
      const pattern = this.lang ? patterns[this.lang] : undefined;
      for (const m of pattern ? this.code.matchAll(pattern) : []) {
        const at = m.index + m[0].length;
        const lit = this.literalAt(at);
        const name = m[1]!;
        if (!lit || !/^\s*(?:;|$)/m.test(this.code.slice(lit.end, lit.end + 40))) continue;
        const pieces = this.literalPieces(lit);
        const text = pieces.length === 1 && "text" in pieces[0]! && pieces[0].constant === undefined && !pieces[0].text.includes(HOLE) ? pieces[0].text : undefined;
        // A name assigned twice, or a parameter's, may hold another value where it is used.
        const assigned = [...this.code.matchAll(new RegExp(`(?<![\\w$.])${name}\\s*(?::=|=(?!=))`, "g"))].length;
        const parameter = new RegExp(`[(,]\\s*[A-Za-z_][\\w<>[\\]?.]*\\s+${name}\\s*[,)=]|[(,]\\s*${name}\\s*:\\s*[A-Za-z_]|[(,]\\s*${name}\\s+[A-Za-z_*[]`).test(this.code);
        this.consts.set(name, text !== undefined && !this.consts.has(name) && assigned === 1 && !parameter ? { text, at: lit.start } : null);
      }
    }
    return this.consts.get(name) ?? undefined;
  }

  /** The name a Go file's code refers to an imported package by: its own, or the one the import gives it. */
  private goPackage(name: string): string | undefined {
    const path = this.goImports().get(name);
    return path !== undefined && GO_PACKAGES.has(path) ? path : undefined;
  }

  /** Whether a Go file's code names an imported package by `name`. */
  private goImported(name: string): boolean {
    return this.goImports().has(name);
  }

  /** The packages a Go file imports, by the name its code refers to each by (the alias, else the package's name), read by Go's parser. */
  private goImports(): Map<string, string> {
    if (!this.goNames) {
      this.goNames = new Map();
      let imports: ReturnType<typeof parseGo>["imports"];
      try {
        imports = parseGo(this.text).imports;
      } catch {
        imports = [];
      }
      for (const i of imports) {
        const segments = i.path.split("/");
        // A major version's suffix (`.../v2`) is no part of the package's name.
        const last = segments.length > 1 && /^v\d+$/.test(segments.at(-1)!) ? segments.at(-2)! : segments.at(-1)!;
        const local = i.name ?? GO_PACKAGES.get(i.path) ?? last.replace(/\.v\d+$/, "").replace(/^go-/, "");
        if (local !== "." && local !== "_") this.goNames.set(local, i.path);
      }
    }
    return this.goNames;
  }

  /** Whether a JVM file imports a name, by itself or with its package's `*`, without renaming it. */
  private imports(names: RegExp): boolean {
    return new RegExp(`^\\s*import\\s+(?:${names.source})\\s*;?\\s*$`, "m").test(this.code);
  }

  /** The value a declaration ending in `text` (with its `=` or `:=`) declares, by its language's syntax. */
  private declared(text: string): string | undefined {
    const patterns: Record<Lang, RegExp> = {
      go: /(?:\bvar\s+([A-Za-z_]\w*)(?:\s+[\w.*[\]]+)?\s*=|(?<![\w.])([A-Za-z_]\w*)(?:\s*,\s*[A-Za-z_]\w*)*\s*:=)$/,
      kotlin: /\b(?:val|var)\s+([A-Za-z_]\w*)(?:\s*:\s*[\w.<>?, ]+)?\s*=$/,
      swift: /\b(?:let|var)\s+([A-Za-z_]\w*)(?:\s*:\s*[\w.<>?[\], ]+)?\s*=$/,
      java: /(?:\bvar|\bfinal|(?<![\w.])[A-Z]\w*(?:<[\w\s.,?<>[\]]*>)?(?:\[\])?)\s+([A-Za-z_]\w*)\s*=$/,
      csharp: /(?:\bvar|\bstring|(?<![\w.])[A-Z]\w*(?:<[\w\s.,?<>[\]]*>)?(?:\[\])?\??)\s+([A-Za-z_]\w*)\s*=$/,
      dart: /(?:\bvar|\bfinal|\bfinal\s+[A-Za-z]\w*(?:<[\w\s.,?<>[\]]*>)?\??|(?<![\w.])[A-Z]\w*(?:<[\w\s.,?<>[\]]*>)?\??)\s+([A-Za-z_]\w*)\s*=$/,
      python: /^(?!)/,
    };
    const m = patterns[this.lang!].exec(text);
    return m ? (m[1] ?? m[2]) : undefined;
  }

  /** The innermost bracket of a kind an offset is inside. */
  private enclosing(at: number, open: Frame["open"]): Frame | undefined {
    let best: Frame | undefined;
    for (const f of this.scan.frames.values()) if (f.open === open && f.at < at && (f.close ?? Infinity) >= at && (!best || f.at > best.at)) best = f;
    return best;
  }

  /** Which offsets lie inside parentheses or square brackets, where no statement starts. */
  private brackets(): Uint8Array {
    if (!this.inBrackets) {
      this.inBrackets = new Uint8Array(this.text.length + 1);
      for (const f of this.scan.frames.values()) if (f.open !== "{" && f.close !== undefined) this.inBrackets.fill(1, f.at + 1, f.close);
    }
    return this.inBrackets;
  }

  /** Past spaces and tabs, and line breaks where `lines`, and Python's `\` line joins. */
  private skip(i: number, lines: boolean): number {
    while (i < this.code.length) {
      const c = this.code[i]!;
      if (c === " " || c === "\t" || c === "\r" || (lines && c === "\n")) i++;
      else if (c === "\\" && this.code[i + 1] === "\n" && this.lang === "python") i += 2;
      else break;
    }
    return i;
  }

  /** The prefix written right before the quote at `start` (`f`, `$`, `@`, `r`), where its language has one. */
  private prefixBefore(start: number): string {
    const prefixes: Partial<Record<Lang, RegExp>> = { python: /(?<![\w$])[rRbBuUfF]{1,2}$/, csharp: /(?<![\w$])(?:\$@?|@\$?)$/, dart: /(?<![\w$])r$/ };
    const pattern = this.lang ? prefixes[this.lang] : undefined;
    return pattern?.exec(this.text.slice(Math.max(0, start - 3), start))?.[0] ?? "";
  }

  /** The string literal at `i`, with the prefix its language writes before the quote (`f`, `$`, `@`, `r`). */
  private literalAt(i: number): { start: number; end: number; prefix: string } | undefined {
    const prefixes: Partial<Record<Lang, RegExp>> = { python: /^[rRbBuUfF]{1,2}(?=["'])/, csharp: /^(?:\$@?|@\$?)(?=")/, dart: /^r(?=["'])/ };
    const pattern = this.lang ? prefixes[this.lang] : undefined;
    const m = pattern?.exec(this.text.slice(i, i + 3));
    if (m && /[\w$]/.test(this.text[i - 1] ?? "")) return undefined;
    const start = i + (m?.[0].length ?? 0);
    const end = this.strings.get(start);
    if (end === undefined) return undefined;
    const q = this.quote(start);
    if (end - start < 2 * q.length || !this.text.startsWith(q, end - q.length)) return undefined;
    return { start, end, prefix: m?.[0] ?? "" };
  }

  private quote(start: number): string {
    const c = this.text[start]!;
    return this.text.startsWith(c.repeat(3), start) && (c === '"' || this.lang === "python" || this.lang === "dart") ? c.repeat(3) : c;
  }

  /** A literal's text between its quotes. */
  private bodyOf(lit: { start: number; end: number }): string {
    const q = this.quote(lit.start).length;
    return this.text.slice(lit.start + q, lit.end - q);
  }

  /** A literal's pieces: its text, and each interpolation its language writes a value, by its name where it is one. */
  private literalPieces(lit: { start: number; end: number; prefix: string }): Piece[] {
    const body = this.bodyOf(lit);
    const legacy = (text: string): Piece => ({ text: text.replace(LEGACY, HOLE) });
    const out: Piece[] = [];
    let text = "";
    const flush = (keepHoles: boolean) => {
      if (text) out.push(keepHoles ? { text } : legacy(text));
      text = "";
    };
    switch (this.lang) {
      case "kotlin":
      case "dart": {
        if (lit.prefix === "r") return [legacy(body)];
        const raw = this.text[lit.start] === '"' && this.quote(lit.start).length === 3 && this.lang === "kotlin";
        for (let i = 0; i < body.length; ) {
          const c = body[i]!;
          if (c === "\\" && !raw) {
            text += body.slice(i, i + 2);
            i += 2;
          } else if (c === "$" && body[i + 1] === "{") {
            const close = matching(body, i + 1, "{", "}");
            if (close < 0) return [legacy(body)];
            flush(false);
            out.push(this.named(nameOf(body.slice(i + 2, close))));
            i = close + 1;
          } else if (c === "$" && /[A-Za-z_]/.test(body[i + 1] ?? "")) {
            const name = /^[A-Za-z_]\w*/.exec(body.slice(i + 1))![0];
            flush(false);
            out.push(this.named(name));
            i += 1 + name.length;
          } else {
            text += c;
            i++;
          }
        }
        flush(false);
        return out;
      }
      case "swift": {
        for (let i = 0; i < body.length; ) {
          if (body[i] === "\\" && body[i + 1] === "(") {
            const close = matching(body, i + 1, "(", ")");
            if (close < 0) return [legacy(body)];
            flush(false);
            out.push(this.named(nameOf(body.slice(i + 2, close))));
            i = close + 1;
          } else if (body[i] === "\\") {
            text += body.slice(i, i + 2);
            i += 2;
          } else text += body[i++];
        }
        flush(false);
        return out;
      }
      case "csharp": {
        if (!lit.prefix.includes("$")) return [legacy(body)];
        for (let i = 0; i < body.length; ) {
          const c = body[i]!;
          if ((c === "{" || c === "}") && body[i + 1] === c) {
            text += c;
            i += 2;
          } else if (c === "{") {
            const close = matching(body, i, "{", "}");
            if (close < 0) return [legacy(body)];
            flush(true);
            out.push(this.named(nameOf(/^[^,:]*/.exec(body.slice(i + 1, close))![0])));
            i = close + 1;
          } else {
            text += c;
            i++;
          }
        }
        flush(true);
        return out;
      }
      case "python": {
        if (!/[fF]/.test(lit.prefix)) return [legacy(body)];
        for (let i = 0; i < body.length; ) {
          const c = body[i]!;
          if ((c === "{" || c === "}") && body[i + 1] === c) {
            text += c;
            i += 2;
          } else if (c === "{") {
            let expression = "";
            i = fieldEnd(body, i + 1, (s, e) => (expression ||= body.slice(s, e)));
            flush(true);
            out.push(this.named(nameOf(expression)));
          } else {
            text += c;
            i++;
          }
        }
        flush(true);
        return out;
      }
      default:
        return [legacy(body)];
    }
  }
}

/**
 * A URL with each `//` of its path written `/`, as Spring's built path and Go's cleaned one are: its scheme's `//`,
 * and its query and fragment, are kept.
 */
function cleanPath(url: string): string {
  const m = /^([A-Za-z][A-Za-z0-9+.-]*:\/\/[^/?#]*)?([^?#]*)([\s\S]*)$/.exec(url)!;
  return `${m[1] ?? ""}${m[2]!.replace(/\/{2,}/g, "/")}${m[3]}`;
}

/** Where the bracket that opens at `open` closes, nested ones counted; -1 where it does not. */
function matching(text: string, open: number, opener: string, closer: string): number {
  let depth = 0;
  for (let i = open; i < text.length; i++) {
    if (text[i] === opener) depth++;
    else if (text[i] === closer && --depth === 0) return i;
  }
  return -1;
}
