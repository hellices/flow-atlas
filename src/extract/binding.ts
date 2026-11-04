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

/** Parentheses and type assertions around an expression, which change nothing at run time. */
export function unwrap(e: ts.Expression): ts.Expression {
  while (ts.isParenthesizedExpression(e) || ts.isAsExpression(e) || ts.isSatisfiesExpression(e) || ts.isTypeAssertionExpression(e)) e = e.expression;
  return e;
}

/**
 * A relative module specifier resolved to one of the files `exists` accepts: the TypeScript file a `.js` specifier
 * stands for first (NodeNext writes `./r.js` for `r.ts`), then the specifier as written, then the extensions and index
 * files TypeScript and Node try.
 */
export function resolveModule(from: string, spec: string, exists: (file: string) => boolean): string | undefined {
  if (!spec.startsWith(".")) return undefined;
  const parts = from.split("/").slice(0, -1);
  for (const seg of spec.split("/")) {
    if (seg === "." || seg === "") continue;
    // A specifier that climbs above the repository names nothing atlas reads.
    if (seg === "..") {
      if (!parts.length) return undefined;
      parts.pop();
    }
    else parts.push(seg);
  }
  const written = parts.join("/");
  const js = /\.(m|c)?jsx?$/.exec(written);
  const base = js ? written.slice(0, -js[0].length) : written;
  const typescriptFor: Record<string, string[]> = { ".js": ["ts", "tsx"], ".jsx": ["tsx"], ".mjs": ["mts"], ".cjs": ["cts"] };
  const substituted = js ? (typescriptFor[js[0]] ?? []).map((e) => `${base}.${e}`) : [];
  const extensions = ["ts", "tsx", "mts", "cts", "js", "jsx", "mjs", "cjs"];
  const candidates = [...substituted, written, ...extensions.map((e) => `${written}.${e}`), ...extensions.map((e) => `${written}/index.${e}`)];
  return candidates.find((c) => /\.(m|c)?[jt]sx?$/.test(c) && exists(c));
}
