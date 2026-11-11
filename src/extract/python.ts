import { posix } from "node:path";
import { closingParen, pythonArg, pythonArgStarts, pythonStrings } from "./routes.js";

/**
 * What the readers of Python web frameworks (FastAPI, Flask) share: the functions of a file and the names they bind,
 * the arguments of a call, the imports of a file and the files they name, and a name followed through them to where it
 * is bound.
 */

/** A literal, or the expression text where the file does not spell the value out. */
export type Value = string | { unread: string };

/** A function: where its body lies and the names it binds there, which hide the file's own. */
export interface Scope {
  start: number;
  end: number;
  names: Set<string>;
}

/**
 * The functions of a file, from its code: the names each binds are its parameters, and those its own body (not a nested
 * function's) assigns, other than to a value `framework` says the file's name stands for wherever it is assigned (an
 * application or router), or takes in a `for`, `with` or `except` statement.
 */
export function scopesOf(code: string, framework: (assigned: string) => boolean): Scope[] {
  // The bracket depth at each offset: a line inside a call's parentheses binds nothing.
  const depth: number[] = [];
  for (let i = 0, d = 0; i < code.length; i++) {
    depth.push(d);
    if ("([{".includes(code[i]!)) d++;
    else if (")]}".includes(code[i]!)) d = Math.max(0, d - 1);
  }
  const scopes: Array<Scope & { indent: number }> = [];
  for (const m of code.matchAll(/^([ \t]*)(?:async[ \t]+)?def[ \t]+\w+[ \t]*\(/gm)) {
    if (depth[m.index ?? 0]) continue;
    const open = (m.index ?? 0) + m[0].length;
    const names = new Set(
      pythonArgStarts(code, open)
        .map((at) => /^\*{0,2}([A-Za-z_]\w*)/.exec(code.slice(at))?.[1])
        .filter((n): n is string => !!n),
    );
    const start = code.indexOf(":", closingParen(code, open));
    if (start < 0) continue;
    // The body ends at the first line, outside brackets, indented no deeper than the `def`.
    const indent = m[1]!.replace(/\t/g, "        ").length;
    let end = code.length;
    for (const line of code.slice(start).matchAll(/\n([ \t]*)\S/g)) {
      const at = start + (line.index ?? 0) + 1;
      if (!depth[at] && line[1]!.replace(/\t/g, "        ").length <= indent) {
        end = at;
        break;
      }
    }
    scopes.push({ start: start + 1, end, names, indent });
  }
  const own = (scope: Scope, at: number) => !scopes.some((s) => s !== scope && s.start > scope.start && s.start <= at && at < s.end);
  for (const scope of scopes) {
    const body = code.slice(scope.start, scope.end);
    const bind = (at: number, names: string) => {
      if (depth[scope.start + at] || !own(scope, scope.start + at)) return;
      for (const n of names.match(/[A-Za-z_]\w*/g) ?? []) scope.names.add(n);
    };
    for (const m of body.matchAll(/^[ \t]*([A-Za-z_]\w*)[ \t]*(?::[^=\n]+)?=(?!=)[ \t]*(.*)/gm)) {
      if (!framework(m[2]!)) bind(m.index ?? 0, m[1]!);
    }
    for (const m of body.matchAll(/^[ \t]*(?:async[ \t]+)?for[ \t]+(.+?)[ \t]+in\b/gm)) bind(m.index ?? 0, m[1]!);
    for (const m of body.matchAll(/^[ \t]*(?:(?:async[ \t]+)?with|except)\b.*/gm)) {
      for (const as of m[0].matchAll(/\bas[ \t]+([A-Za-z_]\w*)/g)) bind(m.index ?? 0, as[1]!);
    }
  }
  return scopes;
}

/**
 * Where the block whose header ends with the `:` at `colon` ends: at the first line, outside brackets, indented no
 * deeper than the header's `indent`.
 */
export function blockEnd(code: string, colon: number, indent: string): number {
  const width = (s: string) => s.replace(/\t/g, "        ").length;
  const line = /([ \t]*)\S/y;
  let depth = 0;
  for (let i = colon; i < code.length; i++) {
    const c = code[i]!;
    if ("([{".includes(c)) depth++;
    else if (")]}".includes(c)) depth = Math.max(0, depth - 1);
    else if (c === "\n" && !depth) {
      line.lastIndex = i + 1;
      const m = line.exec(code);
      if (m && width(m[1]!) <= width(indent)) return i + 1;
    }
  }
  return code.length;
}

/** Whether a function around offset `at` binds `name`, so that it does not refer to the file's own. */
export function shadowed(scopes: Scope[], name: string, at: number): boolean {
  return scopes.some((s) => s.start <= at && at < s.end && s.names.has(name));
}

/** The start of the innermost function a file's offset is in, or -1 at its top level. */
export function scopeAt(scopes: Scope[], at: number): number {
  const around = scopes.filter((s) => s.start <= at && at < s.end);
  return around.length ? Math.max(...around.map((s) => s.start)) : -1;
}

/** A literal, or the text of an argument the file does not spell out. */
export function valueAt(text: string, code: string, at: number): Value {
  const arg = pythonArg(text, code, at);
  const literal = pythonStrings(arg);
  return literal && literal.length === arg.length ? literal.value : { unread: arg.replace(/\s+/g, " ") };
}

/**
 * The value of the keyword argument `name` among the arguments starting at `from`: "" when it is not given, and not read
 * where a `**` argument may give it.
 */
export function keyword(text: string, code: string, from: number, name: string): Value {
  const starts = pythonArgStarts(code, from);
  for (const at of starts) {
    const m = new RegExp(`^${name}\\s*=(?!=)\\s*`).exec(code.slice(at));
    if (m) return valueAt(text, code, at + m[0].length);
  }
  const spread = starts.find((at) => code.startsWith("**", at));
  return spread === undefined ? "" : { unread: pythonArg(text, code, spread).replace(/\s+/g, " ") };
}

/**
 * A `True` or `False` the keyword argument `name` gives: undefined where it is not given, null where it is another
 * value or a `**` argument may give it.
 */
export function booleanKeyword(text: string, code: string, from: number, name: string): boolean | undefined | null {
  const value = keyword(text, code, from, name);
  if (value === "") return undefined;
  if (typeof value === "string") return null;
  return value.unread === "True" ? true : value.unread === "False" ? false : null;
}

/** Names a file imports: the module as written (dots kept) and, for `from m import x`, the name taken. */
export type Imports = Map<string, { module: string; member?: string }>;

/**
 * The names a file's code imports: `from m import x as y` binds `y` to `x` of `m`, `import a.b as c` binds `c` to the
 * module `a.b`, and a plain `import a.b` binds `a`, the package, with the module it names kept as written.
 */
export function pythonImports(code: string): Imports {
  const imports: Imports = new Map();
  for (const m of code.matchAll(/^[ \t]*from[ \t]+(\.*[\w.]*)[ \t]+import[ \t]+(\([^)]*\)|.*(?:\\\n.*)*)/gm)) {
    for (const item of m[2]!.replace(/[()\\]/g, " ").split(",")) {
      const named = /^\s*([A-Za-z_]\w*)(?:\s+as\s+([A-Za-z_]\w*))?\s*$/.exec(item);
      if (named) imports.set(named[2] ?? named[1]!, { module: m[1]!, member: named[1]! });
    }
  }
  for (const m of code.matchAll(/^[ \t]*import[ \t]+(.*)/gm)) {
    for (const item of m[1]!.split(",")) {
      const named = /^\s*([A-Za-z_][\w.]*)\s+as\s+([A-Za-z_]\w*)\s*$/.exec(item);
      if (named) imports.set(named[2]!, { module: named[1]! });
    }
  }
  return imports;
}

/** `import a.b` binds `a`: the names a file's plain imports bind, each to the first segment of its module. */
export function plainImports(code: string): Set<string> {
  const out = new Set<string>();
  for (const m of code.matchAll(/^[ \t]*import[ \t]+(.*)/gm)) {
    for (const item of m[1]!.split(",")) {
      const named = /^\s*([A-Za-z_]\w*)(?:\.[\w.]*)?\s*$/.exec(item);
      if (named) out.add(named[1]!);
    }
  }
  return out;
}

/** The module `member` of `module` names, as `from module import member` imports it when it is a module. */
export const submodule = (module: string, member: string): string => (module.endsWith(".") ? `${module}${member}` : `${module}.${member}`);

/**
 * The file of a module among `files`, as Python imports it from the file `from`: relative to its package, or by its
 * dotted path, found by its path's end (of several, the one nearest the importing file).
 */
export function moduleFiles(files: string[]): (from: string, module: string) => string | undefined {
  const known = new Set(files);
  return (from, module) => {
    const dots = /^\.*/.exec(module)![0].length;
    const rest = module.slice(dots).split(".").filter(Boolean).join("/");
    const candidates = (path: string) => [`${path}.py`, `${path}/__init__.py`].map((p) => posix.normalize(p).replace(/^\.\//, ""));
    if (dots) {
      let dir = posix.dirname(from);
      for (let i = 1; i < dots; i++) dir = posix.dirname(dir);
      return candidates(posix.join(dir, rest)).find((c) => known.has(c));
    }
    const found = files.filter((f) => candidates(rest).some((c) => f === c || f.endsWith(`/${c}`)));
    const shared = (f: string) => {
      const a = posix.dirname(from).split("/");
      const b = f.split("/");
      let n = 0;
      while (n < a.length && a[n] === b[n]) n++;
      return n;
    };
    const best = Math.max(...found.map(shared));
    const nearest = found.filter((f) => shared(f) === best);
    return nearest.length === 1 ? nearest[0] : undefined;
  };
}

/**
 * Names followed through the imports of the files read to where a file binds them (`file#name`): `bound` says whether a
 * file binds a name itself. A name imported from a module that is a file of its own (`from app import views`) is that
 * module, not a name bound in the package.
 */
export function pythonBindings(imports: Map<string, Imports>, bound: (file: string, name: string) => boolean) {
  const moduleFile = moduleFiles([...imports.keys()]);
  const bindingAt = (file: string, name: string, seen = new Set<string>()): string | undefined => {
    const key = `${file}#${name}`;
    const own = imports.get(file);
    if (!own || seen.has(key)) return undefined;
    if (bound(file, name)) return key;
    const imported = own.get(name);
    if (!imported?.member || moduleFile(file, submodule(imported.module, imported.member))) return undefined;
    const module = moduleFile(file, imported.module);
    return module ? bindingAt(module, imported.member, new Set([...seen, key])) : undefined;
  };
  /** The binding an expression `name` or `module.name` refers to, `module` imported. */
  const reference = (file: string, expr: string): string | undefined => {
    const m = /^([A-Za-z_]\w*)(?:\.([A-Za-z_]\w*))?$/.exec(expr);
    if (!m) return undefined;
    if (!m[2]) return bindingAt(file, m[1]!);
    const imported = imports.get(file)?.get(m[1]!);
    const module = imported && moduleFile(file, imported.member ? submodule(imported.module, imported.member) : imported.module);
    return module ? bindingAt(module, m[2]) : undefined;
  };
  return { moduleFile, bindingAt, reference };
}

/** The text of the expression an assignment's right side starts at `at` with, to the end of its statement. */
export function statementValue(text: string, code: string, at: number): string {
  let depth = 0;
  let end = at;
  for (; end < code.length; end++) {
    const c = code[end]!;
    if ("([{".includes(c)) depth++;
    else if (")]}".includes(c)) depth = Math.max(0, depth - 1);
    else if (!depth && (c === ";" || (c === "\n" && code[end - 1] !== "\\"))) break;
  }
  return text.slice(at, end).trim();
}
