import ts from "typescript";
import { joinRoute } from "../paths.js";
import { declarationOf, resolveModule, unwrap } from "./binding.js";

/**
 * Where the routers of Express, @koa/router, Hono and Fastify are served. Each registers routes relative to the path it
 * is mounted at, so a router's routes are read only where every mount of it is known: a literal path, in a call that
 * names the router, held in the same file or required or imported from a relative module, or a mount the configuration
 * declares. A router mounted anywhere atlas cannot read is not placed at the root. An application serves at the root
 * where nothing mounts it.
 *
 * - Express: `Router()` from `express` (as `express.Router()`, a named import or a destructured require) is mounted with
 *   `use(path, router)`; an application (`express()`) mounted the same way is a sub-application, served under that path
 *   (expressjs.com/en/api.html#app.mountpath).
 * - @koa/router: a router (`new Router()` from `@koa/router` or `koa-router`) is mounted with `use(path?, r.routes())`
 *   on another router or a Koa application, and serves its routes under its own `prefix` (the constructor's option, or
 *   `prefix()`), which also comes before what is mounted on it (`_mountNestedRouter`, `register`). A prefix set more than
 *   once is applied differently by different versions (stacked before 15.1, replaced since), so it is not read.
 * - Hono: `new Hono()` from `hono`; `basePath(path)` gives the same routes another base path, and `route(path, app)`
 *   serves the routes of `app` under `path` joined to the base path of the instance it is called on (hono-base.js).
 * - Fastify: an instance (`Fastify()` from `fastify`) or a plugin, a function `register` hands an instance as its first
 *   parameter, which serves its routes under the `prefix` option of every `register` call that takes it in, joined to
 *   where the instance it is registered on is served (fastify.dev/docs/latest/Reference/Plugins, plugin-override.js).
 *   A plugin registered on the first parameter of a function no `register` call takes in is placed at the root, as the
 *   routes on that parameter are read when the configuration names it among the receivers.
 *
 * Routers are told apart by where they are created, not their names: a router is `<file>@<offset of its creation>`, and
 * a name that a closer scope binds to something else is not that router. `use`, `route` and `register` return the
 * instance they are called on, so a chain `Router().use(a).use("/b", b)` is that router, with each call a mount on it.
 */
export interface Mounts {
  /**
   * The router an expression in `file` is: a name for one defined there or imported, one created in place, or a chain
   * of calls on one that return it (`router.get(...).post(...)`); undefined when it is none.
   */
  routerOf(file: string, e: ts.Expression): string | undefined;
  /** The paths a router is served under, or undefined when they are not read. */
  prefixes(router: string): string[] | undefined;
  /** Why the paths of a router are not read, where `prefixes` gives none: "is mounted where ...". */
  why(router: string): string | undefined;
  /**
   * The exact paths @koa/router serves a route path a router registers at, its prefixes joined to it as text, or why
   * they are not known (see `koaJoined`).
   */
  koaPaths(router: string, path: string): { paths: string[] } | { why: string };
  /** The package a router is created from (`express`, `@koa/router`, `koa-router`, `hono` or a preset, `fastify`). */
  packageOf(router: string): string | undefined;
  /**
   * The files that package is resolved from: where the router is created, or for a Fastify plugin, where each
   * `Fastify()` instance it is registered under is; none for a plugin no traced instance takes in.
   */
  originsOf(router: string): string[];
  /**
   * Where `file` mounts `express.static`, which serves the files of a directory: the line and the paths it is mounted
   * at, undefined where a mount is not read.
   */
  statics(file: string): Array<{ line: number; paths: string[] | undefined }>;
  /**
   * How a router picks among the routes a request fits and treats a trailing `/` (see `Dispatch`), from its package and
   * the options the code gives literally: `picks` and `slashes` left out where they are not read.
   */
  dispatchOf(router: string): { picks?: "registration" | "find-my-way"; slashes?: "ignored" | "strict" };
  /**
   * The steps registration order places a router's routes under, from the application a request enters down to the
   * sequence `step` names for a registration on the router at `node` of `file`; undefined where the router is mounted
   * more than once or where it is not read.
   */
  orderOf(router: string, file: string, node: ts.Node): Array<{ router: string; at: number }> | undefined;
}

/** The start of the function a node is in, or -1 at a module's top level: registrations in one run in order. */
export function scopeOf(node: ts.Node): number {
  for (let n = node.parent; n; n = n.parent) if (ts.isFunctionLike(n)) return n.getStart();
  return -1;
}

type Kind = "express-router" | "express-app" | "koa-router" | "koa-app" | "hono" | "fastify" | "plugin";
/** Kinds served at the root where nothing mounts them. */
const APPLICATIONS = new Set<Kind>(["express-app", "koa-app", "hono", "fastify"]);
/** A literal, or why a value is not read. */
type Value = string | { why: string };

/**
 * Node's `http.METHODS`, lowercased: Express (router 2 `methods`, express `utils.methods`) and @koa/router
 * (`getAllHttpMethods`) give a router a method of each name, besides `all`. Which ones a Node version parses varies
 * (`query` is recent); a call to one it lacks throws, so code that makes it runs where it is there.
 */
const NODE_METHODS = [
  "acl", "bind", "checkout", "connect", "copy", "delete", "get", "head", "link", "lock", "m-search", "merge", "mkactivity",
  "mkcalendar", "mkcol", "move", "notify", "options", "patch", "post", "propfind", "proppatch", "purge", "put", "query",
  "rebind", "report", "search", "source", "subscribe", "trace", "unbind", "unlink", "unlock", "unsubscribe",
];
/**
 * The methods that register a route with the method of their name, by the package a router is created from: Express's
 * and @koa/router's above (with `del` for `delete` on @koa/router), Fastify's shorthands (fastify.js) and Hono's
 * (`METHODS` of hono/router). `all` registers every method. A Koa application registers no route itself.
 */
const VERBS: Record<string, ReadonlySet<string>> = {
  express: new Set([...NODE_METHODS, "all"]),
  "@koa/router": new Set([...NODE_METHODS, "all", "del"]),
  "koa-router": new Set([...NODE_METHODS, "all", "del"]),
  koa: new Set(),
  fastify: new Set(["delete", "get", "head", "trace", "patch", "post", "put", "options", "query", "all"]),
  hono: new Set(["get", "post", "put", "delete", "options", "patch", "query", "all"]),
};

/** The methods a router created from `pkg` registers routes with by name; Hono's presets (`hono/tiny`) share Hono's. */
export function verbsOf(pkg: string): ReadonlySet<string> {
  return VERBS[pkg.startsWith("hono/") ? "hono" : pkg] ?? new Set();
}

/**
 * Whether a call returns the instance it is called on, so that a chain of them is that instance: a route method, and
 * `use`, `param`, Hono's `route(path, app)`, Fastify's `register` and `route`, @koa/router's `prefix` and `redirect`
 * (router 2, @koa/router, hono-base.js, fastify.js). Express's `get(name)` with one argument reads a setting instead.
 */
function returnsSelf(kind: Kind, name: string, args: number): boolean {
  switch (kind) {
    case "express-app":
    case "express-router":
      return name === "use" || name === "param" || (VERBS.express!.has(name) && (name !== "get" || args > 1));
    case "koa-router":
      return ["use", "param", "prefix", "redirect"].includes(name) || VERBS["@koa/router"]!.has(name);
    case "koa-app":
      return name === "use";
    case "hono":
      return ["use", "on", "onError", "notFound", "mount"].includes(name) || (name === "route" && args === 2) || VERBS.hono!.has(name);
    case "fastify":
    case "plugin":
      return ["register", "route", "addHook", "setErrorHandler", "setNotFoundHandler", "decorate", "decorateRequest", "decorateReply", "addSchema"].includes(name) || VERBS.fastify!.has(name);
  }
}

const literal = (e: ts.Expression | undefined): string | undefined => {
  const u = e && unwrap(e);
  return u && (ts.isStringLiteral(u) || ts.isNoSubstitutionTemplateLiteral(u)) ? u.text : undefined;
};
const short = (n: ts.Node): string => {
  const text = n.getText().replace(/\s+/g, " ");
  return text.length > 80 ? `${text.slice(0, 77)}...` : text;
};

/** The module a `require("<spec>")` call names, or undefined for anything else. */
const required = (e: ts.Expression | undefined): string | undefined => {
  const u = e && unwrap(e);
  // CommonJS's require, not a function of that name the file declares.
  return u && ts.isCallExpression(u) && ts.isIdentifier(u.expression) && u.expression.text === "require" && !declarationOf(u.expression)
    ? literal(u.arguments[0])
    : undefined;
};

/** The module a binding imports or requires from, with the exported name it takes ("default", "*" for the whole module). */
function importOf(decl: ts.Node | undefined): { spec: string; name: string } | undefined {
  if (!decl) return undefined;
  if (ts.isImportClause(decl)) return { spec: (decl.parent.moduleSpecifier as ts.StringLiteral).text, name: "default" };
  if (ts.isNamespaceImport(decl)) return { spec: (decl.parent.parent.moduleSpecifier as ts.StringLiteral).text, name: "*" };
  if (ts.isImportSpecifier(decl)) return { spec: (decl.parent.parent.parent.moduleSpecifier as ts.StringLiteral).text, name: (decl.propertyName ?? decl.name).text };
  if (ts.isVariableDeclaration(decl)) {
    const init = decl.initializer && unwrap(decl.initializer);
    const whole = required(init);
    if (whole !== undefined) return { spec: whole, name: "default" };
    // `const r = require("./r").api`
    if (init && ts.isPropertyAccessExpression(init)) {
      const from = required(init.expression);
      if (from !== undefined) return { spec: from, name: init.name.text };
    }
  }
  if (ts.isBindingElement(decl) && ts.isObjectBindingPattern(decl.parent)) {
    const from = required(decl.parent.parent.kind === ts.SyntaxKind.VariableDeclaration ? decl.parent.parent.initializer : undefined);
    const key = decl.propertyName ?? decl.name;
    if (from !== undefined && ts.isIdentifier(key)) return { spec: from, name: key.text };
  }
  return undefined;
}

/** What a callee names of a package: `x` imported or required from it, or `m.x` of the whole module. */
function packageName(callee: ts.Expression): { spec: string; name: string } | undefined {
  const u = unwrap(callee);
  if (ts.isIdentifier(u)) return importOf(declarationOf(u));
  const whole = required(u);
  if (whole !== undefined) return { spec: whole, name: "default" };
  if (!ts.isPropertyAccessExpression(u)) return undefined;
  const target = unwrap(u.expression);
  const module = required(target);
  if (module !== undefined) return { spec: module, name: u.name.text };
  const from = ts.isIdentifier(target) ? importOf(declarationOf(target)) : undefined;
  return from && (from.name === "default" || from.name === "*") ? { spec: from.spec, name: u.name.text } : undefined;
}

/** A property's name as the object holds it: `prefix`, `"prefix"`, `["prefix"]`; null for a computed name not spelled out. */
function propertyKey(name: ts.PropertyName): string | null {
  if (ts.isComputedPropertyName(name)) return literal(name.expression) ?? null;
  return ts.isIdentifier(name) || ts.isStringLiteral(name) || ts.isNoSubstitutionTemplateLiteral(name) || ts.isNumericLiteral(name) || ts.isPrivateIdentifier(name) ? name.text : null;
}

/**
 * The `prefix` an options object gives: "" with none; unread where its value is not a literal, or where a computed name
 * the code does not spell out may be it. Of two properties of one name, the object holds the last.
 */
function prefixOption(o: ts.ObjectLiteralExpression, unread: (p: ts.Node) => Value): Value {
  for (const p of [...o.properties].reverse()) {
    const key = p.name ? propertyKey(p.name) : undefined;
    if (key === null) return unread(p);
    if (key !== "prefix") continue;
    return (ts.isPropertyAssignment(p) ? literal(p.initializer) : undefined) ?? unread(p);
  }
  return "";
}

/**
 * A boolean an options object gives at `path` (`["routerOptions", "ignoreTrailingSlash"]`): undefined where it gives
 * none, null where it is not spelled out (an object that is not a literal, a spread, a computed name, another value).
 */
function booleanOption(options: ts.Expression | undefined, path: string[]): boolean | undefined | null {
  if (!options) return undefined;
  const o = unwrap(options);
  if (!ts.isObjectLiteralExpression(o) || o.properties.some(ts.isSpreadAssignment)) return null;
  for (const p of [...o.properties].reverse()) {
    const key = p.name ? propertyKey(p.name) : undefined;
    if (key === null) return null;
    if (key !== path[0]) continue;
    if (!ts.isPropertyAssignment(p)) return null;
    if (path.length > 1) return booleanOption(p.initializer, path.slice(1));
    const v = unwrap(p.initializer);
    return v.kind === ts.SyntaxKind.TrueKeyword ? true : v.kind === ts.SyntaxKind.FalseKeyword ? false : null;
  }
  return undefined;
}

/** The `prefix` an @koa/router constructor's options give: "" with none, unread where not spelled out. */
function koaPrefix(options: ts.Expression | undefined): Value {
  const u = options && unwrap(options);
  if (!u) return "";
  if (!ts.isObjectLiteralExpression(u) || u.properties.some(ts.isSpreadAssignment)) return { why: `has options the code does not spell out (${short(u)})` };
  return prefixOption(u, (p) => ({ why: `has a prefix the code does not spell out (${short(p)})` }));
}

/**
 * What an expression creates: an Express, @koa/router, Koa, Hono or Fastify router or application, with its own prefix
 * and the package it is created from.
 */
function creation(e: ts.Expression): { kind: Kind; own: Value; pkg: string; options?: ts.Expression } | undefined {
  const u = unwrap(e);
  if (!ts.isCallExpression(u) && !ts.isNewExpression(u)) return undefined;
  const from = packageName(u.expression);
  if (!from) return undefined;
  const { spec, name } = from;
  const made = ts.isNewExpression(u);
  const options = u.arguments?.[0];
  const made2 = (m: { kind: Kind; own: Value; pkg: string } | undefined) => (m && options ? { ...m, options } : m);
  return made2(created(spec, name, made, u));
}

function created(spec: string, name: string, made: boolean, u: ts.CallExpression | ts.NewExpression): { kind: Kind; own: Value; pkg: string } | undefined {
  if (spec === "express") return name === "Router" ? { kind: "express-router", own: "", pkg: spec } : name === "default" && !made ? { kind: "express-app", own: "", pkg: spec } : undefined;
  if (spec === "@koa/router" || spec === "koa-router") return name === "default" || name === "Router" ? { kind: "koa-router", own: koaPrefix(u.arguments?.[0]), pkg: spec } : undefined;
  if (spec === "koa") return made && (name === "default" || name === "Koa") ? { kind: "koa-app", own: "", pkg: spec } : undefined;
  if ((spec === "hono" || spec.startsWith("hono/")) && made && name === "Hono") return { kind: "hono", own: "", pkg: spec };
  if (spec === "fastify" && !made && ["default", "fastify", "Fastify"].includes(name)) return { kind: "fastify", own: "", pkg: spec };
  return undefined;
}

/** A method call: its name, receiver and arguments; `x["use"](...)` is the same call as `x.use(...)`. */
function methodCall(node: ts.Node): { name: string; receiver: ts.Expression; args: readonly ts.Expression[] } | undefined {
  if (!ts.isCallExpression(node)) return undefined;
  const callee = unwrap(node.expression);
  if (ts.isPropertyAccessExpression(callee)) return { name: callee.name.text, receiver: callee.expression, args: node.arguments };
  const name = ts.isElementAccessExpression(callee) ? literal(callee.argumentExpression) : undefined;
  return name !== undefined && ts.isElementAccessExpression(callee) ? { name, receiver: callee.expression, args: node.arguments } : undefined;
}

/** Whether an expression calls express's static middleware: `express.static(dir)`, or `static` imported from express. */
function servesStatic(e: ts.Expression): boolean {
  const u = unwrap(e);
  if (!ts.isCallExpression(u)) return false;
  const from = packageName(u.expression);
  return from?.spec === "express" && from.name === "static";
}

/** The router a Koa `use` argument hands over: `r` of `r.routes()` or `r.middleware()`. */
function koaRoutes(e: ts.Expression): ts.Expression | undefined {
  const call = methodCall(unwrap(e));
  return call && !call.args.length && (call.name === "routes" || call.name === "middleware") ? call.receiver : undefined;
}

interface Mount {
  verb: "use" | "route" | "register";
  receiver: ts.Expression;
  /** The path or prefix: undefined where the code gives no literal one, why where that is worth saying. */
  path: Value | undefined;
  target: ts.Expression;
  /** Koa's `use(r.routes())`: the target is the router whose routes are handed over. */
  routes?: true;
  /** The path is written in the call, not the receiver's own one taken where none is (`use(r.routes())`). */
  explicit?: true;
  /** Where the call is, and the start of the function it is in (`scopeOf`). */
  at: number;
  scope: number;
}

interface FileFacts {
  sf: ts.SourceFile;
  /** What the module exports, by exported name: a node of the file, or a name another module exports. */
  exports: Map<string, ts.Node | { spec: string; name: string }>;
  /** Modules re-exported whole (`export * from "./routes"`). */
  stars: string[];
  /** The calls that mount a router, an application or a plugin, with the path they give. */
  mounts: Mount[];
  /** `prefix(path)` calls, which set an @koa/router router's prefix. */
  prefixes: Array<{ receiver: ts.Expression; value: Value }>;
  /** Where `express.static` is mounted. */
  statics: Array<{ receiver: ts.Expression; path: string | undefined; line: number }>;
  /** Express's `set`, `enable` and `disable` of `strict routing`: whether it is turned on, null where not spelled out. */
  strict: Array<{ receiver: ts.Expression; on: boolean | null }>;
}

function factsOf(text: string, file: string): FileFacts {
  const sf = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true, /x$/.test(file) ? ts.ScriptKind.TSX : ts.ScriptKind.TS);
  const facts: FileFacts = { sf, exports: new Map(), stars: [], mounts: [], prefixes: [], statics: [], strict: [] };
  const modifier = (n: ts.Node, kind: ts.SyntaxKind): boolean => ts.canHaveModifiers(n) && !!ts.getModifiers(n)?.some((m) => m.kind === kind);
  const exported = (n: ts.Node): boolean => modifier(n, ts.SyntaxKind.ExportKeyword);
  const visit = (node: ts.Node): void => {
    if (ts.isVariableStatement(node) && exported(node)) {
      for (const d of node.declarationList.declarations) if (ts.isIdentifier(d.name)) facts.exports.set(d.name.text, d.name);
    }
    // `export function plugin(fastify)`, `export default async function (fastify)`.
    if (ts.isFunctionDeclaration(node) && exported(node)) {
      if (modifier(node, ts.SyntaxKind.DefaultKeyword)) facts.exports.set("default", node);
      else if (node.name) facts.exports.set(node.name.text, node);
    }
    if (ts.isExportAssignment(node) && !node.isExportEquals) facts.exports.set("default", unwrap(node.expression));
    if (ts.isExportDeclaration(node) && !node.exportClause && node.moduleSpecifier && ts.isStringLiteral(node.moduleSpecifier)) facts.stars.push(node.moduleSpecifier.text);
    if (ts.isExportDeclaration(node) && node.exportClause && ts.isNamedExports(node.exportClause)) {
      for (const el of node.exportClause.elements) {
        const local = el.propertyName ?? el.name;
        if (node.moduleSpecifier && ts.isStringLiteral(node.moduleSpecifier)) facts.exports.set(el.name.text, { spec: node.moduleSpecifier.text, name: local.text });
        else if (ts.isIdentifier(local)) facts.exports.set(el.name.text, local);
      }
    }
    if (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.EqualsToken) {
      const left = node.left.getText(sf);
      const right = unwrap(node.right);
      const named = /^(?:module\.)?exports\.(\w+)$/.exec(left);
      if (left === "module.exports" && !ts.isObjectLiteralExpression(right)) facts.exports.set("default", right);
      if (named) facts.exports.set(named[1]!, right);
      // `module.exports = { router, api: apiRouter }` exports each name a property holds.
      if (left === "module.exports" && ts.isObjectLiteralExpression(right)) {
        for (const p of right.properties) {
          if (ts.isShorthandPropertyAssignment(p)) facts.exports.set(p.name.text, p.name);
          if (!ts.isPropertyAssignment(p)) continue;
          const value = unwrap(p.initializer);
          if (ts.isIdentifier(value) && (ts.isIdentifier(p.name) || ts.isStringLiteral(p.name))) facts.exports.set(p.name.text, value);
        }
      }
    }
    const call = methodCall(node);
    // A call's place is where its method is named: in a chain `app.use(a).use(b)` every call starts at `app`.
    const callee = ts.isCallExpression(node) ? unwrap(node.expression) : undefined;
    const named = callee && ts.isPropertyAccessExpression(callee) ? callee.name : callee && ts.isElementAccessExpression(callee) ? callee.argumentExpression : node;
    const where = { at: named.getStart(sf), scope: scopeOf(node) };
    if (call && ["set", "enable", "disable"].includes(call.name) && literal(call.args[0]) === "strict routing") {
      const value = call.name === "set" ? unwrap(call.args[1] ?? call.args[0]!) : undefined;
      const on = call.name === "enable" ? true : call.name === "disable" ? false : value?.kind === ts.SyntaxKind.TrueKeyword ? true : value?.kind === ts.SyntaxKind.FalseKeyword ? false : null;
      facts.strict.push({ receiver: unwrap(call.receiver), on });
    }
    if (call?.name === "use") {
      const { args, receiver } = call;
      const first = args[0] && unwrap(args[0]);
      const path = literal(first);
      // `use(fn, ...)` mounts at the receiver's own path; an inline function first shows that overload for certain.
      const pathless = first && (ts.isArrowFunction(first) || ts.isFunctionExpression(first));
      for (const arg of args) {
        const target = unwrap(arg);
        const at = path ?? (pathless || target === first ? "/" : undefined);
        if (servesStatic(target)) {
          const line = sf.getLineAndCharacterOfPosition(node.getStart(sf)).line + 1;
          facts.statics.push({ receiver: unwrap(receiver), path: at, line });
          continue;
        }
        const koa = koaRoutes(target);
        if (koa) facts.mounts.push({ verb: "use", receiver: unwrap(receiver), path: at, target: koa, routes: true, ...(path !== undefined ? { explicit: true as const } : {}), ...where });
        else if (target !== first || path === undefined) facts.mounts.push({ verb: "use", receiver: unwrap(receiver), path: at, target, ...where });
      }
    }
    // Hono's `route(path, app)`; Express's `route(path)` takes one argument and mounts nothing.
    if (call?.name === "route" && call.args.length === 2) facts.mounts.push({ verb: "route", receiver: unwrap(call.receiver), path: literal(call.args[0]), target: unwrap(call.args[1]!), ...where });
    // Fastify's `register(plugin, { prefix })`: no options, or none named prefix, adds none.
    if (call?.name === "register" && call.args.length >= 1 && call.args.length <= 2) {
      const options = call.args[1] && unwrap(call.args[1]);
      let path: Value = "";
      if (options && (!ts.isObjectLiteralExpression(options) || options.properties.some(ts.isSpreadAssignment))) path = { why: `is registered with options the code does not spell out (${short(options)})` };
      else if (options) path = prefixOption(options, (p) => ({ why: `is registered with a prefix the code does not spell out (${short(p)})` }));
      facts.mounts.push({ verb: "register", receiver: unwrap(call.receiver), path, target: unwrap(call.args[0]!), ...where });
    }
    if (call?.name === "prefix" && call.args.length === 1) {
      facts.prefixes.push({ receiver: unwrap(call.receiver), value: literal(call.args[0]) ?? { why: `has a prefix the code does not spell out (${short(call.args[0]!)})` } });
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  return facts;
}

/**
 * The routers of the script files read: `texts` by file; `declared`, the path a router file is served under where the
 * code does not say it (`mounts`); `receivers`, the names whose routes are read at the root when no router is traced.
 */
export function expressMounts(texts: Map<string, string>, declared: Record<string, string> = {}, receivers: string[] = []): Mounts {
  const facts = new Map([...texts].map(([file, text]) => [file, factsOf(text, file)]));
  const resolve = (from: string, spec: string) => resolveModule(from, spec, (f) => facts.has(f));

  type At<T> = (file: string, e: ts.Node, seen: Set<string>) => T | undefined;
  /** What `at` finds for the name a module exports, following re-exports through relative modules. */
  const exported = <T>(file: string, name: string, seen: Set<string>, at: At<T>): T | undefined => {
    const key = `${file}#${name}`;
    const f = facts.get(file);
    if (!f || seen.has(key)) return undefined;
    const e = f.exports.get(name);
    if (!e) {
      // A name a module does not export itself may come through its `export *`; `default` never does.
      if (name === "default") return undefined;
      for (const spec of f.stars) {
        const target = resolve(file, spec);
        const found = target ? exported(target, name, new Set([...seen, key]), at) : undefined;
        if (found !== undefined) return found;
      }
      return undefined;
    }
    if (!("kind" in e)) {
      const target = resolve(file, e.spec);
      return target ? exported(target, e.name, new Set([...seen, key]), at) : undefined;
    }
    return at(file, e, new Set([...seen, key]));
  };
  /** What `at` finds for the binding a name imports from a relative module. */
  const imported = <T>(file: string, id: ts.Identifier, seen: Set<string>, at: At<T>): T | undefined => {
    const from = importOf(declarationOf(id));
    if (!from || from.name === "*") return undefined;
    const target = resolve(file, from.spec);
    return target ? exported(target, from.name, seen, at) : undefined;
  };
  /** What `at` finds for a module's export taken from the whole module: `import * as routes` or `const routes = require(...)`. */
  const member = <T>(file: string, access: ts.PropertyAccessExpression, at: At<T>): T | undefined => {
    if (!ts.isIdentifier(access.expression)) return undefined;
    const decl = declarationOf(access.expression);
    const spec =
      decl && ts.isNamespaceImport(decl)
        ? (decl.parent.parent.moduleSpecifier as ts.StringLiteral).text
        : decl && ts.isVariableDeclaration(decl)
          ? required(decl.initializer)
          : undefined;
    const target = spec === undefined ? undefined : resolve(file, spec);
    return target ? exported(target, access.name.text, new Set(), at) : undefined;
  };

  /** The routers, applications and plugins found, by key, with what they are and the prefix they set themselves. */
  const stores = new Map<string, { kind: Kind; own: Value; pkg: string; options?: ts.Expression }>();
  /** Hono's `basePath(path)`: the routes of the instance it is called on, under another base path. */
  const based = new Map<string, { parent: string; path: Value }>();
  /** The functions `register` takes in as Fastify plugins. */
  const plugins = new Set<string>();
  const kindOf = (handle: string): Kind | undefined => stores.get(handle)?.kind ?? (based.has(handle) ? kindOf(based.get(handle)!.parent) : undefined);

  /** The router, application or plugin an expression is: created in place, held in a name, or imported. */
  const handleAt: At<string> = (file, node, seen) => {
    if (ts.isFunctionDeclaration(node)) return undefined;
    const e = unwrap(node as ts.Expression);
    const call = methodCall(e);
    if (call?.name === "basePath" && call.args.length === 1) {
      const parent = handleAt(file, call.receiver, seen);
      if (!parent || kindOf(parent) !== "hono") return undefined;
      const key = `${file}@${e.getStart()}:${e.getEnd()}`;
      based.set(key, { parent, path: literal(call.args[0]) ?? { why: `has a base path the code does not spell out (${short(call.args[0]!)})` } });
      return key;
    }
    // A call on a router that returns the router it is called on; any other call on one is not that router.
    const on = call ? handleAt(file, call.receiver, seen) : undefined;
    if (call && on) {
      const kind = kindOf(on);
      return kind && returnsSelf(kind, call.name, call.args.length) ? on : undefined;
    }
    const made = creation(e);
    if (made) {
      const key = `${file}@${e.getStart()}`;
      stores.set(key, made);
      return key;
    }
    if (ts.isPropertyAccessExpression(e)) return member(file, e, handleAt);
    if (!ts.isIdentifier(e)) return undefined;
    const decl = declarationOf(e);
    if (!decl) return undefined;
    const key = `${file}@${e.getStart()}`;
    if (seen.has(key)) return undefined;
    const inner = new Set([...seen, key]);
    if (ts.isVariableDeclaration(decl) && ts.isIdentifier(decl.name) && decl.initializer) {
      const init = unwrap(decl.initializer);
      // `const api = router` names the same router; a `let` may be given another later.
      if (!ts.isIdentifier(init) || decl.parent.flags & ts.NodeFlags.Const) {
        const own = handleAt(file, init, inner);
        if (own) return own;
      }
    }
    if (ts.isParameter(decl) && ts.isFunctionLike(decl.parent) && decl.parent.parameters[0] === decl) {
      const fn = `${file}@${decl.parent.getStart()}`;
      if (plugins.has(fn)) return fn;
    }
    return imported(file, e, inner, handleAt);
  };

  /** The function an expression is, as `register` takes it in: in place, held in a name, required or imported. */
  const functionAt: At<string> = (file, node, seen) => {
    if (ts.isFunctionDeclaration(node)) return node.body ? `${file}@${node.getStart()}` : undefined;
    const e = unwrap(node as ts.Expression);
    if (ts.isArrowFunction(e) || ts.isFunctionExpression(e)) return `${file}@${e.getStart()}`;
    const spec = required(e);
    if (spec !== undefined) {
      const target = resolve(file, spec);
      return target ? exported(target, "default", seen, functionAt) : undefined;
    }
    if (ts.isPropertyAccessExpression(e)) return member(file, e, functionAt);
    if (!ts.isIdentifier(e)) return undefined;
    const key = `${file}@${e.getStart()}`;
    if (seen.has(key)) return undefined;
    const inner = new Set([...seen, key]);
    const decl = declarationOf(e);
    if (decl && ts.isFunctionDeclaration(decl)) return functionAt(file, decl, inner);
    if (decl && ts.isVariableDeclaration(decl) && decl.initializer && decl.parent.flags & ts.NodeFlags.Const) {
      const own = functionAt(file, decl.initializer, inner);
      if (own) return own;
    }
    return imported(file, e, inner, functionAt);
  };

  /** Where the first parameter of a function no `register` takes in is the receiver of a call. */
  const untracedPlugin = (receiver: ts.Expression): boolean => {
    if (!ts.isIdentifier(receiver) || !receivers.includes(receiver.text)) return false;
    const decl = declarationOf(receiver);
    return !!decl && ts.isParameter(decl) && ts.isFunctionLike(decl.parent) && decl.parent.parameters[0] === decl;
  };

  // The plugins first: a plugin's parameter is an instance only once a `register` takes the plugin in, which may be
  // known only through another plugin.
  for (let grew = true; grew; ) {
    grew = false;
    for (const [file, f] of facts) {
      for (const m of f.mounts) {
        if (m.verb !== "register") continue;
        const parent = handleAt(file, m.receiver, new Set());
        const kind = parent ? kindOf(parent) : undefined;
        if (kind !== "fastify" && kind !== "plugin" && !(parent === undefined && untracedPlugin(m.receiver))) continue;
        const fn = functionAt(file, m.target, new Set());
        if (fn && !plugins.has(fn)) {
          plugins.add(fn);
          stores.set(fn, { kind: "plugin", own: "", pkg: "fastify" });
          grew = true;
        }
      }
    }
  }

  const ROOT = "";
  // Each mount, keyed by what it serves; the parent is the instance it is mounted on, ROOT for the root.
  type Placed = { parent: string; path: Value | undefined; explicit?: true; file: string; at: number; scope: number };
  const mounts = new Map<string, Placed[]>();
  const mount = (child: string, parent: string, path: Value | undefined, m: Mount, file: string) =>
    (mounts.get(child) ?? mounts.set(child, []).get(child)!).push({ parent, path, ...(m.explicit ? { explicit: m.explicit } : {}), file, at: m.at, scope: m.scope });
  /** The instance a handle registers its routes in: Hono's `basePath` shares the routes of the one it is called on. */
  const storeOf = (handle: string): string => (based.has(handle) ? storeOf(based.get(handle)!.parent) : handle);
  for (const [file, f] of facts) {
    for (const m of f.mounts) {
      const parent = handleAt(file, m.receiver, new Set());
      const above = parent ? kindOf(parent) : undefined;
      if (m.verb === "register") {
        const fn = functionAt(file, m.target, new Set());
        if (fn && plugins.has(fn) && (above === "fastify" || above === "plugin")) mount(fn, parent!, m.path, m, file);
        else if (fn && plugins.has(fn) && parent === undefined && untracedPlugin(m.receiver)) mount(fn, ROOT, m.path, m, file);
        continue;
      }
      const child = handleAt(file, m.target, new Set());
      const kind = child ? kindOf(child) : undefined;
      if (!parent || !child || !kind) continue;
      const express = (k: Kind | undefined) => k === "express-app" || k === "express-router";
      const koa = (k: Kind | undefined) => k === "koa-app" || k === "koa-router";
      // Each framework mounts its own kind: an Express router or application with `use`, an @koa/router router's
      // `routes()` with `use`, a Hono application with `route`.
      const fits =
        (m.verb === "use" && express(above) && express(kind) && !m.routes) ||
        (m.verb === "use" && koa(above) && kind === "koa-router" && m.routes) ||
        (m.verb === "route" && above === "hono" && kind === "hono");
      if (fits) mount(storeOf(child), parent, m.path, m, file);
    }
  }
  // An @koa/router router's prefix: the constructor's option or a `prefix()` call, read where it is set once.
  const koaPrefixes = new Map<string, Value[]>();
  for (const [file, f] of facts) {
    for (const p of f.prefixes) {
      const handle = handleAt(file, p.receiver, new Set());
      if (handle && kindOf(handle) === "koa-router") (koaPrefixes.get(handle) ?? koaPrefixes.set(handle, []).get(handle)!).push(p.value);
    }
  }
  const MOUNTED = "is mounted where the code gives no literal path";
  /**
   * @koa/router's exact paths for a route path a router registers, joined as its `Layer._applyPrefix` does: the text of
   * each prefix put before the path (a path of `/` alone being replaced by it), first the router's own (the
   * constructor's `prefix` as written, `prefix()`'s without a final `/`), then, up each `use(path, r.routes())` that
   * nests it, the path written there (`_mountNestedRouter`; none written, none put) and that router's own prefix, to
   * the Koa application, which puts none.
   */
  const koaJoined = (handle: string, path: string, seen: Set<string>): { paths: string[] } | { why: string } => {
    if (stores.get(handle)?.kind === "koa-app") return { paths: [path] };
    const file = handle.slice(0, handle.lastIndexOf("@"));
    if (declared[file] !== undefined) return { why: "is served under a path the configuration declares, which @koa/router would join to it as text" };
    const own = stores.get(handle)?.own ?? "";
    const set = [...(own === "" ? [] : [own]), ...(koaPrefixes.get(handle) ?? []).map((v) => (typeof v === "string" ? v.replace(/\/$/, "") : v))];
    if (set.length > 1) return { why: "has its prefix set more than once, which @koa/router applies differently by version (stacked before 15.1, replaced since)" };
    const prefix = set[0] ?? "";
    if (typeof prefix !== "string") return prefix;
    const apply = (p: string, before: string) => (before ? (p === "/" ? before : `${before}${p}`) : p);
    const joined = apply(path, prefix);
    const all = mounts.get(handle);
    if (!all?.length || seen.has(handle)) return { why: MOUNTED };
    const out: string[] = [];
    for (const m of all) {
      if (m.parent === ROOT || m.path === undefined || typeof m.path !== "string") return { why: MOUNTED };
      const kind = stores.get(m.parent)?.kind;
      if (kind !== "koa-router" && kind !== "koa-app") return { why: MOUNTED };
      const above = koaJoined(m.parent, apply(joined, m.explicit ? m.path : ""), new Set([...seen, handle]));
      if ("why" in above) return above;
      out.push(...above.paths);
    }
    return { paths: [...new Set(out)] };
  };
  const ownOf = (store: string): Value => {
    const own = stores.get(store)?.own ?? "";
    const set = [...(own === "" ? [] : [own]), ...(koaPrefixes.get(store) ?? [])];
    if (set.length > 1) return { why: "has its prefix set more than once, which @koa/router applies differently by version (stacked before 15.1, replaced since)" };
    return set[0] ?? "";
  };

  type Served = { paths: string[] } | { why: string };
  const served = (handle: string, seen: Set<string>): Served => {
    const base = based.get(handle);
    if (base) {
      // A base path the code does not spell out is the one `mounts` declares for the file, where it declares one.
      if (typeof base.path !== "string") {
        const file = handle.slice(0, handle.lastIndexOf("@"));
        return declared[file] !== undefined ? { paths: [joinRoute(declared[file])] } : { why: base.path.why };
      }
      const above = served(base.parent, seen);
      return "why" in above ? above : { paths: [...new Set(above.paths.map((p) => joinRoute(p, base.path as string)))] };
    }
    const file = handle.slice(0, handle.lastIndexOf("@"));
    if (declared[file] !== undefined) return { paths: [joinRoute(declared[file])] };
    const own = ownOf(handle);
    if (typeof own !== "string") return own;
    const all = mounts.get(handle);
    if (!all?.length) return APPLICATIONS.has(stores.get(handle)?.kind as Kind) ? { paths: [joinRoute(own)] } : { why: MOUNTED };
    if (seen.has(handle)) return { why: MOUNTED };
    const out: string[] = [];
    for (const m of all) {
      if (m.path === undefined) return { why: MOUNTED };
      if (typeof m.path !== "string") return { why: m.path.why };
      const above = m.parent === ROOT ? { paths: ["/"] } : served(m.parent, new Set([...seen, handle]));
      if ("why" in above) return { why: MOUNTED };
      for (const p of above.paths) out.push(joinRoute(p, m.path, own));
    }
    return { paths: [...new Set(out)] };
  };
  const prefixes = (handle: string): string[] | undefined => {
    const s = served(handle, new Set());
    return "paths" in s ? s.paths : undefined;
  };
  /** The applications a router's requests enter by: itself where nothing mounts it; undefined where a mount is not traced. */
  const rootsOf = (handle: string, seen: Set<string>): string[] | undefined => {
    const store = storeOf(handle);
    const all = mounts.get(store);
    if (!all?.length) return APPLICATIONS.has(stores.get(store)?.kind as Kind) ? [store] : undefined;
    if (seen.has(store)) return undefined;
    const out: string[] = [];
    for (const m of all) {
      const up = m.parent === ROOT ? undefined : rootsOf(m.parent, new Set([...seen, store]));
      if (!up) return undefined;
      out.push(...up);
    }
    return [...new Set(out)];
  };
  /** One value every root gives, or undefined where they differ or one gives none. */
  const agreed = <T>(handle: string, of: (root: string) => T | undefined): T | undefined => {
    const values = (rootsOf(handle, new Set()) ?? []).map(of);
    return values.length && values.every((v) => v !== undefined && v === values[0]) ? values[0] : undefined;
  };
  const dispatchOf = (handle: string): ReturnType<Mounts["dispatchOf"]> => {
    const store = storeOf(handle);
    const made = stores.get(store);
    const slashes = (strict: boolean | null | undefined) => (strict === null ? {} : { slashes: strict ? ("strict" as const) : ("ignored" as const) });
    switch (made?.kind) {
      case "express-router":
        // Express's Router option `strict` (router 2, `Layer`): off by default, a trailing `/` is optional.
        return { picks: "registration", ...(booleanOption(made.options, ["strict"]) === null || booleanOption(made.options, ["strict"]) ? {} : slashes(false)) };
      case "express-app": {
        // An application's own router takes `strict routing` from its settings (express `lazyrouter`).
        const set = [...facts].flatMap(([file, f]) => f.strict.filter((x) => handleAt(file, x.receiver, new Set()) !== undefined && storeOf(handleAt(file, x.receiver, new Set())!) === store));
        return { picks: "registration", ...(set.every((x) => x.on === false) ? slashes(false) : {}) };
      }
      case "koa-router": {
        // @koa/router's `exclusive` runs only the last route a request matches, and `strict` makes the `/` count.
        const exclusive = booleanOption(made.options, ["exclusive"]);
        const strict = booleanOption(made.options, ["strict"]);
        return { ...(exclusive === undefined || exclusive === false ? { picks: "registration" as const } : {}), ...(strict === undefined || strict === false ? slashes(false) : {}) };
      }
      case "hono": {
        // The application a request enters reads its path with `getPath`, strict unless `strict: false` (hono-base.js).
        const strict = agreed(store, (root) => {
          const options = stores.get(root)?.options;
          if (booleanOption(options, ["getPath"]) !== undefined) return null;
          const strict = booleanOption(options, ["strict"]);
          return strict === undefined ? true : strict;
        });
        return { picks: "registration", ...(strict === undefined ? {} : slashes(strict)) };
      }
      case "fastify":
      case "plugin": {
        // find-my-way's `ignoreTrailingSlash`, given at the top of Fastify's options or in `routerOptions`.
        const ignore = agreed(store, (root) => {
          const options = stores.get(root)?.options;
          const top = booleanOption(options, ["ignoreTrailingSlash"]);
          const router = booleanOption(options, ["routerOptions", "ignoreTrailingSlash"]);
          return top === null || router === null ? null : !!(top || router);
        });
        return { picks: "find-my-way", ...(ignore === undefined ? {} : slashes(ignore === null ? null : !ignore)) };
      }
      default:
        return {};
    }
  };
  /** The mount steps above a router: none for an application nothing mounts; undefined where a mount is not the only one. */
  const chainOf = (store: string, seen: Set<string>): Array<{ router: string; at: number }> | undefined => {
    if (declared[store.slice(0, store.lastIndexOf("@"))] !== undefined) return undefined;
    const all = mounts.get(store);
    if (!all?.length) return APPLICATIONS.has(stores.get(store)?.kind as Kind) ? [] : undefined;
    if (all.length !== 1 || seen.has(store)) return undefined;
    const m = all[0]!;
    if (m.parent === ROOT) return undefined;
    const parent = storeOf(m.parent);
    const above = chainOf(parent, new Set([...seen, store]));
    return above && [...above, { router: `${parent} ${m.file}@${m.scope}`, at: m.at }];
  };
  const orderOf = (handle: string, file: string, node: ts.Node): Array<{ router: string; at: number }> | undefined => {
    const store = storeOf(handle);
    const chain = chainOf(store, new Set());
    return chain && [...chain, { router: `${store} ${file}@${scopeOf(node)}`, at: node.getStart() }];
  };
  const statics = (file: string): Array<{ line: number; paths: string[] | undefined }> => {
    const out: Array<{ line: number; paths: string[] | undefined }> = [];
    for (const s of facts.get(file)?.statics ?? []) {
      const handle = handleAt(file, s.receiver, new Set());
      if (!handle) continue;
      const above = prefixes(handle);
      out.push({ line: s.line, paths: s.path === undefined || !above ? undefined : [...new Set(above.map((p) => joinRoute(p, s.path!)))] });
    }
    return out;
  };
  return {
    routerOf: (file, e) => (facts.has(file) ? handleAt(file, e, new Set()) : undefined),
    prefixes,
    why: (handle) => {
      const s = served(handle, new Set());
      return "why" in s ? s.why : undefined;
    },
    packageOf: (handle) => stores.get(storeOf(handle))?.pkg,
    koaPaths: (handle, path) => (stores.get(handle)?.kind === "koa-router" ? koaJoined(handle, path, new Set()) : { why: "is not an @koa/router router" }),
    originsOf: (handle) => {
      const fileOf = (h: string) => h.slice(0, h.lastIndexOf("@"));
      const store = storeOf(handle);
      if (stores.get(store)?.kind !== "plugin") return stores.has(store) ? [fileOf(store)] : [];
      const out = new Set<string>();
      const seen = new Set<string>();
      const up = (h: string): void => {
        if (seen.has(h)) return;
        seen.add(h);
        if (stores.get(h)?.kind === "fastify") out.add(fileOf(h));
        else for (const m of mounts.get(h) ?? []) if (m.parent !== ROOT) up(storeOf(m.parent));
      };
      up(store);
      return [...out];
    },
    statics,
    dispatchOf,
    orderOf,
  };
}
