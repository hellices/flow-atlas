import ts from "typescript";
import type { Source } from "../source.js";
import { declarationOf, references } from "./binding.js";
import type { Constants } from "./constants.js";

const SCRIPT = /\.(m|c)?[jt]sx?$/;

/** Files whose code may import a module but is not parsed here: single-file components, MDX, HTML with scripts. */
const OTHER_CODE = /\.(svelte|vue|astro|mdx|html?)$/;

/** How many modules passing a binding on are followed. */
const MAX_MODULES = 20;

/**
 * Where the code of the repository's other files uses a binding a module exports, as imports bind it: each reference of
 * a name an import binds to it (`import { homePath } from "~/utils/routeHelpers"`, through re-exports, by the name it is
 * exported as), and `ns.name` for a namespace import of a module that exports it. A module that passes it on under
 * another name (`export { homePath as home }`) is followed in turn.
 *
 * A file is looked at only where its text holds the name a module exports the binding as, which every static import of
 * it writes. Null where another file may reach the binding in a way not read here: a file of code that is not parsed
 * (a Svelte, Vue or Astro component, MDX, HTML) whose text holds the name, an import of the name (or a namespace) from
 * a module atlas does not resolve, which may be this one, a dynamic `import()` or `require()` of a module that exports
 * it, a namespace object used whole, `export * as`, a default export, or more modules than `MAX_MODULES` passing it on.
 */
export class Importers {
  private files: Array<{ file: string; text: string }> | undefined;
  private readonly cache = new Map<string, ts.Expression[] | null>();

  constructor(
    private readonly source: Pick<Source, "list" | "read">,
    private readonly constants: Constants,
    private readonly skip: (file: string) => boolean,
  ) {}

  private all(): Array<{ file: string; text: string }> {
    if (!this.files) {
      this.files = [];
      for (const file of this.source.list()) {
        if (this.skip(file) || /(?:^|\/)node_modules\//.test(file) || !(SCRIPT.test(file) || OTHER_CODE.test(file))) continue;
        const text = this.source.read(file);
        if (text !== undefined) this.files.push({ file, text });
      }
    }
    return this.files;
  }

  /**
   * The uses, outside `file`, of the binding `declaration` declares there, which `file` exports under `names`; null
   * where they cannot all be read.
   */
  uses(file: string, declaration: ts.Node, names: string[]): ts.Expression[] | null {
    const key = `${file}\0${declaration.pos}\0${declaration.end}\0${names.join("\0")}`;
    if (!this.cache.has(key)) this.cache.set(key, this.find(file, declaration, names));
    return this.cache.get(key)!;
  }

  private find(file: string, declaration: ts.Node, names: string[]): ts.Expression[] | null {
    if (names.includes("default")) return null;
    const same = (n: ts.Node) => n.getSourceFile().fileName === file && n.pos === declaration.pos && n.end === declaration.end;
    const exports = (from: string, spec: string, name: string): boolean => {
      const x = this.constants.exportOf(from, spec, name);
      return !!x && "node" in x && same(x.node);
    };
    const out: ts.Expression[] = [];
    const queue = names.map((name) => ({ module: file, name }));
    const modules = new Set([file]);
    const seen = new Set<string>();
    for (let item = queue.shift(); item; item = queue.shift()) {
      if (seen.has(`${item.module}\0${item.name}`)) continue;
      seen.add(`${item.module}\0${item.name}`);
      if (seen.size > MAX_MODULES) return null;
      const word = new RegExp(`(?<![\\w$])${item.name.replace(/[$]/g, "\\$")}(?![\\w$])`);
      for (const { file: other, text } of this.all()) {
        if (other === file || !word.test(text)) continue;
        if (!SCRIPT.test(other)) return null;
        const sf = this.constants.sourceFile(other);
        if (!sf) return null;
        const passed = (name: string) => {
          if (name === "default") return false;
          queue.push({ module: other, name });
          modules.add(other);
          return true;
        };
        for (const st of sf.statements) {
          const spec = (ts.isImportDeclaration(st) || ts.isExportDeclaration(st)) && st.moduleSpecifier && ts.isStringLiteral(st.moduleSpecifier) ? st.moduleSpecifier.text : undefined;
          if (spec === undefined) continue;
          if (ts.isExportDeclaration(st)) {
            if (st.isTypeOnly || !st.exportClause) continue;
            if (ts.isNamespaceExport(st.exportClause)) {
              if (exports(other, spec, item.name)) return null;
              continue;
            }
            for (const el of st.exportClause.elements) if (!el.isTypeOnly && exports(other, spec, (el.propertyName ?? el.name).text) && !passed(el.name.text)) return null;
            continue;
          }
          const clause = (st as ts.ImportDeclaration).importClause;
          if (!clause || clause.isTypeOnly) continue;
          // A module not read may be this one, under a specifier atlas does not resolve.
          const unread = this.constants.moduleFile(other, spec) === undefined;
          const bound: ts.Identifier[] = [];
          if (clause.name && exports(other, spec, "default")) bound.push(clause.name);
          const nb = clause.namedBindings;
          if (nb && ts.isNamedImports(nb)) {
            for (const el of nb.elements) {
              if (el.isTypeOnly) continue;
              const imported = (el.propertyName ?? el.name).text;
              if (exports(other, spec, imported)) bound.push(el.name);
              else if (unread && imported === item.name) return null;
            }
          }
          for (const name of bound) {
            for (const ref of references(name)) {
              const p = ref.parent;
              if (ts.isExportSpecifier(p)) {
                if (!passed(p.name.text)) return null;
              } else if (ts.isExportAssignment(p)) return null;
              else out.push(ref);
            }
          }
          if (nb && ts.isNamespaceImport(nb)) {
            for (const ref of references(nb.name)) {
              const p = ref.parent;
              const m = ts.isPropertyAccessExpression(p) && p.expression === ref ? p.name.text : ts.isElementAccessExpression(p) && p.expression === ref && ts.isStringLiteralLike(p.argumentExpression) ? p.argumentExpression.text : undefined;
              if (m === undefined) {
                // The namespace used whole may hand the binding anywhere.
                if (unread || exports(other, spec, item.name)) return null;
              } else if (exports(other, spec, m)) out.push(p as ts.Expression);
              else if (unread && m === item.name) return null;
            }
          }
        }
        if (this.loads(sf, modules)) return null;
      }
    }
    return out;
  }

  /** Whether a file loads one of these modules at run time, with `import()` or `require()`, which hands it whole. */
  private loads(sf: ts.SourceFile, modules: Set<string>): boolean {
    let found = false;
    const visit = (n: ts.Node): void => {
      if (found) return;
      if (ts.isCallExpression(n) && n.arguments.length >= 1 && ts.isStringLiteralLike(n.arguments[0]!)) {
        const callee = n.expression;
        const dynamic = callee.kind === ts.SyntaxKind.ImportKeyword || (ts.isIdentifier(callee) && callee.text === "require" && !declarationOf(callee));
        const target = dynamic ? this.constants.moduleFile(sf.fileName, (n.arguments[0] as ts.StringLiteral).text) : undefined;
        if (target && modules.has(target)) found = true;
      }
      if (ts.isImportEqualsDeclaration(n) && ts.isExternalModuleReference(n.moduleReference) && ts.isStringLiteral(n.moduleReference.expression)) {
        const target = this.constants.moduleFile(sf.fileName, n.moduleReference.expression.text);
        if (target && modules.has(target)) found = true;
      }
      ts.forEachChild(n, visit);
    };
    visit(sf);
    return found;
  }
}
