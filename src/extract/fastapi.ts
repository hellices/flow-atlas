import { joinRoute } from "../paths.js";
import { lineOf } from "../source.js";
import { booleanKeyword, keyword, pythonBindings, pythonImports, scopeAt, scopesOf, shadowed, valueAt, type Imports, type Scope, type Value } from "./python.js";
import { pythonArg, pythonArgStarts, pythonCode } from "./routes.js";

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
  /** The applications a file creates, where (`at`), and the routes each serves by itself (see `documentation`). */
  applications(file: string): Array<{ key: string; at: number; routes: DocsRoute[] | { why: string } }>;
}

/** A route FastAPI serves by itself, with the setting that gives its path (`convention`). */
export interface DocsRoute {
  path: string;
  convention: string;
}

interface Binding {
  kind: "app" | "router";
  prefix: Value;
  /** Where `FastAPI(` is called, and the routes the application serves by itself. */
  at?: number;
  docs?: DocsRoute[] | { why: string };
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
  imports: Imports;
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

/**
 * A path setting of `FastAPI(...)`: its default where it is not given, null where it is `None`, the path where it is a
 * literal, and the expression where the file does not spell it out (or a `**` argument may give it).
 */
function pathSetting(text: string, code: string, from: number, name: string, fallback: string): string | null | { unread: string } {
  const starts = pythonArgStarts(code, from);
  for (const at of starts) {
    const m = new RegExp(`^${name}\\s*=(?!=)\\s*`).exec(code.slice(at));
    if (!m) continue;
    const v = valueAt(text, code, at + m[0].length);
    if (typeof v === "string") return v;
    return v.unread === "None" ? null : v;
  }
  const spread = starts.find((at) => code.startsWith("**", at));
  return spread === undefined ? fallback : { unread: pythonArg(text, code, spread).replace(/\s+/g, " ") };
}

/**
 * The routes an application serves by itself, which `FastAPI.setup()` adds when the application is made, before any
 * route of the code (fastapi/applications.py): the OpenAPI document at `openapi_url` (`/openapi.json`); where it is
 * set, the Swagger UI at `docs_url` (`/docs`) and its OAuth2 redirect at `swagger_ui_oauth2_redirect_url`
 * (`/docs/oauth2-redirect`), and ReDoc at `redoc_url` (`/redoc`). A setting that is `None` or empty turns its route off;
 * one the file does not spell out leaves them all unread, with why.
 */
function documentation(text: string, code: string, from: number): DocsRoute[] | { why: string } {
  const settings: Array<[string, string]> = [
    ["openapi_url", "/openapi.json"],
    ["docs_url", "/docs"],
    ["swagger_ui_oauth2_redirect_url", "/docs/oauth2-redirect"],
    ["redoc_url", "/redoc"],
  ];
  const value = new Map(settings.map(([name, fallback]) => [name, pathSetting(text, code, from, name, fallback)]));
  const unread = (name: string) => {
    const v = value.get(name);
    return v !== null && v !== undefined && (typeof v === "object" || (v !== "" && !v.startsWith("/")));
  };
  const on = (name: string) => !!value.get(name) && !unread(name);
  // Each setting counts only where the routes it gives are served: all of them behind openapi_url, the redirect behind
  // docs_url too.
  const needed = unread("openapi_url") ? ["openapi_url"] : !on("openapi_url") ? [] : ["docs_url", "redoc_url", ...(on("docs_url") || unread("docs_url") ? ["swagger_ui_oauth2_redirect_url"] : [])].filter(unread);
  if (needed.length) {
    return {
      why: needed.map((name) => { const v = value.get(name) as string | { unread: string }; return `${name} the file does not spell out as a path (${typeof v === "object" ? v.unread : JSON.stringify(v)})`; }).join(" and "),
    };
  }
  const out: DocsRoute[] = [];
  const add = (name: string) => out.push({ path: value.get(name) as string, convention: `fastapi ${name}` });
  if (!on("openapi_url")) return out;
  add("openapi_url");
  if (on("docs_url")) {
    add("docs_url");
    if (on("swagger_ui_oauth2_redirect_url")) add("swagger_ui_oauth2_redirect_url");
  }
  if (on("redoc_url")) add("redoc_url");
  return out;
}

/** `redirect_slashes` as given: on where it is not given (Starlette's `Router` default), null where not spelled out. */
const redirectsGiven = (given: boolean | undefined | null): boolean | null => (given === undefined ? true : given);

function factsOf(text: string): Facts {
  const code = pythonCode(text);
  // A name assigned an application or router in a function is the file's, as the routes registered on it are.
  const scopes = scopesOf(code, (assigned) => /^(?:[A-Za-z_][\w.]*\.)?(?:FastAPI|APIRouter)[ \t]*\(/.test(assigned));
  const facts: Facts = { routers: new Map(), imports: pythonImports(code), includes: [], scopes, code };
  // `app = FastAPI(...)`, `router: APIRouter = fastapi.APIRouter(prefix="/items")`, at any indentation.
  for (const m of code.matchAll(/^[ \t]*([A-Za-z_]\w*)[ \t]*(?::[^=\n]+)?=[ \t]*(?:[A-Za-z_][\w.]*\.)?(FastAPI|APIRouter)[ \t]*\(/gm)) {
    const name = m[1]!;
    const from = (m.index ?? 0) + m[0].length;
    const binding: Binding =
      m[2] === "FastAPI"
        ? { kind: "app", prefix: "", redirects: redirectsGiven(booleanKeyword(text, code, from, "redirect_slashes")), at: (m.index ?? 0) + m[0].search(/\S/), docs: documentation(text, code, from) }
        : { kind: "router", prefix: keyword(text, code, from, "prefix"), redirects: redirectsGiven(booleanKeyword(text, code, from, "redirect_slashes")) };
    const before = facts.routers.get(name);
    const same = before && before.kind === binding.kind && JSON.stringify(before.prefix) === JSON.stringify(binding.prefix) && before.redirects === binding.redirects;
    // An application made twice with other documentation settings (in two branches) serves routes one of them gives.
    if (same && JSON.stringify(before.docs) !== JSON.stringify(binding.docs)) before.docs = { why: "documentation settings that differ where the file makes it twice" };
    facts.routers.set(name, before === undefined ? binding : same ? before : null);
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

  const { bindingAt: routerAt, reference } = pythonBindings(new Map([...facts].map(([f, x]) => [f, x.imports])), (file, name) => !!facts.get(file)?.routers.has(name));
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
    return reference(file, expr);
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
    applications: (file) =>
      [...(facts.get(file)?.routers ?? [])].flatMap(([name, b]) => (b?.kind === "app" && b.docs && b.at !== undefined ? [{ key: `${file}#${name}`, at: b.at, routes: b.docs }] : [])),
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
