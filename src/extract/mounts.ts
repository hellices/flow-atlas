import ts from "typescript";
import { posix } from "node:path";
import { joinRoute } from "../paths.js";

/**
 * Where Express routers are served. A router (`express.Router()`, `Router()`, `new Router()`) registers routes relative
 * to the path it is mounted at with `use`, so its routes are read only where every mount of it is known: a literal path
 * in a `use` call that names the router, held in the same file or required or imported from a relative module, or a
 * mount the configuration declares. A router mounted anywhere atlas cannot read is not placed at the root.
 */
export interface Mounts {
  /** The names a file binds to routers. */
  routers(file: string): Set<string>;
  /** The paths a router is served under, or undefined when one of its mounts is not read. */
  prefixes(file: string, name: string): string[] | undefined;
}

const isRouterCall = (e: ts.Expression | undefined): boolean => {
  if (!e || !(ts.isCallExpression(e) || ts.isNewExpression(e))) return false;
  const callee = e.expression;
  return (ts.isIdentifier(callee) && callee.text === "Router") || (ts.isPropertyAccessExpression(callee) && callee.name.text === "Router");
};

const literal = (e: ts.Expression | undefined): string | undefined =>
  e && (ts.isStringLiteral(e) || ts.isNoSubstitutionTemplateLiteral(e)) ? e.text : undefined;

interface FileFacts {
  routers: Set<string>;
  /** The router the module exports: `module.exports = r`, `export default r`. */
  exported?: string;
  /** Names bound to a relative module: `const r = require("./r")`, `import r from "./r"`. */
  modules: Map<string, string>;
  uses: Array<{ receiver: string; path: string | undefined; target: string }>;
}

function factsOf(text: string, file: string): FileFacts {
  const sf = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true, /x$/.test(file) ? ts.ScriptKind.TSX : ts.ScriptKind.TS);
  const facts: FileFacts = { routers: new Set(), modules: new Map(), uses: [] };
  const visit = (node: ts.Node): void => {
    if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name)) {
      if (isRouterCall(node.initializer)) facts.routers.add(node.name.text);
      const init = node.initializer;
      if (init && ts.isCallExpression(init) && ts.isIdentifier(init.expression) && init.expression.text === "require") {
        const from = literal(init.arguments[0]);
        if (from?.startsWith(".")) facts.modules.set(node.name.text, from);
      }
    }
    if (ts.isImportDeclaration(node) && node.importClause?.name && ts.isStringLiteral(node.moduleSpecifier) && node.moduleSpecifier.text.startsWith(".")) {
      facts.modules.set(node.importClause.name.text, node.moduleSpecifier.text);
    }
    if (ts.isExportAssignment(node) && ts.isIdentifier(node.expression)) facts.exported = node.expression.text;
    if (
      ts.isBinaryExpression(node) &&
      node.operatorToken.kind === ts.SyntaxKind.EqualsToken &&
      node.left.getText(sf) === "module.exports" &&
      ts.isIdentifier(node.right)
    ) {
      facts.exported = node.right.text;
    }
    if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression) && node.expression.name.text === "use" && ts.isIdentifier(node.expression.expression)) {
      const args = node.arguments;
      const first = args[0];
      for (const arg of args) {
        if (!ts.isIdentifier(arg)) continue;
        // A mount without a path serves the router at the mounting router's own path.
        const path = arg === first ? "/" : first && literal(first);
        facts.uses.push({ receiver: node.expression.expression.text, path, target: arg.text });
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  return facts;
}

const EXTENSIONS = ["", ".js", ".ts", ".mjs", ".cjs", ".jsx", ".tsx", "/index.js", "/index.ts"];

export function expressMounts(texts: Map<string, string>, declared: Record<string, string> = {}): Mounts {
  const facts = new Map([...texts].map(([file, text]) => [file, factsOf(text, file)]));
  const resolve = (from: string, rel: string): string | undefined => {
    const base = posix.normalize(posix.join(posix.dirname(from), rel));
    return EXTENSIONS.map((e) => base + e).find((f) => facts.has(f));
  };
  // Each mount, keyed by the router it serves: `file#name`.
  const mounts = new Map<string, Array<{ parent: string | undefined; path: string | undefined }>>();
  for (const [file, f] of facts) {
    for (const use of f.uses) {
      let child: string | undefined;
      if (f.routers.has(use.target)) child = `${file}#${use.target}`;
      else if (f.modules.has(use.target)) {
        const target = resolve(file, f.modules.get(use.target)!);
        const exported = target ? facts.get(target)!.exported : undefined;
        if (target && exported && facts.get(target)!.routers.has(exported)) child = `${target}#${exported}`;
      }
      if (!child) continue;
      const parent = f.routers.has(use.receiver) ? `${file}#${use.receiver}` : undefined;
      (mounts.get(child) ?? mounts.set(child, []).get(child)!).push({ parent, path: use.path });
    }
  }
  const prefixes = (key: string, seen: Set<string>): string[] | undefined => {
    const file = key.slice(0, key.lastIndexOf("#"));
    if (declared[file] !== undefined) return [joinRoute(declared[file]!)];
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
    routers: (file) => facts.get(file)?.routers ?? new Set(),
    prefixes: (file, name) => prefixes(`${file}#${name}`, new Set()),
  };
}
