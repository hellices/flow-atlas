import ts from "typescript";
import { joinRoute } from "../paths.js";
import { declarationOf, resolveModule, unwrap } from "./binding.js";

/**
 * Where Express routers are served. A router (`Router()` from `express`, as `express.Router()`, a named import or a
 * destructured require) registers routes relative to the path it is mounted at with `use`, so its routes are read only
 * where every mount of it is known: a literal path in a `use` call that names the router, held in the same file or
 * required or imported from a relative module, or a mount the configuration declares. A router mounted anywhere atlas
 * cannot read is not placed at the root.
 *
 * Routers are told apart by where they are created, not their names: a router is `<file>@<offset of its Router()>`, and
 * a name that a closer scope binds to something else is not that router. `use` returns the router it is called on, so
 * a chain `Router().use(a).use("/b", b)` is that router, with each `use` a mount on it.
 */
export interface Mounts {
  /** The router the name used at `id` in `file` refers to, defined there or imported; undefined when it is none. */
  routerOf(file: string, id: ts.Identifier): string | undefined;
  /** The paths a router is served under, or undefined when one of its mounts is not read. */
  prefixes(router: string): string[] | undefined;
}

const literal = (e: ts.Expression | undefined): string | undefined => {
  const u = e && unwrap(e);
  return u && (ts.isStringLiteral(u) || ts.isNoSubstitutionTemplateLiteral(u)) ? u.text : undefined;
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

/** The receiver a `use` call is made on: `x.use(...)` and `x["use"](...)`, which is the same call. */
function useReceiver(node: ts.Node): ts.Expression | undefined {
  if (!ts.isCallExpression(node)) return undefined;
  const callee = node.expression;
  if (ts.isPropertyAccessExpression(callee) && callee.name.text === "use") return callee.expression;
  if (ts.isElementAccessExpression(callee) && literal(callee.argumentExpression) === "use") return callee.expression;
  return undefined;
}

/** The `Router()` an expression is: the creation itself, or a chain of `use` calls made on it. */
function chainRoot(e: ts.Expression): ts.Expression | undefined {
  let u = unwrap(e);
  for (let r = useReceiver(u); r; r = useReceiver(u)) u = unwrap(r);
  return createsRouter(u) ? u : undefined;
}

/** Whether an expression creates an Express router: `Router()` or `new Router()` where `Router` comes from `express`. */
function createsRouter(e: ts.Expression | undefined): boolean {
  const u = e && unwrap(e);
  if (!u || !(ts.isCallExpression(u) || ts.isNewExpression(u))) return false;
  const callee = unwrap(u.expression);
  if (ts.isIdentifier(callee)) {
    const from = importOf(declarationOf(callee));
    return from?.spec === "express" && from.name === "Router";
  }
  if (ts.isPropertyAccessExpression(callee) && callee.name.text === "Router") {
    const target = unwrap(callee.expression);
    if (required(target) === "express") return true;
    const from = ts.isIdentifier(target) ? importOf(declarationOf(target)) : undefined;
    return from?.spec === "express" && (from.name === "default" || from.name === "*");
  }
  return false;
}

/** Whether a name is bound to an Express application: `express()` with `express` imported or required from "express". */
function isExpressApp(id: ts.Identifier): boolean {
  const decl = declarationOf(id);
  const init = decl && ts.isVariableDeclaration(decl) && decl.initializer ? unwrap(decl.initializer) : undefined;
  if (!init || !ts.isCallExpression(init)) return false;
  const callee = unwrap(init.expression);
  if (required(callee) === "express") return true;
  const from = ts.isIdentifier(callee) ? importOf(declarationOf(callee)) : undefined;
  return from?.spec === "express" && from.name === "default";
}

/** The key of the router an expression is, or undefined when it is none. */
const routerIn = (file: string, e: ts.Expression): string | undefined => {
  const root = chainRoot(e);
  return root ? `${file}@${root.getStart()}` : undefined;
};

interface FileFacts {
  sf: ts.SourceFile;
  /** What the module exports, by exported name: a name or a router of the file, or a name another module exports. */
  exports: Map<string, ts.Expression | { spec: string; name: string }>;
  /** Modules re-exported whole (`export * from "./routes"`). */
  stars: string[];
  /** The router mounted: a name, a module's export taken from it (`routes.router`), or a router created in place. */
  uses: Array<{ receiver: ts.Expression; path: string | undefined; target: ts.Expression }>;
}

function factsOf(text: string, file: string): FileFacts {
  const sf = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true, /x$/.test(file) ? ts.ScriptKind.TSX : ts.ScriptKind.TS);
  const facts: FileFacts = { sf, exports: new Map(), stars: [], uses: [] };
  const exported = (n: ts.Node): boolean => ts.canHaveModifiers(n) && !!ts.getModifiers(n)?.some((m) => m.kind === ts.SyntaxKind.ExportKeyword);
  /** A name, or a router created in place (`export default Router().use("/api", api)`). */
  const exportable = (e: ts.Expression): boolean => ts.isIdentifier(e) || chainRoot(e) !== undefined;
  const visit = (node: ts.Node): void => {
    if (ts.isVariableStatement(node) && exported(node)) {
      for (const d of node.declarationList.declarations) if (ts.isIdentifier(d.name)) facts.exports.set(d.name.text, d.name);
    }
    if (ts.isExportAssignment(node) && exportable(unwrap(node.expression))) facts.exports.set("default", unwrap(node.expression));
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
      if (exportable(right) && left === "module.exports") facts.exports.set("default", right);
      if (ts.isIdentifier(right) && named) facts.exports.set(named[1]!, right);
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
    // `app.use(...)` on a name, or on a router created in place (`Router().use(...)`).
    const use = useReceiver(node);
    if (ts.isCallExpression(node) && use && (ts.isIdentifier(unwrap(use)) || chainRoot(use))) {
      const args = node.arguments;
      const first = args[0] && unwrap(args[0]);
      const path = literal(first);
      // `use(fn, ...)` mounts at the receiver's own path; an inline function first shows that overload for certain.
      const pathless = first && (ts.isArrowFunction(first) || ts.isFunctionExpression(first));
      for (const arg of args) {
        const target = unwrap(arg);
        if (!ts.isIdentifier(target) && !(ts.isPropertyAccessExpression(target) && ts.isIdentifier(target.expression)) && !chainRoot(target)) continue;
        facts.uses.push({ receiver: unwrap(use), path: path ?? (pathless || target === first ? "/" : undefined), target });
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  return facts;
}

export function expressMounts(texts: Map<string, string>, declared: Record<string, string> = {}): Mounts {
  const facts = new Map([...texts].map(([file, text]) => [file, factsOf(text, file)]));
  const resolve = (from: string, spec: string) => resolveModule(from, spec, (f) => facts.has(f));

  type At<T> = (file: string, e: ts.Expression, seen: Set<string>) => T | undefined;
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
    if ("spec" in e) {
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

  /** What `at` finds for the name a `const` alias holds (`const api = router`). */
  const aliased = <T>(file: string, id: ts.Identifier, seen: Set<string>, at: At<T>): T | undefined => {
    const decl = declarationOf(id);
    const init = decl && ts.isVariableDeclaration(decl) && decl.initializer && decl.parent.flags & ts.NodeFlags.Const ? unwrap(decl.initializer) : undefined;
    const key = `${file}@${id.getStart()}`;
    return init && ts.isIdentifier(init) && !seen.has(key) ? at(file, init, new Set([...seen, key])) : undefined;
  };
  /** A router a module exports, taken from the whole module: `import * as routes` or `const routes = require(...)`. */
  const memberRouter = (file: string, access: ts.PropertyAccessExpression): string | undefined => {
    const decl = declarationOf(access.expression as ts.Identifier);
    const spec =
      decl && ts.isNamespaceImport(decl)
        ? (decl.parent.parent.moduleSpecifier as ts.StringLiteral).text
        : decl && ts.isVariableDeclaration(decl)
          ? required(decl.initializer)
          : undefined;
    const target = spec === undefined ? undefined : resolve(file, spec);
    return target ? exported(target, access.name.text, new Set(), routerAt) : undefined;
  };
  /** The router a name holds (`const api = Router().use(x)`), or the one an expression creates in place. */
  const routerAt = (file: string, e: ts.Expression, seen = new Set<string>()): string | undefined => {
    if (!ts.isIdentifier(e)) return routerIn(file, e);
    const decl = declarationOf(e);
    if (!decl) return undefined;
    const own = ts.isVariableDeclaration(decl) && ts.isIdentifier(decl.name) && decl.initializer ? routerIn(file, decl.initializer) : undefined;
    return own ?? imported(file, e, seen, routerAt) ?? aliased(file, e, seen, routerAt);
  };
  // An application created here, or one a relative module exports (`export const app = express()`).
  const appAt = (file: string, e: ts.Expression, seen = new Set<string>()): true | undefined =>
    !ts.isIdentifier(e) ? undefined : isExpressApp(e) ? true : (imported(file, e, seen, appAt) ?? aliased(file, e, seen, appAt));

  // Each mount, keyed by the router it serves; the parent is the router it is mounted on, or none for an application.
  const mounts = new Map<string, Array<{ parent: string | undefined; path: string | undefined }>>();
  for (const [file, f] of facts) {
    for (const use of f.uses) {
      const child = ts.isPropertyAccessExpression(use.target) ? memberRouter(file, use.target) : routerAt(file, use.target);
      if (!child) continue;
      // Mounted on a router, or on an Express application; `use` on anything else is no mount atlas can place.
      const parent = routerAt(file, use.receiver);
      if (!parent && !appAt(file, use.receiver)) continue;
      (mounts.get(child) ?? mounts.set(child, []).get(child)!).push({ parent, path: use.path });
    }
  }
  const prefixes = (key: string, seen: Set<string>): string[] | undefined => {
    const file = key.slice(0, key.lastIndexOf("@"));
    if (declared[file] !== undefined) return [joinRoute(declared[file])];
    const all = mounts.get(key);
    if (!all?.length || seen.has(key)) return undefined;
    const out: string[] = [];
    for (const m of all) {
      if (m.path === undefined) return undefined;
      const above = m.parent ? prefixes(m.parent, new Set([...seen, key])) : ["/"];
      if (!above) return undefined;
      for (const p of above) out.push(joinRoute(p, m.path));
    }
    return [...new Set(out)];
  };
  return {
    routerOf: (file, id) => (facts.has(file) ? routerAt(file, id) : undefined),
    prefixes: (router) => prefixes(router, new Set()),
  };
}
