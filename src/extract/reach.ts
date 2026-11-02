import ts from "typescript";
import type { Source } from "../source.js";

const MAX_FUNCTIONS = 400;

interface Parsed {
  sf: ts.SourceFile;
  /** Top-level functions and function-valued constants by name. */
  functions: Map<string, ts.Node>;
  /** Local name to the relatively imported module and the name it has there. */
  imports: Map<string, { file: string; name: string }>;
  /** Names re-exported from other modules: `export { a as b } from "./x"` and `export * from "./y"`. */
  reexports: Map<string, { file: string; name: string }>;
  stars: string[];
  /** What `export default` gives: a function node, or the name of a top-level function. */
  defaultExport?: ts.Node | string;
}

const isFunctionValue = (n: ts.Node | undefined): boolean =>
  !!n && (ts.isArrowFunction(n) || ts.isFunctionExpression(n));

const hasDefault = (n: ts.Node): boolean =>
  ts.canHaveModifiers(n) && !!ts.getModifiers(n)?.some((m) => m.kind === ts.SyntaxKind.DefaultKeyword);

function bindingNames(name: ts.BindingName, out: string[] = []): string[] {
  if (ts.isIdentifier(name)) out.push(name.text);
  else for (const el of name.elements) if (!ts.isOmittedExpression(el)) bindingNames(el.name, out);
  return out;
}

/**
 * What a name used at `id` is bound to between it and the top of its file: a local function (returned, to follow),
 * another local binding such as a parameter or a variable (null: it shadows any top-level function of that name), or
 * nothing (undefined: the top-level function or import of that name applies).
 */
function localBinding(id: ts.Identifier): ts.Node | null | undefined {
  const name = id.text;
  for (let a: ts.Node | undefined = id.parent; a && !ts.isSourceFile(a); a = a.parent) {
    if (ts.isFunctionLike(a)) {
      for (const p of a.parameters) if (bindingNames(p.name).includes(name)) return null;
      if ((ts.isFunctionExpression(a) || ts.isFunctionDeclaration(a)) && a.name?.text === name && a.body) return a.body;
    }
    if (ts.isCatchClause(a) && a.variableDeclaration && bindingNames(a.variableDeclaration.name).includes(name)) return null;
    if ((ts.isForStatement(a) || ts.isForInStatement(a) || ts.isForOfStatement(a)) && a.initializer && ts.isVariableDeclarationList(a.initializer)) {
      for (const d of a.initializer.declarations) if (bindingNames(d.name).includes(name)) return null;
    }
    const statements = ts.isBlock(a) || ts.isModuleBlock(a) || ts.isCaseClause(a) || ts.isDefaultClause(a) ? a.statements : undefined;
    for (const st of statements ?? []) {
      if (ts.isFunctionDeclaration(st) && st.name?.text === name) return st.body ?? null;
      if ((ts.isClassDeclaration(st) || ts.isEnumDeclaration(st)) && st.name?.text === name) return null;
      if (ts.isVariableStatement(st)) {
        for (const d of st.declarationList.declarations) {
          if (ts.isIdentifier(d.name) && d.name.text === name) return isFunctionValue(d.initializer) ? d.initializer! : null;
          if (bindingNames(d.name).includes(name)) return null;
        }
      }
    }
  }
  return undefined;
}

/**
 * Finds the member methods a piece of code calls, following the local and relatively imported functions it uses.
 * In code that reaches its neighbours through ports, these are the port methods an outbound adapter implements.
 */
export class Reach {
  private readonly cache = new Map<string, Parsed | null>();

  constructor(private readonly source: Source) {}

  parse(file: string): Parsed | null {
    if (this.cache.has(file)) return this.cache.get(file)!;
    const text = this.source.read(file);
    if (text === undefined) {
      this.cache.set(file, null);
      return null;
    }
    const sf = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true, file.endsWith("x") ? ts.ScriptKind.TSX : ts.ScriptKind.TS);
    const parsed: Parsed = { sf, functions: new Map(), imports: new Map(), reexports: new Map(), stars: [] };
    for (const st of sf.statements) {
      if (ts.isFunctionDeclaration(st) && st.body) {
        if (st.name) parsed.functions.set(st.name.text, st.body);
        if (hasDefault(st)) parsed.defaultExport = st.body;
      } else if (ts.isExportAssignment(st) && !st.isExportEquals) {
        const e = st.expression;
        if (ts.isIdentifier(e)) parsed.defaultExport = e.text;
        else if (isFunctionValue(e)) parsed.defaultExport = e;
      } else if (ts.isVariableStatement(st)) {
        for (const d of st.declarationList.declarations) {
          if (ts.isIdentifier(d.name) && isFunctionValue(d.initializer)) parsed.functions.set(d.name.text, d.initializer!);
        }
      } else if (ts.isImportDeclaration(st) && ts.isStringLiteral(st.moduleSpecifier) && st.importClause) {
        const target = this.resolve(file, st.moduleSpecifier.text);
        const nb = st.importClause.namedBindings;
        if (target && st.importClause.name) parsed.imports.set(st.importClause.name.text, { file: target, name: "default" });
        if (target && nb && ts.isNamedImports(nb)) {
          for (const el of nb.elements) parsed.imports.set(el.name.text, { file: target, name: (el.propertyName ?? el.name).text });
        }
      } else if (ts.isExportDeclaration(st) && st.moduleSpecifier && ts.isStringLiteral(st.moduleSpecifier)) {
        const target = this.resolve(file, st.moduleSpecifier.text);
        if (!target) continue;
        if (!st.exportClause) parsed.stars.push(target);
        else if (ts.isNamedExports(st.exportClause)) {
          for (const el of st.exportClause.elements) parsed.reexports.set(el.name.text, { file: target, name: (el.propertyName ?? el.name).text });
        }
      }
    }
    this.cache.set(file, parsed);
    return parsed;
  }

  /** A relative module specifier resolved to a file of the source, trying TypeScript extensions and index files. */
  resolve(from: string, spec: string): string | undefined {
    if (!spec.startsWith(".")) return undefined;
    const parts = from.split("/").slice(0, -1);
    for (const seg of spec.split("/")) {
      if (seg === "." || seg === "") continue;
      if (seg === "..") parts.pop();
      else parts.push(seg);
    }
    const base = parts.join("/").replace(/\.(m|c)?js$/, "");
    for (const candidate of [base, `${base}.ts`, `${base}.tsx`, `${base}/index.ts`, `${base}/index.tsx`]) {
      if (/\.(m|c)?tsx?$/.test(candidate) && this.source.read(candidate) !== undefined) return candidate;
    }
    return undefined;
  }

  /** The function a module exports under a name, following re-exports. */
  private exported(file: string, name: string, depth = 0): { file: string; node: ts.Node } | undefined {
    const p = this.parse(file);
    if (!p || depth > 5) return undefined;
    if (name === "default" && p.defaultExport !== undefined) {
      if (typeof p.defaultExport !== "string") return { file, node: p.defaultExport };
      return this.exported(file, p.defaultExport, depth + 1);
    }
    const local = p.functions.get(name);
    if (local) return { file, node: local };
    const re = p.reexports.get(name) ?? p.imports.get(name);
    if (re) return this.exported(re.file, re.name, depth + 1);
    for (const star of p.stars) {
      const found = this.exported(star, name, depth + 1);
      if (found) return found;
    }
    return undefined;
  }

  /**
   * Member method names called under `start` in `file`, sorted. A function declared inside the code, or bound to a
   * local name, is followed only where it is used; a function written inline (a callback argument) counts as run.
   */
  from(file: string, start: ts.Node): string[] {
    const names = new Set<string>();
    const seen = new Set<string>();
    const queue: Array<{ file: string; node: ts.Node }> = [{ file, node: start }];
    while (queue.length && seen.size < MAX_FUNCTIONS) {
      const { file: f, node } = queue.shift()!;
      const parsed = this.parse(f);
      if (!parsed) continue;
      const classOf = enclosingClass(node);
      const visit = (n: ts.Node): void => {
        if (ts.isTypeNode(n) || ts.isImportDeclaration(n)) return;
        if (n !== node && (ts.isFunctionDeclaration(n) || (ts.isVariableDeclaration(n) && isFunctionValue(n.initializer)))) return;
        if (ts.isCallExpression(n) && ts.isPropertyAccessExpression(n.expression)) {
          const member = n.expression.name.text;
          names.add(member);
          if (n.expression.expression.kind === ts.SyntaxKind.ThisKeyword && classOf) {
            const method = classOf.members.find((m) => ts.isMethodDeclaration(m) && m.name.getText(parsed.sf) === member);
            const key = `${f}#this.${member}`;
            if (method && !seen.has(key)) {
              seen.add(key);
              queue.push({ file: f, node: method });
            }
          }
        }
        if (ts.isIdentifier(n) && !(ts.isPropertyAccessExpression(n.parent) && n.parent.name === n)) {
          const local = localBinding(n);
          const target =
            local !== undefined
              ? local && { file: f, node: local }
              : parsed.functions.has(n.text)
                ? { file: f, node: parsed.functions.get(n.text)! }
                : parsed.imports.has(n.text)
                  ? this.exported(parsed.imports.get(n.text)!.file, parsed.imports.get(n.text)!.name)
                  : undefined;
          if (target) {
            const key = `${target.file}#${target.node.pos}`;
            if (!seen.has(key)) {
              seen.add(key);
              queue.push(target);
            }
          }
        }
        ts.forEachChild(n, visit);
      };
      visit(node);
    }
    return [...names].sort();
  }
}

function enclosingClass(node: ts.Node): ts.ClassLikeDeclaration | undefined {
  for (let n: ts.Node | undefined = node; n; n = n.parent) if (ts.isClassLike(n)) return n;
  return undefined;
}

/** The name of the function, method or function-valued property or constant that holds a node. */
export function scopeOf(node: ts.Node): string | undefined {
  for (let n: ts.Node | undefined = node.parent; n; n = n.parent) {
    if ((ts.isMethodDeclaration(n) || ts.isFunctionDeclaration(n) || ts.isGetAccessor(n)) && n.name) return n.name.getText();
    if (isFunctionValue(n)) {
      const p = n.parent;
      if (p && (ts.isVariableDeclaration(p) || ts.isPropertyAssignment(p) || ts.isPropertyDeclaration(p)) && p.name) return p.name.getText();
    }
  }
  return undefined;
}

/** For text-read languages: a lookup of the last `fun`, `func` or `def` declared before an index. */
export function textScopes(text: string): (index: number) => string | undefined {
  const decls = [...text.matchAll(/\b(?:fun|func|def)\s+(?:<[^>]*>\s*)?([A-Za-z_]\w*)/g)].map((m) => ({ at: m.index ?? 0, name: m[1]! }));
  return (index) => {
    let found: string | undefined;
    for (const d of decls) {
      if (d.at >= index) break;
      found = d.name;
    }
    return found;
  };
}
