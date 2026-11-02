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
}

const isFunctionValue = (n: ts.Node | undefined): boolean =>
  !!n && (ts.isArrowFunction(n) || ts.isFunctionExpression(n));

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
      if (ts.isFunctionDeclaration(st) && st.name && st.body) parsed.functions.set(st.name.text, st.body);
      else if (ts.isVariableStatement(st)) {
        for (const d of st.declarationList.declarations) {
          if (ts.isIdentifier(d.name) && isFunctionValue(d.initializer)) parsed.functions.set(d.name.text, d.initializer!);
        }
      } else if (ts.isImportDeclaration(st) && ts.isStringLiteral(st.moduleSpecifier) && st.importClause?.namedBindings) {
        const target = this.resolve(file, st.moduleSpecifier.text);
        const nb = st.importClause.namedBindings;
        if (target && ts.isNamedImports(nb)) {
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

  /** Member method names called under `start` in `file`, sorted. */
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
          const target = parsed.functions.has(n.text)
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
