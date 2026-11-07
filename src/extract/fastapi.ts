import { posix } from "node:path";
import { joinRoute } from "../paths.js";
import { lineOf } from "../source.js";
import { pythonArg, pythonArgStarts, pythonCode, pythonStrings } from "./routes.js";

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
  /** What the name a decorator is written on refers to in a file: a router or an application (`file#name`), or none. */
  receiver(file: string, name: string): string | undefined;
  /** The paths a router's routes are served under, its own prefix included ("" for an application); undefined when not read. */
  served(key: string): string[] | undefined;
  /** Whether an expression a file mounts (`app.mount("/v1", sub)`) is an application or router of the files read. */
  traced(file: string, expr: string): boolean;
  /** Why the routers asked about were not read, one line per cause. */
  limits(component: string): string[];
}

/** A literal, or the expression text where the file does not spell the value out. */
type Value = string | { unread: string };

interface Binding {
  kind: "app" | "router";
  prefix: Value;
}

interface Facts {
  /** Names bound to `FastAPI(...)` or `APIRouter(...)`; null where the file binds a name to several different ones. */
  routers: Map<string, Binding | null>;
  /** Names imported: the module as written (dots kept) and, for `from m import x`, the name taken. */
  imports: Map<string, { module: string; member?: string }>;
  /** `include_router` calls, and `mount` calls, which serve what they mount under their path as an include does. */
  includes: Array<{ receiver: string; target: string; prefix: Value; at: number; verb: "includes" | "mounts" }>;
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

function factsOf(text: string): Facts {
  const code = pythonCode(text);
  const facts: Facts = { routers: new Map(), imports: new Map(), includes: [] };
  // `app = FastAPI(...)`, `router: APIRouter = fastapi.APIRouter(prefix="/items")`, at any indentation.
  for (const m of code.matchAll(/^[ \t]*([A-Za-z_]\w*)[ \t]*(?::[^=\n]+)?=[ \t]*(?:[A-Za-z_][\w.]*\.)?(FastAPI|APIRouter)[ \t]*\(/gm)) {
    const name = m[1]!;
    const binding: Binding = { kind: m[2] === "FastAPI" ? "app" : "router", prefix: m[2] === "FastAPI" ? "" : keyword(text, code, (m.index ?? 0) + m[0].length, "prefix") };
    const before = facts.routers.get(name);
    const same = before && before.kind === binding.kind && JSON.stringify(before.prefix) === JSON.stringify(binding.prefix);
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
  /** The router an `include_router` argument names: `router`, `utils_router` or `items.router` of an imported module. */
  const included = (file: string, expr: string): string | undefined => {
    const m = /^([A-Za-z_]\w*)(?:\.([A-Za-z_]\w*))?$/.exec(expr);
    if (!m) return undefined;
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
      const child = included(file, inc.target);
      // A mount of anything else (StaticFiles, an application made elsewhere) is the route reader's to say.
      if (!child) {
        if (inc.verb === "includes") unresolved.push(`${file}:${lineOf(texts.get(file)!, inc.at)} includes ${inc.target}, which atlas does not trace to an APIRouter of the route files`);
        continue;
      }
      (includes.get(child) ?? includes.set(child, []).get(child)!).push({ ...inc, parent: routerAt(file, inc.receiver), file });
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

  return {
    receiver: (file, n) => routerAt(file, n),
    traced: (file, expr) => included(file, expr) !== undefined,
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
