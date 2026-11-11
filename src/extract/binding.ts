import ts from "typescript";

/** The declaration in a binding name (a plain name or a destructuring pattern) that binds `text`. */
function bindingIn(name: ts.BindingName, text: string): ts.Node | undefined {
  if (ts.isIdentifier(name)) return name.text === text ? name.parent : undefined;
  for (const el of name.elements) {
    if (ts.isOmittedExpression(el)) continue;
    const found = bindingIn(el.name, text);
    if (found) return found;
  }
  return undefined;
}

/**
 * A `var` of a function's, namespace's or file's own scope, wherever it is written in it: JavaScript hoists it to the
 * whole scope.
 */
function hoistedVar(scope: ts.Node, text: string): ts.Node | undefined {
  let found: ts.Node | undefined;
  const visit = (n: ts.Node): void => {
    // A function's body, a class static block and a namespace each keep their own `var`s.
    if (found || (n !== scope && (ts.isFunctionLike(n) || ts.isClassStaticBlockDeclaration(n) || ts.isModuleBlock(n)))) return;
    // `let`, `const` and `using` belong to their block.
    if (ts.isVariableDeclarationList(n) && !(n.flags & ts.NodeFlags.BlockScoped)) {
      for (const d of n.declarations) found ??= bindingIn(d.name, text);
    }
    ts.forEachChild(n, visit);
  };
  visit(scope);
  return found;
}

/** A declaration of these statements that binds `text`; in a block, a `var` is left to the scope it is hoisted to. */
function inStatements(statements: readonly ts.Statement[], text: string, file: boolean): ts.Node | undefined {
  for (const st of statements) {
    if ((ts.isFunctionDeclaration(st) || ts.isClassDeclaration(st) || ts.isEnumDeclaration(st)) && st.name?.text === text) return st;
    if (ts.isModuleDeclaration(st) && ts.isIdentifier(st.name) && st.name.text === text) return st;
    if (ts.isVariableStatement(st) && (file || st.declarationList.flags & ts.NodeFlags.BlockScoped)) {
      for (const d of st.declarationList.declarations) {
        const found = bindingIn(d.name, text);
        if (found) return found;
      }
    }
    // `import X = A.B` binds in a namespace as in a file.
    if (ts.isImportEqualsDeclaration(st) && st.name.text === text) return st;
    if (!file) continue;
    if (ts.isImportDeclaration(st) && st.importClause) {
      const clause = st.importClause;
      if (clause.name?.text === text) return clause;
      const nb = clause.namedBindings;
      if (nb && ts.isNamespaceImport(nb) && nb.name.text === text) return nb;
      if (nb && ts.isNamedImports(nb)) for (const el of nb.elements) if (el.name.text === text) return el;
    }
  }
  return undefined;
}

/**
 * The node that binds the name used at `id`, by the lexical scopes around it: a parameter, a catch or loop binding, a
 * hoisted `var`, a declaration of an enclosing block, or a declaration or import of the file. The innermost wins, so a
 * shadowing binding is never taken for the outer one. Undefined for a global.
 */
export function declarationOf(id: ts.Identifier): ts.Node | undefined {
  const text = id.text;
  for (let a: ts.Node | undefined = id.parent; a; a = a.parent) {
    if (ts.isFunctionLike(a)) {
      for (const p of a.parameters) {
        const found = bindingIn(p.name, text);
        if (found) return found;
      }
      if (ts.isFunctionExpression(a) && a.name?.text === text) return a;
      // The body's `var`s are not seen from the parameters: `f(a = x) { var x }` reads an outer `x`.
      const body = "body" in a ? (a.body as ts.Node | undefined) : undefined;
      const inBody = body && id.pos >= body.pos && id.end <= body.end;
      const hoisted = inBody ? hoistedVar(body, text) : undefined;
      if (hoisted) return hoisted;
    }
    // A named class expression binds its name inside itself.
    if (ts.isClassExpression(a) && a.name?.text === text) return a;
    if (ts.isClassStaticBlockDeclaration(a)) {
      const hoisted = hoistedVar(a.body, text);
      if (hoisted) return hoisted;
    }
    if (ts.isCatchClause(a) && a.variableDeclaration) {
      const found = bindingIn(a.variableDeclaration.name, text);
      if (found) return found;
    }
    if ((ts.isForStatement(a) || ts.isForInStatement(a) || ts.isForOfStatement(a)) && a.initializer && ts.isVariableDeclarationList(a.initializer)) {
      for (const d of a.initializer.declarations) {
        const found = bindingIn(d.name, text);
        if (found) return found;
      }
    }
    if (ts.isBlock(a) || ts.isModuleBlock(a)) {
      const found = inStatements(a.statements, text, false) ?? (ts.isModuleBlock(a) ? hoistedVar(a, text) : undefined);
      if (found) return found;
    }
    // The clauses of a switch share one scope: a declaration in one case is seen by the cases after it.
    if (ts.isCaseBlock(a)) {
      const found = inStatements(a.clauses.flatMap((c) => [...c.statements]), text, false);
      if (found) return found;
    }
    if (ts.isSourceFile(a)) return inStatements(a.statements, text, true) ?? hoistedVar(a, text);
  }
  return undefined;
}

/** The name a binding imports from one of `modules` ("default" for a default import), or undefined. */
export function importedFrom(id: ts.Identifier, modules: string[]): string | undefined {
  const d = declarationOf(id);
  const spec = (n: ts.Node | undefined) => (n && ts.isImportDeclaration(n) && ts.isStringLiteral(n.moduleSpecifier) ? n.moduleSpecifier.text : undefined);
  if (d && ts.isImportSpecifier(d) && modules.includes(spec(d.parent.parent.parent) ?? "")) return (d.propertyName ?? d.name).text;
  if (d && ts.isImportClause(d) && modules.includes(spec(d.parent) ?? "")) return "default";
  return undefined;
}

/** Parentheses and type assertions (`as`, `satisfies`, `<T>`, `!`) around an expression, which change nothing at run time. */
export function unwrap(e: ts.Expression): ts.Expression {
  while (ts.isParenthesizedExpression(e) || ts.isAsExpression(e) || ts.isSatisfiesExpression(e) || ts.isTypeAssertionExpression(e) || ts.isNonNullExpression(e)) e = e.expression;
  return e;
}

/**
 * A relative module specifier resolved to one of the files `exists` accepts: the TypeScript file a `.js` specifier
 * stands for first (NodeNext writes `./r.js` for `r.ts`), then the specifier as written, then the extensions and index
 * files TypeScript and Node try.
 */
export function resolveModule(from: string, spec: string, exists: (file: string) => boolean): string | undefined {
  if (!spec.startsWith(".")) return undefined;
  const written = joinPath(from.split("/").slice(0, -1).join("/"), spec);
  return written === undefined ? undefined : resolvePath(written, exists);
}

/** A relative path joined to a directory of the repository; undefined where it climbs above the repository. */
export function joinPath(dir: string, relative: string): string | undefined {
  const parts = dir ? dir.split("/") : [];
  for (const seg of relative.split("/")) {
    if (seg === "." || seg === "") continue;
    // A path that climbs above the repository names nothing atlas reads.
    if (seg === "..") {
      if (!parts.length) return undefined;
      parts.pop();
    } else parts.push(seg);
  }
  return parts.join("/");
}

/** A module path of the repository (no extension needed) resolved to a file `exists` accepts, as `resolveModule` does. */
export function resolvePath(written: string, exists: (file: string) => boolean): string | undefined {
  const js = /\.(m|c)?jsx?$/.exec(written);
  const base = js ? written.slice(0, -js[0].length) : written;
  const typescriptFor: Record<string, string[]> = { ".js": ["ts", "tsx"], ".jsx": ["tsx"], ".mjs": ["mts"], ".cjs": ["cts"] };
  const substituted = js ? (typescriptFor[js[0]] ?? []).map((e) => `${base}.${e}`) : [];
  const extensions = ["ts", "tsx", "mts", "cts", "js", "jsx", "mjs", "cjs"];
  // A specifier that names its file's extension (`./foo.ts`) is that file; no other extension is tried after it.
  const explicit = /\.(m|c)?[jt]sx?$/.test(written);
  const candidates = [...substituted, written, ...(explicit ? [] : [...extensions.map((e) => `${written}.${e}`), ...extensions.map((e) => (written ? `${written}/index.${e}` : `index.${e}`))])];
  return candidates.find((c) => /\.(m|c)?[jt]sx?$/.test(c) && exists(c));
}

const identifiersByFile = new WeakMap<ts.SourceFile, Map<string, ts.Identifier[]>>();

/**
 * Whether an identifier refers to a binding where it is written: not a property's or a member's name, a key a
 * destructuring or an import takes, the name an export gives, a label, an attribute's or an intrinsic element's name,
 * nor a name in a type.
 */
export function isReference(id: ts.Identifier): boolean {
  const p = id.parent;
  if ((ts.isPropertyAccessExpression(p) && p.name === id) || (ts.isQualifiedName(p) && p.right === id)) return false;
  if ((ts.isPropertyAssignment(p) || ts.isPropertyDeclaration(p) || ts.isMethodDeclaration(p) || ts.isPropertySignature(p) || ts.isMethodSignature(p) || ts.isGetAccessorDeclaration(p) || ts.isSetAccessorDeclaration(p) || ts.isEnumMember(p)) && p.name === id) return false;
  if ((ts.isBindingElement(p) || ts.isImportSpecifier(p)) && p.propertyName === id) return false;
  // `export { local as name }` refers to `local`; `export { name } from "m"` to nothing of this file.
  if (ts.isExportSpecifier(p)) return !p.parent.parent.moduleSpecifier && (p.propertyName ?? p.name) === id;
  if (ts.isJsxAttribute(p) || ts.isLabeledStatement(p) || ts.isBreakOrContinueStatement(p)) return false;
  if ((ts.isJsxOpeningElement(p) || ts.isJsxSelfClosingElement(p) || ts.isJsxClosingElement(p)) && p.tagName === id && /^[a-z]/.test(id.text)) return false;
  for (let a: ts.Node = p; !ts.isSourceFile(a); a = a.parent) {
    if (ts.isTypeNode(a) && !ts.isExpressionWithTypeArguments(a)) return false;
    if (ts.isStatement(a)) break;
  }
  return true;
}

/** The identifiers of its file that refer to the binding a name declares, the name itself left out. */
export function references(name: ts.Identifier): ts.Identifier[] {
  const sf = name.getSourceFile();
  let index = identifiersByFile.get(sf);
  if (!index) {
    const built = new Map<string, ts.Identifier[]>();
    const visit = (n: ts.Node): void => {
      if (ts.isIdentifier(n)) (built.get(n.text) ?? built.set(n.text, []).get(n.text)!).push(n);
      ts.forEachChild(n, visit);
    };
    visit(sf);
    identifiersByFile.set(sf, built);
    index = built;
  }
  const declaration = name.parent;
  return (index.get(name.text) ?? []).filter((id) => id !== name && isReference(id) && declarationOf(id) === declaration);
}
