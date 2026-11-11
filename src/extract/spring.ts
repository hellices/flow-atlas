import type { RouteSource } from "../config.js";
import type { Surface } from "../model.js";
import { surfaceId } from "../model.js";
import { HOLE, joinRoute, resolveReference, routeTemplate } from "../paths.js";
import { lineOf } from "../source.js";
import type { Spans } from "./spans.js";
import { literalEnd, withoutComments } from "./calls.js";
import { registeredMappingRoutes, routerFunctionRoutes, type FunctionalRoute } from "./functional.js";

const SHORTCUTS: Record<string, string> = { GetMapping: "GET", PostMapping: "POST", PutMapping: "PUT", DeleteMapping: "DELETE", PatchMapping: "PATCH" };
const MAPPING = /@(?:[\w.]*\.)?(RequestMapping|GetMapping|PostMapping|PutMapping|DeleteMapping|PatchMapping)\b/g;
// A type's name, plain or a Kotlin backtick identifier (`Foo Controller`).
const TYPE = /\b(?:class|interface|object|record)\s+(?:[A-Za-z_]\w*|`[^`\n]+`)/g;
const REQUEST_METHODS = /\b(GET|HEAD|POST|PUT|PATCH|DELETE|OPTIONS|TRACE)\b/g;

/**
 * The views a handler renders, by route, with the file of the handler so its application's templates can be found; and
 * the paths its replies redirect to, with the line of each.
 */
export type Views = Map<string, { file: string; names: string[]; redirects: Array<{ path: string; line: number }> }>;

/**
 * Java or Kotlin code with the contents of every string and character literal blanked (quotes, newlines and offsets
 * kept), so annotations, braces and keywords are searched in code only. Values are read back from the unmasked text.
 */
function maskStrings(file: string, code: string): string {
  const out = code.split("");
  let i = 0;
  while (i < code.length) {
    const quote = code.startsWith('"""', i) ? '"""' : code[i] === '"' || code[i] === "'" ? code[i]! : undefined;
    if (!quote) {
      i++;
      continue;
    }
    const end = literalEnd(code, i, quote, file);
    const close = code.startsWith(quote, end - quote.length) ? end - quote.length : end;
    for (let k = i + quote.length; k < close; k++) if (out[k] !== "\n") out[k] = " ";
    i = end;
  }
  return out.join("");
}

/** Where the `(`, `{` or `[` at `open` closes, in masked code. */
function closing(masked: string, open: number): number | undefined {
  let depth = 0;
  for (let i = open; i < masked.length; i++) {
    const c = masked[i]!;
    if (c === "(" || c === "{" || c === "[") depth++;
    else if ((c === ")" || c === "}" || c === "]") && --depth === 0) return i;
  }
  return undefined;
}

/** Where the declaration holding `at` begins: after the last `;`, `{` or `}` outside parentheses before it. */
function declarationStart(masked: string, at: number): number {
  let depth = 0;
  for (let i = at - 1; i >= 0; i--) {
    const c = masked[i]!;
    if (c === ")") depth++;
    else if (c === "(") depth--;
    else if (depth === 0 && (c === ";" || c === "{" || c === "}")) return i + 1;
  }
  return 0;
}

/** The modifiers Java and Kotlin allow before a type declaration (`fun` as in `fun interface`). */
const MODIFIERS = new Set([
  "public",
  "protected",
  "private",
  "internal",
  "open",
  "abstract",
  "final",
  "static",
  "sealed",
  "non-sealed",
  "data",
  "inner",
  "enum",
  "annotation",
  "value",
  "strictfp",
  "expect",
  "actual",
  "external",
  "companion",
  "fun",
]);

/**
 * Whether only annotations and modifiers stand between `from` and `to`, so an annotation ending at `from` belongs to
 * the declaration at `to`. Kotlin members need no `;`, so a mapping on the member before a nested type is otherwise
 * hard to tell from one on the type.
 */
function onlyAnnotations(masked: string, from: number, to: number): boolean {
  let i = from;
  while (i < to) {
    if (/\s/.test(masked[i]!)) {
      i++;
      continue;
    }
    const annotation = /^@[\w.]+/.exec(masked.slice(i, to));
    if (annotation) {
      i += annotation[0].length;
      let j = i;
      while (/\s/.test(masked[j] ?? "")) j++;
      if (masked[j] === "(") {
        const close = closing(masked, j);
        if (close === undefined) return false;
        i = close + 1;
      }
      continue;
    }
    const word = /^[A-Za-z]+(?:-[A-Za-z]+)?/.exec(masked.slice(i, to));
    if (!word || !MODIFIERS.has(word[0])) return false;
    i += word[0].length;
  }
  return true;
}

/**
 * Where the run of annotations that holds the one at `at` begins: annotations written one after another, with only
 * spaces between, belong to one declaration. Members in Kotlin need no `;`, so the previous member's text is not a
 * boundary to search back to.
 */
function annotationsStart(masked: string, at: number): number {
  const spans: Array<{ start: number; end: number }> = [];
  for (const a of masked.matchAll(/@[\w.]+/g)) {
    const start = a.index ?? 0;
    let end = start + a[0].length;
    let j = end;
    while (/\s/.test(masked[j] ?? "")) j++;
    if (masked[j] === "(") end = (closing(masked, j) ?? j) + 1;
    spans.push({ start, end });
  }
  let begin = at;
  for (;;) {
    const previous = spans.filter((sp) => sp.end <= begin && !masked.slice(sp.end, begin).trim()).pop();
    if (!previous) return begin;
    begin = previous.start;
  }
}

/**
 * String literals of a value: `"a"`, `{"a", "b"}`, `["a"]`, `arrayOf("a")`, or a one-line Kotlin raw string
 * `"""a"""`, whose run of closing quotes ends at its last three; undefined when anything else is in it. A literal over
 * several lines (a Java text block) is not read, since its indentation is stripped, and neither is a Kotlin string
 * template (`"$BASE/users"`, `"${x}"`), whose value is computed.
 */
function literals(value: string, kotlin: boolean): string[] | undefined {
  const out: string[] = [];
  let unknown = false;
  const rest = value.replace(/"""([\s\S]*?"*)"""(?!")|"((?:[^"\\\n]|\\.)*)"/g, (_, raw: string | undefined, s: string | undefined) => {
    // In a Kotlin raw string every `$name` is a template; in a plain one `\$` is an escaped, literal dollar.
    const template = raw !== undefined ? /\$[A-Za-z_{`]/ : /(?<!\\)(?:\\\\)*\$[A-Za-z_{`]/;
    if (raw?.includes("\n") || (kotlin && template.test(raw ?? s!))) unknown = true;
    out.push(raw ?? s!.replace(/\\([$\\"])/g, "$1"));
    return "";
  });
  if (unknown) return undefined;
  return /^[\s{}[\],]*$/.test(rest.replace(/\barrayOf\s*\(/, "").replace(/\)\s*$/, "")) ? out : undefined;
}

/** Top-level `name = value` pairs and positional values of annotation arguments. */
function attributes(args: string): { positional?: string; named: Map<string, string> } {
  const parts: string[] = [];
  let depth = 0;
  let start = 0;
  let quoted = false;
  for (let i = 0; i < args.length; i++) {
    const c = args[i]!;
    if (c === '"' && args[i - 1] !== "\\") quoted = !quoted;
    if (quoted) continue;
    if ("({[".includes(c)) depth++;
    else if (")}]".includes(c)) depth--;
    else if (c === "," && depth === 0) {
      parts.push(args.slice(start, i));
      start = i + 1;
    }
  }
  parts.push(args.slice(start));
  const named = new Map<string, string>();
  let positional: string | undefined;
  for (const part of parts.map((p) => p.trim()).filter(Boolean)) {
    const m = /^([A-Za-z_]\w*)\s*=\s*([\s\S]+)$/.exec(part);
    if (m && !m[2]!.startsWith("=")) named.set(m[1]!, m[2]!);
    else if (positional === undefined) positional = part;
  }
  return { positional, named };
}

/** `text` split at each top-level `sep`: one inside a string or brackets belongs to its part. */
function splitTop(text: string, sep: string): string[] {
  const parts: string[] = [];
  let depth = 0;
  let start = 0;
  for (let i = 0; i < text.length; i++) {
    const c = text[i]!;
    if (c === '"') {
      const quote = text.startsWith('"""', i) ? '"""' : '"';
      for (i += quote.length; i < text.length && !text.startsWith(quote, i); i++) if (quote === '"' && text[i] === "\\") i++;
      i += quote.length - 1;
    } else if ("([{".includes(c)) depth++;
    else if (")]}".includes(c)) depth--;
    else if (c === sep && depth === 0) {
      parts.push(text.slice(start, i));
      start = i + 1;
    }
  }
  parts.push(text.slice(start));
  return parts.map((p) => p.trim());
}

/** The value of a constant expression used at `at`, or undefined when it is not one this file spells out. */
type Constant = (expression: string, at: number) => string | undefined;

/** A type the file declares: its name, its body, and whether it names a supertype a constant could come from. */
interface DeclaredType {
  name: string;
  start: number;
  end: number;
  inherits: boolean;
  /** A Kotlin companion object, whose members its class sees as its own. */
  companion: boolean;
}

function declaredTypes(masked: string): DeclaredType[] {
  const out: DeclaredType[] = [];
  for (const t of masked.matchAll(TYPE)) {
    const at = t.index ?? 0;
    let i = at + t[0].length;
    let depth = 0;
    let inherits = false;
    for (; i < masked.length; i++) {
      const c = masked[i]!;
      if (c === "(" || c === "<") depth++;
      else if (c === ")" || c === ">") depth--;
      else if (depth === 0 && (c === "{" || c === ";")) break;
      else if (depth === 0 && (c === ":" || /^(?:extends|implements)\b/.test(masked.slice(i, i + 10)))) inherits = true;
    }
    const end = masked[i] === "{" ? closing(masked, i) : undefined;
    if (end === undefined) continue;
    const companion = /\bcompanion\s+$/.test(masked.slice(Math.max(0, at - 20), at));
    out.push({ name: t[0].split(/\s+/).pop()!, start: i, end, inherits, companion });
  }
  return out;
}

/**
 * The string constants a file declares: Java `static final String A = ..., B = ...;` and Kotlin `const val A = ...`,
 * whose values are literals and other such constants joined with `+`. An annotation argument must be a compile-time
 * constant, so a mapping that names one has its value, found as the languages find a name: in the types around the use,
 * innermost first, then (Kotlin) the file's top level; `Type.NAME` in a type the file declares once. A name is not read
 * where it could mean something this file does not show: past a type that names a supertype (an inherited constant),
 * or one imported by name (`import static a.Paths.PATH`). A type's own annotation sits outside its body, so a name used
 * there is not one of its members.
 */
function stringConstants(code: string, masked: string, kotlin: boolean, evaluated?: (at: number) => void): Constant {
  const types = declaredTypes(masked);
  // The type whose members a position is among: the innermost body around it, a companion counting as its class.
  const chain = (at: number): DeclaredType[] => types.filter((t) => t.start < at && at < t.end).sort((a, b) => b.start - a.start);
  const ownerOf = (at: number): DeclaredType | undefined => chain(at).find((t) => !t.companion);
  const declared: Array<{ name: string; owner: DeclaredType | undefined; at: number; expression: string }> = [];
  const add = (name: string, at: number, expression: string) => declared.push({ name, owner: ownerOf(at), at, expression: expression.trim() });
  if (kotlin) {
    for (const m of masked.matchAll(/\bconst\s+val\s+([A-Za-z_]\w*)\s*(?::\s*String\s*)?=/g)) {
      const from = (m.index ?? 0) + m[0].length;
      const semicolon = masked.indexOf(";", from);
      const end = Math.min(expressionEnd(masked, from), semicolon < 0 ? masked.length : semicolon);
      add(m[1]!, m.index ?? 0, code.slice(from, end));
    }
  } else {
    for (const m of masked.matchAll(/\b(?:static\s+final|final\s+static)\s+String\s+(?=[A-Za-z_]\w*\s*=)/g)) {
      const from = (m.index ?? 0) + m[0].length;
      const end = masked.indexOf(";", from);
      if (end < 0) continue;
      // One declaration may hold several: `A = "/a", B = A + "/b"`.
      let offset = from;
      for (const part of splitTop(masked.slice(from, end), ",")) {
        const start = masked.indexOf(part, offset);
        offset = start + part.length;
        const declarator = /^([A-Za-z_]\w*)\s*=/.exec(part);
        if (declarator) add(declarator[1]!, start, code.slice(start + declarator[0].length, start + part.length));
      }
    }
  }
  const imported = new Set(
    [...masked.matchAll(kotlin ? /^\s*import\s+[\w.]+\.(\w+)(?:\s+as\s+(\w+))?/gm : /^\s*import\s+static\s+[\w.]+\.(\w+)\s*;/gm)].map((m) => m[2] ?? m[1]!),
  );
  const only = (found: typeof declared) => (new Set(found.map((d) => d.expression)).size === 1 ? found[0] : undefined);
  const lookup = (name: string, at: number): (typeof declared)[number] | undefined => {
    for (const type of chain(at)) {
      if (type.companion) continue;
      const own = declared.filter((d) => d.name === name && d.owner === type);
      if (own.length) return only(own);
      if (type.inherits) return undefined;
    }
    if (imported.has(name)) return undefined;
    return kotlin ? only(declared.filter((d) => d.name === name && d.owner === undefined)) : undefined;
  };
  // Types a single-type import names (`import a.b.Paths;`): a same-named type of this file nested elsewhere is not it.
  const importedTypes = new Set(
    [...masked.matchAll(kotlin ? /^\s*import\s+[\w.]+\.([A-Z]\w*)(?:\s+as\s+(\w+))?/gm : /^\s*import\s+(?!static\b)[\w.]+\.([A-Z]\w*)\s*;/gm)].map((m) => m[2] ?? m[1]!),
  );
  // The type a simple name means where it is used: one of the file's top-level types, or a member type of a type around
  // the use. A type nested elsewhere is out of scope, and an imported one is not this file's.
  const parentOf = (t: DeclaredType): DeclaredType | undefined => types.filter((p) => p !== t && p.start < t.start && t.end <= p.end).sort((a, b) => b.start - a.start)[0];
  const qualified = (type: string, name: string, at: number): (typeof declared)[number] | undefined => {
    if (importedTypes.has(type)) return undefined;
    const around = chain(at);
    const named = types.filter((t) => t.name === type && !t.companion && (parentOf(t) === undefined || around.includes(parentOf(t)!)));
    if (named.length !== 1) return undefined;
    const own = declared.filter((d) => d.name === name && d.owner === named[0]);
    return own.length ? only(own) : undefined;
  };
  // A declaration's value depends only on the declaration, so each is evaluated once. One that fails through a cycle is
  // itself on or behind that cycle, so its failure holds wherever the evaluation started.
  const values = new Map<number, string | undefined>();
  const evaluate = (expression: string, at: number, seen: Set<number>): string | undefined => {
    let out = "";
    for (const term of splitTop(expression, "+")) {
      const value = /^"/.test(term) ? literals(term, kotlin) : undefined;
      if (value?.length === 1) {
        out += value[0];
        continue;
      }
      const name = /^(?:([A-Za-z_]\w*)\.)?([A-Za-z_]\w*)$/.exec(term);
      const found = name ? (name[1] ? qualified(name[1], name[2]!, at) : lookup(name[2]!, at)) : undefined;
      if (!found || seen.has(found.at)) return undefined;
      if (!values.has(found.at)) {
        evaluated?.(found.at);
        values.set(found.at, evaluate(found.expression, found.at, new Set([...seen, found.at])));
      }
      const resolved = values.get(found.at);
      if (resolved === undefined) return undefined;
      out += resolved;
    }
    return out;
  };
  return (expression, at) => evaluate(expression, at, new Set());
}

/** The string constants a Java or Kotlin file declares, as a mapping at an offset sees them; `evaluated` hears each declaration evaluated. */
export function fileConstants(file: string, text: string, evaluated?: (at: number) => void): Constant {
  const code = withoutComments(file, text);
  return stringConstants(code, maskStrings(file, code), /\.kts?$/.test(file), evaluated);
}

/**
 * The paths a mapping names: none written means the root; literals, or constants the file declares, alone or in a
 * list; undefined when they are built in code.
 */
function mappingPaths(args: string | undefined, kotlin: boolean, constant: Constant, at: number): string[] | undefined {
  if (args === undefined || !args.trim()) return [""];
  const { positional, named } = attributes(args);
  const value = named.get("path") ?? named.get("value") ?? positional;
  if (value === undefined) return [""];
  const paths = literals(value, kotlin);
  if (paths) return paths.length ? paths : [""];
  // `{A, B}` in Java, `[A, B]` or `arrayOf(A, B)` in Kotlin.
  const list = /^(?:\{([\s\S]*)\}|\[([\s\S]*)\]|arrayOf\s*\(([\s\S]*)\))$/.exec(value.trim());
  const items = list ? splitTop(list[1] ?? list[2] ?? list[3] ?? "", ",").filter(Boolean) : [value];
  const resolved = items.map((item) => constant(item, at));
  return resolved.every((p) => p !== undefined) ? (resolved.length ? resolved : [""]) : undefined;
}

/**
 * The methods a `@RequestMapping` names: none when it states no `method`, the `RequestMethod` values it lists, or
 * undefined when its `method` is an expression this reading cannot resolve.
 */
function requestMethods(args: string | undefined): string[] | undefined {
  const value = args ? attributes(args).named.get("method") : undefined;
  if (!value) return [];
  const methods = [...value.matchAll(REQUEST_METHODS)].map((m) => m[1]!);
  return methods.length ? [...new Set(methods)] : undefined;
}

/**
 * A Spring path pattern as an OpenAPI-style template: `{id}` and `{id:\\d+}` are both `{id}`. A catch-all keeps its
 * form (`{*rest}`, `**`), which matching takes as the rest of the path.
 */
const springTemplate = (path: string): string =>
  routeTemplate(path.replace(/\{(\*?[A-Za-z_]\w*)(?::[^{}]*(?:\{[^{}]*\}[^{}]*)*)?\}/g, "{$1}"));

/**
 * The regexps of the variables that share a segment of a template with text or other variables: Spring's
 * `RegexPathElement` gives each `(.*)`, any text of the segment, none included. A variable's own regexp is written for
 * Java's engine and is not kept, so it too takes any text here.
 */
const springPatterns = (template: string): Record<string, string> | undefined => {
  const out = new Map<string, string>();
  for (const seg of template.split("/")) {
    if (/^\{[^{}]*\}$/.test(seg)) continue;
    for (const m of seg.matchAll(/\{([^{}*]+)\}/g)) out.set(m[1]!, ".*");
  }
  return out.size ? Object.fromEntries(out) : undefined;
};

/**
 * Where the parameter list of the method a mapping annotates opens: past the annotations that follow the mapping
 * (`@ResponseBody`, `@ResponseStatus(HttpStatus.OK)`), whatever their order.
 */
function parametersAt(masked: string, from: number): number | undefined {
  let i = from;
  for (;;) {
    while (/\s/.test(masked[i] ?? "")) i++;
    const annotation = /^@[\w.]+/.exec(masked.slice(i));
    if (!annotation) break;
    i += annotation[0].length;
    let j = i;
    while (/\s/.test(masked[j] ?? "")) j++;
    if (masked[j] === "(") {
      const close = closing(masked, j);
      if (close === undefined) return undefined;
      i = close + 1;
    }
  }
  const open = masked.indexOf("(", i);
  return open < 0 ? undefined : open;
}

/**
 * Where a Kotlin expression body that starts at `from` ends: at a line break outside brackets, unless the next line
 * goes on with the expression (`.call()`, `?:`, an operator, `else`).
 */
function expressionEnd(masked: string, from: number): number {
  let depth = 0;
  let i = from;
  while (/\s/.test(masked[i] ?? "")) i++;
  for (; i < masked.length; i++) {
    const c = masked[i]!;
    if ("([{".includes(c)) depth++;
    else if (")]}".includes(c)) {
      if (depth === 0) return i;
      depth--;
    } else if (c === "\n" && depth === 0) {
      const line = masked.slice(masked.lastIndexOf("\n", i - 1) + 1, i).trim();
      const next = /^\s*(\S{1,4})/.exec(masked.slice(i + 1))?.[1] ?? "";
      // The expression goes on when this line leaves it open (`if (x)`, `=`, `->`, `else`, an operator) or the next
      // line continues it (`.call()`, `?:`, an operator, `else`).
      const open = !line || /(?:\b(?:if|while)\s*\(.*\)|[=,+\-*/(]|->|&&|\|\||\?:|\belse)$/.test(line);
      if (!open && !/^(\?\.|\?:|\.|\+|-|\*|\/|&&|\|\||else\b)/.test(next)) return i;
    }
  }
  return masked.length;
}

/**
 * The body of the method a mapping annotates, after its parameter list: `{ ... }`, or a Kotlin `= expression`; as
 * written and with its strings masked, and where it starts in the file.
 */
function methodBody(code: string, masked: string, open: number): { body: string; masked: string; start: number } | undefined {
  const close = closing(masked, open);
  if (close === undefined) return undefined;
  const brace = masked.slice(close + 1).search(/[{;=]/);
  if (brace < 0) return undefined;
  const start = close + 1 + brace;
  let end: number | undefined;
  if (masked[start] === "=") end = expressionEnd(masked, start + 1);
  else if (masked[start] === "{") end = (closing(masked, start) ?? -2) + 1;
  if (end === undefined || end < 0) return undefined;
  return { body: code.slice(start, end), masked: masked.slice(start, end), start };
}

/** Where a statement's expression that starts at `from` ends: at a `;` or a closing bracket outside brackets. */
function statementEnd(masked: string, from: number, kotlin: boolean): number {
  let depth = 0;
  const end = kotlin ? expressionEnd(masked, from) : masked.length;
  for (let i = from; i < end; i++) {
    const c = masked[i]!;
    if ("([{".includes(c)) depth++;
    else if (")]}".includes(c) && depth-- === 0) return i;
    else if (c === ";" && depth === 0) return i;
  }
  return end;
}

/**
 * Whether the `return` at `at` of a block body (`masked` starts with its `{`) returns from the handler: no brace around
 * it opens the body of a type declared or created in it, or of a function declared in it, or (in Java) of a lambda. A
 * Kotlin lambda's `return` returns from the enclosing function; a Java switch rule's block (`case A -> {`) is the
 * handler's.
 */
function handlerReturn(masked: string, at: number, kotlin: boolean): boolean {
  const open: number[] = [];
  for (let i = 0; i < at; i++) {
    if (masked[i] === "{") open.push(i);
    else if (masked[i] === "}") open.pop();
  }
  return open.slice(1).every((b) => {
    const before = masked.slice(0, b).trimEnd();
    // A type: `class X`, `object : Y`, `new X() {`, `record R(...)`.
    if (/(?<![\w$.])(?:class|interface|enum)\s+[\w$][^{};=]*$/.test(before)) return false;
    if (kotlin && /(?<![\w$.])object\b[^{};=]*$/.test(before)) return false;
    if (before.endsWith(")")) {
      const paren = openingParen(before, before.length - 1);
      const head = before.slice(0, paren).trimEnd();
      if (/\bnew\s+[\w$.]+(?:\s*<[^;{}()]*>)?$|\brecord\s+[\w$]+(?:\s*<[^;{}()]*>)?$/.test(head)) return false;
    }
    if (kotlin) return !/\bfun\b[^{};=]*$/.test(before);
    // A Java lambda's block; a switch rule's starts with its label.
    return !before.endsWith("->") || /(?:^|[;{}])\s*(?:case\b[^;{}]*|default\s*)->$/.test(before);
  });
}

/** Where the `(` that the `)` at `close` closes opens, in masked code. */
function openingParen(masked: string, close: number): number {
  let depth = 0;
  for (let i = close; i >= 0; i--) {
    if (masked[i] === ")") depth++;
    else if (masked[i] === "(" && --depth === 0) return i;
  }
  return 0;
}

/**
 * Where a Kotlin expression from `from` (up to `limit`) ends, as a branch: at a `;`, a closing bracket or an `else`
 * outside brackets, or at the end of a line that neither leaves it open (an operator) nor is continued by the next.
 */
function branchEnd(masked: string, from: number, limit: number): number {
  let depth = 0;
  for (let i = from; i < limit; i++) {
    const c = masked[i]!;
    if ("([{".includes(c)) depth++;
    else if (")]}".includes(c)) {
      if (depth === 0) return i;
      depth--;
    } else if (depth > 0) continue;
    else if (c === ";" || (/^else\b/.test(masked.slice(i, i + 5)) && !/[\w$]/.test(masked[i - 1] ?? ""))) return i;
    else if (c === "\n") {
      const line = masked.slice(masked.lastIndexOf("\n", i - 1) + 1, i).trim();
      const next = /^\s*(\S{1,2})/.exec(masked.slice(i + 1, limit))?.[1] ?? "";
      if (line && !/(?:[=,+\-*/(]|->|&&|\|\||\?:)$/.test(line) && !/^(\?\.|\?:|\.|&&|\|\|)/.test(next)) return i;
    }
  }
  return limit;
}

/**
 * The results of a Kotlin expression from `from` (up to `limit`), as ranges of `masked`, and where it ends: the whole
 * expression, or for an `if` or `when`, the results of each branch. A branch that is a block is not read.
 */
function kotlinResults(masked: string, from: number, limit: number): { ranges: Array<readonly [number, number]>; end: number } {
  let i = from;
  while (i < limit && /\s/.test(masked[i]!)) i++;
  const skip = (at: number) => at + (/^\s*/.exec(masked.slice(at, limit))?.[0].length ?? 0);
  const keyword = /^(if|when)\b/.exec(masked.slice(i, limit))?.[1];
  if (masked[i] === "{") return { ranges: [], end: (closing(masked, i) ?? limit - 1) + 1 };
  if (keyword === "if") {
    const open = skip(i + 2);
    const close = masked[open] === "(" ? closing(masked, open) : undefined;
    if (close === undefined || close >= limit) return { ranges: [], end: limit };
    const then = kotlinResults(masked, close + 1, limit);
    const other = skip(then.end);
    if (!/^else\b/.test(masked.slice(other, limit))) return then;
    const otherwise = kotlinResults(masked, other + 4, limit);
    return { ranges: [...then.ranges, ...otherwise.ranges], end: otherwise.end };
  }
  if (keyword === "when") {
    let open = skip(i + 4);
    if (masked[open] === "(") open = skip((closing(masked, open) ?? limit) + 1);
    const close = masked[open] === "{" ? closing(masked, open) : undefined;
    if (close === undefined || close >= limit) return { ranges: [], end: limit };
    const ranges: Array<readonly [number, number]> = [];
    let depth = 0;
    for (let k = open + 1; k < close; k++) {
      const c = masked[k]!;
      if ("([{".includes(c)) depth++;
      else if (")]}".includes(c)) depth--;
      else if (depth === 0 && masked.startsWith("->", k)) {
        const arm = kotlinResults(masked, k + 2, close);
        ranges.push(...arm.ranges);
        k = arm.end - 1;
      }
    }
    return { ranges, end: close + 1 };
  }
  const end = branchEnd(masked, i, limit);
  return { ranges: i < end ? [[i, end]] : [], end };
}

/** What a handler's reply leads to: the views it renders and the URLs it redirects to, by where each is written. */
interface Replies {
  views: string[];
  redirects: Array<{ url: string; at: number }>;
  /** Redirects to a URL that starts with a value the file does not spell out. */
  unread: Array<{ at: number; expression: string }>;
}

interface ReplyContext {
  code: string;
  masked: string;
  kotlin: boolean;
  constant: Constant;
  /** The body of the private method of the handler's type that a call by this name, at this offset, runs. */
  helper: (name: string, at: number) => { body: string; masked: string; start: number } | undefined;
}

/**
 * The text an expression yields: string literals, and the string constants the file declares, joined with `+`; any
 * other term is a value, written as `{}`. `known` says no term was one.
 */
function textOf(expression: string, at: number, context: ReplyContext): { text: string; known: boolean } {
  let text = "";
  let known = true;
  for (const term of splitTop(expression.trim(), "+")) {
    const literal = term.startsWith('"') ? literals(term, context.kotlin) : undefined;
    const value = literal?.length === 1 ? literal[0] : context.constant(term, at);
    if (value !== undefined) text += value;
    // A Kotlin string template is text with values in it.
    else if (context.kotlin && /^"(?:[^"\\\n]|\\.)*"$/.test(term)) {
      text += term.slice(1, -1).replace(/\$\{[^}]*\}|\$[A-Za-z_]\w*/g, "{}");
      known = false;
    } else {
      text += "{}";
      known = false;
    }
  }
  return { text, known };
}

/**
 * What a handler body replies with. `ModelAndView(x)` and `setViewName(x)` always; when the handler writes no response
 * body, also what it returns (or a Kotlin expression body's value and branches), and what a private method of its type
 * returns when the handler returns that method's result. A name is a view when it is text the file spells out: a
 * literal or a `static final String` (Kotlin `const val`). A name starting with `redirect:` is a redirect, the rest of
 * it the URL (Spring MVC, "Redirecting"), a value in it written as `{}`; `forward:` is neither.
 */
function replies(
  body: { body: string; masked: string; start: number },
  strings: boolean,
  context: ReplyContext,
  seen: Set<number> = new Set(),
): Replies {
  const out: Replies = { views: [], redirects: [], unread: [] };
  const take = (written: string, from: number) => {
    const expression = written.trim();
    const at = from + written.length - written.trimStart().length;
    const call = /^(?:this\s*\.\s*)?([A-Za-z_]\w*)\s*\(/.exec(expression);
    if (call && closing(context.masked, at + call[0].length - 1) === at + expression.length - 1) {
      const helper = context.helper(call[1]!, at);
      if (!helper || seen.has(helper.start)) return;
      const inner = replies(helper, true, context, new Set([...seen, helper.start]));
      out.views.push(...inner.views);
      out.redirects.push(...inner.redirects);
      out.unread.push(...inner.unread);
      return;
    }
    const { text, known } = textOf(expression, at, context);
    if (text.startsWith("redirect:")) {
      const url = text.slice("redirect:".length);
      if (url.startsWith("{}")) out.unread.push({ at, expression });
      else out.redirects.push({ url, at });
    } else if (known && /^[\w./-]+$/.test(text)) out.views.push(text);
  };
  const { body: code, masked, start } = body;
  // A match that starts inside a string literal (masked there) is text, not a call or a result.
  for (const m of code.matchAll(/\b(?:ModelAndView|setViewName)\s*\(/g)) {
    const open = (m.index ?? 0) + m[0].length - 1;
    if (masked[m.index ?? 0] !== code[m.index ?? 0]) continue;
    const close = closing(masked, open);
    if (close === undefined) continue;
    const argument = splitTop(code.slice(open + 1, close), ",")[0] ?? "";
    if (argument) take(argument, start + open + 1);
  }
  if (!strings) return out;
  const results = (from: number, end: number) => {
    // In Kotlin, a branch's value is a result too: `= if (x) "a" else "b"`, `when { c -> "a" }`.
    const ranges = context.kotlin ? kotlinResults(masked, from, end).ranges : [[from, end] as const];
    for (const [a, b] of ranges) if (code.slice(a, b).trim()) take(code.slice(a, b), start + a);
  };
  if (code.trimStart().startsWith("{")) {
    for (const m of masked.matchAll(/\breturn\b/g)) {
      if (!handlerReturn(masked, m.index ?? 0, context.kotlin)) continue;
      const from = (m.index ?? 0) + m[0].length;
      results(from, statementEnd(masked, from, context.kotlin));
    }
  } else results(1, code.length);
  return { views: [...new Set(out.views)], redirects: out.redirects, unread: out.unread };
}

/**
 * The path a redirect URL leads to from a route: a path from the root as written (RedirectView puts the context path
 * before it), a relative one resolved against the route's path, as a browser resolves the Location it is sent; its URI
 * variables are the current request's (Spring MVC, "Redirect Attributes"), values here. Undefined for an absolute URL,
 * another site's.
 */
function redirectPath(url: string, route: string): string | undefined {
  if (/^[A-Za-z][A-Za-z0-9+.-]*:/.test(url) || url.startsWith("//")) return undefined;
  const resolved = url.startsWith("/") ? url : resolveReference(route, url);
  return resolved.split(/[?#]/)[0]!.replace(/\{[^{}]*\}/g, HOLE);
}

interface TypeScope {
  /** Where the body's `{` and `}` are. */
  start: number;
  end: number;
  /** The class-level mapping's paths and methods; paths undefined when they are built in code. */
  paths: string[] | undefined;
  methods: string[] | undefined;
  /** `@RestController` or `@ResponseBody` on the type: handlers write their return value as the response. */
  responseBody: boolean;
  /** The type's own `@RequestMapping`, where a limit names it when its paths or methods are not read. */
  mapping?: { at: number; args: string | undefined };
  /** What a `PathMatchConfigurer` predicate tests the type by. */
  handler: HandlerType;
  /** Where its declaration starts, its annotations included. */
  header: number;
  /** The exchange interface its type-level mapping comes from, where it has none of its own. */
  from?: [string, ExchangeInterface];
}

/**
 * Spring MVC routes in Java or Kotlin: `@GetMapping`, `@PostMapping`, `@PutMapping`, `@DeleteMapping`,
 * `@PatchMapping` and `@RequestMapping` on methods, combined with the `@RequestMapping` on the type that holds them
 * (paths joined, methods united as Spring does), and the login and logout endpoints Spring Security configures. A path
 * may be a string constant the file declares; one the file does not spell out (a constant of another file, an
 * expression) is unknown: no route is registered for it, and `limits` says so.
 * `views` collects, per route, the view names its handler renders.
 */
export function routesFromSpring(
  file: string,
  text: string,
  spec: RouteSource,
  views?: Views,
  spans?: Spans,
  limits?: string[],
  prefixes?: PathPrefixes,
  exchanges?: Exchanges,
): Surface[] {
  const code = withoutComments(file, text);
  const masked = maskStrings(file, code);
  const kotlin = /\.kts?$/.test(file);
  const pkg = /^\s*package\s+([\w.]+)/m.exec(masked)?.[1] ?? "";
  const imports = importsOf(masked, kotlin);
  const constant = stringConstants(code, masked, kotlin);
  const unread = (at: number, args: string | undefined, what: string) =>
    limits?.push(`routes ${spec.component}: ${file}:${lineOf(text, at)} maps ${what} the file does not spell out (${(args ?? "").trim()}); its routes are not read`);
  const mappings = [...masked.matchAll(MAPPING)].map((m) => {
    const at = m.index ?? 0;
    let open = at + m[0].length;
    while (/\s/.test(masked[open] ?? "")) open++;
    const close = masked[open] === "(" ? closing(masked, open) : undefined;
    return { at, kind: m[1]!, args: close === undefined ? undefined : code.slice(open + 1, close), end: close === undefined ? at + m[0].length : close + 1 };
  });

  const types: TypeScope[] = [];
  const typeLevel = new Set<number>();
  for (const t of masked.matchAll(TYPE)) {
    const at = t.index ?? 0;
    const header = declarationStart(masked, at);
    // The body is the first `{` after the name outside parentheses (a constructor's parameters come first in Kotlin).
    let i = at + t[0].length;
    let depth = 0;
    for (; i < masked.length; i++) {
      const c = masked[i]!;
      if (c === "(") depth++;
      else if (c === ")") depth--;
      else if (depth === 0 && (c === "{" || c === ";")) break;
    }
    const end = masked[i] === "{" ? closing(masked, i) : undefined;
    if (end === undefined) continue;
    const own = mappings.find((m) => m.kind === "RequestMapping" && m.at >= header && m.at < at && onlyAnnotations(masked, m.end, at));
    if (own) typeLevel.add(own.at);
    const annotations = code.slice(header, at);
    const head = masked.slice(at + t[0].length, i);
    types.push({
      handler: {
        name: t[0].split(/\s+/).pop()!,
        kind: t[0].split(/\s+/)[0]!,
        annotations: new Set([...masked.slice(header, at).matchAll(/@(?:[\w.]*\.)?(\w+)/g)].map((a) => a[1]!)),
        written: [...masked.slice(header, at).matchAll(/@([\w.]+)/g)].map((a) => a[1]!),
        imports,
        package: pkg,
        // A supertype past the parameters of a Kotlin primary constructor, or after `extends` or `implements`.
        inherits: /\b(?:extends|implements)\b/.test(head) || /:/.test(head.replace(/\([^()]*\)/g, "")),
      },
      header,
      start: i,
      end,
      paths: own ? mappingPaths(own.args, kotlin, constant, own.at) : [""],
      methods: own ? requestMethods(own.args) : [],
      responseBody: /@(?:[\w.]*\.)?(?:RestController|ResponseBody)\b/.test(annotations),
      ...(own ? { mapping: { at: own.at, args: own.args } } : {}),
    });
  }

  // The exchange interfaces each controller implements. Spring takes one type-level mapping for the whole class, the first
  // its type hierarchy holds (`createRequestMappingInfo`, `firstRunOf`): the class's own `@RequestMapping`, else the
  // `@HttpExchange` of the first interface it lists that carries one, for its own methods as for the interfaces'.
  const implemented = new Map<TypeScope, Array<[string, ExchangeInterface]>>();
  for (const t of types) {
    if (t.handler.kind === "interface" || !(t.handler.annotations.has("Controller") || t.handler.annotations.has("RestController"))) continue;
    const found = supertypes(masked.slice(t.header, t.start), kotlin)
      .map((name) => exchangeOf(exchanges, name, imports, file))
      .filter((f): f is [string, ExchangeInterface] => !!f);
    if (!found.length) continue;
    implemented.set(t, found);
    const typed = found.find(([, iface]) => iface.typed);
    if (!t.mapping && typed) {
      t.paths = typed[1].paths;
      t.methods = typed[1].methods;
      t.from = typed;
    }
  }

  // The type a position is in: the innermost body around it.
  const typeAt = (at: number): TypeScope | undefined => types.filter((t) => t.start < at && at < t.end).sort((a, b) => b.start - a.start)[0];
  // The private method of the type a call at `at` is in, when the type declares one method of that name: a private
  // method is not overridden, and with no overload the call runs that one.
  const helper = (name: string, at: number) => {
    const owner = typeAt(at);
    if (!owner) return undefined;
    const declarations = [...masked.matchAll(new RegExp(kotlin ? `\\bfun\\s+${name}\\s*\\(` : `\\b${name}\\s*\\(`, "g"))].filter((m) => {
      const i = m.index ?? 0;
      if (typeAt(i) !== owner) return false;
      if (kotlin) return true;
      const close = closing(masked, i + m[0].length - 1);
      return close !== undefined && /^\s*(?:throws\b[^{;]*)?\{/.test(masked.slice(close + 1)) && !/\bnew\s*$/.test(masked.slice(0, i));
    });
    if (declarations.length !== 1) return undefined;
    const at0 = declarations[0]!.index ?? 0;
    if (!/\bprivate\b/.test(masked.slice(declarationStart(masked, at0), at0))) return undefined;
    return methodBody(code, masked, at0 + declarations[0]![0].length - 1);
  };

  const out: Surface[] = [];
  const unreadTypes = new Set<TypeScope>();
  // A mapping annotation's arguments are its paths, not requests, type-level ones included.
  for (const m of mappings) spans?.add(file, m.at, m.end);
  for (const m of mappings) {
    if (typeLevel.has(m.at)) continue;
    // The innermost type whose body holds the handler; a nested type closed before it does not count.
    const owner = types.filter((t) => t.start < m.at && m.at < t.end).sort((a, b) => b.start - a.start)[0];
    // The prefix a `PathMatchConfigurer` gives the handler type: none decided, its routes are not read.
    const prefix = owner && prefixes ? prefixes.of(owner.handler) : "";
    if (prefix === undefined) continue;
    const bases = owner ? owner.paths : [""];
    const paths = mappingPaths(m.args, kotlin, constant, m.at);
    const own = m.kind === "RequestMapping" ? requestMethods(m.args) : [SHORTCUTS[m.kind]!];
    const inherited = owner ? owner.methods : [];
    // A type mapping not read is named once, where it is written; a handler's own mapping, where it is.
    if ((!bases || !inherited) && owner?.mapping && !unreadTypes.has(owner)) {
      unreadTypes.add(owner);
      unread(owner.mapping.at, owner.mapping.args, bases ? "a method" : "a path");
    }
    if (!paths) unread(m.at, m.args, "a path");
    else if (!own) unread(m.at, m.args, "a method");
    if (!bases || !paths || !own || !inherited) continue;
    const united = [...new Set([...inherited, ...own])];
    const methods = united.length ? united : ["*"];
    const open = parametersAt(masked, m.end);
    // Every annotation on the method, before or after the mapping.
    const signature = code.slice(annotationsStart(masked, m.at), open ?? m.end);
    const responseBody = (owner?.responseBody ?? false) || /@(?:[\w.]*\.)?ResponseBody\b/.test(signature);
    const body = views && open !== undefined ? methodBody(code, masked, open) : undefined;
    const reply = body ? replies(body, !responseBody, { code, masked, kotlin, constant, helper }) : undefined;
    const rendered = reply?.views ?? [];
    for (const u of reply?.unread ?? []) {
      limits?.push(`routes ${spec.component}: ${file}:${lineOf(text, u.at)} redirects to a URL the file does not spell out (${u.expression}); the request it leads to is not read`);
    }
    for (const base of bases) {
      for (const path of paths) {
        const full = springTemplate(joinRoute(spec.prefix ?? "", prefix, base, path));
        const redirects = (reply?.redirects ?? []).flatMap((r) => {
          const target = redirectPath(r.url, full);
          return target ? [{ path: target, line: lineOf(text, r.at) }] : [];
        });
        for (const method of methods) {
          const id = surfaceId({ component: spec.component, method, path: full });
          if (rendered.length || redirects.length) {
            const known = views!.get(id);
            views!.set(id, { file, names: [...new Set([...(known?.names ?? []), ...rendered])], redirects: [...(known?.redirects ?? []), ...redirects] });
          }
          const line = lineOf(text, m.at);
          // Paths that differ only in a trailing `/` are one route here, so a mapping that lists both registers it once.
          if (out.some((o) => o.id === id && o.at.line === line)) continue;
          const patterns = springPatterns(full);
          out.push({ id, component: spec.component, method, path: full, at: { file, line }, evidence: "text", ...(patterns ? { patterns } : {}) });
        }
      }
    }
  }
  // The `@HttpExchange` mappings of the interfaces a controller implements, where it maps the method no other way.
  for (const [t, found] of implemented) {
    const prefix = prefixes ? prefixes.of(t.handler) : "";
    if (prefix === undefined) continue;
    const own = mappings
      .filter((m) => m.at > t.start && m.at < t.end && typeAt(m.at) === t)
      .map((m) => methodAfter(masked, m.end, kotlin))
      .filter((m): m is { name: string; params: string[] } => !!m);
    const bases = t.paths;
    const inherited = t.methods;
    if ((!bases || !inherited) && t.from) {
      const [qualified, iface] = t.from;
      limits?.push(`routes ${spec.component}: ${iface.file}:${iface.line} maps ${bases ? "a method" : "a path"} the file does not spell out on ${qualified}, which ${t.handler.name} implements; its routes are not read`);
    }
    if (!bases || !inherited) continue;
    for (const [qualified, iface] of found) {
      const where = `${iface.file}:${iface.line}`;
      if (iface.inherits) limits?.push(`routes ${spec.component}: ${where} ${qualified} extends interfaces whose exchanges are not read; the routes ${t.handler.name} serves from them are not read`);
      for (const member of iface.members) {
        if (own.some((m) => overrides(m, member))) continue;
        if (!member.paths || !member.methods) {
          limits?.push(`routes ${spec.component}: ${iface.file}:${member.line} maps ${member.paths ? "a method" : "a path"} the file does not spell out (${member.args.trim()}); the route ${t.handler.name} serves for it is not read`);
          continue;
        }
        const united = [...new Set([...inherited, ...member.methods])];
        for (const base of bases) {
          for (const path of member.paths) {
            const full = springTemplate(joinRoute(spec.prefix ?? "", prefix, base, path));
            const patterns = springPatterns(full);
            for (const method of united.length ? united : ["*"]) {
              out.push({ id: surfaceId({ component: spec.component, method, path: full }), component: spec.component, method, path: full, at: { file: iface.file, line: member.line }, evidence: "text", ...(patterns ? { patterns } : {}) });
            }
          }
        }
      }
    }
  }
  out.push(...securityRoutes(file, text, code, masked, spec));
  const functional = (r: FunctionalRoute): Surface => {
    const full = springTemplate(joinRoute(spec.prefix ?? "", r.path));
    const patterns = springPatterns(full);
    return { id: surfaceId({ component: spec.component, method: r.method, path: full }), component: spec.component, method: r.method, path: full, at: { file, line: r.line }, evidence: "text", ...(patterns ? { patterns } : {}), ...(r.implicit ? { implicit: true } : {}) };
  };
  out.push(...routerFunctionRoutes(file, text, spec, constant, spans, limits).map(functional));
  out.push(...registeredMappingRoutes(file, text, constant, spec.component, spans, limits).map(functional));
  return out;
}

/** The names of the interfaces a type's header lists after its name: Java's `implements A, B<T>`, Kotlin's `: A, B()`. */
function supertypes(head: string, kotlin: boolean): string[] {
  const flat = head.replace(/<[^<>]*(?:<[^<>]*>[^<>]*)*>/g, "");
  const list = kotlin ? /:\s*([\s\S]*)$/.exec(flat.replace(/\([^()]*\)/g, ""))?.[1] : /\bimplements\s+([\s\S]*)$/.exec(flat)?.[1];
  return (list ?? "")
    .split(",")
    .map((x) => /^\s*([\w.]+)/.exec(x.replace(/\bby\b[\s\S]*$/, ""))?.[1])
    .filter((x): x is string => !!x);
}

/** Kotlin's types that are Java's primitives where they are not nullable. */
const KOTLIN_PRIMITIVES: Record<string, string> = { Int: "int", Long: "long", Short: "short", Byte: "byte", Boolean: "boolean", Char: "char", Float: "float", Double: "double" };

/**
 * The method declared after an annotation that ends at `end`, past any other annotation: its name, and the erased
 * types of its parameters (`Map<String, Object> m` is `Map`, `vararg x: String` and `String... x` are `String[]`, a
 * Kotlin `Long` is `long`), by which a method overrides another of its name.
 */
function methodAfter(masked: string, end: number, kotlin: boolean): { name: string; params: string[] } | undefined {
  let i = end;
  for (;;) {
    while (/\s/.test(masked[i] ?? "")) i++;
    if (masked[i] !== "@") break;
    i++;
    while (/[\w.]/.test(masked[i] ?? "")) i++;
    while (/\s/.test(masked[i] ?? "")) i++;
    if (masked[i] === "(") i = (closing(masked, i) ?? i) + 1;
  }
  const open = masked.indexOf("(", i);
  if (open < 0 || /[;{}=]/.test(masked.slice(i, open))) return undefined;
  const name = /(\w+)\s*$/.exec(masked.slice(i, open))?.[1];
  const close = closing(masked, open);
  if (!name || close === undefined) return undefined;
  const params = splitTop(masked.slice(open + 1, close).replace(/<[^<>]*(?:<[^<>]*(?:<[^<>]*>[^<>]*)*>[^<>]*)*>/g, ""), ",")
    .filter(Boolean)
    .map((p) => {
      let text = p.replace(/@[\w.]+(?:\s*\([^()]*(?:\([^()]*\)[^()]*)*\))?/g, " ").replace(/\bfinal\b/g, " ").trim();
      let array = "";
      if (kotlin) {
        if (/^vararg\b/.test(text)) array = "[]";
        text = (/:\s*([\s\S]*?)\s*(?:=[\s\S]*)?$/.exec(text.replace(/^vararg\s+/, ""))?.[1] ?? text).trim();
        const nullable = text.endsWith("?");
        text = text.replace(/\?$/, "");
        const simple = text.slice(text.lastIndexOf(".") + 1);
        return (nullable ? simple : (KOTLIN_PRIMITIVES[simple] ?? simple)) + array;
      }
      if (text.includes("...")) array = "[]";
      const type = text.replace(/\.\.\./, " ").replace(/\s+\w+$/, "").replace(/\s+/g, "");
      return type.slice(type.lastIndexOf(".", type.indexOf("[") < 0 ? type.length : type.indexOf("[")) + 1) + array;
    });
  return { name, params };
}

/** Whether a method of a class overrides one of an interface: the same name and parameter types. */
const overrides = (a: { name: string; params: string[] }, b: { name: string; params: string[] }): boolean => a.name === b.name && a.params.join(",") === b.params.join(",");

const EXCHANGE = /@(?:[\w.]*\.)?(HttpExchange|GetExchange|PostExchange|PutExchange|PatchExchange|DeleteExchange)\b/g;

/** An interface with `@HttpExchange` mappings: a client's, or the routes of a controller that implements it. */
export interface ExchangeInterface {
  file: string;
  line: number;
  /** The interface's own `@HttpExchange` paths and methods ([""] and [] with none); undefined where not read. */
  paths: string[] | undefined;
  methods: string[] | undefined;
  /** Whether it extends other interfaces, whose methods it holds too. */
  inherits: boolean;
  /** Whether it carries an `@HttpExchange` of its own. */
  typed: boolean;
  members: Array<{ name: string; params: string[]; line: number; args: string; paths: string[] | undefined; methods: string[] | undefined }>;
}
/** The interfaces with `@HttpExchange` mappings the files declare, by qualified name; null for one declared twice. */
export type Exchanges = Map<string, ExchangeInterface | null>;

/**
 * The `@HttpExchange`, `@GetExchange`, `@PostExchange`, `@PutExchange`, `@PatchExchange` and `@DeleteExchange` mappings
 * of the interfaces the files declare. Spring MVC and WebFlux serve a controller at those of an interface it implements
 * (`RequestMappingHandlerMapping` reads them through the type hierarchy), as it does `@RequestMapping`: the type's
 * `url` (or `value`) joined with the method's, and the type's `method` with the method's.
 */
export function httpExchanges(texts: Map<string, string>): Exchanges {
  const out: Exchanges = new Map();
  for (const [file, text] of texts) {
    if (!/@(?:[\w.]*\.)?(?:Http|Get|Post|Put|Patch|Delete)Exchange\b/.test(text)) continue;
    const code = withoutComments(file, text);
    const masked = maskStrings(file, code);
    const kotlin = /\.kts?$/.test(file);
    const constant = stringConstants(code, masked, kotlin);
    const pkg = /^\s*package\s+([\w.]+)/m.exec(masked)?.[1] ?? "";
    const found = [...masked.matchAll(EXCHANGE)].map((m) => {
      const at = m.index ?? 0;
      let open = at + m[0].length;
      while (/\s/.test(masked[open] ?? "")) open++;
      const close = masked[open] === "(" ? closing(masked, open) : undefined;
      const args = close === undefined ? undefined : code.slice(open + 1, close);
      const value = args === undefined || !args.trim() ? undefined : (() => {
        const { positional, named } = attributes(args);
        return named.get("url") ?? named.get("value") ?? positional;
      })();
      const listed = value === undefined ? [] : literals(value, kotlin);
      const resolved = value === undefined ? undefined : constant(value, at);
      const paths = value === undefined ? [""] : listed?.length === 1 ? listed : listed === undefined && resolved !== undefined ? [resolved] : undefined;
      const method = args === undefined ? undefined : attributes(args).named.get("method");
      const verb = m[1] === "HttpExchange" ? (method === undefined ? [] : (literals(method, kotlin)?.map((v) => v.toUpperCase()) ?? undefined)) : [m[1]!.replace("Exchange", "").toUpperCase()];
      return { at, end: close === undefined ? at + m[0].length : close + 1, args: args ?? "", paths: paths?.some((p) => /:\/\//.test(p)) ? undefined : paths, methods: verb };
    });
    // Each type's body, for the types an interface is nested in: `p.Outer.Contract`.
    const bodies = [...masked.matchAll(TYPE)].flatMap((t) => {
      const open = masked.indexOf("{", (t.index ?? 0) + t[0].length);
      const close = open < 0 ? undefined : closing(masked, open);
      return close === undefined ? [] : [{ name: t[0].split(/\s+/).pop()!, start: open, end: close }];
    });
    for (const t of masked.matchAll(TYPE)) {
      if (!t[0].startsWith("interface")) continue;
      const at = t.index ?? 0;
      const header = declarationStart(masked, at);
      let i = at + t[0].length;
      while (i < masked.length && masked[i] !== "{" && masked[i] !== ";") i++;
      const end = masked[i] === "{" ? closing(masked, i) : undefined;
      if (end === undefined) continue;
      const own = found.find((f) => f.at >= header && f.at < at && onlyAnnotations(masked, f.end, at));
      // Members of a type nested in the interface are that type's.
      const nested = [...masked.slice(i + 1, end).matchAll(TYPE)].map((n) => i + 1 + (n.index ?? 0));
      const members = found
        .filter((f) => f.at > i && f.at < end && !nested.some((n) => {
          const body = masked.indexOf("{", n);
          const close = body < 0 ? undefined : closing(masked, body);
          return close !== undefined && f.at > body && f.at < close;
        }))
        .flatMap((f) => {
          const method = methodAfter(masked, f.end, kotlin);
          return method ? [{ ...method, line: lineOf(text, f.at), args: f.args, paths: f.paths, methods: f.methods }] : [];
        });
      if (!own && !members.length) continue;
      const outer = bodies.filter((b) => b.start < at && at < b.end).sort((a, b) => a.start - b.start).map((b) => b.name);
      const name = [...outer, t[0].split(/\s+/).pop()!].join(".");
      const key = pkg ? `${pkg}.${name}` : name;
      const head = masked.slice(at + t[0].length, i);
      out.set(key, out.has(key) ? null : { file, line: lineOf(text, own?.at ?? at), paths: own ? own.paths : [""], methods: own ? own.methods : [], inherits: kotlin ? /:/.test(head) : /\bextends\b/.test(head), typed: !!own, members });
    }
  }
  return out;
}

/** The exchange interface a name in a type's header means: imported by name, of the file's package, or of a package imported whole. */
function exchangeOf(exchanges: Exchanges | undefined, written: string, imports: Imports, file: string): [string, ExchangeInterface] | undefined {
  if (!exchanges?.size) return undefined;
  // A name imported by name, else a type of the file's own package, else one of a package imported whole (JLS 6.4.1);
  // `Outer.Contract` by its first name. A type nested in another of the same file is named by its simple name there.
  const dot = written.indexOf(".");
  const head = dot < 0 ? written : written.slice(0, dot);
  const tail = dot < 0 ? "" : written.slice(dot);
  const own = imports.package ? `${imports.package}.${written}` : written;
  const local = [...exchanges].filter(([k, v]) => v?.file === file && dot < 0 && k.endsWith(`.${written}`) && k !== own).map(([k]) => k);
  const candidates = imports.single.has(head)
    ? [`${imports.single.get(head)!}${tail}`]
    : exchanges.get(own)
      ? [own]
      : local.length
        ? local
        : dot > 0 && exchanges.get(written)
          ? [written]
          : imports.wildcard.map((p) => `${p}.${written}`);
  const hits = candidates.filter((c) => exchanges.get(c));
  return hits.length === 1 ? [hits[0]!, exchanges.get(hits[0]!)!] : undefined;
}

/** Where the parenthesis that `close` closes opens, in masked code. */
function opening(masked: string, close: number): number | undefined {
  let depth = 0;
  for (let i = close; i >= 0; i--) {
    if (masked[i] === ")") depth++;
    else if (masked[i] === "(" && --depth === 0) return i;
  }
  return undefined;
}

/**
 * The identifier a call chain through the `.` at `dot` starts from: `f` for `f.permitAll().loginPage(`; empty when the
 * chain starts at the beginning of the text (it continues a call made before it); undefined when it starts elsewhere.
 */
function chainRoot(masked: string, dot: number): string | undefined {
  let i = dot - 1;
  for (;;) {
    while (i >= 0 && /\s/.test(masked[i]!)) i--;
    if (i < 0) return "";
    if (masked[i] === ")") {
      const open = opening(masked, i);
      if (open === undefined) return undefined;
      i = open - 1;
      while (i >= 0 && /\s/.test(masked[i]!)) i--;
    }
    const end = i + 1;
    while (i >= 0 && /[\w$]/.test(masked[i]!)) i--;
    const name = masked.slice(i + 1, end);
    let j = i;
    while (j >= 0 && /\s/.test(masked[j]!)) j--;
    if (masked[j] === ".") {
      i = j - 1;
      continue;
    }
    return name || undefined;
  }
}

/**
 * The names the file declares, each with its type (empty when the declaration states none: `val x = ...`, `var x`) and
 * the text it is in scope for: a parameter's function body (a block, or a Kotlin expression body), a local's enclosing
 * block from its declaration on. A parameter of a function without a body, or of a lambda, binds nothing read here.
 */
function bindings(masked: string, kotlin: boolean): Array<{ name: string; type: string; start: number; end: number }> {
  const out: Array<{ name: string; type: string; start: number; end: number }> = [];
  // `Type name` in Java, `name: Type` in Kotlin, and an untyped `val`/`var` in either.
  // A type may be written with its package (`org.springframework...HttpSecurity`).
  const type = "(?:[a-z_]\\w*\\.)*[A-Z][\\w.]*";
  const typed = kotlin ? new RegExp(`\\b([a-z_]\\w*)\\s*:\\s*(${type})`, "g") : new RegExp(`(?<![\\w.])(${type})(?:<[^<>()]*>)?(?:\\[\\])?\\s+([a-z_$][\\w$]*)\\s*(?=[,)=;:])`, "g");
  const found = [
    ...[...masked.matchAll(typed)].map((m) => ({ at: m.index ?? 0, name: kotlin ? m[1]! : m[2]!, type: kotlin ? m[2]! : m[1]! })),
    ...[...masked.matchAll(/\b(?:val|var)\s+([a-z_]\w*)\s*=/g)].map((m) => ({ at: m.index ?? 0, name: m[1]!, type: "" })),
  ];
  for (const { at, name, type } of found) {
    const owner = enclosingOpen(masked, at);
    if (owner === undefined) continue;
    if (masked[owner] === "{") {
      const end = closing(masked, owner);
      // A field or property is seen throughout its type's body; a local, from its declaration on.
      const member = /\b(?:class|interface|object|enum|record)\b/.test(masked.slice(declarationStart(masked, owner), owner));
      if (end !== undefined) out.push({ name, type, start: member ? owner : at, end });
      continue;
    }
    const params = closing(masked, owner);
    if (params === undefined) continue;
    // After the parameters: a return type or `throws`, then the body. A function without one (abstract, in an
    // interface) ends where the next declaration starts, so the next function's body is not taken for its own.
    let i = params + 1;
    let depth = 0;
    for (; i < masked.length; i++) {
      const c = masked[i]!;
      if (c === "<") depth++;
      else if (c === ">" && masked[i - 1] !== "-") depth--;
      else if (depth === 0 && (c === "{" || c === "=" || c === ";" || c === "}" || (c === "-" && masked[i + 1] === ">"))) break;
      else if (depth === 0 && /[\s;]/.test(masked[i - 1] ?? " ") && /^(?:(?:fun|val|var|class|interface|object)\b|@[A-Za-z])/.test(masked.slice(i, i + 10))) break;
    }
    if (masked[i] === "{") {
      const end = closing(masked, i);
      if (end !== undefined) out.push({ name, type, start: i, end });
    } else if (masked[i] === "=" && masked[i + 1] !== "=") out.push({ name, type, start: i, end: expressionEnd(masked, i + 1) });
  }
  return out;
}

/** The `(` or `{` that encloses `at`, the nearest one not closed before it; undefined at the top level. */
function enclosingOpen(masked: string, at: number): number | undefined {
  let depth = 0;
  for (let i = at - 1; i >= 0; i--) {
    const c = masked[i]!;
    if (c === ")" || c === "}" || c === "]") depth++;
    else if (c === "(" || c === "{" || c === "[") {
      if (depth === 0) return c === "[" ? undefined : i;
      depth--;
    }
  }
  return undefined;
}

function setting(code: string, masked: string, call: string, receiver: string | undefined): string | null | undefined {
  // A builder keeps the last value a setter was given. Only a setter on the configurer counts: in a lambda, a chain
  // that starts at its parameter; in the chained form, the chain that continues the configurer call itself.
  const m = [...masked.matchAll(new RegExp(`\\.${call}\\s*\\(`, "g"))].filter((c) => chainRoot(masked, c.index ?? 0) === (receiver ?? "")).pop();
  if (!m) return undefined;
  const open = (m.index ?? 0) + m[0].length - 1;
  const close = closing(masked, open);
  const arg = close === undefined ? "" : code.slice(open + 1, close).trim();
  return /^"([^"\\]*)"$/.exec(arg)?.[1] ?? null;
}

/**
 * Endpoints Spring Security serves without a controller: `formLogin` takes the login form's POST at its processing URL
 * (`loginProcessingUrl`, else `loginPage`, else `/login`) and `logout` a POST at `logoutUrl`, else `/logout`. The
 * lambda form (`formLogin(f -> f.loginPage("/x"))`), the chained form (`formLogin().loginPage("/x").and()`) and
 * `withDefaults()` are read. A disabled configurer serves nothing, and a URL the file does not spell out, or a
 * customizer defined elsewhere, registers nothing.
 */
function securityRoutes(file: string, text: string, code: string, masked: string, spec: RouteSource): Surface[] {
  const out: Surface[] = [];
  // Only a file that configures HttpSecurity; `request.logout()` on a servlet request is not a configurer.
  if (!/\bHttpSecurity\b|\bSecurityFilterChain\b|\bWebSecurityConfigurerAdapter\b/.test(masked)) return out;
  const add = (path: string, index: number) => {
    const full = springTemplate(joinRoute(spec.prefix ?? "", path));
    out.push({ id: surfaceId({ component: spec.component, method: "POST", path: full }), component: spec.component, method: "POST", path: full, at: { file, line: lineOf(text, index) }, evidence: "text" });
  };
  const declared = bindings(masked, /\.kts?$/.test(file));
  for (const m of masked.matchAll(/\.(formLogin|logout)\s*\(/g)) {
    const at = m.index ?? 0;
    // Only a call on that configurer, directly or down its chain, where its name is in scope; `request.logout()` on a
    // servlet request, even one named like an HttpSecurity elsewhere in the file, is a servlet call.
    const root = chainRoot(masked, at);
    // The innermost declaration of the name decides: a nested `http: HttpServletRequest` hides an outer HttpSecurity.
    const binding = declared.filter((b) => b.name === root && at >= b.start && at < b.end).sort((a, b) => b.start - a.start)[0];
    if (!binding || !/(?:^|\.)HttpSecurity$/.test(binding.type)) continue;
    const open = at + m[0].length - 1;
    const close = closing(masked, open);
    if (close === undefined) continue;
    let from = open + 1;
    let to = close;
    const argument = masked.slice(open + 1, close).trim();
    let receiver: string | undefined;
    if (argument && !/^(?:Customizer\s*\.\s*)?withDefaults\s*\(\s*\)$/.test(argument)) {
      // A lambda is read where its parameter stays in it; a customizer held elsewhere (a variable, a method, a lambda
      // handing its parameter on) may set anything, so what it serves is unknown and nothing is registered.
      const lambda = /^(?:\(\s*)?(?:[\w<>?,.\s]+\s)?(\w+)\s*\)?\s*->/.exec(argument);
      const disabled = /^\w+\s*::\s*disable$/.test(argument);
      if (!disabled && (!lambda || new RegExp(`[(,]\\s*${lambda[1]}\\s*[,)]`).test(argument.slice(lambda[0].length)))) continue;
      receiver = lambda?.[1];
    }
    if (!argument) {
      // The chained form: the configuration runs from here to `.and()` or the end of the statement.
      const rest = masked.slice(close + 1);
      const stop = rest.search(/\.and\s*\(|;/);
      from = close + 1;
      to = close + 1 + (stop < 0 ? rest.length : stop);
    }
    const region = code.slice(from, to);
    const regionMasked = masked.slice(from, to);
    if (/::disable\b|\.disable\s*\(/.test(regionMasked)) continue;
    if (m[1] === "formLogin") {
      const processing = setting(region, regionMasked, "loginProcessingUrl", receiver);
      const page = setting(region, regionMasked, "loginPage", receiver);
      const url = processing !== undefined ? processing : page !== undefined ? page : "/login";
      if (url) add(url, at);
    } else {
      if (/\.logoutRequestMatcher\s*\(/.test(regionMasked)) continue;
      const url = setting(region, regionMasked, "logoutUrl", receiver);
      if (url !== null) add(url ?? "/logout", at);
    }
  }
  return out;
}

/** A `GroupedOpenApi` a file builds: the group it names, and the `@Bean` method it is built in, if any. */
export interface GroupedOpenApiBuild {
  /** The group the builder's last `group(...)` sets, when the file spells it out. */
  group?: string;
  /** What that `group(...)` passes; empty when the chain sets none. */
  expression: string;
  line: number;
  /** The type whose `@Bean` method builds it, and whether that type is a component Spring scans for beans. */
  bean?: { type: string; component: boolean };
}

/** Stereotypes that make a class a component, whose `@Bean` methods Spring registers (lite mode outside `@Configuration`). */
const COMPONENT = /@(?:[\w.]*\.)?(?:Configuration|SpringBootApplication|Component|Service|Repository|Controller|RestController|ControllerAdvice|RestControllerAdvice)\b/;

/**
 * Whether `name` is declared as a parameter or local of the member text `region` (Java `Type name`, Kotlin `name: Type`
 * or `val name`, or a lambda parameter: `name ->`, `(a, name) ->`, Kotlin's `{ a, name ->`): such a name hides a
 * constant of the same name, as Java and Kotlin scoping say. A declaration in a block already closed counts too, so a
 * name that may be hidden is never read as the constant.
 */
function declaredLocally(region: string, name: string, kotlin: boolean): boolean {
  const n = name.replace(/\$/g, "\\$");
  const token = new RegExp(`(?<![\\w$])${n}(?![\\w$])`);
  for (const arrow of region.matchAll(/->/g)) {
    const before = region.slice(0, arrow.index);
    const parameters = (kotlin ? /\{([^{}]*)$/ : /\(([^()]*)\)\s*$/).exec(before)?.[1] ?? /([A-Za-z_$][\w$]*)\s*$/.exec(before)?.[1] ?? "";
    if (token.test(parameters)) return true;
  }
  if (kotlin) return new RegExp(`(?<![\\w.$])${n}\\s*:(?!:)|\\b(?:val|var)\\s+${n}\\b`).test(region);
  // Java: the name after a type, read back token by token over `...`, `[]` and balanced (nested) generics.
  for (const m of region.matchAll(new RegExp(`(?<![\\w.$])${n}\\s*(?=[,)=;:[])`, "g"))) {
    let i = (m.index ?? 0) - 1;
    const skipSpace = () => {
      while (i >= 0 && /\s/.test(region[i]!)) i--;
    };
    skipSpace();
    if (region.slice(i - 2, i + 1) === "...") i -= 3;
    for (;;) {
      skipSpace();
      if (region[i] === "]") {
        i--;
        skipSpace();
        if (region[i] !== "[") break;
        i--;
      } else if (region[i] === ">") {
        let depth = 0;
        for (; i >= 0; i--) {
          if (region[i] === ">") depth++;
          else if (region[i] === "<" && --depth === 0) break;
        }
        i--;
      } else break;
    }
    const type = /([A-Za-z_$][\w$.]*)$/.exec(region.slice(0, i + 1))?.[1];
    if (type && !/^(?:return|throw|new|else|case|yield|assert|instanceof)$/.test(type)) return true;
  }
  return false;
}

/**
 * Every `GroupedOpenApi.builder()` chain of a Java or Kotlin file. The builder keeps the last value `group(...)` is given,
 * so the chain's last `group(...)` names the group: a literal, or a string constant of the file that no parameter or local
 * of the same name hides; otherwise `group` is undefined. A chain that sets no group (it is set elsewhere) has none
 * either. `bean` says which type's `@Bean` method the chain is in (a Java method body, a Kotlin expression body).
 */
export function groupedOpenApis(file: string, text: string): GroupedOpenApiBuild[] {
  const code = withoutComments(file, text);
  const masked = maskStrings(file, code);
  const kotlin = /\.kts?$/.test(file);
  const constant = stringConstants(code, masked, kotlin);
  const types = declaredTypes(masked);
  const out: GroupedOpenApiBuild[] = [];
  for (const m of masked.matchAll(/\bGroupedOpenApi\s*\.\s*builder\s*\(\s*\)/g)) {
    const at = m.index ?? 0;
    // The member the chain is in: the outermost bracket inside its type's body, or the chain itself for an expression body.
    const owner = types.filter((t) => t.start < at && at < t.end).sort((a, b) => b.start - a.start)[0];
    let member = at;
    for (let o = enclosingOpen(masked, at); o !== undefined && (!owner || o > owner.start); o = enclosingOpen(masked, o)) member = o;
    let header = masked.slice(declarationStart(masked, member), member);
    // Kotlin members need no `;`: only the annotations right before the last `fun` belong to this one.
    const fun = kotlin ? [...header.matchAll(/\bfun\b/g)].pop()?.index : undefined;
    if (fun !== undefined) header = /(?:@[\w.]+(?:\([^)]*\))?\s*|\b(?:private|public|internal|protected|open|override|final)\s+)*$/.exec(header.slice(0, fun))?.[0] ?? "";
    const bean =
      owner && /@(?:[\w.]*\.)?Bean\b/.test(header)
        ? { type: owner.name, component: COMPONENT.test(masked.slice(declarationStart(masked, owner.start), owner.start)) }
        : undefined;
    const region = masked.slice(declarationStart(masked, member), at);
    let found: GroupedOpenApiBuild = { expression: "", line: lineOf(text, at), ...(bean ? { bean } : {}) };
    let i = at + m[0].length;
    // Each `.name(...)` of the chain in turn, across lines; the chain ends at anything else.
    for (;;) {
      const call = /^\s*\.\s*([A-Za-z_]\w*)\s*\(/.exec(masked.slice(i));
      if (!call) break;
      const open = i + call[0].length - 1;
      const close = closing(masked, open);
      if (close === undefined) break;
      if (call[1] === "group") {
        const expression = code.slice(open + 1, close).trim();
        const hidden = splitTop(expression, "+").some((term) => /^[A-Za-z_$][\w$]*$/.test(term) && declaredLocally(region, term, kotlin));
        const group = hidden ? undefined : constant(expression, open);
        found = { ...(group !== undefined ? { group } : {}), expression, line: lineOf(text, open), ...(bean ? { bean } : {}) };
      }
      i = close + 1;
    }
    out.push(found);
  }
  return out;
}

/** What a `PathMatchConfigurer` predicate tests a handler type by: the annotations written on it and where it is. */
export interface HandlerType {
  name: string;
  /** `class`, `interface`, `object` or `record`. */
  kind: string;
  /** The simple names of the annotations written on it. */
  annotations: Set<string>;
  /** Those annotations as written (`Tag`, `io.swagger.v3.oas.annotations.tags.Tag`), with the imports that name them. */
  written: string[];
  imports: Imports;
  package: string;
  /** Whether it names a supertype, whose annotations it may take. */
  inherits: boolean;
}

/** The path prefixes `PathMatchConfigurer.addPathPrefix` gives handler types, read from every Spring file. */
export interface PathPrefixes {
  /** The prefix a handler type's routes are served under ("" for none), or undefined where it is not read. */
  of(type: HandlerType): string | undefined;
  /** Why handler types were left unread, one line per cause. */
  limits(component: string): string[];
}

const ANNOTATION_CLASS = /^(?:[\w.]*\.)?(\w+)(?:\.class|::class(?:\.java)?)$/;

/**
 * Reads `addPathPrefix(prefix, predicate)` calls, which serve the handler methods of every handler type the predicate
 * accepts under the prefix (docs.spring.io/spring-framework/reference/web/webmvc/mvc-config/path-matching.html). The
 * predicate is read where it is one of these, decided for certain from the type's declaration:
 *
 * - `HandlerTypePredicate.forAnnotation(A.class, ...)`: a type annotated with one of them, `@RestController` counting as
 *   `@Controller` (it is meta-annotated with it). `HandlerTypePredicate` finds an annotation on supertypes and through
 *   meta-annotations too (`AnnotationUtils.findAnnotation`), so a type without one is decided only where it names no
 *   supertype and is a `@Controller` or `@RestController` itself.
 * - `HandlerTypePredicate.forBasePackage("p", ...)`: a type whose qualified name starts with one of the packages and a
 *   `.` (`HandlerTypePredicate.Builder.basePackage`).
 * - a lambda `c -> c.isAnnotationPresent(A.class)` (Kotlin `{ it.isAnnotationPresent(A::class.java) }`): `A` written on
 *   the type itself, which Spring's stereotypes, not `@Inherited`, cannot get from a supertype.
 *
 * Spring takes the first prefix whose predicate accepts the type, in the order the calls are made; the order of calls in
 * different configurers is not read, so prefixes from two of them that disagree leave the type unread.
 */
export function pathPrefixes(texts: Map<string, string>): PathPrefixes {
  /** `group`: the configurer the call is made in, whose calls Spring takes in order. */
  type Entry = { where: string; group: string; prefix: string | undefined; prefixText: string; predicate: string; test: ((t: HandlerType) => boolean | undefined) | undefined };
  const entries: Entry[] = [];
  const meta = annotationTypes(texts);
  for (const [file, text] of texts) {
    if (!/\baddPathPrefix\s*\(/.test(text)) continue;
    const code = withoutComments(file, text);
    const masked = maskStrings(file, code);
    const kotlin = /\.kts?$/.test(file);
    const constant = stringConstants(code, masked, kotlin);
    /** The `configurePathMatch` body around a call, else the innermost block: one configurer's calls, in order. */
    const groupOf = (at: number): string => {
      let innermost: number | undefined;
      for (let open = enclosingOpen(masked, at); open !== undefined; open = enclosingOpen(masked, open)) {
        if (masked[open] !== "{") continue;
        innermost ??= open;
        if (/\bconfigurePathMatch\s*\([^()]*\)[^{}()]*$/.test(masked.slice(Math.max(0, open - 300), open))) return `${file}@${open}`;
      }
      return `${file}@${innermost ?? 0}`;
    };
    for (const m of masked.matchAll(/\.\s*addPathPrefix\s*\(/g)) {
      const open = (m.index ?? 0) + m[0].length - 1;
      const close = closing(masked, open);
      if (close === undefined) continue;
      const args = splitTop(code.slice(open + 1, close), ",").map((a) => a.trim());
      // Kotlin passes a last lambda after the parentheses: `addPathPrefix("/api") { it.isAnnotationPresent(...) }`.
      const trailing = kotlin && args.length === 1 ? /^\s*\{/.exec(masked.slice(close + 1)) : null;
      const end = trailing ? closing(masked, close + 1 + trailing[0].length - 1) : undefined;
      if (end !== undefined) args.push(code.slice(close + 1, end + 1).trim());
      const [prefixText = "", predicate = ""] = args;
      const literal = literals(prefixText, kotlin);
      const value = literal?.length === 1 ? literal[0] : constant(prefixText, m.index ?? 0);
      // Spring resolves `${...}` placeholders in a prefix from the environment (RequestMappingHandlerMapping).
      const prefix = value === undefined || /\$\{/.test(value) ? undefined : value;
      entries.push({
        where: `${file}:${lineOf(text, m.index ?? 0)}`,
        group: groupOf(m.index ?? 0),
        prefix,
        prefixText,
        predicate: predicate.replace(/\s+/g, " "),
        test: args.length === 2 ? predicateTest(predicate, kotlin, meta) : undefined,
      });
    }
  }
  const causes = new Map<string, Set<string>>();
  const unread = (why: string, type: HandlerType) => {
    (causes.get(why) ?? causes.set(why, new Set()).get(why)!).add(type.name);
    return undefined;
  };
  return {
    of: (type) => {
      if (!entries.length) return "";
      // What each configurer decides, in the order of its calls: a prefix, or the entry that leaves it undecided.
      const decided = new Map<string, { prefix: string } | { entry: Entry; why: string }>();
      for (const e of entries) {
        if (decided.has(e.group)) continue;
        if (type.kind === "interface") {
          decided.set(e.group, { entry: e, why: `${e.where} gives a path prefix to the handler types ${e.predicate} accepts, which the class that implements an interface decides` });
          continue;
        }
        const accepts = e.test?.(type);
        if (e.test === undefined) decided.set(e.group, { entry: e, why: `${e.where} gives a path prefix to the handler types a predicate atlas does not read accepts (${e.predicate})` });
        else if (accepts === undefined) decided.set(e.group, { entry: e, why: `${e.where} gives a path prefix to the handler types ${e.predicate} accepts, which a supertype or a meta-annotation may decide` });
        else if (accepts && e.prefix === undefined) decided.set(e.group, { entry: e, why: `${e.where} gives the handler types ${e.predicate} accepts a path prefix the file does not spell out (${e.prefixText})` });
        else if (accepts) decided.set(e.group, { prefix: e.prefix! });
      }
      const all = [...decided.values()];
      const open = all.find((d): d is { entry: Entry; why: string } => "why" in d);
      if (open) return unread(open.why, type);
      const values = [...new Set(all.map((d) => (d as { prefix: string }).prefix))];
      if (values.length > 1) {
        const where = [...new Set(entries.filter((e) => decided.has(e.group) && e.prefix !== undefined && values.includes(e.prefix)).map((e) => e.where))];
        return unread(`${where.join(", ")} give path prefixes (${values.join(", ")}) in configurers whose order is not read`, type);
      }
      return values[0] ?? "";
    },
    limits: (component) => [...causes].map(([why, types]) => `routes ${component}: ${why}; the routes of ${[...types].sort().join(", ")} are not read`),
  };
}

/** A predicate on handler types atlas decides: a test giving undefined where it cannot decide for a type, or undefined. */
function predicateTest(predicate: string, kotlin: boolean, meta: Map<string, { written: string[]; imports: Imports } | null>): ((t: HandlerType) => boolean | undefined) | undefined {
  const text = predicate.trim();
  const call = /^(?:[\w.]*\.)?(forAnnotation|forBasePackage)\s*\(([\s\S]*)\)$/.exec(text);
  if (call) {
    const args = splitTop(call[2]!, ",").map((a) => a.trim()).filter(Boolean);
    if (!args.length) return undefined;
    if (call[1] === "forBasePackage") {
      const packages = args.map((a) => literals(a, kotlin));
      if (!packages.every((p) => p?.length === 1)) return undefined;
      const bases = packages.map((p) => (p![0]!.endsWith(".") ? p![0]! : `${p![0]!}.`));
      return (t) => bases.some((b) => `${t.package}.${t.name}`.startsWith(b));
    }
    const names = args.map((a) => ANNOTATION_CLASS.exec(a)?.[1]);
    if (!names.every(Boolean)) return undefined;
    return (t) => {
      const { names: present, complete } = metaClosure(t, meta);
      if (names.some((n) => present.has(n!))) return true;
      // Not found, a supertype, or an annotation whose own annotations are not read, may still carry one.
      return t.inherits || !complete ? undefined : false;
    };
  }
  // `c -> c.isAnnotationPresent(A.class)`, `(Class<?> c) -> ...`, `{ it.isAnnotationPresent(A::class.java) }`.
  const lambda =
    /^\(?\s*(?:[\w<>?,\s]+\s+)?(\w+)\s*\)?\s*->\s*\1\s*\.\s*isAnnotationPresent\s*\(([^()]*)\)$/.exec(text) ??
    /^\{\s*(?:(\w+)\s*->\s*\1|it)\s*\.\s*isAnnotationPresent\s*\(([^()]*)\)\s*\}$/.exec(text);
  const name = lambda && ANNOTATION_CLASS.exec(lambda[2]!.trim())?.[1];
  if (!name) return undefined;
  // Class.isAnnotationPresent sees an annotation of a supertype only where it is @Inherited, which Spring's stereotypes are not.
  return (t) => (t.annotations.has(name) ? true : t.inherits && name !== "Controller" && name !== "RestController" ? undefined : false);
}

/** The types a Java or Kotlin file names by import: by simple name, the packages imported whole, and its own package. */
export interface Imports {
  package: string;
  single: Map<string, string>;
  wildcard: string[];
  kotlin: boolean;
}

function importsOf(masked: string, kotlin: boolean): Imports {
  const single = new Map<string, string>();
  const wildcard: string[] = [];
  for (const m of masked.matchAll(/^\s*import\s+(?!static\b)([\w.]+?)(\.\*)?(?:\s+as\s+(\w+))?\s*;?\s*$/gm)) {
    if (m[2]) wildcard.push(m[1]!);
    else single.set(m[3] ?? m[1]!.slice(m[1]!.lastIndexOf(".") + 1), m[1]!);
  }
  return { package: /^\s*package\s+([\w.]+)/m.exec(masked)?.[1] ?? "", single, wildcard, kotlin };
}

/**
 * The annotations that Spring, springdoc/Swagger, Lombok, Jakarta and the JDK declare on annotations a handler type
 * commonly carries, by qualified name, from their sources, as `AnnotationUtils.findAnnotation` follows them. The
 * meta-annotations of java.lang.annotation (`@Target`, `@Retention`, `@Documented`, `@Inherited`, `@Repeatable`) are left
 * out: they carry no annotation of a user's. Most carry none other.
 */
const SPRING_WEB = "org.springframework.web.bind.annotation";
const STEREOTYPE = "org.springframework.stereotype";
const REFLECTIVE = "org.springframework.aot.hint.annotation.Reflective";
const NONE: string[] = [];
const KNOWN_META: Record<string, string[]> = {
  // Spring Framework (stereotype, web, validation, transaction).
  [`${SPRING_WEB}.RestController`]: [`${STEREOTYPE}.Controller`, `${SPRING_WEB}.ResponseBody`],
  [`${STEREOTYPE}.Controller`]: [`${STEREOTYPE}.Component`],
  [`${STEREOTYPE}.Service`]: [`${STEREOTYPE}.Component`],
  [`${STEREOTYPE}.Repository`]: [`${STEREOTYPE}.Component`],
  [`${STEREOTYPE}.Component`]: [`${STEREOTYPE}.Indexed`],
  [`${STEREOTYPE}.Indexed`]: NONE,
  [`${SPRING_WEB}.RequestMapping`]: [`${SPRING_WEB}.Mapping`, REFLECTIVE],
  [`${SPRING_WEB}.Mapping`]: NONE,
  [REFLECTIVE]: NONE,
  [`${SPRING_WEB}.ResponseBody`]: NONE,
  [`${SPRING_WEB}.CrossOrigin`]: NONE,
  [`${SPRING_WEB}.ResponseStatus`]: NONE,
  [`${SPRING_WEB}.SessionAttributes`]: NONE,
  ["org.springframework.validation.annotation.Validated"]: NONE,
  ["org.springframework.transaction.annotation.Transactional"]: [REFLECTIVE],
  // Spring Security.
  ["org.springframework.security.access.prepost.PreAuthorize"]: NONE,
  ["org.springframework.security.access.prepost.PostAuthorize"]: NONE,
  ["org.springframework.security.access.annotation.Secured"]: NONE,
  // springdoc's Swagger 3 annotations, Swagger 2 and springfox.
  ["io.swagger.v3.oas.annotations.tags.Tag"]: NONE,
  ["io.swagger.v3.oas.annotations.tags.Tags"]: NONE,
  ["io.swagger.v3.oas.annotations.Hidden"]: NONE,
  ["io.swagger.v3.oas.annotations.security.SecurityRequirement"]: NONE,
  ["io.swagger.v3.oas.annotations.security.SecurityRequirements"]: NONE,
  ["io.swagger.v3.oas.annotations.responses.ApiResponse"]: NONE,
  ["io.swagger.v3.oas.annotations.responses.ApiResponses"]: NONE,
  ["io.swagger.annotations.Api"]: NONE,
  ["io.swagger.annotations.ApiResponses"]: NONE,
  ["springfox.documentation.annotations.ApiIgnore"]: NONE,
  // Lombok's are kept in the source only.
  ...Object.fromEntries(
    ["Data", "Getter", "Setter", "RequiredArgsConstructor", "AllArgsConstructor", "NoArgsConstructor", "extern.slf4j.Slf4j", "extern.log4j.Log4j2", "extern.java.Log"].map((n) => [`lombok.${n}`, NONE]),
  ),
  // Jakarta Validation and Annotations, and the javax packages they were renamed from.
  ...Object.fromEntries(
    ["jakarta", "javax"].flatMap((root) => ["validation.Valid", "annotation.security.RolesAllowed", "annotation.security.PermitAll", "annotation.security.DenyAll"].map((n) => [`${root}.${n}`, NONE])),
  ),
  // The JDK's and Kotlin's, which a file uses without importing them.
  ...Object.fromEntries(
    ["java.lang.Deprecated", "java.lang.SuppressWarnings", "kotlin.Deprecated", "kotlin.Suppress", ...["Target", "Retention", "Documented", "Inherited", "Repeatable"].map((n) => `java.lang.annotation.${n}`)].map((n) => [n, NONE]),
  ),
};
const IMPLICIT = { java: ["java.lang"], kotlin: ["kotlin", "kotlin.annotation"] };

/** The annotation types the files declare (`@interface A`, Kotlin `annotation class A`), by qualified name, with the annotations written on each and the imports that name them; null for a name declared twice. */
function annotationTypes(texts: Map<string, string>): Map<string, { written: string[]; imports: Imports } | null> {
  const out = new Map<string, { written: string[]; imports: Imports } | null>();
  for (const [file, text] of texts) {
    if (!/@interface\b|\bannotation\s+class\b/.test(text)) continue;
    const masked = maskStrings(file, withoutComments(file, text));
    const imports = importsOf(masked, /\.kts?$/.test(file));
    for (const m of masked.matchAll(/(?:@interface|\bannotation\s+class)\s+(\w+)/g)) {
      const at = m.index ?? 0;
      const written = [...masked.slice(declarationStart(masked, at), at).matchAll(/@([\w.]+)/g)].map((a) => a[1]!);
      const name = imports.package ? `${imports.package}.${m[1]}` : m[1]!;
      out.set(name, out.has(name) ? null : { written, imports });
    }
  }
  return out;
}

/**
 * The qualified name an annotation written in a file means, as the language finds it: written qualified, imported by
 * name, a type of the file's package the files declare, the one known type of the packages imported whole, or one the
 * language imports itself. Undefined where none of those names it for certain.
 */
function resolveAnnotation(written: string, imports: Imports, declared: Map<string, unknown>): string | undefined {
  const known = (name: string) => name in KNOWN_META || declared.has(name);
  const dot = written.indexOf(".");
  if (dot > 0) {
    const head = imports.single.get(written.slice(0, dot));
    return head ? `${head}${written.slice(dot)}` : written;
  }
  const imported = imports.single.get(written);
  if (imported) return imported;
  const own = imports.package ? `${imports.package}.${written}` : written;
  if (declared.has(own)) return own;
  const whole = [...new Set(imports.wildcard.map((p) => `${p}.${written}`).filter(known))];
  if (whole.length === 1) return whole[0];
  if (whole.length > 1) return undefined;
  return (imports.kotlin ? IMPLICIT.kotlin : IMPLICIT.java).map((p) => `${p}.${written}`).find((n) => n in KNOWN_META);
}

/**
 * The simple names of the annotations present on a type through meta-annotations, as `AnnotationUtils.findAnnotation`
 * searches them, and whether every one was followed: an annotation not resolved to one the files declare or
 * `KNOWN_META` names may carry any.
 */
function metaClosure(type: HandlerType, declared: Map<string, { written: string[]; imports: Imports } | null>): { names: Set<string>; complete: boolean } {
  const names = new Set<string>(type.annotations);
  let complete = true;
  const seen = new Set<string>();
  const queue = type.written.map((w) => ({ written: w, imports: type.imports }));
  while (queue.length) {
    const { written, imports } = queue.shift()!;
    const name = resolveAnnotation(written, imports, declared);
    // An annotation written is present by its name, followed or not.
    names.add(written.slice(written.lastIndexOf(".") + 1));
    if (name === undefined) {
      complete = false;
      continue;
    }
    if (seen.has(name)) continue;
    seen.add(name);
    names.add(name.slice(name.lastIndexOf(".") + 1));
    const own = declared.get(name);
    if (own) queue.push(...own.written.map((w) => ({ written: w, imports: own.imports })));
    else if (name in KNOWN_META) queue.push(...KNOWN_META[name]!.map((w) => ({ written: w, imports })));
    else complete = false;
  }
  return { names, complete };
}
