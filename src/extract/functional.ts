import type { RouteSource } from "../config.js";
import { joinRoute } from "../paths.js";
import { lineOf } from "../source.js";
import { literalEnd, withoutComments } from "./calls.js";
import type { Spans } from "./spans.js";

/**
 * Spring's functional endpoints, WebMvc.fn and WebFlux.fn: the router functions `@Bean` methods return, which
 * `RouterFunctionMapping` serves at the root (no `PathMatchConfigurer` prefix applies to them). Read from Java and
 * Kotlin:
 *
 * - `RouterFunctions.route()`'s builder: `GET(pattern, handler)`, `GET(pattern, predicate, handler)`,
 *   `GET(predicate, handler)` and `GET(handler)` (every GET request) and the other methods, `route(predicate, handler)`,
 *   `add(routerFunction)`, `nest(predicate, builder -> ...)`, `path(pattern, builder -> ...)`, `resources(pattern,
 *   location)`, `resource(predicate, resource)`, and the calls that change no route (`filter`, `before`, `build`, ...).
 * - The static composition: `route(predicate, handler)`, `nest(predicate, routerFunction)`, `resources`, `resource`,
 *   and on a router function `and`, `andOther`, `andRoute`, `andNest`, `filter`.
 * - The Kotlin DSL, `router { }` and `coRouter { }`: the same methods with a trailing handler, `"/x".nest { }`,
 *   `predicate.nest { }`, `"/x" { }` and `predicate { }`, `accept(type) { }` and the like.
 *
 * A predicate is read as the methods and paths it takes: `GET(pattern)` and the others, `path(pattern)`, `method`,
 * `methods`, `all()`; `accept`, `contentType`, `headers`, `param`, `queryParam` and `version` narrow a request by what is
 * not its method or path, so they leave both as they are; `and` takes what both do, `or` either. A nested route's
 * pattern is matched against what its nest's pattern leaves (`PathPattern.matchStartOfPath`), so it is joined after it;
 * a route with no path of its own takes any rest of the path within its nest (`/teams/**`). `path(pattern)` puts a `/`
 * before a pattern that has none (`PathPatternParser.initFullPathPattern`). `resources(pattern, location)` answers GET
 * and HEAD with a file under the location (`PathResourceLookupFunction`), never the location itself, a directory: a
 * pattern ending in `/**` serves one segment or more after it.
 *
 * What is not read, a predicate not spelled out, a router function built elsewhere or a lookup function, is said in
 * `limits` and left out.
 */

/** A route a router function or a registered mapping serves: its method, its path pattern as written, and its line. */
export interface FunctionalRoute {
  method: string;
  path: string;
  line: number;
  implicit?: true;
}
/** The value of a string constant the file declares, used at an offset (see `fileConstants`). */
type Constant = (expression: string, at: number) => string | undefined;

type Tok = { kind: "id" | "str" | "num" | "op"; text: string; at: number; end: number; value?: string; nl: boolean };

type Node =
  | { t: "id"; name: string; at: number; end: number }
  | { t: "str"; value?: string; at: number; end: number }
  | { t: "call"; name: string; target?: Node; args: Node[]; at: number; end: number; nameAt: number }
  | { t: "member"; target: Node; name: string; at: number; end: number }
  | { t: "lambda"; params: string[]; body: Node[]; at: number; end: number }
  | { t: "infix"; op: string; left: Node; right: Node; at: number; end: number }
  | { t: "not"; operand: Node; at: number; end: number }
  /** A local's declaration; `final` where the language keeps it from being assigned again (`final`, Kotlin's `val`). */
  | { t: "decl"; name: string; init?: Node; final: boolean; at: number; end: number }
  | { t: "return"; value?: Node; at: number; end: number }
  | { t: "opaque"; at: number; end: number };

/** The most alternatives one predicate is read as, so that `and` of many `or`s does not run away. */
const MAX_ALTERNATIVES = 256;
/** The most routes one file's router functions are read as, so that a router function added to itself does not run away. */
const MAX_ROUTES = 4096;
/** The most nested contexts and statements one file's router functions are read through. */
const MAX_WORK = 20000;
const METHODS = new Set(["GET", "HEAD", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"]);
/** Predicates that narrow a request by what is not its method or path. */
const NARROWING = new Set(["accept", "contentType", "headers", "param", "queryParam", "version"]);
/** Calls on a builder or a router function that add no route and change none. */
const NEUTRAL = new Set(["filter", "before", "after", "onError", "withAttribute", "withAttributes"]);
/** Where the functional API lives: a file that names neither package builds no router function of Spring's. */
const PACKAGES = /\borg\.springframework\.web\.(?:servlet\.function|reactive\.function\.server)\b/;

/** Java or Kotlin code as tokens; a string's value is undefined where it is a template or a multi-line text block. */
function tokenize(file: string, code: string, kotlin: boolean): Tok[] {
  const out: Tok[] = [];
  let i = 0;
  let nl = false;
  const ops = ["::", "->", "?.", "!!", "&&", "||", "==", "!=", "<=", ">=", "?:"];
  while (i < code.length) {
    const c = code[i]!;
    if (/\s/.test(c)) {
      if (c === "\n") nl = true;
      i++;
      continue;
    }
    const start = i;
    if (c === '"') {
      const quote = code.startsWith('"""', i) ? '"""' : '"';
      const end = literalEnd(code, i, quote, file);
      const body = code.slice(i + quote.length, code.startsWith(quote, end - quote.length) ? end - quote.length : end);
      const template = quote === '"""' ? /\$[A-Za-z_{`]/ : /(?<!\\)(?:\\\\)*\$[A-Za-z_{`]/;
      const unknown = (quote === '"""' && (!kotlin || body.includes("\n"))) || (kotlin && template.test(body)) || /\\u/.test(body);
      const value = unknown ? undefined : quote === '"""' ? body : body.replace(/\\(.)/g, (_, e: string) => ({ n: "\n", t: "\t", r: "\r", b: "\b", f: "\f", "0": "\0" })[e] ?? e);
      out.push({ kind: "str", text: code.slice(start, end), at: start, end, value, nl });
      i = end;
    } else if (c === "'") {
      const end = literalEnd(code, i, "'", file);
      out.push({ kind: "num", text: code.slice(start, end), at: start, end, nl });
      i = end;
    } else if (c === "`") {
      const end = code.indexOf("`", i + 1);
      const stop = end === -1 ? code.length : end + 1;
      out.push({ kind: "id", text: code.slice(i + 1, stop - 1), at: start, end: stop, nl });
      i = stop;
    } else if (/[A-Za-z_$]/.test(c)) {
      while (i < code.length && /[\w$]/.test(code[i]!)) i++;
      out.push({ kind: "id", text: code.slice(start, i), at: start, end: i, nl });
    } else if (/\d/.test(c)) {
      while (i < code.length && /[\w.]/.test(code[i]!)) i++;
      out.push({ kind: "num", text: code.slice(start, i), at: start, end: i, nl });
    } else {
      const op = ops.find((o) => code.startsWith(o, i)) ?? c;
      i += op.length;
      out.push({ kind: "op", text: op, at: start, end: i, nl });
    }
    nl = false;
  }
  return out;
}

const BINARY = new Set(["+", "-", "*", "/", "%", "==", "!=", "<", ">", "<=", ">=", "&&", "||", "?:", "&", "|", "^", "instanceof", "is", "as"]);

/** A parser of the Java and Kotlin expressions a router function is written in; what it does not know is opaque. */
class Parser {
  i = 0;
  constructor(
    readonly toks: Tok[],
    readonly kotlin: boolean,
  ) {}
  peek(k = 0): Tok | undefined {
    return this.toks[this.i + k];
  }
  is(text: string, k = 0): boolean {
    return this.peek(k)?.text === text && this.peek(k)?.kind !== "str";
  }
  get last(): number {
    return this.toks[this.i - 1]?.end ?? 0;
  }
  /** The index after the bracket that the one at `from` opens closes. */
  skipBalanced(from: number): number {
    let depth = 0;
    for (let k = from; k < this.toks.length; k++) {
      const t = this.toks[k]!;
      if (t.kind !== "op") continue;
      if ("([{".includes(t.text)) depth++;
      else if (")]}".includes(t.text) && --depth === 0) return k + 1;
    }
    return this.toks.length;
  }
  /** Skips `<...>` type arguments at the cursor, where they are there. */
  typeArgs(): void {
    if (!this.is("<")) return;
    let depth = 0;
    for (let k = this.i; k < this.toks.length; k++) {
      const t = this.toks[k]!.text;
      if (t === "<") depth++;
      else if (t === ">" && --depth === 0) {
        this.i = k + 1;
        return;
      } else if (!/^[\w$.?,*\s[\]]+$|^@$|^&$|^:$/.test(t)) return;
    }
  }
  opaque(from: number): Node {
    return { t: "opaque", at: this.toks[from]?.at ?? 0, end: this.last };
  }

  /** Statements up to the `}` that closes the block (the cursor after it), or to the end. */
  statements(): Node[] {
    const out: Node[] = [];
    while (this.i < this.toks.length && !this.is("}")) {
      const before = this.i;
      if (this.is(";")) {
        this.i++;
        continue;
      }
      out.push(this.statement());
      if (this.i === before) this.i++;
    }
    if (this.is("}")) this.i++;
    return out;
  }

  statement(): Node {
    const from = this.i;
    const at = this.peek()?.at ?? 0;
    if (this.is("return")) {
      this.i++;
      const value = this.is(";") || this.is("}") ? undefined : this.expression();
      return { t: "return", value, at, end: this.last };
    }
    if (this.kotlin && (this.is("val") || this.is("var"))) {
      const final = this.is("val");
      this.i++;
      const name = this.peek()?.text ?? "";
      this.i++;
      if (this.is(":")) {
        this.i++;
        this.type();
      }
      if (!this.is("=")) return { t: "decl", name, final, at, end: this.last };
      this.i++;
      return { t: "decl", name, init: this.expression(), final, at, end: this.last };
    }
    if (!this.kotlin) {
      // `final RouterFunction<ServerResponse> name = ...;`, `var name = ...;`
      let k = this.i;
      while (this.toks[k]?.text === "final") k++;
      const save = this.i;
      this.i = k;
      if (this.type() && this.peek()?.kind === "id" && this.is("=", 1) && !this.is("==", 1)) {
        const name = this.peek()!.text;
        this.i += 2;
        return { t: "decl", name, init: this.expression(), final: k > save, at, end: this.last };
      }
      this.i = save;
      // A statement of control flow is not read: its routes would be registered on a condition.
      if (["if", "for", "while", "do", "switch", "try", "synchronized", "throw"].includes(this.peek()?.text ?? "")) {
        while (this.i < this.toks.length && !this.is(";") && !this.is("{")) this.i = this.is("(") ? this.skipBalanced(this.i) : this.i + 1;
        if (this.is("{")) this.i = this.skipBalanced(this.i);
        else this.i++;
        return this.opaque(from);
      }
    } else if (["if", "for", "while", "when", "try", "throw", "do"].includes(this.peek()?.text ?? "")) {
      this.i++;
      while (this.i < this.toks.length && !this.is("{") && !this.is("}") && !(this.peek()!.nl && this.i > from + 1)) this.i = this.is("(") ? this.skipBalanced(this.i) : this.i + 1;
      if (this.is("{")) this.i = this.skipBalanced(this.i);
      return this.opaque(from);
    }
    const e = this.expression();
    if (this.is(";")) this.i++;
    return e;
  }

  /** A type: `Name`, `a.b.Name`, with type arguments and `[]`; false where there is none at the cursor. */
  type(): boolean {
    if (this.peek()?.kind !== "id") return false;
    this.i++;
    while (this.is(".") && this.peek(1)?.kind === "id") this.i += 2;
    this.typeArgs();
    while (this.is("[") && this.is("]", 1)) this.i += 2;
    if (this.is("?")) this.i++;
    return true;
  }

  expression(): Node {
    const from = this.i;
    let left = this.unary();
    for (;;) {
      const t = this.peek();
      if (!t) break;
      // Kotlin's infix `and`, `or` on predicates, on the same line.
      if (this.kotlin && t.kind === "id" && (t.text === "and" || t.text === "or") && !t.nl) {
        this.i++;
        const right = this.unary();
        left = { t: "infix", op: t.text, left, right, at: left.at, end: right.end };
        continue;
      }
      if (t.kind === "op" && t.text === "+" && !(this.kotlin && t.nl)) {
        this.i++;
        const right = this.unary();
        left = { t: "infix", op: "+", left, right, at: left.at, end: right.end };
        continue;
      }
      if ((t.kind === "op" || t.kind === "id") && BINARY.has(t.text) && !(this.kotlin && t.nl)) {
        this.i++;
        if (t.text === "as" || t.text === "is" || t.text === "instanceof") this.type();
        else this.unary();
        left = this.opaque(from);
        continue;
      }
      if (t.text === "?" && !this.kotlin) {
        this.i++;
        this.expression();
        if (this.is(":")) this.i++;
        this.expression();
        left = this.opaque(from);
        continue;
      }
      break;
    }
    return left;
  }

  unary(): Node {
    const t = this.peek();
    if (t && t.kind === "op" && t.text === "!") {
      this.i++;
      const operand = this.unary();
      return { t: "not", operand, at: t.at, end: operand.end };
    }
    if (t && t.kind === "op" && (t.text === "-" || t.text === "+")) {
      const from = this.i;
      this.i++;
      this.unary();
      return this.opaque(from);
    }
    return this.postfix(this.primary());
  }

  /** The arguments in the parentheses at the cursor, the cursor after them; one not read is opaque, the others still read. */
  args(): Node[] {
    const out: Node[] = [];
    const end = this.skipBalanced(this.i) - 1;
    this.i++;
    while (this.i < end) {
      const before = this.i;
      // A Kotlin named argument, `name = value`.
      if (this.kotlin && this.peek()?.kind === "id" && this.is("=", 1)) this.i += 2;
      if (this.is("*")) this.i++;
      const e = this.expression();
      if (this.i === end || (this.is(",") && this.i < end)) {
        out.push(e);
        if (this.i < end) this.i++;
        continue;
      }
      // Not read to its end: the argument is opaque up to the next `,` at its depth.
      let k = before;
      for (let depth = 0; k < end; k++) {
        const t = this.toks[k]!;
        if (t.kind !== "op") continue;
        if ("([{".includes(t.text)) depth++;
        else if (")]}".includes(t.text)) depth--;
        else if (t.text === "," && depth === 0) break;
      }
      out.push({ t: "opaque", at: this.toks[before]!.at, end: this.toks[k - 1]?.end ?? this.toks[before]!.end });
      this.i = k < end ? k + 1 : end;
    }
    this.i = end + 1;
    return out;
  }

  /** A Kotlin lambda, the cursor at its `{`. */
  kotlinLambda(): Node {
    const at = this.peek()!.at;
    this.i++;
    const params: string[] = [];
    // `a, b ->` or `(a, b) ->` before the body.
    let k = this.i;
    const names: string[] = [];
    while (this.toks[k]?.kind === "id" || this.toks[k]?.text === "," || this.toks[k]?.text === ":" || this.toks[k]?.text === "_") {
      if (this.toks[k]!.kind === "id" && this.toks[k - 1]?.text !== ":") names.push(this.toks[k]!.text);
      k++;
    }
    if (this.toks[k]?.text === "->") {
      params.push(...names);
      this.i = k + 1;
    }
    const body = this.statements();
    return { t: "lambda", params: params.length ? params : ["it"], body, at, end: this.last };
  }

  /** A Java lambda's body after its `->`. */
  javaLambda(params: string[], at: number): Node {
    if (this.is("{")) {
      this.i++;
      const body = this.statements();
      return { t: "lambda", params, body, at, end: this.last };
    }
    const e = this.expression();
    return { t: "lambda", params, body: [{ t: "return", value: e, at: e.at, end: e.end }], at, end: e.end };
  }

  primary(): Node {
    const t = this.peek();
    const from = this.i;
    if (!t) return { t: "opaque", at: this.last, end: this.last };
    if (t.kind === "str") {
      this.i++;
      return { t: "str", value: t.value, at: t.at, end: t.end };
    }
    if (t.kind === "num") {
      this.i++;
      return this.opaque(from);
    }
    if (t.kind === "op" && t.text === "(") {
      const close = this.skipBalanced(this.i);
      if (!this.kotlin && this.toks[close]?.text === "->") {
        const params = this.toks.slice(this.i + 1, close - 1).filter((x, k, all) => x.kind === "id" && (all[k + 1]?.text === "," || k === all.length - 1)).map((x) => x.text);
        this.i = close + 1;
        return this.javaLambda(params, t.at);
      }
      // A Java cast, `(Type) value`, is the value.
      if (!this.kotlin) {
        this.i++;
        const next = this.type() && this.is(")") ? this.peek(1) : undefined;
        if (next && next.text !== "instanceof" && (next.kind === "id" || next.kind === "str" || next.kind === "num" || next.text === "(" || next.text === "!")) {
          this.i++;
          return this.unary();
        }
        this.i = from;
      }
      this.i++;
      const inner = this.expression();
      if (this.is(")")) this.i++;
      else this.i = close;
      return inner;
    }
    if (t.kind === "op" && t.text === "{" && this.kotlin) return this.kotlinLambda();
    if (t.kind === "op" && t.text === "::") {
      this.i++;
      if (this.peek()?.kind === "id") this.i++;
      return this.opaque(from);
    }
    if (t.kind === "op" && (t.text === "[" || t.text === "{")) {
      this.i = this.skipBalanced(this.i);
      return this.opaque(from);
    }
    if (t.kind === "op" && t.text === "@") {
      this.i += 2;
      if (this.is("(")) this.i = this.skipBalanced(this.i);
      return this.primary();
    }
    if (t.kind === "id" && t.text === "new" && !this.kotlin) {
      this.i++;
      this.type();
      if (this.is("(")) this.i = this.skipBalanced(this.i);
      if (this.is("{")) this.i = this.skipBalanced(this.i);
      return this.opaque(from);
    }
    if (t.kind === "id") {
      if (!this.kotlin && this.is("->", 1)) {
        this.i += 2;
        return this.javaLambda([t.text], t.at);
      }
      this.i++;
      if (this.kotlin && this.is("<") && this.peek(1)?.kind === "id") {
        const save = this.i;
        this.typeArgs();
        if (!this.is("(")) this.i = save;
      }
      if (this.is("(")) {
        const args = this.args();
        return this.trailing({ t: "call", name: t.text, args, at: t.at, end: this.last, nameAt: t.at });
      }
      if (this.kotlin && this.is("{") && !this.peek()!.nl) return this.trailing({ t: "call", name: t.text, args: [], at: t.at, end: t.end, nameAt: t.at });
      return { t: "id", name: t.text, at: t.at, end: t.end };
    }
    this.i++;
    return this.opaque(from);
  }

  /** A Kotlin call's trailing lambda, added as its last argument. */
  trailing(call: Extract<Node, { t: "call" }>): Node {
    if (this.kotlin && this.is("{") && !this.peek()!.nl) {
      const lambda = this.kotlinLambda();
      return { ...call, args: [...call.args, lambda], end: lambda.end };
    }
    return call;
  }

  postfix(node: Node): Node {
    for (;;) {
      if ((this.is(".") || this.is("?.")) && this.peek(1)) {
        this.i++;
        this.typeArgs();
        const name = this.peek();
        if (!name || name.kind !== "id") return node;
        this.i++;
        if (this.is("(")) {
          const args = this.args();
          node = this.trailing({ t: "call", name: name.text, target: node, args, at: node.at, end: this.last, nameAt: name.at });
        } else if (this.kotlin && this.is("{") && !this.peek()!.nl) {
          node = this.trailing({ t: "call", name: name.text, target: node, args: [], at: node.at, end: name.end, nameAt: name.at });
        } else node = { t: "member", target: node, name: name.text, at: node.at, end: name.end };
        continue;
      }
      if (this.is("::")) {
        this.i++;
        if (this.peek()?.kind === "id") this.i++;
        node = { t: "opaque", at: node.at, end: this.last };
        continue;
      }
      if (this.is("!!")) {
        this.i++;
        continue;
      }
      // Kotlin's `"/x" { }` and `predicate { }`: `invoke` on the value, with the lambda.
      if (this.kotlin && this.is("{") && !this.peek()!.nl && (node.t === "str" || node.t === "infix" || node.t === "call" || node.t === "not")) {
        const lambda = this.kotlinLambda();
        node = { t: "call", name: "invoke", target: node, args: [lambda], at: node.at, end: lambda.end, nameAt: node.at };
        continue;
      }
      return node;
    }
  }
}

/** What a predicate takes: alternatives, each a set of methods (none: any) and a path pattern (none: any). */
type Alt = { methods?: string[]; path?: string };
type Read<T> = T | { why: string };
const failed = <T>(r: Read<T>): r is { why: string } => typeof r === "object" && r !== null && !Array.isArray(r) && "why" in r;

interface Route {
  method: string;
  path: string;
  at: number;
  implicit?: boolean;
}

/** A method of the file: its parameters, its body's statements (an expression body as a `return`), and whether it is a `@Bean`. */
interface Method {
  name: string;
  params: number;
  body: Node[];
  bean: boolean;
  /** The bean is a router function: its type names one, or its body builds one. */
  router: boolean;
  at: number;
  start: number;
  end: number;
}

/** The methods a file declares, found by token: Java `Type name(params) { ... }`, Kotlin `fun name(params) = ...` or `{ ... }`. */
function methods(toks: Tok[], kotlin: boolean): Method[] {
  const out: Method[] = [];
  const p = new Parser(toks, kotlin);
  for (let k = 0; k < toks.length; k++) {
    const t = toks[k]!;
    let nameAt: number | undefined;
    if (kotlin && t.kind === "id" && t.text === "fun") {
      let j = k + 1;
      if (toks[j]?.text === "<") {
        p.i = j;
        p.typeArgs();
        j = p.i;
      }
      // An extension's receiver, `fun Type.name(`.
      while (toks[j + 1]?.text === "." && toks[j + 2]?.kind === "id") j += 2;
      if (toks[j]?.kind === "id" && toks[j + 1]?.text === "(") nameAt = j;
    } else if (!kotlin && t.kind === "id" && toks[k + 1]?.text === "(" && !["if", "for", "while", "switch", "catch", "synchronized", "return", "new", "throw", "super", "this"].includes(t.text)) {
      // A declaration: a type (or `void`) before the name, not a `.` or `new`, and a body after the parameters.
      const before = toks[k - 1];
      if (!before || !(before.kind === "id" || before.text === ">" || before.text === "]") || ["new", "return", "throw", "else", "case"].includes(before.text)) continue;
      nameAt = k;
    }
    if (nameAt === undefined) continue;
    const close = p.skipBalanced(nameAt + 1);
    let j = close;
    let type = "";
    if (kotlin && toks[j]?.text === ":") {
      const from = j + 1;
      p.i = from;
      p.type();
      j = p.i;
      type = toks
        .slice(from, j)
        .map((x) => x.text)
        .join("");
    }
    if (!kotlin && toks[j]?.text === "throws") while (j < toks.length && toks[j]!.text !== "{" && toks[j]!.text !== ";") j++;
    let body: Node[] | undefined;
    let end = j;
    if (toks[j]?.text === "{") {
      p.i = j + 1;
      body = p.statements();
      end = p.i;
    } else if (kotlin && toks[j]?.text === "=") {
      p.i = j + 1;
      const e = p.expression();
      body = [{ t: "return", value: e, at: e.at, end: e.end }];
      end = p.i;
    }
    if (!body) continue;
    // The annotations and modifiers before the declaration, back to the previous statement or member.
    let s = kotlin ? k - 1 : nameAt - 1;
    while (s >= 0 && !(toks[s]!.kind === "op" && ";{}".includes(toks[s]!.text))) {
      if (toks[s]!.text === ")") {
        let depth = 0;
        for (; s >= 0; s--) {
          if (toks[s]!.text === ")") depth++;
          else if (toks[s]!.text === "(" && --depth === 0) break;
        }
      }
      s--;
    }
    const head = toks.slice(s + 1, kotlin ? k : nameAt);
    const bean = head.some((x, n) => x.text === "@" && head.slice(n + 1).find((y) => y.kind === "id" && y.text !== "org" && y.text !== "springframework" && y.text !== "context" && y.text !== "annotation")?.text === "Bean");
    if (!kotlin) type = head.filter((x) => x.text !== "@").map((x) => x.text).join(" ");
    const first = body[0];
    // A Kotlin expression body with no declared type: its type is the expression's, a router function where it is the
    // DSL's or one `RouterFunctions` builds (`route()`, `route`, `nest`, `resources`, `resource`).
    let root: Node | undefined = first?.t === "return" && kotlin && !type ? first.value : undefined;
    while (root?.t === "call" && root.target) root = root.target;
    const builds =
      body.length === 1 &&
      !!root &&
      ((root.t === "call" && ["router", "coRouter", "route", "nest", "resources", "resource"].includes(root.name)) || ((root.t === "id" || root.t === "member") && root.name === "RouterFunctions"));
    out.push({
      name: toks[nameAt]!.text,
      params: close - nameAt > 3 ? 1 + toks.slice(nameAt + 2, close - 1).filter((x) => x.text === ",").length : 0,
      body,
      bean,
      router: /\b(?:Co)?RouterFunction\b/.test(type) || builds,
      at: toks[nameAt]!.at,
      start: toks[s + 1]?.at ?? t.at,
      end: toks[end - 1]?.end ?? t.end,
    });
    k = Math.max(k, end - 1);
  }
  return out;
}

/**
 * The locals of a body whose value is their initializer: declared `final` or `val`, or never assigned again in the body
 * (`x = ...`, `x += ...`). Another value a later assignment gives is not read, so neither is that local.
 */
function settled(code: string, body: Node[]): Map<string, Node> {
  const out = new Map<string, Node>();
  const text = body.length ? code.slice(body[0]!.at, body[body.length - 1]!.end) : "";
  for (const s of body) {
    if (s.t !== "decl" || !s.init) continue;
    const name = s.name.replace(/\$/g, "\\$");
    const assigned = [...text.matchAll(new RegExp(`(?<![\\w$.])${name}\\s*(?:[-+*/%&|^]|<<|>>>?)?=(?!=)`, "g"))].length;
    if (s.final || assigned <= 1) out.set(s.name, s.init);
  }
  return out;
}

/**
 * The name of a constant of an enum or class, `Type.NAME`, or `NAME` where the file imports it from that type (Java's
 * `import static`, Kotlin's import); undefined for anything else.
 */
function constantOf(n: Node, type: string, text: string): string | undefined {
  const simple = type.slice(type.lastIndexOf(".") + 1);
  if (n.t === "member" && (n.target.t === "id" ? n.target.name : n.target.t === "member" ? n.target.name : undefined) === simple) return /^[A-Z]+$/.test(n.name) ? n.name : undefined;
  if (n.t !== "id" || !/^[A-Z]+$/.test(n.name)) return undefined;
  const escaped = type.replace(/\./g, "\\.");
  return new RegExp(`^\\s*import\\s+(?:static\\s+)?${escaped}\\.(?:\\*|${n.name})\\s*;?\\s*$`, "m").test(text) ? n.name : undefined;
}

/** The router functions a Java or Kotlin file's `@Bean` methods build, with what is not read in `limits`. */
export function routerFunctionRoutes(file: string, text: string, spec: RouteSource, constant: Constant, spans?: Spans, limits?: string[]): FunctionalRoute[] {
  if (!PACKAGES.test(text)) return [];
  const kotlin = /\.kts?$/.test(file);
  const code = withoutComments(file, text);
  const toks = tokenize(file, code, kotlin);
  // Kotlin may import the DSL under another name: `import org.springframework.web.servlet.function.router as routes`.
  const aliases = new Map([...text.matchAll(/^\s*import\s+org\.springframework\.web\.(?:servlet\.function|reactive\.function\.server)\.(router|coRouter)\s+as\s+(\w+)/gm)].map((m) => [m[2]!, m[1]!]));
  for (const t of toks) if (t.kind === "id" && aliases.has(t.text) && t.text !== aliases.get(t.text)) t.text = aliases.get(t.text)!;
  const all = methods(toks, kotlin);
  const routes: Route[] = [];
  let capped = false;
  /**
   * The work the file's router functions take, one unit a nested context and a statement: nests of alternatives
   * multiply, so past a bound the rest is not read, and a limit says so.
   */
  let work = 0;
  const spend = (at: number): boolean => {
    if (capped) return true;
    if (++work <= MAX_WORK) return false;
    limits?.push(`routes ${spec.component}: ${file}:${lineOf(text, at)} nests router functions past ${MAX_WORK} contexts and statements; the rest are not read`);
    capped = true;
    return true;
  };
  /** The helpers a bean calls, which are read where it does. */
  const called = new Set<string>();
  const said = new Set<string>();
  const say = (at: number, what: string) => {
    const line = `routes ${spec.component}: ${file}:${lineOf(text, at)} ${what}; its routes are not read`;
    if (!said.has(line)) limits?.push(line);
    said.add(line);
  };
  const short = (n: Node) => {
    const s = code.slice(n.at, n.end).replace(/\s+/g, " ").trim();
    return s.length > 80 ? `${s.slice(0, 77)}...` : s;
  };
  const owner = (n: Node | undefined) => n?.t === "id" ? n.name : n?.t === "member" ? n.name : undefined;

  interface Ctx {
    prefix: string;
    methods?: string[];
    locals: Map<string, Node>;
    seen: Set<string>;
  }
  const withLocals = (ctx: Ctx, body: Node[]): Ctx => {
    const locals = new Map(ctx.locals);
    for (const [name, init] of settled(code, body)) locals.set(name, init);
    return { ...ctx, locals };
  };

  /** A string a pattern argument gives: a literal, or a constant the file declares. */
  const stringOf = (n: Node, ctx: Ctx): string | undefined => {
    if (n.t === "str") {
      if (n.value !== undefined) spans?.add(file, n.at, n.end);
      return n.value;
    }
    if (n.t === "id" && ctx.locals.has(n.name) && !ctx.seen.has(n.name)) return stringOf(ctx.locals.get(n.name)!, { ...ctx, seen: new Set([...ctx.seen, n.name]) });
    if (n.t === "id" || n.t === "member") return constant(code.slice(n.at, n.end).replace(/\s+/g, ""), n.at);
    return undefined;
  };
  const isString = (n: Node, ctx: Ctx): boolean => n.t === "str" || ((n.t === "id" || n.t === "member") && stringOf(n, ctx) !== undefined);
  const httpMethod = (n: Node): string | undefined => constantOf(n, "org.springframework.http.HttpMethod", text);

  const and = (a: Alt[], b: Alt[]): Read<Alt[]> => {
    const out: Alt[] = [];
    for (const x of a) {
      for (const y of b) {
        if (x.path !== undefined && y.path !== undefined) return { why: "a predicate that takes two path patterns at once" };
        if (out.length >= MAX_ALTERNATIVES) return { why: `a predicate of more than ${MAX_ALTERNATIVES} combinations of methods and paths` };
        const methods = x.methods && y.methods ? x.methods.filter((m) => y.methods!.includes(m)) : (x.methods ?? y.methods);
        if (methods && !methods.length) continue;
        out.push({ ...(methods ? { methods } : {}), ...((x.path ?? y.path) !== undefined ? { path: x.path ?? y.path } : {}) });
      }
    }
    return out;
  };

  /** What a request predicate takes. */
  /** `or`: the alternatives of either, as many as `and` takes at most. */
  const or = (l: Alt[], r: Alt[]): Read<Alt[]> =>
    l.length + r.length > MAX_ALTERNATIVES ? { why: `a predicate of more than ${MAX_ALTERNATIVES} combinations of methods and paths` } : [...l, ...r];
  /** What a local holds, read once: a name used twice is not read twice. */
  const held = new Map<Node, Read<Alt[]>>();
  const predicate = (n: Node, ctx: Ctx): Read<Alt[]> => {
    const not = { why: `a predicate atlas does not read (${short(n)})` };
    if (n.t === "str") {
      const v = stringOf(n, ctx);
      return v === undefined ? not : [{ path: v }];
    }
    if (n.t === "id") {
      const init = ctx.locals.get(n.name);
      if (!init || ctx.seen.has(n.name)) return { why: `a predicate the file does not spell out (${n.name})` };
      if (!held.has(init)) held.set(init, predicate(init, { ...ctx, seen: new Set([...ctx.seen, n.name]) }));
      return held.get(init)!;
    }
    if (n.t === "not") {
      const inner = predicate(n.operand, ctx);
      return failed(inner) ? inner : inner.every((a) => !a.methods && a.path === undefined) ? [{}] : not;
    }
    if (n.t === "infix" && (n.op === "and" || n.op === "or")) {
      const l = predicate(n.left, ctx);
      if (failed(l)) return l;
      const r = predicate(n.right, ctx);
      if (failed(r)) return r;
      return n.op === "or" ? or(l, r) : and(l, r);
    }
    if (n.t !== "call") return not;
    if (n.target && owner(n.target) !== "RequestPredicates" && (n.name === "and" || n.name === "or" || n.name === "negate")) {
      const l = predicate(n.target, ctx);
      if (failed(l)) return l;
      if (n.name === "negate") return l.every((a) => !a.methods && a.path === undefined) ? [{}] : not;
      const r = n.args[0] ? predicate(n.args[0], ctx) : not;
      if (failed(r)) return r;
      return n.name === "or" ? or(l, r) : and(l, r);
    }
    if (n.target && owner(n.target) !== "RequestPredicates") return not;
    if (METHODS.has(n.name) && n.args.length === 1) {
      const v = stringOf(n.args[0]!, ctx);
      return v === undefined ? { why: `a pattern the file does not spell out (${short(n.args[0]!)})` } : [{ methods: [n.name], path: v }];
    }
    if (n.name === "path" && n.args.length === 1) {
      const v = stringOf(n.args[0]!, ctx);
      return v === undefined ? { why: `a pattern the file does not spell out (${short(n.args[0]!)})` } : [{ path: v }];
    }
    if ((n.name === "method" || n.name === "methods") && n.args.length) {
      const ms = n.args.map(httpMethod);
      return ms.every((m) => m !== undefined) ? [{ methods: ms }] : not;
    }
    if (n.name === "all" && !n.args.length) return [{}];
    if (NARROWING.has(n.name)) return [{}];
    return not;
  };

  /** The pattern a nested route is served at: its nest's, then its own, with a `/` before it where it has none. */
  const nested = (prefix: string, own: string | undefined): Read<string> => {
    if (/\*\*|\{\*/.test(prefix)) return { why: `a nest whose pattern takes the rest of the path (${prefix})` };
    if (own === undefined) return `${prefix}/**`;
    return prefix + (own && !own.startsWith("/") ? `/${own}` : own);
  };
  const add = (alts: Alt[], ctx: Ctx, at: number, only?: string[]) => {
    for (const alt of alts) {
      let methods = alt.methods && ctx.methods ? alt.methods.filter((m) => ctx.methods!.includes(m)) : (alt.methods ?? ctx.methods);
      if (only) methods = (methods ?? only).filter((m) => only.includes(m));
      if (methods && !methods.length) continue;
      const path = nested(ctx.prefix, alt.path);
      if (failed(path)) {
        say(at, `builds a router function on ${path.why}`);
        continue;
      }
      for (const method of methods ?? ["*"]) {
        if (routes.length >= MAX_ROUTES) {
          if (!capped) limits?.push(`routes ${spec.component}: ${file}:${lineOf(text, at)} builds more than ${MAX_ROUTES} routes in router functions; the rest are not read`);
          capped = true;
          return;
        }
        routes.push({ method, path, at, ...(only && method === "HEAD" ? { implicit: true } : {}) });
      }
    }
  };
  /** A nest: the context its routes are read in, one per alternative of its predicate. */
  const nest = (pred: Node, ctx: Ctx, at: number): Ctx[] => {
    const alts = predicate(pred, ctx);
    if (failed(alts)) {
      say(at, `nests router functions under ${alts.why}`);
      return [];
    }
    const out: Ctx[] = [];
    for (const a of alts) {
      const prefix = a.path === undefined ? ctx.prefix : nested(ctx.prefix, a.path);
      if (failed(prefix)) {
        say(at, `nests router functions under ${prefix.why}`);
        continue;
      }
      const methods = a.methods && ctx.methods ? a.methods.filter((m) => ctx.methods!.includes(m)) : (a.methods ?? ctx.methods);
      if (methods && !methods.length) continue;
      // Alternatives that leave the same path and methods (`accept(a).or(accept(b))`) are one context.
      if (out.some((c) => c.prefix === prefix && String(c.methods) === String(methods))) continue;
      if (spend(at)) return [];
      out.push({ ...ctx, prefix, ...(methods ? { methods } : {}) });
    }
    return out;
  };
  /** `resources(pattern, location)`: GET and HEAD under a pattern ending in `/**`, one segment or more after it. */
  const resources = (n: Extract<Node, { t: "call" }>, ctx: Ctx) => {
    const pattern = n.args.length >= 2 ? stringOf(n.args[0]!, ctx) : undefined;
    const base = pattern === undefined ? undefined : /^(.*)\/(?:\*\*|\{\*[^{}]*\})$/.exec(pattern)?.[1];
    if (base === undefined || /[*?{}]/.test(base)) {
      say(n.nameAt, `serves resources at ${pattern === undefined ? "paths a lookup function or a pattern the file does not spell out decides" : `${pattern}, a pattern whose paths atlas does not read`} (${n.name})`);
      return;
    }
    add([{ path: `${base}/{path}/**` }], ctx, n.nameAt, ["GET", "HEAD"]);
  };

  /** A route a method call registers: `GET(pattern, handler)`, `GET(pattern, predicate, handler)`, `GET(predicate, handler)`, `GET(handler)`. */
  const verb = (n: Extract<Node, { t: "call" }>, ctx: Ctx) => {
    const args = n.args.slice(0, -1);
    let alts: Read<Alt[]> = [{ methods: [n.name] }];
    if (args.length >= 1) {
      const first = args[0]!;
      const own: Read<Alt[]> = isString(first, ctx) ? [{ methods: [n.name], path: stringOf(first, ctx)! }] : first.t === "str" ? { why: `a pattern the file does not spell out (${short(first)})` } : predicate(first, ctx);
      alts = failed(own) ? own : and([{ methods: [n.name] }], own);
    }
    if (!failed(alts) && args.length === 2) {
      const extra = predicate(args[1]!, ctx);
      alts = failed(extra) ? extra : and(alts, extra);
    }
    if (failed(alts)) say(n.nameAt, `registers ${n.name} on ${alts.why}`);
    else add(alts, ctx, n.nameAt);
  };

  /** A builder's calls in order, from `route()` or a builder parameter to the end of the chain. */
  const builder = (chain: Extract<Node, { t: "call" }>[], ctx: Ctx) => {
    for (const n of chain) {
      if (spend(n.at)) return;
      if (METHODS.has(n.name) && n.args.length >= 1 && n.args.length <= 3) verb(n, ctx);
      else if (n.name === "route" && n.args.length === 2) {
        const alts = predicate(n.args[0]!, ctx);
        if (failed(alts)) say(n.nameAt, `routes on ${alts.why}`);
        else add(alts, ctx, n.nameAt);
      } else if (n.name === "add" && n.args.length === 1) routerFunction(n.args[0]!, ctx);
      else if (n.name === "resources") resources(n, ctx);
      else if (n.name === "resource" && n.args.length >= 2) {
        const alts = predicate(n.args[0]!, ctx);
        if (failed(alts)) say(n.nameAt, `serves a resource on ${alts.why}`);
        else add(alts, ctx, n.nameAt, ["GET", "HEAD"]);
      } else if ((n.name === "nest" || n.name === "path") && n.args.length === 2) {
        const inner = n.name === "path" ? pathNest(n.args[0]!, ctx, n.nameAt) : nest(n.args[0]!, ctx, n.nameAt);
        const lambda = n.args[1]!;
        for (const c of inner) {
          // A `Consumer<Builder>` calls the builder it is given; a `Supplier<RouterFunction>` returns one.
          if (lambda.t !== "lambda") say(n.nameAt, `nests router functions built elsewhere (${short(lambda)})`);
          else if (lambda.params.length === 1 && lambda.body.some((st) => rootedAt(st, lambda.params[0]!))) consumer(lambda, c);
          else supplier(lambda, c);
        }
      } else if (NEUTRAL.has(n.name) || n.name === "build") continue;
      else say(n.nameAt, `builds a router function with a call atlas does not read (${n.name})`);
    }
  };
  const pathNest = (pattern: Node, ctx: Ctx, at: number): Ctx[] => {
    const v = stringOf(pattern, ctx);
    if (v === undefined) {
      say(at, `nests router functions under a pattern the file does not spell out (${short(pattern)})`);
      return [];
    }
    const prefix = nested(ctx.prefix, v);
    if (failed(prefix)) {
      say(at, `nests router functions under ${prefix.why}`);
      return [];
    }
    return [{ ...ctx, prefix }];
  };
  /** `builder -> builder.GET(...)...`: each statement a chain on the parameter. */
  const consumer = (lambda: Extract<Node, { t: "lambda" }>, ctx: Ctx) => {
    const param = lambda.params[0]!;
    const inner = withLocals(ctx, lambda.body);
    for (const s of lambda.body) {
      const e = s.t === "return" ? s.value : s.t === "decl" ? undefined : s;
      if (!e) continue;
      const chain = unroll(e);
      if (chain && chain.root.t === "id" && chain.root.name === param) builder(chain.calls, inner);
      else if (mentions(e, param)) say(e.at, `builds a router function atlas does not read (${short(e)})`);
    }
  };
  /** `() -> route()...build()`: the router function it returns. */
  const supplier = (lambda: Extract<Node, { t: "lambda" }>, ctx: Ctx) => {
    const inner = withLocals(ctx, lambda.body);
    for (const s of lambda.body) if (s.t === "return" && s.value) routerFunction(s.value, inner);
  };
  const mentions = (n: Node, name: string): boolean => new RegExp(`(?<![\\w$])${name.replace(/\$/g, "\\$")}(?![\\w$])`).test(code.slice(n.at, n.end));
  const rootedAt = (st: Node, name: string): boolean => {
    const e = st.t === "return" ? st.value : st;
    const chain = e && unroll(e);
    return !!chain && chain.root.t === "id" && chain.root.name === name;
  };
  /** A call chain from its root: `a.b().c()` is `a`, then `b`, `c`. */
  const unroll = (n: Node): { root: Node; calls: Array<Extract<Node, { t: "call" }>> } | undefined => {
    const calls: Array<Extract<Node, { t: "call" }>> = [];
    let x: Node | undefined = n;
    while (x && x.t === "call" && x.target) {
      calls.unshift(x);
      x = x.target;
    }
    return x ? { root: x, calls } : undefined;
  };

  /** The routes of a router function expression. */
  const routerFunction = (n: Node, ctx: Ctx): void => {
    if (capped) return;
    if (n.t === "id") {
      const init = ctx.locals.get(n.name);
      if (init && !ctx.seen.has(n.name)) return routerFunction(init, { ...ctx, seen: new Set([...ctx.seen, n.name]) });
      return say(n.at, `adds a router function the file does not spell out (${n.name})`);
    }
    if (n.t === "infix" && n.op === "+" && kotlin) {
      routerFunction(n.left, ctx);
      return routerFunction(n.right, ctx);
    }
    if (n.t !== "call") return say(n.at, `builds a router function atlas does not read (${short(n)})`);
    const { root, calls } = unroll(n)!;
    let head: Extract<Node, { t: "call" }>;
    let rest: Array<Extract<Node, { t: "call" }>>;
    if (root.t === "call") [head, rest] = [root, calls];
    else if (owner(root) === "RouterFunctions" && calls.length) [head, rest] = [calls[0]!, calls.slice(1)];
    else if (root.t === "id") {
      // Calls on a router function a name holds: `other.and(...)`.
      routerFunction(root, ctx);
      for (const c of calls) onRouterFunction(c, ctx);
      return;
    } else return say(n.at, `builds a router function atlas does not read (${short(n)})`);
    // `route()` and the calls on its builder, up to `build()`, then calls on the router function it builds.
    if (head.name === "route" && !head.args.length) {
      const built = rest.findIndex((c) => c.name === "build");
      builder(built < 0 ? rest : rest.slice(0, built), ctx);
      for (const c of built < 0 ? [] : rest.slice(built + 1)) onRouterFunction(c, ctx);
      return;
    }
    const known = ((head.name === "route" || head.name === "nest") && head.args.length === 2) || head.name === "resources" || head.name === "resource" || (kotlin && (head.name === "router" || head.name === "coRouter"));
    if (!known) {
      // A method of the file that takes no argument and returns a router function: a helper, read here, or another
      // bean, read on its own.
      const own = head.target ? undefined : all.find((m) => m.name === head.name && m.params === 0 && !head.args.length);
      if (!own || ctx.seen.has(`${own.name}()`)) return say(head.nameAt, `builds a router function atlas does not read (${short(head)})`);
      if (!own.bean) called.add(own.name);
      // A bean is read at the root on its own; composed under a nest, it serves there as well.
      if (!own.bean || ctx.prefix !== "" || ctx.methods) body(own.body, { prefix: ctx.prefix, ...(ctx.methods ? { methods: ctx.methods } : {}), locals: new Map(), seen: new Set([...ctx.seen, `${own.name}()`]) });
    } else staticCall(head, ctx);
    for (const c of rest) onRouterFunction(c, ctx);
  };
  /** `route(predicate, handler)`, `nest(predicate, routerFunction)`, `resources`, `resource`, `router { }`. */
  const staticCall = (n: Extract<Node, { t: "call" }>, ctx: Ctx) => {
    if (n.name === "route" && n.args.length === 2) {
      const alts = predicate(n.args[0]!, ctx);
      if (failed(alts)) say(n.nameAt, `routes on ${alts.why}`);
      else add(alts, ctx, n.nameAt);
    } else if (n.name === "nest" && n.args.length === 2) {
      for (const c of nest(n.args[0]!, ctx, n.nameAt)) routerFunction(n.args[1]!, c);
    } else if (n.name === "resources") resources(n, ctx);
    else if (n.name === "resource" && n.args.length >= 2) {
      const alts = predicate(n.args[0]!, ctx);
      if (failed(alts)) say(n.nameAt, `serves a resource on ${alts.why}`);
      else add(alts, ctx, n.nameAt, ["GET", "HEAD"]);
    } else if (kotlin && (n.name === "router" || n.name === "coRouter") && n.args.length === 1 && n.args[0]!.t === "lambda") dsl(n.args[0].body, ctx);
    else say(n.nameAt, `builds a router function atlas does not read (${n.name})`);
  };
  /** A call on a router function: `and`, `andOther`, `andRoute`, `andNest`, and those that change no route. */
  const onRouterFunction = (c: Extract<Node, { t: "call" }>, ctx: Ctx) => {
    if ((c.name === "and" || c.name === "andOther") && c.args.length === 1) routerFunction(c.args[0]!, ctx);
    else if (c.name === "andRoute" && c.args.length === 2) {
      const alts = predicate(c.args[0]!, ctx);
      if (failed(alts)) say(c.nameAt, `routes on ${alts.why}`);
      else add(alts, ctx, c.nameAt);
    } else if (c.name === "andNest" && c.args.length === 2) {
      for (const inner of nest(c.args[0]!, ctx, c.nameAt)) routerFunction(c.args[1]!, inner);
    } else if (!NEUTRAL.has(c.name)) say(c.nameAt, `builds a router function with a call atlas does not read (${c.name})`);
  };

  /** The Kotlin router DSL's statements. */
  const dsl = (statements: Node[], outer: Ctx) => {
    const ctx = withLocals(outer, statements);
    for (const s of statements) {
      if (spend(s.at)) return;
      if (s.t === "decl") continue;
      if (s.t !== "call") {
        say(s.at, `builds a router function with a statement atlas does not read (${short(s)})`);
        continue;
      }
      const handler = s.args[s.args.length - 1];
      if (!s.target && METHODS.has(s.name)) {
        // `GET("/x")` alone is a predicate and registers nothing.
        if (s.args.length === 1 && isString(s.args[0]!, ctx)) continue;
        verb(s, ctx);
      } else if (s.name === "nest" && s.target && handler?.t === "lambda") {
        for (const c of nest(s.target, ctx, s.nameAt)) dsl(handler.body, c);
      } else if (s.name === "invoke" && s.target && handler?.t === "lambda") {
        const alts = predicate(s.target, ctx);
        if (failed(alts)) say(s.at, `routes on ${alts.why}`);
        else add(alts, ctx, s.at);
      } else if (!s.target && ["accept", "contentType", "headers", "param", "method", "path", "pathExtension"].includes(s.name) && s.args.length >= 2) {
        const alts = predicate({ ...s, args: s.args.slice(0, -1) }, ctx);
        if (failed(alts)) say(s.nameAt, `routes on ${alts.why}`);
        else add(alts, ctx, s.nameAt);
      } else if (!s.target && s.name === "resources") {
        if (s.args.length === 2) resources(s, ctx);
        else say(s.nameAt, "serves resources at paths a lookup function decides (resources)");
      } else if (!s.target && s.name === "resource" && s.args.length === 2) {
        const alts = predicate(s.args[0]!, ctx);
        if (failed(alts)) say(s.nameAt, `serves a resource on ${alts.why}`);
        else add(alts, ctx, s.nameAt, ["GET", "HEAD"]);
      } else if (!s.target && s.name === "add" && s.args.length === 1) routerFunction(s.args[0]!, ctx);
      else if (!s.target && NEUTRAL.has(s.name)) continue;
      else say(s.nameAt, `builds a router function with a call atlas does not read (${s.name})`);
    }
  };

  /** A method body: the router function its `return` gives, with its locals. */
  const body = (statements: Node[], ctx: Ctx) => {
    const inner = withLocals(ctx, statements);
    for (const s of statements) if (s.t === "return" && s.value) routerFunction(s.value, inner);
  };

  const read: Array<[number, number]> = [];
  for (const m of all) {
    if (!m.bean || !m.router) continue;
    read.push([m.start, m.end]);
    body(m.body, { prefix: "", locals: new Map(), seen: new Set([`${m.name}()`]) });
  }
  // A router function built anywhere else is not served for certain: a helper no bean of the file calls, or one built
  // outside any method atlas reads.
  const helpers = all.filter((m) => !m.bean && m.router);
  for (const m of helpers) if (!called.has(m.name)) say(m.at, `builds a router function in ${m.name}, which no @Bean method of the file calls`);
  for (let k = 0; k < toks.length; k++) {
    const t = toks[k]!;
    const starts =
      (t.kind === "id" && kotlin && (t.text === "router" || t.text === "coRouter") && toks[k + 1]?.text === "{" && toks[k - 1]?.text !== "." && toks[k - 1]?.text !== "fun") ||
      (t.kind === "id" && t.text === "RouterFunctions" && toks[k + 1]?.text === "." && ["route", "nest", "resources", "resource"].includes(toks[k + 2]?.text ?? "") && toks[k - 1]?.text !== "." && toks[k - 1]?.text !== "import");
    if (!starts || read.some(([s, e]) => t.at >= s && t.at < e)) continue;
    if (helpers.some((m) => t.at >= m.start && t.at < m.end)) continue;
    say(t.at, `builds a router function outside a @Bean method (${t.text})`);
  }

  return routes.map((r) => ({ method: r.method, path: joinRoute(r.path === "" ? "/" : r.path), line: lineOf(text, r.at), ...(r.implicit ? { implicit: true } : {}) }));
}

/** Each node of a tree, depth first. */
function walk(n: Node | undefined, visit: (n: Node) => void): void {
  if (!n) return;
  visit(n);
  switch (n.t) {
    case "call":
      walk(n.target, visit);
      for (const a of n.args) walk(a, visit);
      break;
    case "member":
      walk(n.target, visit);
      break;
    case "lambda":
      for (const s of n.body) walk(s, visit);
      break;
    case "infix":
      walk(n.left, visit);
      walk(n.right, visit);
      break;
    case "not":
      walk(n.operand, visit);
      break;
    case "decl":
      walk(n.init, visit);
      break;
    case "return":
      walk(n.value, visit);
      break;
  }
}

/** The calls a `RequestMappingInfo` builder takes that narrow a request by what is not its path or method. */
const INFO_NARROWING = new Set(["params", "headers", "consumes", "produces", "mappingName", "customCondition", "options", "version", "build"]);

/**
 * The handler methods a file registers with `RequestMappingHandlerMapping.registerMapping(info, handler, method)`, at
 * the paths and methods of the `RequestMappingInfo` it builds (`RequestMappingInfo.paths(...).methods(...).build()`,
 * in place or in a local): served as given, with no `PathMatchConfigurer` prefix, which only the methods the mapping
 * detects get. `paths` puts a `/` before a pattern that has none (`PathPatternsRequestCondition`); no method is any.
 */
export function registeredMappingRoutes(file: string, text: string, constant: Constant, component: string, spans?: Spans, limits?: string[]): FunctionalRoute[] {
  if (!/\bregisterMapping\b/.test(text) || !/\bRequestMappingInfo\b/.test(text)) return [];
  const kotlin = /\.kts?$/.test(file);
  const code = withoutComments(file, text);
  const toks = tokenize(file, code, kotlin);
  const out: FunctionalRoute[] = [];
  const say = (at: number, what: string) => limits?.push(`routes ${component}: ${file}:${lineOf(text, at)} ${what}; its route is not read`);
  const all = methods(toks, kotlin);
  for (const t of toks) {
    if (t.text === "registerMapping" && !all.some((m) => t.at >= m.start && t.at < m.end)) say(t.at, "registers a handler method outside a method atlas reads");
  }
  for (const m of all) {
    const locals = settled(code, m.body);
    walk({ t: "lambda", params: [], body: m.body, at: m.at, end: m.end }, (n) => {
      if (n.t !== "call" || n.name !== "registerMapping" || !n.target || n.args.length !== 3) return;
      let info: Node = n.args[0]!;
      for (const seen = new Set<string>(); info.t === "id" && locals.has(info.name) && !seen.has(info.name); ) {
        seen.add(info.name);
        info = locals.get(info.name)!;
      }
      const shown = code.slice(n.args[0]!.at, n.args[0]!.end).replace(/\s+/g, " ");
      const calls: Array<Extract<Node, { t: "call" }>> = [];
      let x: Node | undefined = info;
      while (x && x.t === "call" && x.target) {
        calls.unshift(x);
        x = x.target;
      }
      const owner = x?.t === "id" ? x.name : x?.t === "member" ? x.name : undefined;
      if (owner !== "RequestMappingInfo" || calls[0]?.name !== "paths") return say(n.nameAt, `registers a handler method with a mapping the file does not spell out (${shown})`);
      const paths = calls[0].args.map((a) => {
        if (a.t === "str") {
          if (a.value !== undefined) spans?.add(file, a.at, a.end);
          return a.value;
        }
        return a.t === "id" || a.t === "member" ? constant(code.slice(a.at, a.end).replace(/\s+/g, ""), a.at) : undefined;
      });
      let verbs: string[] | undefined;
      let unread: string | undefined;
      for (const c of calls.slice(1)) {
        if (c.name === "methods") {
          const ms = c.args.map((a) => constantOf(a, "org.springframework.web.bind.annotation.RequestMethod", text));
          if (ms.some((v) => v === undefined || !/^[A-Z]+$/.test(v))) unread = `methods the file does not spell out (${code.slice(c.at, c.end).replace(/\s+/g, " ")})`;
          // `methods(...)` sets the condition anew (`DefaultBuilder.methods`); none given is any method.
          else verbs = ms.length ? (ms as string[]) : undefined;
        } else if (c.name === "paths") unread = "a second list of paths";
        else if (!INFO_NARROWING.has(c.name)) unread = `a condition atlas does not read (${c.name})`;
      }
      if (paths.some((p) => p === undefined) || !paths.length) unread ??= `paths the file does not spell out (${shown})`;
      if (unread) return say(n.nameAt, `registers a handler method with ${unread}`);
      for (const p of paths as string[]) {
        const path = p && !p.startsWith("/") ? `/${p}` : p;
        for (const method of verbs ?? ["*"]) out.push({ method, path: joinRoute(path), line: lineOf(text, n.nameAt) });
      }
    });
  }
  return out;
}
