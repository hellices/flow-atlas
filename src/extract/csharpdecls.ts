import { lineOf } from "../source.js";
import { bracketPairs, lex, type Token } from "./csharp.js";

/**
 * The declarations of a C# file, read from its tokens (see `csharp.ts`): `using` aliases, namespaces, types with their
 * attributes, base types, constants and methods, and the top-level statements a program may start with. Only what
 * reading routes needs: a member is a method, a constant, or passed over.
 */

export interface CsFile {
  file: string;
  text: string;
  tokens: Token[];
  /** Each opening bracket's index with its closing one's, and the reverse. */
  pairs: Map<number, number>;
  opens: Map<number, number>;
  /** `using Alias = Some.Name;`: the alias with the last name of what it stands for. */
  aliases: Map<string, string>;
  types: TypeDecl[];
  /** The token range of the top-level statements, where the file has any. */
  topLevel?: [number, number];
  /** Where the lexer stopped before the end, at a string literal it cannot read. */
  stopped?: number;
}

export interface Argument {
  /** The name of a named argument (`name: value`) or attribute property (`Name = value`). */
  name?: string;
  start: number;
  end: number;
}

export interface Attribute {
  /** The attribute's type as written, its last name without the `Attribute` suffix (`Route` for `Mvc.RouteAttribute`). */
  name: string;
  args: Argument[];
  at: number;
}

export interface Parameter {
  name: string;
  type: string;
  self: boolean;
  optional: boolean;
}

export interface MethodDecl {
  name: string;
  owner: TypeDecl;
  modifiers: Set<string>;
  attributes: Attribute[];
  params: Parameter[];
  generic: boolean;
  /** An explicit interface implementation (`void IFoo.Bar()`), which is private. */
  explicit: boolean;
  /** The token range of the body: inside its braces, or the expression after `=>`. */
  body?: [number, number];
  expression: boolean;
  at: number;
}

export interface TypeDecl {
  name: string;
  namespace: string;
  file: CsFile;
  keyword: string;
  modifiers: Set<string>;
  attributes: Attribute[];
  /** The last name of each base type and interface (`ControllerBase` for `Microsoft.AspNetCore.Mvc.ControllerBase`). */
  bases: string[];
  generic: boolean;
  nested: boolean;
  methods: MethodDecl[];
  /** Constants by name, with the token range of their value. */
  consts: Map<string, [number, number]>;
  at: number;
}

const MODIFIERS = new Set([
  "public", "private", "protected", "internal", "static", "abstract", "sealed", "partial", "virtual", "override", "new",
  "readonly", "extern", "unsafe", "async", "file", "required", "volatile", "const", "ref", "fixed", "implicit", "explicit",
]);
const TYPE_KEYWORDS = new Set(["class", "struct", "interface", "enum"]);

export function readCsFile(file: string, text: string): CsFile {
  const { tokens, stopped } = lex(text);
  const pairs = bracketPairs(tokens);
  const opens = new Map([...pairs].map(([o, c]) => [c, o]));
  const f: CsFile = { file, text, tokens, pairs, opens, aliases: new Map(), types: [], ...(stopped !== undefined ? { stopped } : {}) };
  scope(f, 0, tokens.length, "", undefined, true);
  return f;
}

export const lineAt = (f: CsFile, i: number): number => lineOf(f.text, f.tokens[Math.min(i, f.tokens.length - 1)]?.start ?? 0);

const is = (t: Token | undefined, text: string): boolean => !!t && t.kind !== "str" && t.kind !== "char" && t.text === text;
const isId = (t: Token | undefined): boolean => t?.kind === "id";

/** The index after a bracket group starting at `i`, or `i + 1` for any other token. */
export const skip = (f: CsFile, i: number): number => (f.pairs.has(i) ? f.pairs.get(i)! + 1 : i + 1);

/**
 * The index of the `>` that closes a type argument list opening at `i` (`<` after a name), or undefined where the `<` is
 * a comparison: only names, `,`, `.`, `?`, `::`, `*`, arrays, tuples and nested lists may stand between.
 */
export function genericClose(f: CsFile, i: number, end = f.tokens.length): number | undefined {
  if (!is(f.tokens[i], "<") || !isId(f.tokens[i - 1])) return undefined;
  let depth = 0;
  for (let j = i; j < end; j++) {
    const t = f.tokens[j]!;
    if (is(t, "<")) depth++;
    else if (is(t, ">")) {
      depth--;
      if (depth === 0) return j;
    } else if (is(t, "(") || is(t, "[")) {
      const close = f.pairs.get(j);
      if (close === undefined) return undefined;
      j = close;
    } else if (!(isId(t) || [",", ".", "?", "::", "*"].includes(t.text))) return undefined;
  }
  return undefined;
}

/** The comma-separated parts of a bracket group opening at `open`, each a named argument where it starts `name:`. */
export function argumentsOf(f: CsFile, open: number): Argument[] {
  const close = f.pairs.get(open);
  if (close === undefined || close === open + 1) return [];
  const out: Argument[] = [];
  let start = open + 1;
  for (let j = open + 1; j <= close; j++) {
    if (j === close || is(f.tokens[j], ",")) {
      const arg: Argument = { start, end: j };
      if (isId(f.tokens[start]) && (is(f.tokens[start + 1], ":") || is(f.tokens[start + 1], "=")) && start + 2 < j) {
        arg.name = f.tokens[start]!.text;
        arg.start = start + 2;
      }
      // `ref`, `out` and `in` before an argument pass it, they are not its value.
      while (arg.start < j - 1 && ["ref", "out", "in"].includes(f.tokens[arg.start]!.text) && f.tokens[arg.start]!.kind === "id") arg.start++;
      out.push(arg);
      start = j + 1;
      continue;
    }
    const g = genericClose(f, j, close);
    if (g !== undefined) j = g;
    else if (f.pairs.has(j)) j = f.pairs.get(j)!;
  }
  return out;
}

/** The attributes in the sections `[...]` from `i` on, and the index after them. */
function attributesAt(f: CsFile, i: number, end: number): { attributes: Attribute[]; next: number } {
  const attributes: Attribute[] = [];
  while (i < end && is(f.tokens[i], "[") && f.pairs.has(i)) {
    const close = f.pairs.get(i)!;
    let j = i + 1;
    // A target (`return:`, `assembly:`) applies the section elsewhere.
    const targeted = isId(f.tokens[j]) && is(f.tokens[j + 1], ":");
    if (targeted) j += 2;
    while (j < close) {
      const at = j;
      let last = "";
      while (j < close && !is(f.tokens[j], ",") && !is(f.tokens[j], "(")) {
        if (isId(f.tokens[j])) last = f.tokens[j]!.text;
        const g = genericClose(f, j, close);
        j = g !== undefined ? g + 1 : j + 1;
      }
      const args = is(f.tokens[j], "(") ? argumentsOf(f, j) : [];
      if (is(f.tokens[j], "(")) j = f.pairs.get(j)! + 1;
      const name = f.aliases.get(last) ?? last;
      if (!targeted && name) attributes.push({ name: name.endsWith("Attribute") && name !== "Attribute" ? name.slice(0, -"Attribute".length) : name, args, at });
      if (is(f.tokens[j], ",")) j++;
    }
    i = close + 1;
  }
  return { attributes, next: i };
}

/** The dotted name from `i` (`A.B.C`, `global::A.B`) and the index after it. */
function qualified(f: CsFile, i: number): { name: string; next: number } {
  let name = "";
  while (isId(f.tokens[i]) || is(f.tokens[i], ".") || is(f.tokens[i], "::")) name += f.tokens[i++]!.text;
  return { name, next: i };
}

/** Whether a type declaration starts at `i`: attributes and modifiers before `class`, `struct`, `interface`, `enum` or `record`. */
function typeKeywordAt(f: CsFile, i: number, end: number): { keyword: number; attributes: Attribute[]; modifiers: Set<string> } | undefined {
  const { attributes, next } = attributesAt(f, i, end);
  let j = next;
  const modifiers = new Set<string>();
  while (j < end && isId(f.tokens[j]) && MODIFIERS.has(f.tokens[j]!.text)) modifiers.add(f.tokens[j++]!.text);
  const t = f.tokens[j];
  if (!t || !isId(t)) return undefined;
  if (TYPE_KEYWORDS.has(t.text)) return { keyword: j, attributes, modifiers };
  if (t.text === "record" && (isId(f.tokens[j + 1]) || is(f.tokens[j + 1], "class") || is(f.tokens[j + 1], "struct"))) return { keyword: j, attributes, modifiers };
  return undefined;
}

/** Reads the declarations between `from` and `to`, in `namespace`, inside type `outer` where there is one. */
function scope(f: CsFile, from: number, to: number, namespace: string, outer: TypeDecl | undefined, top: boolean): void {
  let i = from;
  let ns = namespace;
  // Only the file itself may hold top-level statements, before its first namespace or type.
  let statements = top && from === 0 && !outer;
  while (i < to) {
    const t = f.tokens[i]!;
    if (top && isId(t) && t.text === "global" && is(f.tokens[i + 1], "using")) {
      i++;
      continue;
    }
    if (top && isId(t) && t.text === "using" && !is(f.tokens[i + 1], "(") && !(isId(f.tokens[i + 1]) && f.tokens[i + 1]!.text === "var")) {
      let end = i + 1;
      while (end < to && !is(f.tokens[end], ";")) end = skip(f, end);
      // `using Alias = A.B.C;` names `C`; `using Type name = value;` (two names before `=`) declares a variable instead.
      if (isId(f.tokens[i + 1]) && is(f.tokens[i + 2], "=")) {
        const target = f.tokens.slice(i + 3, end).filter((x) => x.kind === "id");
        const last = target[target.length - 1]?.text;
        if (last) f.aliases.set(f.tokens[i + 1]!.text, last);
        i = end + 1;
        continue;
      }
      // A using directive names only a namespace or type; a using declaration (`using Type name = value;`) is a statement.
      const named = f.tokens.slice(i + 1, end);
      if (named.every((x) => x.kind === "id" || [".", "::", "<", ">", ","].includes(x.text))) {
        i = end + 1;
        continue;
      }
    }
    if (isId(t) && t.text === "namespace" && !outer) {
      const { name, next } = qualified(f, i + 1);
      statements = false;
      if (is(f.tokens[next], ";")) {
        ns = name;
        i = next + 1;
        continue;
      }
      if (is(f.tokens[next], "{") && f.pairs.has(next)) {
        const close = f.pairs.get(next)!;
        scope(f, next + 1, close, ns ? `${ns}.${name}` : name, undefined, true);
        i = close + 1;
        continue;
      }
    }
    const decl = typeKeywordAt(f, i, to);
    if (decl) {
      statements = false;
      i = typeDecl(f, decl.keyword, to, ns, outer, decl.attributes, decl.modifiers);
      continue;
    }
    if (statements) {
      // Top-level statements come before any type or namespace declaration of the file; they run to the first one.
      const start = i;
      let j = i;
      let boundary = true;
      while (j < to) {
        if (boundary && (typeKeywordAt(f, j, to) || (is(f.tokens[j], "namespace") && isId(f.tokens[j + 1])))) break;
        const tok = f.tokens[j]!;
        boundary = is(tok, ";") || (is(tok, "{") && f.pairs.has(j));
        j = skip(f, j);
      }
      if (j > start) f.topLevel = [start, j];
      statements = false;
      i = j;
      continue;
    }
    i = skip(f, i);
  }
}

/** Reads the type declared at the keyword `k`, and returns the index after it. */
function typeDecl(f: CsFile, k: number, to: number, namespace: string, outer: TypeDecl | undefined, attributes: Attribute[], modifiers: Set<string>): number {
  let keyword = f.tokens[k]!.text;
  let j = k + 1;
  if (keyword === "record" && (is(f.tokens[j], "class") || is(f.tokens[j], "struct"))) keyword = f.tokens[j++]!.text === "struct" ? "record struct" : "record";
  const nameTok = f.tokens[j];
  if (!nameTok || !isId(nameTok)) return k + 1;
  const type: TypeDecl = {
    name: nameTok.text,
    namespace,
    file: f,
    keyword,
    modifiers,
    attributes,
    bases: [],
    generic: false,
    nested: !!outer,
    methods: [],
    consts: new Map(),
    at: j,
  };
  j++;
  const g = genericClose(f, j, to);
  if (g !== undefined) {
    type.generic = true;
    j = g + 1;
  }
  if (is(f.tokens[j], "(")) j = skip(f, j);
  if (is(f.tokens[j], ":")) {
    j++;
    let last = "";
    while (j < to && !is(f.tokens[j], "{") && !is(f.tokens[j], ";") && !(isId(f.tokens[j]) && f.tokens[j]!.text === "where")) {
      const t = f.tokens[j]!;
      if (is(t, ",")) {
        if (last) type.bases.push(f.aliases.get(last) ?? last);
        last = "";
        j++;
        continue;
      }
      if (isId(t)) last = t.text;
      const close = genericClose(f, j, to);
      j = close !== undefined ? close + 1 : skip(f, j);
    }
    if (last) type.bases.push(f.aliases.get(last) ?? last);
  }
  while (j < to && !is(f.tokens[j], "{") && !is(f.tokens[j], ";")) j = skip(f, j);
  f.types.push(type);
  if (!is(f.tokens[j], "{") || !f.pairs.has(j)) return j + 1;
  const close = f.pairs.get(j)!;
  if (keyword === "class" || keyword === "struct" || keyword === "record" || keyword === "record struct") members(f, j + 1, close, type);
  return close + 1;
}

/** Reads the members of `type` between `from` and `to`. */
function members(f: CsFile, from: number, to: number, type: TypeDecl): void {
  let j = from;
  while (j < to) {
    const nested = typeKeywordAt(f, j, to);
    if (nested) {
      j = typeDecl(f, nested.keyword, to, type.namespace, type, nested.attributes, nested.modifiers);
      continue;
    }
    const { attributes, next } = attributesAt(f, j, to);
    j = next;
    const modifiers = new Set<string>();
    while (j < to && isId(f.tokens[j]) && MODIFIERS.has(f.tokens[j]!.text)) modifiers.add(f.tokens[j++]!.text);
    const start = j;
    let done = false;
    while (j < to && !done) {
      const t = f.tokens[j]!;
      if (is(t, "(")) {
        // A tuple type before the name, `(int a, int b) Method()`, is passed over.
        if (j === start || !(isId(f.tokens[j - 1]) || is(f.tokens[j - 1], ">"))) {
          j = skip(f, j);
          continue;
        }
        let nameAt = j - 1;
        let generic = false;
        if (is(f.tokens[nameAt], ">")) {
          let depth = 0;
          for (let b = nameAt; b >= start; b--) {
            if (is(f.tokens[b], ">")) depth++;
            else if (is(f.tokens[b], "<") && --depth === 0) {
              nameAt = b - 1;
              break;
            }
          }
          generic = true;
        }
        const name = f.tokens[nameAt]!.text;
        const operator = f.tokens.slice(start, nameAt + 1).some((x) => x.kind === "id" && x.text === "operator");
        const ctor = nameAt === start;
        const params = parameters(f, j);
        let k = skip(f, j);
        // A constructor's `: base(...)` and a method's `where` constraints come before its body.
        while (k < to && !is(f.tokens[k], "{") && !is(f.tokens[k], "=>") && !is(f.tokens[k], ";")) k = skip(f, k);
        let body: [number, number] | undefined;
        let expression = false;
        if (is(f.tokens[k], "{") && f.pairs.has(k)) {
          body = [k + 1, f.pairs.get(k)!];
          k = f.pairs.get(k)! + 1;
        } else if (is(f.tokens[k], "=>")) {
          let e = k + 1;
          while (e < to && !is(f.tokens[e], ";")) e = skip(f, e);
          body = [k + 1, e];
          expression = true;
          k = e + 1;
        } else k++;
        if (!operator && !ctor && isId(f.tokens[nameAt])) {
          type.methods.push({ name, owner: type, modifiers, attributes, params, generic, explicit: is(f.tokens[nameAt - 1], "."), body, expression, at: nameAt });
        }
        j = k;
        done = true;
      } else if (is(t, "{")) {
        // A property or event with accessors, maybe with an initializer after them.
        j = skip(f, j);
        if (is(f.tokens[j], "=")) {
          while (j < to && !is(f.tokens[j], ";")) j = skip(f, j);
          j++;
        }
        done = true;
      } else if (is(t, "=>") || is(t, "=") || is(t, ";")) {
        let end = j;
        while (end < to && !is(f.tokens[end], ";")) end = skip(f, end);
        if (modifiers.has("const") && is(t, "=")) constants(f, start, end, type);
        j = end + 1;
        done = true;
      } else {
        const g = genericClose(f, j, to);
        j = g !== undefined ? g + 1 : skip(f, j);
      }
    }
  }
}

/** The constants `type NAME = value, OTHER = value` declares between `start` and `end`. */
function constants(f: CsFile, start: number, end: number, type: TypeDecl): void {
  let j = start;
  while (j < end) {
    if (isId(f.tokens[j]) && is(f.tokens[j + 1], "=")) {
      let e = j + 2;
      while (e < end && !is(f.tokens[e], ",")) e = skip(f, e);
      type.consts.set(f.tokens[j]!.text, [j + 2, e]);
      j = e + 1;
      continue;
    }
    j = skip(f, j);
  }
}

/** The parameters of the list opening at `open`. */
function parameters(f: CsFile, open: number): Parameter[] {
  return argumentsOf(f, open).flatMap((a) => {
    let i = a.name !== undefined ? a.start - 2 : a.start;
    i = attributesAt(f, i, a.end).next;
    let self = false;
    while (i < a.end && isId(f.tokens[i]) && ["this", "params", "ref", "out", "in", "scoped", "readonly"].includes(f.tokens[i]!.text)) self ||= f.tokens[i++]!.text === "this";
    let e = i;
    while (e < a.end && !is(f.tokens[e], "=")) e = skip(f, e);
    const nameTok = f.tokens[e - 1];
    if (!nameTok || !isId(nameTok) || e - 1 <= i) return [];
    const typeText = f.tokens
      .slice(i, e - 1)
      .map((x) => x.text)
      .join("");
    return [{ name: nameTok.text, type: typeText, self, optional: e < a.end }];
  });
}
