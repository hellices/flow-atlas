/**
 * A reader of Go source: its tokens as the Go specification (go.dev/ref/spec, "Lexical elements") defines them, with
 * the semicolons the lexer inserts at the end of a line, and a syntax tree of the declarations, statements and
 * expressions a route registration is made of. Comments, interpreted and raw strings and runes are read whole, so text
 * that looks like code inside them is none. What the parser does not read is kept as a `bad` node over its tokens; it
 * never stops the file from being read.
 */

export interface Token {
  kind: "ident" | "keyword" | "string" | "rune" | "number" | "op" | ";" | "eof";
  text: string;
  /** A string's value, decoded; undefined where an escape is not valid Go. */
  value?: string;
  start: number;
  end: number;
}

const KEYWORDS = new Set([
  "break", "case", "chan", "const", "continue", "default", "defer", "else", "fallthrough", "for", "func", "go", "goto",
  "if", "import", "interface", "map", "package", "range", "return", "select", "struct", "switch", "type", "var",
]);

// Longest first, so that `<<=` is read before `<<` and `<`.
const OPERATORS = [
  "<<=", ">>=", "&^=", "...", "&&", "||", "<-", "++", "--", "==", "!=", "<=", ">=", ":=", "+=", "-=", "*=", "/=", "%=",
  "&=", "|=", "^=", "<<", ">>", "&^", "+", "-", "*", "/", "%", "&", "|", "^", "<", ">", "=", "!", "(", ")", "[", "]",
  "{", "}", ",", ";", ".", ":", "~",
];

const IDENT_START = /[\p{L}_]/u;
const IDENT_PART = /[\p{L}\p{Nd}_]/u;

/** The value of an interpreted string's or rune's escapes, as the spec lists them; undefined for one Go refuses. */
function unescape(body: string): string | undefined {
  let out = "";
  for (let i = 0; i < body.length; i++) {
    const c = body[i]!;
    if (c !== "\\") {
      out += c;
      continue;
    }
    const e = body[++i];
    const simple: Record<string, string> = { a: "\x07", b: "\b", f: "\f", n: "\n", r: "\r", t: "\t", v: "\v", "\\": "\\", "'": "'", '"': '"' };
    if (e !== undefined && Object.hasOwn(simple, e)) {
      out += simple[e];
      continue;
    }
    const hex = (n: number) => {
      const digits = body.slice(i + 1, i + 1 + n);
      if (!new RegExp(`^[0-9a-fA-F]{${n}}$`).test(digits)) return undefined;
      i += n;
      return parseInt(digits, 16);
    };
    if (e === "x") {
      const v = hex(2);
      if (v === undefined) return undefined;
      out += String.fromCharCode(v);
    } else if (e === "u" || e === "U") {
      const v = hex(e === "u" ? 4 : 8);
      if (v === undefined || v > 0x10ffff || (v >= 0xd800 && v < 0xe000)) return undefined;
      out += String.fromCodePoint(v);
    } else if (e !== undefined && /[0-7]/.test(e)) {
      const digits = body.slice(i, i + 3);
      if (!/^[0-7]{3}$/.test(digits) || parseInt(digits, 8) > 255) return undefined;
      i += 2;
      out += String.fromCharCode(parseInt(digits, 8));
    } else return undefined;
  }
  return out;
}

/** The tokens of a Go file, with the semicolons the spec inserts after a line's last token where it may end a statement. */
export function tokenize(text: string): Token[] {
  const out: Token[] = [];
  let i = 0;
  const endsStatement = (): boolean => {
    const t = out[out.length - 1];
    if (!t) return false;
    if (t.kind === "ident" || t.kind === "string" || t.kind === "rune" || t.kind === "number") return true;
    if (t.kind === "keyword") return ["break", "continue", "fallthrough", "return"].includes(t.text);
    return t.kind === "op" && ["++", "--", ")", "]", "}"].includes(t.text);
  };
  const newline = (at: number) => {
    if (endsStatement()) out.push({ kind: ";", text: "\n", start: at, end: at });
  };
  while (i < text.length) {
    const c = text[i]!;
    if (c === "\n") {
      newline(i);
      i++;
      continue;
    }
    if (c === " " || c === "\t" || c === "\r" || c === "\uFEFF") {
      i++;
      continue;
    }
    if (c === "/" && text[i + 1] === "/") {
      const end = text.indexOf("\n", i);
      i = end < 0 ? text.length : end;
      continue;
    }
    if (c === "/" && text[i + 1] === "*") {
      const end = text.indexOf("*/", i + 2);
      const stop = end < 0 ? text.length : end + 2;
      // A general comment that holds a newline acts like a newline.
      if (text.slice(i, stop).includes("\n")) newline(i);
      i = stop;
      continue;
    }
    const start = i;
    if (IDENT_START.test(c) || (c.charCodeAt(0) >= 0xd800 && IDENT_START.test(String.fromCodePoint(text.codePointAt(i)!)))) {
      while (i < text.length) {
        const ch = String.fromCodePoint(text.codePointAt(i)!);
        if (!IDENT_PART.test(ch)) break;
        i += ch.length;
      }
      const word = text.slice(start, i);
      out.push({ kind: KEYWORDS.has(word) ? "keyword" : "ident", text: word, start, end: i });
      continue;
    }
    if (/[0-9]/.test(c) || (c === "." && /[0-9]/.test(text[i + 1] ?? ""))) {
      const m = /^(?:0[xX][0-9a-fA-F_]*(?:\.[0-9a-fA-F_]*)?(?:[pP][+-]?[0-9_]+)?|0[bBoO][0-9_]+|(?:[0-9][0-9_]*(?:\.[0-9_]*)?|\.[0-9][0-9_]*)(?:[eE][+-]?[0-9_]+)?)i?/.exec(text.slice(i))!;
      i += Math.max(1, m[0].length);
      out.push({ kind: "number", text: text.slice(start, i), start, end: i });
      continue;
    }
    if (c === '"' || c === "'") {
      i++;
      while (i < text.length && text[i] !== c && text[i] !== "\n") i += text[i] === "\\" ? 2 : 1;
      const closed = text[i] === c;
      if (closed) i++;
      const body = text.slice(start + 1, closed ? i - 1 : i);
      const value = closed ? unescape(body) : undefined;
      out.push({ kind: c === '"' ? "string" : "rune", text: text.slice(start, i), ...(value !== undefined ? { value } : {}), start, end: i });
      continue;
    }
    if (c === "`") {
      const end = text.indexOf("`", i + 1);
      i = end < 0 ? text.length : end + 1;
      // Carriage returns inside a raw string are discarded from its value.
      out.push({ kind: "string", text: text.slice(start, i), ...(end < 0 ? {} : { value: text.slice(start + 1, end).replace(/\r/g, "") }), start, end: i });
      continue;
    }
    const op = OPERATORS.find((o) => text.startsWith(o, i)) ?? c;
    i += op.length;
    out.push(op === ";" ? { kind: ";", text: ";", start, end: i } : { kind: "op", text: op, start, end: i });
  }
  newline(text.length);
  out.push({ kind: "eof", text: "", start: text.length, end: text.length });
  return out;
}

export type Expr =
  | { k: "ident"; name: string; start: number; end: number }
  | { k: "string"; value: string | undefined; start: number; end: number }
  | { k: "lit"; text: string; start: number; end: number }
  | { k: "sel"; x: Expr; name: string; start: number; end: number }
  | { k: "call"; fn: Expr; args: Expr[]; ellipsis: boolean; start: number; end: number }
  | { k: "index"; x: Expr; indices: Expr[]; start: number; end: number }
  | { k: "slice"; x: Expr; start: number; end: number }
  | { k: "assert"; x: Expr; type: Expr | undefined; start: number; end: number }
  | { k: "unary"; op: string; x: Expr; start: number; end: number }
  | { k: "binary"; op: string; x: Expr; y: Expr; start: number; end: number }
  | { k: "paren"; x: Expr; start: number; end: number }
  | { k: "func"; type: FuncType; body: Block; start: number; end: number }
  | { k: "composite"; type?: Expr; elts: Array<{ key?: Expr; value: Expr }>; start: number; end: number }
  | { k: "kv"; key: Expr; value: Expr; start: number; end: number }
  | { k: "functype"; type: FuncType; start: number; end: number }
  | { k: "arraytype"; elt: Expr; start: number; end: number }
  | { k: "maptype"; key: Expr; value: Expr; start: number; end: number }
  | { k: "chantype"; elt: Expr; start: number; end: number }
  | { k: "structtype"; fields: Field[]; start: number; end: number }
  | { k: "ifacetype"; start: number; end: number }
  | { k: "ellipsis"; elt: Expr | undefined; start: number; end: number }
  | { k: "bad"; start: number; end: number };

export interface Field {
  /** The names declared; none for an embedded field or an unnamed parameter. */
  names: Array<{ name: string; start: number }>;
  type: Expr;
  variadic?: boolean;
}

export interface FuncType {
  params: Field[];
  results: Field[];
}

export interface Block {
  stmts: Stmt[];
  start: number;
  end: number;
}

export type Stmt =
  | { k: "expr"; x: Expr; start: number }
  | { k: "assign"; lhs: Expr[]; op: string; rhs: Expr[]; start: number }
  | { k: "range"; lhs: Expr[]; define: boolean; x: Expr; body: Block; start: number }
  | { k: "decl"; decl: GenDecl; start: number }
  | { k: "block"; block: Block; start: number }
  | { k: "if"; init?: Stmt; cond: Expr; then: Block; else?: Stmt; start: number }
  | { k: "for"; init?: Stmt; cond?: Expr; post?: Stmt; body: Block; start: number }
  | { k: "switch"; init?: Stmt; tag?: Stmt; clauses: Array<{ exprs: Expr[]; body: Stmt[] }>; start: number }
  | { k: "return"; results: Expr[]; start: number }
  | { k: "go"; call: Expr; defer: boolean; start: number }
  | { k: "labeled"; label: string; stmt: Stmt; start: number }
  | { k: "other"; start: number };

export interface GenDecl {
  kind: "var" | "const" | "type" | "import";
  specs: Array<{ names: Array<{ name: string; start: number }>; type?: Expr; values: Expr[]; start: number }>;
}

export interface FuncDecl {
  name: string;
  recv?: Field;
  type: FuncType;
  body?: Block;
  start: number;
  end: number;
}

export interface Import {
  /** The name written before the path: an alias, `_` or `.`; undefined where none is. */
  name?: string;
  path: string;
  start: number;
}

export interface GoFile {
  pkg: string;
  imports: Import[];
  funcs: FuncDecl[];
  decls: GenDecl[];
}

class Parser {
  private p = 0;
  /** Below zero inside a control clause's header, where `{` opens the block and not a composite literal. */
  private exprLev = 0;

  constructor(private readonly toks: Token[]) {}

  private get t(): Token {
    return this.toks[this.p]!;
  }

  private is(text: string, kind?: Token["kind"]): boolean {
    return this.t.text === text && (kind === undefined ? this.t.kind === "op" || this.t.kind === "keyword" : this.t.kind === kind);
  }

  private next(): Token {
    const t = this.t;
    if (t.kind !== "eof") this.p++;
    return t;
  }

  private accept(text: string): boolean {
    if (!this.is(text)) return false;
    this.next();
    return true;
  }

  private peekKind(): Token["kind"] {
    return this.t.kind;
  }

  private semi(): boolean {
    return this.t.kind === ";";
  }

  /** Skips to the token after the one that closes the bracket at the current token. */
  private skipBalanced(): void {
    const open = this.t.text;
    const close = open === "(" ? ")" : open === "[" ? "]" : "}";
    let depth = 0;
    while (this.t.kind !== "eof") {
      const t = this.next();
      if (t.kind !== "op") continue;
      if (t.text === open) depth++;
      else if (t.text === close && --depth === 0) return;
    }
  }

  /** Skips a statement or declaration not read, with any brackets it opens. */
  private skipStatement(): void {
    while (this.t.kind !== "eof" && !this.semi() && !this.is("}")) {
      if (this.is("(") || this.is("[") || this.is("{")) this.skipBalanced();
      else this.next();
    }
  }

  file(): GoFile {
    const out: GoFile = { pkg: "", imports: [], funcs: [], decls: [] };
    while (this.semi()) this.next();
    if (this.accept("package")) {
      if (this.t.kind === "ident") out.pkg = this.next().text;
    }
    while (this.t.kind !== "eof") {
      if (this.semi()) {
        this.next();
        continue;
      }
      const start = this.t.start;
      const at = this.p;
      try {
        if (this.is("import")) out.imports.push(...this.imports());
        else if (this.is("func")) {
          const f = this.funcDecl(start);
          if (f) out.funcs.push(f);
        } else if (this.is("var") || this.is("const") || this.is("type")) out.decls.push(this.genDecl());
        else this.skipStatement();
      } catch {
        this.p = at;
        this.next();
        this.skipStatement();
      }
      if (this.p === at) this.next();
    }
    return out;
  }

  private imports(): Import[] {
    this.next();
    const spec = (): Import | undefined => {
      let name: string | undefined;
      if (this.t.kind === "ident" || this.is(".")) name = this.next().text;
      const start = this.t.start;
      if (this.t.kind !== "string") return undefined;
      const value = this.next().value;
      return value === undefined ? undefined : { ...(name !== undefined ? { name } : {}), path: value, start };
    };
    const out: Import[] = [];
    if (this.accept("(")) {
      while (!this.is(")") && this.t.kind !== "eof") {
        if (this.semi()) {
          this.next();
          continue;
        }
        const s = spec();
        if (s) out.push(s);
        else this.skipStatement();
      }
      this.accept(")");
    } else {
      const s = spec();
      if (s) out.push(s);
    }
    return out;
  }

  private funcDecl(start: number): FuncDecl | undefined {
    this.next();
    let recv: Field | undefined;
    if (this.is("(")) recv = this.params()[0];
    if (this.t.kind !== "ident") {
      this.skipStatement();
      return undefined;
    }
    const name = this.next().text;
    if (this.is("[")) this.skipBalanced();
    const type = this.signature();
    const body = this.is("{") ? this.block() : undefined;
    return { name, ...(recv ? { recv } : {}), type, ...(body ? { body } : {}), start, end: this.toks[this.p - 1]!.end };
  }

  private signature(): FuncType {
    const params = this.params();
    let results: Field[] = [];
    if (this.is("(")) results = this.params();
    else if (this.startsType()) results = [{ names: [], type: this.type() }];
    return { params, results };
  }

  private startsType(): boolean {
    const t = this.t;
    if (t.kind === "ident") return true;
    if (t.kind === "keyword") return ["func", "map", "chan", "struct", "interface"].includes(t.text);
    return t.kind === "op" && ["*", "[", "(", "<-"].includes(t.text);
  }

  /**
   * A parameter list: each entry a name with its type, or a type alone; where any entry names its parameter, the
   * entries before a type are names of that type (`a, b int`).
   */
  private params(): Field[] {
    if (!this.accept("(")) return [];
    const entries: Array<{ name?: { name: string; start: number }; type: Expr; variadic: boolean }> = [];
    while (!this.is(")") && this.t.kind !== "eof") {
      while (this.semi()) this.next();
      if (this.is(")")) break;
      let name: { name: string; start: number } | undefined;
      if (this.t.kind === "ident" && this.named()) name = { name: this.t.text, start: this.next().start };
      const variadic = this.accept("...");
      entries.push({ ...(name ? { name } : {}), type: this.type(), variadic });
      if (!this.accept(",")) break;
    }
    while (this.semi()) this.next();
    this.accept(")");
    if (!entries.some((e) => e.name)) return entries.map((e) => ({ names: [], type: e.type, ...(e.variadic ? { variadic: true } : {}) }));
    const out: Field[] = [];
    let names: Array<{ name: string; start: number }> = [];
    for (const e of entries) {
      if (!e.name) {
        if (e.type.k === "ident") names.push({ name: e.type.name, start: e.type.start });
        continue;
      }
      names.push(e.name);
      out.push({ names, type: e.type, ...(e.variadic ? { variadic: true } : {}) });
      names = [];
    }
    return out;
  }

  /**
   * Whether the identifier at hand names a parameter, a type following it: not where a `,`, `)` or `.` does, nor a
   * generic type's `[` (`List[T]`), told from a slice or array type's (`a []T`, `a [4]T`) by what follows the `[`.
   */
  private named(): boolean {
    const nx = this.toks[this.p + 1];
    if (!nx || nx.kind === ";" || nx.kind === "eof") return false;
    if (nx.kind === "op" && [",", ")", "."].includes(nx.text)) return false;
    if (nx.kind === "op" && nx.text === "[") {
      const after = this.toks[this.p + 2];
      return after?.text === "]" || after?.kind === "number";
    }
    return true;
  }

  type(): Expr {
    const start = this.t.start;
    const t = this.t;
    if (t.kind === "ident") {
      let x: Expr = { k: "ident", name: this.next().text, start, end: t.end };
      if (this.is(".") && this.toks[this.p + 1]?.kind === "ident") {
        this.next();
        const n = this.next();
        x = { k: "sel", x, name: n.text, start, end: n.end };
      }
      if (this.is("[") && this.toks[this.p + 1]?.text !== "]") {
        // A generic type's arguments.
        const from = this.p;
        this.skipBalanced();
        x = { k: "index", x, indices: [], start, end: this.toks[this.p - 1]!.end };
        if (from === this.p) this.next();
      }
      return x;
    }
    if (this.accept("*")) {
      const x = this.type();
      return { k: "unary", op: "*", x, start, end: x.end };
    }
    if (this.is("(")) {
      this.next();
      const x = this.type();
      this.accept(")");
      return { k: "paren", x, start, end: this.toks[this.p - 1]!.end };
    }
    if (this.accept("[")) {
      if (!this.accept("]")) {
        if (!this.accept("...")) this.expr();
        this.accept("]");
      }
      const elt = this.type();
      return { k: "arraytype", elt, start, end: elt.end };
    }
    if (this.accept("map")) {
      this.accept("[");
      const key = this.type();
      this.accept("]");
      const value = this.type();
      return { k: "maptype", key, value, start, end: value.end };
    }
    if (this.is("chan") || this.is("<-")) {
      if (this.accept("<-")) this.accept("chan");
      else {
        this.next();
        this.accept("<-");
      }
      const elt = this.type();
      return { k: "chantype", elt, start, end: elt.end };
    }
    if (this.accept("func")) {
      const type = this.signature();
      return { k: "functype", type, start, end: this.toks[this.p - 1]!.end };
    }
    if (this.accept("struct")) {
      const fields: Field[] = [];
      if (this.accept("{")) {
        while (!this.is("}") && this.t.kind !== "eof") {
          if (this.semi()) {
            this.next();
            continue;
          }
          const at = this.p;
          fields.push(...this.structField());
          if (this.t.kind === "string") this.next();
          if (this.p === at) this.next();
        }
        this.accept("}");
      }
      return { k: "structtype", fields, start, end: this.toks[this.p - 1]!.end };
    }
    if (this.is("interface")) {
      this.next();
      if (this.is("{")) this.skipBalanced();
      return { k: "ifacetype", start, end: this.toks[this.p - 1]!.end };
    }
    if (this.is("~")) {
      this.next();
      return this.type();
    }
    this.next();
    return { k: "bad", start, end: t.end };
  }

  private structField(): Field[] {
    // An embedded field: `T`, `*T` or `pkg.T`, alone on its line or before a tag.
    if (this.is("*")) return [{ names: [], type: this.type() }];
    const names: Array<{ name: string; start: number }> = [];
    const at = this.p;
    if (this.t.kind === "ident") {
      const first = this.next();
      if (this.is(".") || this.semi() || this.is("}") || this.peekKind() === "string") {
        this.p = at;
        return [{ names: [], type: this.type() }];
      }
      names.push({ name: first.text, start: first.start });
      while (this.accept(",")) if (this.t.kind === "ident") names.push({ name: this.t.text, start: this.next().start });
    }
    return [{ names, type: this.type() }];
  }

  private genDecl(): GenDecl {
    const kind = this.next().text as GenDecl["kind"];
    const specs: GenDecl["specs"] = [];
    const spec = () => {
      const start = this.t.start;
      const names: Array<{ name: string; start: number }> = [];
      if (kind === "type") {
        if (this.t.kind !== "ident") return this.skipStatement();
        names.push({ name: this.t.text, start: this.next().start });
        if (this.is("[") && this.toks[this.p + 1]?.kind === "ident" && this.toks[this.p + 2]?.kind !== "op") this.skipBalanced();
        this.accept("=");
        specs.push({ names, type: this.type(), values: [], start });
        return;
      }
      while (this.t.kind === "ident") {
        names.push({ name: this.t.text, start: this.next().start });
        if (!this.accept(",")) break;
      }
      let type: Expr | undefined;
      if (!this.is("=") && !this.semi() && !this.is(")")) type = this.type();
      const values = this.accept("=") ? this.exprList() : [];
      specs.push({ names, ...(type ? { type } : {}), values, start });
    };
    if (this.accept("(")) {
      while (!this.is(")") && this.t.kind !== "eof") {
        if (this.semi()) {
          this.next();
          continue;
        }
        const at = this.p;
        spec();
        if (this.p === at) this.next();
      }
      this.accept(")");
    } else spec();
    return { kind, specs };
  }

  block(): Block {
    const start = this.t.start;
    this.accept("{");
    const stmts = this.stmtList();
    const end = this.t.end;
    this.accept("}");
    return { stmts, start, end };
  }

  private stmtList(): Stmt[] {
    const out: Stmt[] = [];
    while (!this.is("}") && !this.is("case") && !this.is("default") && this.t.kind !== "eof") {
      if (this.semi()) {
        this.next();
        continue;
      }
      const at = this.p;
      try {
        out.push(this.stmt());
      } catch {
        this.p = at;
        this.skipStatement();
        out.push({ k: "other", start: this.toks[at]!.start });
      }
      if (this.p === at) this.next();
    }
    return out;
  }

  private stmt(): Stmt {
    const start = this.t.start;
    const t = this.t;
    if (t.kind === "keyword") {
      switch (t.text) {
        case "var":
        case "const":
        case "type":
          return { k: "decl", decl: this.genDecl(), start };
        case "return": {
          this.next();
          const results = this.semi() || this.is("}") ? [] : this.exprList();
          return { k: "return", results, start };
        }
        case "if":
          return this.ifStmt();
        case "for":
          return this.forStmt();
        case "switch":
        case "select":
          return this.switchStmt();
        case "go":
        case "defer": {
          this.next();
          return { k: "go", call: this.expr(), defer: t.text === "defer", start };
        }
        case "break":
        case "continue":
        case "goto":
        case "fallthrough":
          this.next();
          if (this.t.kind === "ident") this.next();
          return { k: "other", start };
        case "func":
          break;
        default:
          this.skipStatement();
          return { k: "other", start };
      }
    }
    if (this.is("{")) return { k: "block", block: this.block(), start };
    if (t.kind === "ident" && this.toks[this.p + 1]?.text === ":" && this.toks[this.p + 1]?.kind === "op") {
      this.next();
      this.next();
      while (this.semi()) this.next();
      if (this.is("}")) return { k: "other", start };
      return { k: "labeled", label: t.text, stmt: this.stmt(), start };
    }
    return this.simpleStmt();
  }

  private simpleStmt(range = false): Stmt {
    const start = this.t.start;
    if (range && this.is("range")) {
      this.next();
      const x = this.expr();
      return { k: "range", lhs: [], define: false, x, body: { stmts: [], start, end: start }, start };
    }
    const lhs = this.exprList();
    const op = this.t;
    if (op.kind === "op" && (op.text === ":=" || op.text === "=" || (op.text.endsWith("=") && !["==", "!=", "<=", ">="].includes(op.text)))) {
      this.next();
      if (range && this.is("range")) {
        this.next();
        const x = this.expr();
        return { k: "range", lhs, define: op.text === ":=", x, body: { stmts: [], start, end: start }, start };
      }
      return { k: "assign", lhs, op: op.text, rhs: this.exprList(), start };
    }
    if (op.kind === "op" && (op.text === "++" || op.text === "--")) {
      this.next();
      return { k: "other", start };
    }
    if (op.kind === "op" && op.text === "<-") {
      this.next();
      this.expr();
      return { k: "other", start };
    }
    return { k: "expr", x: lhs[0] ?? { k: "bad", start, end: start }, start };
  }

  /** A control clause's header, read with `{` taken as the start of the block. */
  private header<T>(read: () => T): T {
    const lev = this.exprLev;
    this.exprLev = -1;
    try {
      return read();
    } finally {
      this.exprLev = lev;
    }
  }

  private ifStmt(): Stmt {
    const start = this.next().start;
    const { init, cond } = this.header(() => {
      let init: Stmt | undefined;
      let cond: Expr | undefined;
      if (!this.semi()) {
        const s = this.simpleStmt();
        if (this.semi()) {
          this.next();
          init = s;
        } else if (s.k === "expr") cond = s.x;
      } else this.next();
      if (!cond && !this.is("{")) {
        const s = this.simpleStmt();
        if (s.k === "expr") cond = s.x;
      }
      const bad: Expr = { k: "bad", start, end: start };
      return { init, cond: cond ?? bad };
    });
    const then = this.block();
    let els: Stmt | undefined;
    if (this.accept("else")) els = this.is("if") ? this.ifStmt() : { k: "block", block: this.block(), start: this.t.start };
    return { k: "if", ...(init ? { init } : {}), cond, then, ...(els ? { else: els } : {}), start };
  }

  private forStmt(): Stmt {
    const start = this.next().start;
    const head = this.header(() => {
      if (this.is("{")) return {};
      let init: Stmt | undefined;
      let cond: Expr | undefined;
      let post: Stmt | undefined;
      const first = this.semi() ? undefined : this.simpleStmt(true);
      if (first?.k === "range") return { range: first };
      if (this.semi()) {
        this.next();
        init = first;
        if (!this.semi()) {
          const c = this.simpleStmt();
          if (c.k === "expr") cond = c.x;
        }
        if (this.semi()) this.next();
        if (!this.is("{")) post = this.simpleStmt();
      } else if (first?.k === "expr") cond = first.x;
      return { init, cond, post };
    });
    const body = this.block();
    if ("range" in head && head.range && head.range.k === "range") return { ...head.range, body, start };
    const h = head as { init?: Stmt; cond?: Expr; post?: Stmt };
    return { k: "for", ...(h.init ? { init: h.init } : {}), ...(h.cond ? { cond: h.cond } : {}), ...(h.post ? { post: h.post } : {}), body, start };
  }

  private switchStmt(): Stmt {
    const start = this.next().start;
    const { init, tag } = this.header(() => {
      let init: Stmt | undefined;
      let tag: Stmt | undefined;
      if (!this.is("{")) {
        const s = this.semi() ? undefined : this.simpleStmt();
        if (this.semi()) {
          this.next();
          init = s;
          if (!this.is("{")) tag = this.simpleStmt();
        } else tag = s;
      }
      return { init, tag };
    });
    const clauses: Array<{ exprs: Expr[]; body: Stmt[] }> = [];
    this.accept("{");
    while (!this.is("}") && this.t.kind !== "eof") {
      if (this.semi()) {
        this.next();
        continue;
      }
      let exprs: Expr[] = [];
      if (this.accept("case")) {
        // A select's case is a statement; a switch's, a list of expressions or types.
        const s = this.simpleStmt();
        exprs = s.k === "expr" ? [s.x] : [];
        while (this.accept(",")) exprs.push(this.expr());
      } else if (!this.accept("default")) {
        this.skipStatement();
        continue;
      }
      this.accept(":");
      clauses.push({ exprs, body: this.stmtList() });
    }
    this.accept("}");
    return { k: "switch", ...(init ? { init } : {}), ...(tag ? { tag } : {}), clauses, start };
  }

  exprList(): Expr[] {
    const out = [this.expr()];
    while (this.accept(",")) out.push(this.expr());
    return out;
  }

  private static readonly PREC: Record<string, number> = {
    "||": 1, "&&": 2, "==": 3, "!=": 3, "<": 3, "<=": 3, ">": 3, ">=": 3, "+": 4, "-": 4, "|": 4, "^": 4,
    "*": 5, "/": 5, "%": 5, "<<": 5, ">>": 5, "&": 5, "&^": 5,
  };

  expr(prec = 1): Expr {
    let x = this.unary();
    for (;;) {
      const op = this.t;
      const p = op.kind === "op" ? Parser.PREC[op.text] : undefined;
      if (p === undefined || p < prec) return x;
      this.next();
      const y = this.expr(p + 1);
      x = { k: "binary", op: op.text, x, y, start: x.start, end: y.end };
    }
  }

  private unary(): Expr {
    const t = this.t;
    if (t.kind === "op" && ["+", "-", "!", "^", "*", "&", "<-", "~"].includes(t.text)) {
      this.next();
      const x = this.unary();
      return { k: "unary", op: t.text, x, start: t.start, end: x.end };
    }
    return this.primary();
  }

  private operand(): Expr {
    const t = this.t;
    const start = t.start;
    if (t.kind === "ident") {
      this.next();
      return { k: "ident", name: t.text, start, end: t.end };
    }
    if (t.kind === "string") {
      this.next();
      return { k: "string", value: t.value, start, end: t.end };
    }
    if (t.kind === "number" || t.kind === "rune") {
      this.next();
      return { k: "lit", text: t.text, start, end: t.end };
    }
    if (this.is("(")) {
      this.next();
      const lev = this.exprLev;
      this.exprLev = Math.max(0, lev) + 1;
      const x = this.expr();
      this.exprLev = lev;
      this.accept(")");
      return { k: "paren", x, start, end: this.toks[this.p - 1]!.end };
    }
    if (this.is("func")) {
      this.next();
      const type = this.signature();
      if (this.is("{")) {
        const lev = this.exprLev;
        this.exprLev = 0;
        const body = this.block();
        this.exprLev = lev;
        return { k: "func", type, body, start, end: body.end };
      }
      return { k: "functype", type, start, end: this.toks[this.p - 1]!.end };
    }
    if (this.is("[") || this.is("map") || this.is("chan") || this.is("struct") || this.is("interface")) return this.type();
    this.next();
    return { k: "bad", start, end: t.end };
  }

  private primary(): Expr {
    let x = this.operand();
    for (;;) {
      if (this.is(".")) {
        this.next();
        if (this.t.kind === "ident") {
          const n = this.next();
          x = { k: "sel", x, name: n.text, start: x.start, end: n.end };
        } else if (this.accept("(")) {
          const type = this.is("type") ? (this.next(), undefined) : this.type();
          this.accept(")");
          x = { k: "assert", x, type, start: x.start, end: this.toks[this.p - 1]!.end };
        } else return x;
      } else if (this.is("(")) {
        this.next();
        const lev = this.exprLev;
        this.exprLev = Math.max(0, lev) + 1;
        const args: Expr[] = [];
        let ellipsis = false;
        while (!this.is(")") && this.t.kind !== "eof") {
          while (this.semi()) this.next();
          if (this.is(")")) break;
          args.push(this.expr());
          if (this.accept("...")) ellipsis = true;
          if (!this.accept(",")) break;
          while (this.semi()) this.next();
        }
        this.exprLev = lev;
        const end = this.t.end;
        this.accept(")");
        x = { k: "call", fn: x, args, ellipsis, start: x.start, end };
      } else if (this.is("[")) {
        this.next();
        const lev = this.exprLev;
        this.exprLev = Math.max(0, lev) + 1;
        const indices: Expr[] = [];
        let sliced = false;
        while (!this.is("]") && this.t.kind !== "eof") {
          if (this.accept(":")) {
            sliced = true;
            continue;
          }
          indices.push(this.expr());
          if (!this.accept(",") && !this.is(":")) break;
        }
        this.exprLev = lev;
        const end = this.t.end;
        this.accept("]");
        x = sliced ? { k: "slice", x, start: x.start, end } : { k: "index", x, indices, start: x.start, end };
      } else if (this.is("{") && isTypeLike(x) && (this.exprLev >= 0 || !isTypeName(x))) {
        x = this.composite(x);
      } else return x;
    }
  }

  private composite(type: Expr | undefined): Expr {
    const start = type?.start ?? this.t.start;
    this.accept("{");
    const lev = this.exprLev;
    this.exprLev = Math.max(0, lev) + 1;
    const elts: Array<{ key?: Expr; value: Expr }> = [];
    while (!this.is("}") && this.t.kind !== "eof") {
      while (this.semi()) this.next();
      if (this.is("}")) break;
      const element = (): Expr => (this.is("{") ? this.composite(undefined) : this.expr());
      const first = element();
      if (this.accept(":")) elts.push({ key: first, value: element() });
      else elts.push({ value: first });
      if (!this.accept(",")) {
        while (this.semi()) this.next();
        break;
      }
    }
    this.exprLev = lev;
    const end = this.t.end;
    this.accept("}");
    return { k: "composite", ...(type ? { type } : {}), elts, start, end };
  }
}

/** Whether an expression may be the type of a composite literal (`T{}`, `pkg.T{}`, `[]T{}`, `T[int]{}`). */
function isTypeLike(x: Expr): boolean {
  if (x.k === "ident") return true;
  if (x.k === "sel") return x.x.k === "ident";
  if (x.k === "index") return isTypeLike(x.x);
  return x.k === "arraytype" || x.k === "maptype" || x.k === "structtype";
}

/**
 * Whether a composite literal's type is a TypeName, which a control clause's header reads as the operand before the
 * block (go.dev/ref/spec, "Composite literals": the parsing ambiguity), unlike `[]T{}` or `struct{}{}`.
 */
function isTypeName(x: Expr): boolean {
  return x.k === "ident" || x.k === "sel" || (x.k === "index" && isTypeName(x.x));
}

/** A Go file's package, imports, functions and declarations. */
export function parseGo(text: string): GoFile {
  return new Parser(tokenize(text)).file();
}
