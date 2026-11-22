import { posix } from "node:path";
import { closingParen, pythonArg, pythonArgStarts, pythonCode, pythonStrings } from "./routes.js";

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
    const bind = (at: number, target: string) => {
      if (depth[scope.start + at] || !own(scope, scope.start + at)) return;
      for (const n of targetNames(target)) scope.names.add(n);
    };
    // Every target of an assignment, chained (`a = b = 1`) or augmented (`a += 1`), binds the names it holds.
    for (const m of body.matchAll(/^[ \t]*(?=[^\s#])/gm)) {
      const at = scope.start + (m.index ?? 0) + m[0].length;
      if (depth[at]) continue;
      const assigned = assignment(code, at);
      if (assigned && !framework(assigned.value)) for (const t of assigned.targets) bind(m.index ?? 0, t);
    }
    for (const m of body.matchAll(/^[ \t]*(?:async[ \t]+)?for[ \t]+(.+?)[ \t]+in\b/gm)) bind(m.index ?? 0, m[1]!);
    for (const m of body.matchAll(/^[ \t]*(?:(?:async[ \t]+)?with|except)\b.*/gm)) {
      for (const as of m[0].matchAll(/\bas[ \t]+(\([^()]*\)|\[[^\]]*\]|[A-Za-z_][\w.]*(?:\[[^\]]*\])?)/g)) bind(m.index ?? 0, as[1]!);
    }
  }
  return scopes;
}

/**
 * The names a target binds (an assignment's, a `for`'s, an `as`'s): a name, alone or in a tuple or list at any depth
 * (`x`, `x, (y, *z)`), a single name annotated (`x: int`); not an attribute or a subscript (`box.app`, `d[k]`), which
 * binds no name of the function's.
 */
export function targetNames(target: string): string[] {
  const t = target.trim();
  const annotated = /^([A-Za-z_]\w*)\s*:(?!=)/.exec(t);
  if (annotated) return [annotated[1]!];
  const items: string[] = [];
  let depth = 0;
  let start = 0;
  for (let i = 0; i <= t.length; i++) {
    const c = t[i];
    if (c === undefined || (c === "," && depth === 0)) {
      items.push(t.slice(start, i).trim());
      start = i + 1;
    } else if ("([{".includes(c)) depth++;
    else if (")]}".includes(c)) depth--;
  }
  return items.flatMap((item) => {
    const bare = item.replace(/^\*\s*/, "");
    if (/^[A-Za-z_]\w*$/.test(bare)) return [bare];
    const wrapped = /^([([])([^]*)([)\]])$/.exec(bare);
    return wrapped && closingParen(bare, 1) === bare.length - 1 ? targetNames(wrapped[2]!) : [];
  });
}

/**
 * The assignment statement at offset `at` of blanked code: its targets, each before an `=` outside brackets (an
 * augmented one's before its operator), and the value after the last; undefined for any other statement.
 */
export function assignment(code: string, at: number): { targets: string[]; value: string } | undefined {
  let depth = 0;
  let end = at;
  for (; end < code.length; end++) {
    const c = code[end]!;
    if ("([{".includes(c)) depth++;
    else if (")]}".includes(c)) depth = Math.max(0, depth - 1);
    else if (!depth && (c === ";" || (c === "\n" && code[end - 1] !== "\\"))) break;
  }
  const statement = code.slice(at, end);
  if (/^(?:def|class|if|elif|while|for|with|return|yield|lambda|assert|del|raise|import|from|global|nonlocal|async|await)\b|^@/.test(statement)) return undefined;
  const cuts: Array<[number, number]> = [];
  depth = 0;
  for (let i = 0; i < statement.length; i++) {
    const c = statement[i]!;
    if ("([{".includes(c)) depth++;
    else if (")]}".includes(c)) depth = Math.max(0, depth - 1);
    else if (c === "=" && !depth && statement[i + 1] !== "=" && !"=!<>:".includes(statement[i - 1] ?? "")) {
      const op = /(?:\*\*|\/\/|<<|>>|[-+*/%&|^@])$/.exec(statement.slice(0, i))?.[0] ?? "";
      cuts.push([i - op.length, i + 1]);
      // An augmented assignment has one target.
      if (op) break;
    } else if (c === "=" && !depth && "<>".includes(statement[i - 1] ?? "") && "<>".includes(statement[i - 2] ?? "") && statement[i - 1] === statement[i - 2]) {
      cuts.push([i - 2, i + 1]);
      break;
    }
  }
  if (!cuts.length) return undefined;
  const targets = cuts.map(([from], k) => statement.slice(k ? cuts[k - 1]![1] : 0, from).trim());
  return { targets, value: statement.slice(cuts[cuts.length - 1]![1]).trim() };
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

const NOT_CALLED = new Set(["if", "elif", "while", "for", "with", "return", "await", "yield", "not", "and", "or", "in", "is", "lambda", "assert", "del", "raise", "except", "def", "class", "async", "print"]);

/**
 * The function the decorators starting at `line` (1-based) of blanked code put on, or the `def` at that line, as a
 * request's handler: its name, and the names of the functions its own body calls for certain, one call deep. Undefined
 * where the line is neither or no `def` follows the decorators.
 */
export function decoratedHandler(code: string, line: number): { name: string; calls: string[] } | undefined {
  const lines = code.split("\n");
  if (line < 1 || line > lines.length || !/^[ \t]*(?:@|(?:async[ \t]+)?def[ \t])/.test(lines[line - 1]!)) return undefined;
  let at = lines.slice(0, line - 1).reduce((n, l) => n + l.length + 1, 0);
  // Past each decorator, its arguments spanning lines, and the blank lines after it, to the statement they decorate.
  const blank = /[ \t]*\n/y;
  for (let decorator = /^[ \t]*@/.exec(code.slice(at)); decorator; decorator = /^[ \t]*@/.exec(code.slice(at))) {
    let depth = 0;
    let i = at + decorator[0].length;
    for (; i < code.length; i++) {
      const c = code[i]!;
      if ("([{".includes(c)) depth++;
      else if (")]}".includes(c)) depth = Math.max(0, depth - 1);
      else if (c === "\n" && !depth) break;
    }
    at = i + 1;
    for (blank.lastIndex = at; blank.exec(code); ) at = blank.lastIndex;
  }
  const def = /^([ \t]*)(?:async[ \t]+)?def[ \t]+([A-Za-z_]\w*)[ \t]*\(/.exec(code.slice(at));
  if (!def) return undefined;
  const colon = code.indexOf(":", closingParen(code, at + def[0].length));
  if (colon < 0) return undefined;
  const end = blockEnd(code, colon, def[1]!);
  // A function or lambda the handler declares runs only where it is called: its body is left out, and a function's
  // name counts only where the rest of the handler calls it. What runs as it is declared stays: a nested def's default
  // arguments and annotations, a class statement's body (only the functions in it are left out), a lambda's defaults.
  const body = code.slice(colon + 1, end).split("");
  const blankOut = (from: number, to: number) => {
    for (let i = Math.max(from, colon + 1); i < Math.min(to, end); i++) if (body[i - colon - 1] !== "\n") body[i - colon - 1] = " ";
  };
  for (const n of code.slice(colon + 1, end).matchAll(/^([ \t]*)((?:async[ \t]+)?def[ \t]+[A-Za-z_]\w*)/gm)) {
    const start = colon + 1 + (n.index ?? 0) + n[1]!.length;
    const header = headerColon(code, start);
    // The `def name` itself is no call; the rest of the header runs now, the body later.
    blankOut(start, start + n[2]!.length);
    if (header >= 0) blankOut(header + 1, blockEnd(code, header, n[1]!));
  }
  for (const [start, stop] of lambdaRanges(code)) if (start > colon && start <= end) blankOut(start, stop);
  // The names a handler calls for certain: bare (`f(`), on `self` or `cls`, or on a module the file imports from its own
  // package (`svc.load(` after `from . import svc`). A method of any other value (`q.get(`, `requests.post(`) names
  // nothing of the component's.
  const local = new Set(["self", "cls"]);
  for (const m of code.matchAll(/^[ \t]*from[ \t]+\.[\w.]*[ \t]+import[ \t]+(?:\(([^)]*)\)|([^\n]+))/gm))
    for (const item of (m[1] ?? m[2]!).split(",")) {
      const i = /^\s*([A-Za-z_]\w*)(?:\s+as\s+([A-Za-z_]\w*))?\s*$/.exec(item);
      if (i) local.add(i[2] ?? i[1]!);
    }
  const calls: string[] = [];
  for (const m of body.join("").matchAll(/(?<![\w.]|\bclass[ \t]+)([A-Za-z_]\w*)(?:[ \t]*\.[ \t]*([A-Za-z_]\w*))?[ \t]*\(/g)) {
    if (m[2] === undefined) calls.push(m[1]!);
    else if (local.has(m[1]!)) calls.push(m[2]);
  }
  return { name: def[2]!, calls: [...new Set(calls.filter((n) => !NOT_CALLED.has(n)))].sort() };
}

/** The `:` that ends the block header starting at `from`, outside brackets; -1 where there is none. */
function headerColon(code: string, from: number): number {
  let depth = 0;
  for (let i = from; i < code.length; i++) {
    const c = code[i]!;
    if ("([{".includes(c)) depth++;
    else if (")]}".includes(c)) depth = Math.max(0, depth - 1);
    else if (c === ":" && !depth) return i;
  }
  return -1;
}

/**
 * Where the body of each `lambda` of blanked code lies, from past its `:` to the end of its expression (a `,` or a
 * closing bracket of what holds it, or the end of a line outside brackets), with the name an assignment binds it to
 * (`callback = lambda: ...`): it runs only when the lambda is called. Its default arguments, before the `:`, run as
 * it is made.
 */
function lambdaRanges(code: string): Array<[number, number, string | undefined]> {
  // The bracket depth at each offset, so a lambda inside brackets may run over several lines.
  const depthAt: number[] = [];
  for (let i = 0, d = 0; i < code.length; i++) {
    depthAt.push(d);
    if ("([{".includes(code[i]!)) d++;
    else if (")]}".includes(code[i]!)) d = Math.max(0, d - 1);
  }
  const out: Array<[number, number, string | undefined]> = [];
  for (const m of code.matchAll(/(?<![\w.])lambda\b/g)) {
    const colon = headerColon(code, (m.index ?? 0) + m[0].length);
    if (colon < 0) continue;
    const inside = (depthAt[m.index ?? 0] ?? 0) > 0;
    let depth = 0;
    let i = colon + 1;
    for (; i < code.length; i++) {
      const c = code[i]!;
      if ("([{".includes(c)) depth++;
      else if (")]}".includes(c)) {
        if (!depth) break;
        depth--;
      } else if (!depth && (c === "," || (!inside && c === "\n" && code[i - 1] !== "\\"))) break;
    }
    const bound = /(?:^|[\n;])[ \t]*([A-Za-z_]\w*)[ \t]*=[ \t]*\(?[ \t]*$/.exec(code.slice(Math.max(0, (m.index ?? 0) - 200), m.index ?? 0))?.[1];
    out.push([colon + 1, i, bound]);
  }
  return out;
}

/**
 * For Python: the name of the innermost function whose body holds an offset, by indentation, so a statement after a
 * function's body (a module-level request, a decorator's arguments) belongs to none, and neither does a default
 * argument, which Python evaluates when it defines the function. A lambda's body is a scope of its own, named as the
 * assignment that binds it names it (`callback`), else `lambda`, since it runs only when it is called.
 */
export function pythonScopes(text: string): (index: number) => string | undefined {
  const code = pythonCode(text);
  const defs: Array<{ start: number; end: number; name: string }> = [];
  for (const m of code.matchAll(/^([ \t]*)(?:async[ \t]+)?def[ \t]+([A-Za-z_]\w*)[ \t]*\(/gm)) {
    const colon = headerColon(code, (m.index ?? 0) + m[0].length - 1);
    if (colon >= 0) defs.push({ start: colon + 1, end: blockEnd(code, colon, m[1]!), name: m[2]! });
  }
  for (const [start, end, name] of lambdaRanges(code)) defs.push({ start, end, name: name ?? "lambda" });
  return (index) => {
    let found: { start: number; end: number; name: string } | undefined;
    for (const d of defs) if (d.start <= index && index < d.end && (!found || d.start > found.start)) found = d;
    return found?.name;
  };
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
 * value (a string, `""` included) or a `**` argument may give it.
 */
export function booleanKeyword(text: string, code: string, from: number, name: string): boolean | undefined | null {
  const given = pythonArgStarts(code, from).some((at) => new RegExp(`^${name}\\s*=(?!=)`).test(code.slice(at)));
  const value = keyword(text, code, from, name);
  if (value === "" && !given) return undefined;
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
