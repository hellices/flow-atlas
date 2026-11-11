import { posix } from "node:path";
import { joinRoute } from "../paths.js";
import { lineOf } from "../source.js";
import { closingParen, pythonArg, pythonArgStarts, pythonCode, pythonStrings } from "./routes.js";

/**
 * Where FastAPI routers are served. A route registered on an `APIRouter` is served at the router's `prefix` joined to
 * its path, under every `include_router` that takes the router in, with that call's `prefix`, under where the router
 * it is included into is served; an application (`FastAPI()`) serves at the root ("Bigger Applications - Multiple
 * Files"). A router's routes are read only where every one of those prefixes is a literal, or the configuration
 * declares where the router's file is served (`mounts`); a router included nowhere serves nothing.
 *
 * Names are followed through the imports of the files read: `from app.api.routes import items` makes `items.router`
 * the `router` of `app/api/routes/items.py`, `from .utils import router as utils_router` the one it names.
 */
export interface Routers {
  /**
   * What the name a decorator is written on refers to in a file at offset `at`: a router or an application
   * (`file#name`), or none, as where a function there binds the name to something else.
   */
  receiver(file: string, name: string, at?: number): string | undefined;
  /** The paths a router's routes are served under, its own prefix included ("" for an application); undefined when not read. */
  served(key: string): string[] | undefined;
  /** Whether an expression a file mounts at `at` (`app.mount("/v1", sub)`) is an application or router of the files read. */
  traced(file: string, expr: string, at?: number): boolean;
  /** Why the routers asked about were not read, one line per cause. */
  limits(component: string): string[];
  /**
   * The steps registration order places a route registered on a router at offset `at` of `file` under (see
   * `Dispatch.order`): each `include_router` or `mount` that takes the router in, from the application down, then the
   * function body the registration is in. Undefined where a router is taken in more than once or where it is not read.
   */
  order(key: string, file: string, at: number): Array<{ router: string; at: number }> | undefined;
  /**
   * Whether the application whose router serves a router's routes redirects a request no route takes to the path with
   * the `/` at its end added or removed (`redirect_slashes`, on by default): undefined where that is not read.
   */
  redirects(key: string): boolean | undefined;
}

/** A literal, or the expression text where the file does not spell the value out. */
type Value = string | { unread: string };

interface Binding {
  kind: "app" | "router";
  prefix: Value;
  /**
   * The `redirect_slashes` of an application, or of a router (which holds only where it is mounted as an application,
   * not where `include_router` copies its routes): true where it is not given, null where it is not spelled out.
   */
  redirects?: boolean | null;
}

interface Facts {
  /** Names bound to `FastAPI(...)` or `APIRouter(...)`; null where the file binds a name to several different ones. */
  routers: Map<string, Binding | null>;
  /** Names imported: the module as written (dots kept) and, for `from m import x`, the name taken. */
  imports: Map<string, { module: string; member?: string }>;
  /** `include_router` calls, and `mount` calls, which serve what they mount under their path as an include does. */
  includes: Array<{ receiver: string; target: string; prefix: Value; at: number; verb: "includes" | "mounts" }>;
  scopes: Scope[];
  /** The file's code, strings and comments blanked (`pythonCode`). */
  code: string;
}

/**
 * Where a registration at offset `at` of a file's code runs among the file's statements. Python applies the decorators
 * of one definition from the one nearest it up (`@a` over `@b` over `def f` is `a(b(f))`), when the definition runs:
 * a decorator's place is its definition's, and among the definition's decorators, the nearer first. Any other call is
 * placed where it is.
 */
function placeOf(code: string, at: number): number {
  const scale = code.length + 1;
  if (!/^[ \t]*@/.test(code.slice(at))) return at * scale;
  const definition = /^[ \t]*(?:async[ \t]+)?(?:def|class)\b/gm;
  definition.lastIndex = at;
  const found = definition.exec(code);
  return found ? found.index * scale + (found.index - at) : at * scale;
}

/** A function: where its body lies and the names it binds there, which hide the file's own. */
interface Scope {
  start: number;
  end: number;
  names: Set<string>;
}

/**
 * The functions of a file, from its code: the names each binds are its parameters, and those its own body (not a nested
 * function's) assigns, other than to an application or router, or takes in a `for`, `with` or `except` statement.
 */
function scopesOf(code: string): Scope[] {
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
      if (!/^(?:[A-Za-z_][\w.]*\.)?(?:FastAPI|APIRouter)[ \t]*\(/.test(m[2]!)) bind(m.index ?? 0, m[1]!);
    }
    for (const m of body.matchAll(/^[ \t]*(?:async[ \t]+)?for[ \t]+(.+?)[ \t]+in\b/gm)) bind(m.index ?? 0, m[1]!);
    for (const m of body.matchAll(/^[ \t]*(?:(?:async[ \t]+)?with|except)\b.*/gm)) {
      for (const as of m[0].matchAll(/\bas[ \t]+([A-Za-z_]\w*)/g)) bind(m.index ?? 0, as[1]!);
    }
  }
  return scopes;
}

/** Whether a function around offset `at` binds `name`, so that it does not refer to the file's own. */
function shadowed(scopes: Scope[], name: string, at: number): boolean {
  return scopes.some((s) => s.start <= at && at < s.end && s.names.has(name));
}

/** A literal, or the text of an argument the file does not spell out. */
function valueAt(text: string, code: string, at: number): Value {
  const arg = pythonArg(text, code, at);
  const literal = pythonStrings(arg);
  return literal && literal.length === arg.length ? literal.value : { unread: arg.replace(/\s+/g, " ") };
}

/**
 * The value of the keyword argument `name` among the arguments starting at `from`: "" when it is not given, and not read
 * where a `**` argument may give it.
 */
function keyword(text: string, code: string, from: number, name: string): Value {
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
function booleanKeyword(text: string, code: string, from: number, name: string): boolean | undefined | null {
  const value = keyword(text, code, from, name);
  if (value === "") return undefined;
  if (typeof value === "string") return null;
  return value.unread === "True" ? true : value.unread === "False" ? false : null;
}

/** `redirect_slashes` as given: on where it is not given (Starlette's `Router` default), null where not spelled out. */
const redirectsGiven = (given: boolean | undefined | null): boolean | null => (given === undefined ? true : given);

/** The start of the innermost function a file's offset is in, or -1 at its top level. */
function scopeAt(scopes: Scope[], at: number): number {
  const around = scopes.filter((s) => s.start <= at && at < s.end);
  return around.length ? Math.max(...around.map((s) => s.start)) : -1;
}

function factsOf(text: string): Facts {
  const code = pythonCode(text);
  const facts: Facts = { routers: new Map(), imports: new Map(), includes: [], scopes: scopesOf(code), code };
  // `app = FastAPI(...)`, `router: APIRouter = fastapi.APIRouter(prefix="/items")`, at any indentation.
  for (const m of code.matchAll(/^[ \t]*([A-Za-z_]\w*)[ \t]*(?::[^=\n]+)?=[ \t]*(?:[A-Za-z_][\w.]*\.)?(FastAPI|APIRouter)[ \t]*\(/gm)) {
    const name = m[1]!;
    const from = (m.index ?? 0) + m[0].length;
    const binding: Binding =
      m[2] === "FastAPI"
        ? { kind: "app", prefix: "", redirects: redirectsGiven(booleanKeyword(text, code, from, "redirect_slashes")) }
        : { kind: "router", prefix: keyword(text, code, from, "prefix"), redirects: redirectsGiven(booleanKeyword(text, code, from, "redirect_slashes")) };
    const before = facts.routers.get(name);
    const same = before && before.kind === binding.kind && JSON.stringify(before.prefix) === JSON.stringify(binding.prefix) && before.redirects === binding.redirects;
    facts.routers.set(name, before === undefined || same ? binding : null);
  }
  for (const m of code.matchAll(/^[ \t]*from[ \t]+(\.*[\w.]*)[ \t]+import[ \t]+(\([^)]*\)|.*(?:\\\n.*)*)/gm)) {
    for (const item of m[2]!.replace(/[()\\]/g, " ").split(",")) {
      const named = /^\s*([A-Za-z_]\w*)(?:\s+as\s+([A-Za-z_]\w*))?\s*$/.exec(item);
      if (named) facts.imports.set(named[2] ?? named[1]!, { module: m[1]!, member: named[1]! });
    }
  }
  for (const m of code.matchAll(/^[ \t]*import[ \t]+(.*)/gm)) {
    for (const item of m[1]!.split(",")) {
      const named = /^\s*([A-Za-z_][\w.]*)\s+as\s+([A-Za-z_]\w*)\s*$/.exec(item);
      if (named) facts.imports.set(named[2]!, { module: named[1]! });
    }
  }
  for (const m of code.matchAll(/(?<![\w.])([A-Za-z_]\w*)\.include_router\(\s*/g)) {
    const from = (m.index ?? 0) + m[0].length;
    // The router is the first argument, or the one named `router`.
    const first = pythonArgStarts(code, from).find((at) => !/^[A-Za-z_]\w*\s*=(?!=)/.test(code.slice(at)));
    const named = pythonArgStarts(code, from)
      .map((at) => ({ at, m: /^router\s*=(?!=)\s*/.exec(code.slice(at)) }))
      .find((a) => a.m);
    const at = named ? named.at + named.m![0].length : first;
    if (at === undefined) continue;
    facts.includes.push({ receiver: m[1]!, target: pythonArg(text, code, at).replace(/\s+/g, " "), prefix: keyword(text, code, from, "prefix"), at: m.index ?? 0, verb: "includes" });
  }
  // Starlette's `mount("/v1", sub)` hands the paths under `/v1` to `sub`.
  for (const m of code.matchAll(/(?<![\w.])([A-Za-z_]\w*)\.mount\(\s*/g)) {
    const all = pythonArgStarts(code, (m.index ?? 0) + m[0].length);
    const named = (name: string) => {
      const at = all.find((a) => new RegExp(`^${name}\\s*=(?!=)`).test(code.slice(a)));
      return at === undefined ? undefined : at + /^\w+\s*=\s*/.exec(code.slice(at))![0].length;
    };
    const positional = all.filter((a) => !/^[A-Za-z_]\w*\s*=(?!=)/.test(code.slice(a)) && !code.startsWith("*", a));
    const pathAt = named("path") ?? positional[0];
    const appAt = named("app") ?? positional.find((a) => a !== pathAt);
    if (pathAt === undefined || appAt === undefined) continue;
    facts.includes.push({ receiver: m[1]!, target: pythonArg(text, code, appAt).replace(/\s+/g, " "), prefix: valueAt(text, code, pathAt), at: m.index ?? 0, verb: "mounts" });
  }
  return facts;
}

/**
 * The routers of the Python files read: `texts` by file, and `declared`, the path a router file is served under where
 * the code does not say it (`mounts`).
 */
export function fastapiRouters(texts: Map<string, string>, declared: Record<string, string> = {}): Routers {
  const facts = new Map([...texts].filter(([f]) => f.endsWith(".py")).map(([f, t]) => [f, factsOf(t)]));
  const files = [...facts.keys()];

  /** The file of a module, as Python imports it from `from`: relative to its package, or by its dotted path. */
  const moduleFile = (from: string, module: string): string | undefined => {
    const dots = /^\.*/.exec(module)![0].length;
    const rest = module.slice(dots).split(".").filter(Boolean).join("/");
    const candidates = (path: string) => [`${path}.py`, `${path}/__init__.py`].map((p) => posix.normalize(p).replace(/^\.\//, ""));
    if (dots) {
      let dir = posix.dirname(from);
      for (let i = 1; i < dots; i++) dir = posix.dirname(dir);
      return candidates(posix.join(dir, rest)).find((c) => facts.has(c));
    }
    // An absolute module is found by its path's end; of several, the one nearest the importing file.
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
  const submodule = (module: string, member: string) => (module.endsWith(".") ? `${module}${member}` : `${module}.${member}`);

  /** The router or application a name refers to in a file, followed through `from m import name`. */
  const routerAt = (file: string, name: string, seen = new Set<string>()): string | undefined => {
    const key = `${file}#${name}`;
    const f = facts.get(file);
    if (!f || seen.has(key)) return undefined;
    if (f.routers.has(name)) return key;
    const imported = f.imports.get(name);
    if (!imported?.member || moduleFile(file, submodule(imported.module, imported.member))) return undefined;
    const module = moduleFile(file, imported.module);
    return module ? routerAt(module, imported.member, new Set([...seen, key])) : undefined;
  };
  /** What a name refers to at offset `at` of a file: none where a function there binds it. */
  const receiver = (file: string, name: string, at?: number): string | undefined =>
    at !== undefined && shadowed(facts.get(file)?.scopes ?? [], name, at) ? undefined : routerAt(file, name);
  /**
   * The router an `include_router` argument at offset `at` names: `router`, `utils_router` or `items.router` of an
   * imported module.
   */
  const included = (file: string, expr: string, at?: number): string | undefined => {
    const m = /^([A-Za-z_]\w*)(?:\.([A-Za-z_]\w*))?$/.exec(expr);
    if (!m || (at !== undefined && shadowed(facts.get(file)?.scopes ?? [], m[1]!, at))) return undefined;
    if (!m[2]) return routerAt(file, m[1]!);
    const imported = facts.get(file)?.imports.get(m[1]!);
    const module = imported && moduleFile(file, imported.member ? submodule(imported.module, imported.member) : imported.module);
    return module ? routerAt(module, m[2]) : undefined;
  };

  // Each include, keyed by the router it takes in.
  const includes = new Map<string, Array<Facts["includes"][number] & { parent: string | undefined; file: string }>>();
  const unresolved: string[] = [];
  for (const [file, f] of facts) {
    for (const inc of f.includes) {
      const child = included(file, inc.target, inc.at);
      // A mount of anything else (StaticFiles, an application made elsewhere) is the route reader's to say.
      if (!child) {
        if (inc.verb === "includes") unresolved.push(`${file}:${lineOf(texts.get(file)!, inc.at)} includes ${inc.target}, which atlas does not trace to an APIRouter of the route files`);
        continue;
      }
      (includes.get(child) ?? includes.set(child, []).get(child)!).push({ ...inc, parent: receiver(file, inc.receiver, inc.at), file });
    }
  }

  const name = (key: string) => key.slice(key.lastIndexOf("#") + 1);
  const fileOf = (key: string) => key.slice(0, key.lastIndexOf("#"));
  const said = (key: string) => `${name(key)} in ${fileOf(key)}`;
  const own = (v: Value) => (typeof v === "string" ? v : undefined);
  // Why a router is not read, by cause: the router the cause is about, if any, and the routers it leaves unread.
  const causes = new Map<string, { about?: string; routers: Set<string> }>();
  type Served = { paths: string[] } | { why: string; about?: string };
  const servedAt = (key: string, seen: Set<string>): Served => {
    const binding = facts.get(fileOf(key))?.routers.get(name(key));
    if (!binding) return { why: `${fileOf(key)} binds ${name(key)} to more than one router`, about: key };
    const all = includes.get(key);
    // An application serves at the root, unless another one mounts it.
    if (binding.kind === "app" && !all?.length) return { paths: [""] };
    if (declared[fileOf(key)] !== undefined) return { paths: [joinRoute(declared[fileOf(key)]!)] };
    const prefix = own(binding.prefix);
    if (prefix === undefined) return { why: `${said(key)} has a prefix the file does not spell out (${(binding.prefix as { unread: string }).unread})`, about: key };
    if (!all?.length) return { why: `${said(key)} is included nowhere in the route files`, about: key };
    if (seen.has(key)) return { why: `${said(key)} is included into itself`, about: key };
    const out: string[] = [];
    for (const inc of all) {
      const where = `${inc.file}:${lineOf(texts.get(inc.file)!, inc.at)}`;
      const at = own(inc.prefix);
      if (at === undefined) return { why: `${where} ${inc.verb} ${inc.target} ${inc.verb === "includes" ? "with a prefix" : "at a path"} the file does not spell out (${(inc.prefix as { unread: string }).unread})` };
      if (!inc.parent) return { why: `${where} ${inc.verb} ${inc.target} ${inc.verb === "includes" ? "into" : "on"} ${inc.receiver}, which atlas does not trace to an application or APIRouter` };
      const above = servedAt(inc.parent, new Set([...seen, key]));
      if ("why" in above) return above;
      for (const p of above.paths) out.push(joinRoute(p, at, prefix));
    }
    return { paths: [...new Set(out)] };
  };

  /** The include steps above a router: none for an application nothing mounts. */
  const chainOf = (key: string, seen: Set<string>): Array<{ router: string; at: number }> | undefined => {
    const binding = facts.get(fileOf(key))?.routers.get(name(key));
    const all = includes.get(key);
    if (!binding || seen.has(key) || declared[fileOf(key)] !== undefined) return undefined;
    if (binding.kind === "app" && !all?.length) return [];
    if (all?.length !== 1 || !all[0]!.parent) return undefined;
    const inc = all[0]!;
    const above = chainOf(inc.parent!, new Set([...seen, key]));
    return above && [...above, { router: `${inc.parent} ${inc.file}@${scopeAt(facts.get(inc.file)!.scopes, inc.at)}`, at: placeOf(facts.get(inc.file)!.code, inc.at) }];
  };
  /** The `redirect_slashes` of the application whose router a router's routes are copied into, or that it is. */
  const redirectsOf = (key: string, seen: Set<string>): boolean | null | undefined => {
    const binding = facts.get(fileOf(key))?.routers.get(name(key));
    if (!binding || seen.has(key)) return undefined;
    if (binding.kind === "app") return binding.redirects;
    // An included router's routes are the router of what includes it; a mounted one is its own router.
    const all = includes.get(key) ?? [];
    const values = all.map((inc) => (inc.verb === "mounts" ? binding.redirects : inc.parent ? redirectsOf(inc.parent, new Set([...seen, key])) : undefined));
    return values.length && values.every((v) => v !== undefined && v === values[0]) ? values[0] : undefined;
  };

  return {
    receiver,
    order: (key, file, at) => {
      const chain = chainOf(key, new Set());
      const f = facts.get(file);
      return chain && f && [...chain, { router: `${key} ${file}@${scopeAt(f.scopes, at)}`, at: placeOf(f.code, at) }];
    },
    redirects: (key) => redirectsOf(key, new Set()) ?? undefined,
    traced: (file, expr, at) => included(file, expr, at) !== undefined,
    served: (key) => {
      const s = servedAt(key, new Set());
      if ("paths" in s) return s.paths;
      const cause = causes.get(s.why) ?? causes.set(s.why, { about: s.about, routers: new Set() }).get(s.why)!;
      cause.routers.add(key);
      return undefined;
    },
    limits: (component) => [
      ...[...causes].map(([why, { about, routers }]) => {
        const others = [...routers].filter((r) => r !== about).map((r) => `${fileOf(r)} (${name(r)})`);
        const whose = !others.length ? "its routes are" : `${about && routers.has(about) ? "its routes and those of" : "the routes of"} ${others.join(", ")} are`;
        return `routes ${component}: ${why}; ${whose} not read (declare where it is served in mounts)`;
      }),
      ...unresolved.map((u) => `routes ${component}: ${u}`),
    ],
  };
}
