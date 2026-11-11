/**
 * A lexer for C#, after the C# language specification's lexical structure (§6.4): comments, preprocessing directives,
 * identifiers (`@` verbatim ones too), numbers, character literals and every string literal form: regular, verbatim
 * (`@"..."`), raw (`"""..."""`, C# 11), interpolated (`$"..."`, `$@"..."`, `$$"""..."""`) and UTF-8 (`"..."u8`). A
 * string's value is the text it stands for; an interpolated one keeps its holes, each lexed as an expression. Nothing
 * in a comment, a directive line or a string is a token of the code, so text there never reads as code.
 */

export interface Token {
  kind: "id" | "str" | "num" | "char" | "punct";
  /** The identifier (without a verbatim `@`), the punctuator, or the source text of a number or character literal. */
  text: string;
  start: number;
  end: number;
  /** A string's parts: the text it holds, and the tokens of each interpolation hole. */
  parts?: Array<string | Token[]>;
}

// Longest first. `>>` and `>>=` are no tokens of the lexical grammar (C# spec §6.4.6, "right_shift"): two `>`, as the
// close of nested type arguments is.
const PUNCTS = ["<<=", "<<", "=>", "::", "?.", "??=", "??", "==", "!=", "<=", ">=", "&&", "||", "++", "--", "+=", "-=", "*=", "/=", "%=", "&=", "|=", "^=", "..", "->"];

const isIdStart = (c: string): boolean => /[\p{L}\p{Nl}_]/u.test(c);
const isIdPart = (c: string): boolean => /[\p{L}\p{Nl}\p{Nd}\p{Mn}\p{Mc}\p{Pc}\p{Cf}_]/u.test(c);

/** Where a line ends after `at`: its line terminator (CR, LF, NEL, LS, PS), or the end of the text. */
function lineEnd(text: string, at: number): number {
  let i = at;
  while (i < text.length && !/[\r\n\u0085\u2028\u2029]/.test(text[i]!)) i++;
  return i;
}

/** Where a `#if false` region ending at `from` (its directive's line end) stops: at the directive line that closes it. */
function disabledEnd(t: string, from: number): number {
  let depth = 0;
  for (let i = from; i < t.length; ) {
    // Past the line terminator, then the next line, as `lineEnd` reads lines.
    i += t.startsWith("\r\n", i) ? 2 : 1;
    const end = lineEnd(t, i);
    const directive = /^[ \t]*#[ \t]*(if|elif|else|endif)\b/.exec(t.slice(i, end));
    if (directive?.[1] === "if") depth++;
    else if (directive && depth === 0) return i;
    else if (directive?.[1] === "endif") depth--;
    i = end;
  }
  return t.length;
}

/** The character a `\uXXXX` or `\UXXXXXXXX` escape at `at` stands for in an identifier, with where it ends. */
function idEscape(t: string, at: number): { ch: string; end: number } | undefined {
  const m = /^\\(?:u([0-9A-Fa-f]{4})|U([0-9A-Fa-f]{8}))/.exec(t.slice(at, at + 10));
  if (!m) return undefined;
  const cp = parseInt(m[1] ?? m[2]!, 16);
  return cp <= 0x10ffff ? { ch: String.fromCodePoint(cp), end: at + m[0].length } : undefined;
}

/** The tokens of C# source text. Text it cannot lex as C# (an unterminated string) ends the tokens there. */
export function lexCSharp(text: string): Token[] {
  return lex(text).tokens;
}

/** The tokens of C# source text, and where a string it cannot read (one left open) stops them, if one does. */
export function lex(text: string): { tokens: Token[]; stopped?: number } {
  const lexer = new Lexer(text);
  const tokens: Token[] = [];
  for (let t = lexer.next(); t; t = lexer.next()) tokens.push(t);
  return { tokens, ...(lexer.failed !== undefined ? { stopped: lexer.failed } : {}) };
}

class Lexer {
  pos = 0;
  /** Where a string literal this lexer cannot read starts. */
  failed: number | undefined;
  /** Whether only whitespace stands between the last line start and `pos`, where a `#` starts a directive. */
  private lineStart = true;
  constructor(private readonly text: string) {}

  next(): Token | undefined {
    const t = this.text;
    for (;;) {
      if (this.pos >= t.length) return undefined;
      const c = t[this.pos]!;
      if (/[\r\n\u0085\u2028\u2029]/.test(c)) {
        this.pos++;
        this.lineStart = true;
        continue;
      }
      if (/\s/.test(c)) {
        this.pos++;
        continue;
      }
      if (c === "/" && t[this.pos + 1] === "/") {
        this.pos = lineEnd(t, this.pos);
        continue;
      }
      if (c === "/" && t[this.pos + 1] === "*") {
        const close = t.indexOf("*/", this.pos + 2);
        this.pos = close < 0 ? t.length : close + 2;
        continue;
      }
      if (c === "#" && this.lineStart) {
        const end = lineEnd(t, this.pos);
        // `#if false` leaves out what follows up to its `#else`, `#elif` or `#endif` (nested `#if`s within it too); a
        // condition on symbols is decided by the build, so both of its branches are read.
        if (/^#\s*if\s+false\s*(?:\/\/.*)?$/.test(t.slice(this.pos, end).trimEnd())) this.pos = disabledEnd(t, end);
        else this.pos = end;
        continue;
      }
      break;
    }
    this.lineStart = false;
    return this.token();
  }

  private token(): Token | undefined {
    const t = this.text;
    const start = this.pos;
    const c = t[start]!;
    // String forms that start with `$` or `@`, in either order.
    const prefix = /^(\$+@?|@\$+|@)(?=")/.exec(t.slice(start, start + 12));
    if (prefix || c === '"') {
      const str = this.string(start, prefix?.[1] ?? "");
      if (!str && this.failed === undefined) this.failed = start;
      return str;
    }
    // An identifier may start with a Unicode escape of a letter (C# spec §6.4.3).
    const startsId = (at: number) => isIdStart(t[at] ?? "") || isIdStart(idEscape(t, at)?.ch ?? "");
    if (c === "@" && startsId(start + 1)) {
      this.pos = start + 1;
      const id = this.identifier();
      return { kind: "id", text: id, start, end: this.pos };
    }
    if (startsId(start)) return { kind: "id", text: this.identifier(), start, end: this.pos };
    if (/[0-9]/.test(c) || (c === "." && /[0-9]/.test(t[start + 1] ?? ""))) return this.number(start);
    if (c === "'") return this.character(start);
    const punct = PUNCTS.find((p) => t.startsWith(p, start)) ?? c;
    this.pos = start + punct.length;
    return { kind: "punct", text: punct, start, end: this.pos };
  }

  /** An identifier's name, its Unicode escapes read as the characters they stand for. */
  private identifier(): string {
    const t = this.text;
    let out = "";
    while (this.pos < t.length) {
      const escaped = t[this.pos] === "\\" ? idEscape(t, this.pos) : undefined;
      const ch = escaped?.ch ?? String.fromCodePoint(t.codePointAt(this.pos)!);
      if (!isIdPart(ch)) break;
      out += ch;
      this.pos = escaped?.end ?? this.pos + ch.length;
    }
    return out;
  }

  private number(start: number): Token {
    const t = this.text;
    let i = start;
    if (/^0[xXbB]/.test(t.slice(i, i + 2))) {
      i += 2;
      while (/[0-9A-Fa-f_]/.test(t[i] ?? "")) i++;
    } else {
      while (/[0-9_]/.test(t[i] ?? "")) i++;
      if (t[i] === "." && /[0-9]/.test(t[i + 1] ?? "")) {
        i++;
        while (/[0-9_]/.test(t[i] ?? "")) i++;
      }
      if (/[eE]/.test(t[i] ?? "") && /^[eE][+-]?[0-9]/.test(t.slice(i, i + 3))) {
        i += t[i + 1] === "+" || t[i + 1] === "-" ? 2 : 1;
        while (/[0-9_]/.test(t[i] ?? "")) i++;
      }
    }
    while (/[uUlLfFdDmM]/.test(t[i] ?? "")) i++;
    this.pos = i;
    return { kind: "num", text: t.slice(start, i), start, end: i };
  }

  private character(start: number): Token {
    const t = this.text;
    let i = start + 1;
    while (i < t.length && t[i] !== "'" && !/[\r\n]/.test(t[i]!)) i += t[i] === "\\" ? 2 : 1;
    this.pos = Math.min(t.length, i + 1);
    return { kind: "char", text: t.slice(start, this.pos), start, end: this.pos };
  }

  /** A string literal whose `"` is at `start + prefix.length`. */
  private string(start: number, prefix: string): Token | undefined {
    const t = this.text;
    const dollars = (prefix.match(/\$/g) ?? []).length;
    const verbatim = prefix.includes("@");
    const open = start + prefix.length;
    let quotes = 0;
    while (t[open + quotes] === '"') quotes++;
    // `""` is an empty string; three quotes or more open a raw string.
    if (quotes >= 3 && !verbatim) return this.raw(start, open, quotes, dollars);
    this.pos = open + 1;
    const parts: Array<string | Token[]> = [];
    let buf = "";
    for (;;) {
      if (this.pos >= t.length) return undefined;
      const c = t[this.pos]!;
      if (c === '"') {
        if (verbatim && t[this.pos + 1] === '"') {
          buf += '"';
          this.pos += 2;
          continue;
        }
        this.pos++;
        break;
      }
      if (!verbatim && /[\r\n]/.test(c)) return undefined;
      if (dollars && (c === "{" || c === "}")) {
        if (t[this.pos + 1] === c) {
          buf += c;
          this.pos += 2;
          continue;
        }
        if (c === "}") return undefined;
        if (buf) parts.push(buf);
        buf = "";
        this.pos++;
        const hole = this.hole(1);
        if (!hole) return undefined;
        parts.push(hole);
        continue;
      }
      if (!verbatim && c === "\\") {
        const e = escape(t, this.pos);
        if (!e) return undefined;
        buf += e.value;
        this.pos = e.end;
        continue;
      }
      buf += c;
      this.pos++;
    }
    if (buf || !parts.length) parts.push(buf);
    if (t.slice(this.pos, this.pos + 2) === "u8") this.pos += 2;
    return { kind: "str", text: t.slice(start, this.pos), start, end: this.pos, parts };
  }

  /**
   * The tokens of an interpolation hole, after its opening brace(s), up to the `}` (or `braces` of them) that closes
   * it; an alignment (`,5`) or format (`:N2`) after the expression is passed over.
   */
  private hole(braces: number): Token[] | undefined {
    const t = this.text;
    const tokens: Token[] = [];
    let depth = 0;
    for (;;) {
      const tok = this.next();
      if (!tok) return undefined;
      if (tok.kind === "punct" && "([{".includes(tok.text)) depth++;
      else if (tok.kind === "punct" && ")]".includes(tok.text)) depth--;
      else if (tok.kind === "punct" && tok.text === "}") {
        if (depth === 0) {
          this.pos = tok.start;
          break;
        }
        depth--;
      } else if (depth === 0 && tok.kind === "punct" && tok.text === ":") {
        // The format runs to the closing brace; an alignment (`,5`) stays among the tokens, so the hole's value is
        // not read as the bare expression's.
        this.pos = tok.end;
        while (this.pos < t.length && t[this.pos] !== "}") this.pos++;
        break;
      }
      tokens.push(tok);
    }
    for (let i = 0; i < braces; i++) {
      if (t[this.pos] !== "}") return undefined;
      this.pos++;
    }
    return tokens;
  }

  /**
   * A raw string literal (C# 11): `quotes` quotes open and close it; a multi-line one starts on the line after the
   * opening quotes and ends on the line before the closing ones, each line without the whitespace before them. With
   * `dollars` `$`, that many braces open an interpolation hole and fewer are text.
   */
  private raw(start: number, open: number, quotes: number, dollars: number): Token | undefined {
    const t = this.text;
    const bodyStart = open + quotes;
    // The closing quotes are the first run of at least `quotes` outside an interpolation hole (whose code may hold a raw
    // string of its own); a longer run is an error.
    const holes = new Map<number, { run: number; end: number; tokens: Token[] }>();
    let close = -1;
    for (let i = bodyStart; i < t.length; ) {
      const c = t[i];
      if (dollars && c === "{") {
        let run = 0;
        while (t[i + run] === "{") run++;
        if (run >= dollars) {
          this.pos = i + run;
          const tokens = this.hole(dollars);
          if (!tokens) return undefined;
          holes.set(i, { run, end: this.pos, tokens });
          i = this.pos;
        } else i += run;
        continue;
      }
      if (c === '"') {
        let run = 0;
        while (t[i + run] === '"') run++;
        if (run > quotes) return undefined;
        if (run === quotes) {
          close = i;
          break;
        }
        i += run;
        continue;
      }
      i++;
    }
    if (close < 0) return undefined;
    let after = close + quotes;
    const parts: Array<string | Token[]> = [];
    let buf = "";
    /** Text from `i` to `end`, each hole as its tokens; at each line start, `indent` is left out. */
    const read = (from: number, end: number, indent?: string): boolean => {
      let lineStart = indent !== undefined;
      for (let i = from; i < end; ) {
        if (lineStart) {
          lineStart = false;
          const lineStop = lineEnd(t, i);
          if (t.startsWith(indent!, i)) i += indent!.length;
          else if (!t.slice(i, Math.min(lineStop, end)).trim()) i = Math.min(lineStop, end);
          else return false;
          continue;
        }
        const hole = holes.get(i);
        if (hole) {
          // Braces beyond `dollars` are text before the hole.
          buf += "{".repeat(hole.run - dollars);
          if (buf) parts.push(buf);
          buf = "";
          parts.push(hole.tokens);
          i = hole.end;
          continue;
        }
        if (indent !== undefined && /[\r\n\u0085\u2028\u2029]/.test(t[i]!)) {
          const nl = t.startsWith("\r\n", i) ? "\r\n" : t[i]!;
          buf += nl;
          i += nl.length;
          lineStart = true;
          continue;
        }
        buf += t[i];
        i++;
      }
      return true;
    };
    const firstLineEnd = lineEnd(t, bodyStart);
    if (firstLineEnd < close) {
      // Multi-line: the content runs from the line after the opening quotes to the line before the closing ones, each
      // line without the closing line's whitespace.
      if (t.slice(bodyStart, firstLineEnd).trim()) return undefined;
      let lastLineStart = close;
      while (lastLineStart > firstLineEnd && !/[\r\n\u0085\u2028\u2029]/.test(t[lastLineStart - 1]!)) lastLineStart--;
      const indent = t.slice(lastLineStart, close);
      if (indent.trim()) return undefined;
      const contentStart = firstLineEnd + (t.startsWith("\r\n", firstLineEnd) ? 2 : 1);
      const contentEnd = lastLineStart - (t.slice(lastLineStart - 2, lastLineStart) === "\r\n" ? 2 : 1);
      if (contentStart <= contentEnd && !read(contentStart, contentEnd, indent)) return undefined;
    } else read(bodyStart, close);
    if (buf || !parts.length) parts.push(buf);
    if (t.slice(after, after + 2) === "u8") after += 2;
    this.pos = after;
    return { kind: "str", text: t.slice(start, after), start, end: after, parts };
  }
}

/** The character a simple, hexadecimal or Unicode escape sequence at `at` stands for. */
function escape(t: string, at: number): { value: string; end: number } | undefined {
  const c = t[at + 1];
  const simple: Record<string, string> = { "'": "'", '"': '"', "\\": "\\", "0": "\0", a: "\x07", b: "\b", e: "\x1b", f: "\f", n: "\n", r: "\r", t: "\t", v: "\v" };
  if (c !== undefined && Object.hasOwn(simple, c)) return { value: simple[c]!, end: at + 2 };
  if (c === "u" && /^[0-9A-Fa-f]{4}$/.test(t.slice(at + 2, at + 6))) return { value: String.fromCharCode(parseInt(t.slice(at + 2, at + 6), 16)), end: at + 6 };
  if (c === "U" && /^[0-9A-Fa-f]{8}$/.test(t.slice(at + 2, at + 10))) {
    const cp = parseInt(t.slice(at + 2, at + 10), 16);
    return cp <= 0x10ffff ? { value: String.fromCodePoint(cp), end: at + 10 } : undefined;
  }
  if (c === "x") {
    const m = /^[0-9A-Fa-f]{1,4}/.exec(t.slice(at + 2, at + 6));
    if (m) return { value: String.fromCharCode(parseInt(m[0], 16)), end: at + 2 + m[0].length };
  }
  return undefined;
}

/** A string token's value where it holds no interpolation hole; undefined for any other token. */
export function stringValue(token: Token | undefined): string | undefined {
  if (token?.kind !== "str" || !token.parts) return undefined;
  return token.parts.every((p) => typeof p === "string") ? (token.parts).join("") : undefined;
}

/**
 * For each opening bracket's index, the index of the bracket that closes it: `(`, `[` and `{`. Brackets that do not
 * pair up (in code that does not compile) are left out.
 */
export function bracketPairs(tokens: Token[]): Map<number, number> {
  const pairs = new Map<number, number>();
  const stack: number[] = [];
  const closes: Record<string, string> = { ")": "(", "]": "[", "}": "{" };
  tokens.forEach((tok, i) => {
    if (tok.kind !== "punct") return;
    if (tok.text === "(" || tok.text === "[" || tok.text === "{") stack.push(i);
    else if (Object.hasOwn(closes, tok.text)) {
      // Unwind to the opening bracket of this kind; anything left open within it does not pair.
      const at = stack.map((j) => tokens[j]!.text).lastIndexOf(closes[tok.text]!);
      if (at < 0) return;
      pairs.set(stack[at]!, i);
      stack.length = at;
    }
  });
  return pairs;
}

/** The text with each comment, directive and string literal's text blanked out, at the same offsets and lines. */
export function maskCSharp(text: string): string {
  const out = text.replace(/[^\r\n\u2028\u2029]/g, " ").split("");
  for (const t of lexCSharp(text)) {
    if (t.kind === "str") out.splice(t.start, 2, '"', '"');
    else for (let i = t.start; i < t.end; i++) out[i] = text[i]!;
  }
  return out.join("");
}
