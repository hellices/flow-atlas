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

const PUNCTS = ["=>", "::", "?.", "??=", "??", "==", "!=", "<=", "&&", "||", "++", "--", "+=", "-=", "*=", "/=", "%=", "&=", "|=", "^=", "..", "->"];

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
  const lines = /^[ \t]*#[ \t]*(if|elif|else|endif)\b.*$/gm;
  lines.lastIndex = from;
  for (let m = lines.exec(t); m; m = lines.exec(t)) {
    if (m[1] === "if") depth++;
    else if (depth === 0) return m.index;
    else if (m[1] === "endif") depth--;
  }
  return t.length;
}

/** The tokens of C# source text. Text it cannot lex as C# (an unterminated string) ends the tokens there. */
export function lexCSharp(text: string): Token[] {
  const lexer = new Lexer(text);
  const out: Token[] = [];
  for (let t = lexer.next(); t; t = lexer.next()) out.push(t);
  return out;
}

class Lexer {
  pos = 0;
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
    if (prefix || c === '"') return this.string(start, prefix?.[1] ?? "");
    if (c === "@" && isIdStart(t[start + 1] ?? "")) {
      this.pos = start + 1;
      const id = this.identifier();
      return { kind: "id", text: id, start, end: this.pos };
    }
    if (isIdStart(c)) return { kind: "id", text: this.identifier(), start, end: this.pos };
    if (/[0-9]/.test(c) || (c === "." && /[0-9]/.test(t[start + 1] ?? ""))) return this.number(start);
    if (c === "'") return this.character(start);
    const punct = PUNCTS.find((p) => t.startsWith(p, start)) ?? c;
    this.pos = start + punct.length;
    return { kind: "punct", text: punct, start, end: this.pos };
  }

  private identifier(): string {
    const t = this.text;
    const start = this.pos;
    while (this.pos < t.length) {
      const cp = t.codePointAt(this.pos)!;
      const ch = String.fromCodePoint(cp);
      if (!isIdPart(ch)) break;
      this.pos += ch.length;
    }
    return t.slice(start, this.pos);
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
      const save = this.pos;
      const tok = this.next();
      if (!tok) return undefined;
      if (tok.kind === "punct" && "([{".includes(tok.text)) depth++;
      else if (tok.kind === "punct" && ")]".includes(tok.text)) depth--;
      else if (tok.kind === "punct" && tok.text === "}") {
        if (depth === 0) {
          this.pos = save;
          break;
        }
        depth--;
      } else if (depth === 0 && tok.kind === "punct" && (tok.text === ":" || tok.text === ",")) {
        // The format (or alignment and format) runs to the closing brace.
        this.pos = save;
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
    const fence = '"'.repeat(quotes);
    const bodyStart = open + quotes;
    const close = t.indexOf(fence, bodyStart);
    if (close < 0) return undefined;
    // The closing fence is the first run of at least `quotes` quotes; more quotes than that are an error.
    let after = close + quotes;
    if (t[after] === '"') return undefined;
    const firstLineEnd = lineEnd(t, bodyStart);
    const multiline = firstLineEnd < close;
    let segments: Array<[number, number]>;
    if (multiline) {
      if (t.slice(bodyStart, firstLineEnd).trim()) return undefined;
      const lastLineStart = Math.max(t.lastIndexOf("\n", close - 1), t.lastIndexOf("\r", close - 1)) + 1;
      const indent = t.slice(lastLineStart, close);
      if (indent.trim()) return undefined;
      segments = [];
      let lineAt = firstLineEnd + (t.startsWith("\r\n", firstLineEnd) ? 2 : 1);
      while (lineAt < lastLineStart) {
        const end = lineEnd(t, lineAt);
        const line = t.slice(lineAt, end);
        if (line.trim() && !line.startsWith(indent)) return undefined;
        segments.push([line.trim() ? lineAt + indent.length : end, end]);
        lineAt = end + (t.startsWith("\r\n", end) ? 2 : 1);
      }
    } else segments = [[bodyStart, close]];
    const parts: Array<string | Token[]> = [];
    let buf = "";
    for (let s = 0; s < segments.length; s++) {
      if (s > 0) buf += "\n";
      const end = segments[s]![1];
      let i = segments[s]![0];
      while (i < end) {
        if (dollars && t[i] === "{") {
          let run = 0;
          while (t[i + run] === "{") run++;
          if (run >= dollars) {
            // Braces beyond `dollars` are text before the hole.
            buf += "{".repeat(run - dollars);
            if (buf) parts.push(buf);
            buf = "";
            this.pos = i + run;
            const hole = this.hole(dollars);
            if (!hole) return undefined;
            parts.push(hole);
            i = this.pos;
            continue;
          }
        }
        buf += t[i];
        i++;
      }
    }
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
