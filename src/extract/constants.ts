import picomatch from "picomatch";
import ts from "typescript";
import { parse as parseYaml } from "yaml";
import type { Source } from "../source.js";
import { declarationOf, joinPath, resolveModule, resolvePath, unwrap } from "./binding.js";

/** The longest text read: a longer value is left unread, so constants built on each other cannot grow without end. */
const MAX_LENGTH = 2048;

type Value = string | number;

/** What an expression stands for, where the code spells it out. */
type Ref =
  | { kind: "value"; value: Value }
  /** An enum's members by name, null for one not read, and the names its numeric values map back to at run time. */
  | { kind: "enum"; members: Map<string, Value | null>; reverse: Map<string, string> | undefined }
  /** An object literal; `deep` where its nested object literals cannot change either (`as const`, or written in place). */
  | { kind: "object"; node: ts.ObjectLiteralExpression; deep: boolean }
  | { kind: "array"; node: ts.ArrayLiteralExpression }
  /** A module, as `import * as ns` and `export * as ns` give it. */
  | { kind: "module"; file: string };

/**
 * What a module exports under a name: the node that declares it (or the expression `export default` gives), a module,
 * or the binding of a package the repository does not hold that it passes on (`export { Route } from "react-router"`),
 * by the package and the name it exports there; undefined where the module exports no such name, null where it may
 * but atlas does not read what (a module not read, two `export *` that give it differently).
 */
export type Exported = { node: ts.Node } | { file: string } | { module: string; name: string };
type Found = Exported | null | undefined;

/** Where a module specifier leads: a file of the repository. */
type Resolved = { file: string };

/**
 * The conditions Node.js resolves a package's `exports` under: for an `import` or a `require`, with and without
 * `module-sync` (on from Node.js 22.12), always with `node` and `default`.
 */
const CONDITIONS = [["import"], ["require"], ["import", "module-sync"], ["require", "module-sync"]].map((c) => new Set(["node", ...c, "default"]));

interface TsConfig {
  baseUrl?: string;
  paths?: Record<string, unknown>;
  /** The directory of the configuration that sets `paths`, which they are relative to when no `baseUrl` is set. */
  pathsDir?: string;
}

const isScript = (f: string) => /\.(m|c)?[jt]sx?$/.test(f);
const hasModifier = (n: ts.Node, kind: ts.SyntaxKind) => ts.canHaveModifiers(n) && !!ts.getModifiers(n)?.some((m) => m.kind === kind);
const own = (o: object, key: string) => Object.prototype.hasOwnProperty.call(o, key);

/** `x as const` or `<const>x` around an expression (through parentheses and other assertions). */
function constAsserted(e: ts.Expression): boolean {
  for (let x: ts.Expression = e; ; ) {
    if ((ts.isAsExpression(x) || ts.isTypeAssertionExpression(x)) && ts.isConstTypeReference(x.type)) return true;
    if (ts.isParenthesizedExpression(x) || ts.isAsExpression(x) || ts.isSatisfiesExpression(x) || ts.isTypeAssertionExpression(x) || ts.isNonNullExpression(x)) x = x.expression;
    else return false;
  }
}

/** The object literal `Object.freeze({ ... })` freezes (the global `Object`), which keeps its own properties as written. */
function frozen(e: ts.Expression): ts.ObjectLiteralExpression | undefined {
  const u = unwrap(e);
  if (!ts.isCallExpression(u) || u.arguments.length !== 1 || !ts.isPropertyAccessExpression(u.expression) || u.expression.name.text !== "freeze") return undefined;
  const object = u.expression.expression;
  const arg = unwrap(u.arguments[0]!);
  return ts.isIdentifier(object) && object.text === "Object" && !declarationOf(object) && ts.isObjectLiteralExpression(arg) ? arg : undefined;
}

/** A property or member name as the object holds it; undefined where it is computed from something not read. */
function keyOf(name: ts.PropertyName, value: (e: ts.Expression) => Value | undefined): string | undefined {
  if (ts.isComputedPropertyName(name)) {
    const v = value(name.expression);
    return v === undefined ? undefined : String(v);
  }
  if (ts.isNumericLiteral(name)) return String(Number(name.text));
  return ts.isIdentifier(name) || ts.isStringLiteral(name) || ts.isNoSubstitutionTemplateLiteral(name) ? name.text : undefined;
}

/** A literal an enum member may be initialized with: a string, a number, or a number with its sign. */
function literal(e: ts.Expression): Value | undefined {
  const u = unwrap(e);
  if (ts.isStringLiteral(u) || ts.isNoSubstitutionTemplateLiteral(u)) return u.text;
  if (ts.isNumericLiteral(u)) return Number(u.text);
  if (ts.isPrefixUnaryExpression(u) && ts.isNumericLiteral(unwrap(u.operand)) && (u.operator === ts.SyntaxKind.MinusToken || u.operator === ts.SyntaxKind.PlusToken)) {
    const n = Number((unwrap(u.operand) as ts.NumericLiteral).text);
    return u.operator === ts.SyntaxKind.MinusToken ? -n : n;
  }
  return undefined;
}

/**
 * Reads the strings TypeScript and JavaScript code spells out, across the files of a repository: literals, templates
 * and `+` of those, and names that hold them, followed through imports to the module that declares them.
 *
 * A name holds a value where it is a `const` initialized with one; a member of an enum whose member is initialized with
 * a literal, or has none and is first (0) or follows a numeric member (TypeScript's auto-increment, which an ambient
 * enum that is not `const` does not have), with a numeric enum's reverse mapping (`E[0]`); a property of an object literal held in a `const` with `as const` (or frozen with `Object.freeze`, one level
 * deep), as its last own property of that name (a spread or a computed name not read may set any); the elements of a
 * `const` array. A `let`, a parameter, a member computed from anything else, an accessor, a method and anything an
 * object inherits (`constructor`) are not read.
 *
 * Imports are followed to the module that exports the name: a relative specifier as `resolveModule` resolves it, else
 * through the `paths` (and `baseUrl`) of the nearest `tsconfig.json` above the importing file, with its relative
 * `extends`, as TypeScript resolves them; else to a package of the workspace (the root package.json's `workspaces` or
 * pnpm-workspace.yaml) at the file Node.js loads (see `packageEntry`); where that is a build output not committed, at
 * the one source its path mirrors (see `built`). Re-exports are followed as ECMAScript's ResolveExport does (`export {
 * x as y } from`, `export { imported }`, `export *`, `export * as ns`): a module's own export hides `export *`, and a
 * name two `export *` give from different bindings, or one from a module not read, is not read. Cycles of imports or of
 * constants end unread.
 */
export class Constants {
  private readonly parsed = new Map<string, ts.SourceFile | null>();
  private readonly refs = new Map<ts.Node, Ref | undefined>();
  private readonly pending = new Set<ts.Node>();
  private readonly visiting = new Set<string>();
  private readonly configs = new Map<string, TsConfig | undefined>();
  private readonly sources = new Map<string, string | undefined>();
  private workspace: Map<string, string[]> | undefined;

  constructor(private readonly source: Pick<Source, "read" | "list">) {}

  /** The string an expression is, where the code spells it out. */
  text(e: ts.Expression | undefined): string | undefined {
    const v = e && this.value(e);
    return typeof v === "string" ? v : undefined;
  }

  /** The elements of the array an expression is: written in place, or held in a `const`. */
  elements(e: ts.Expression | undefined): readonly ts.Expression[] | undefined {
    const r = e && this.ref(e);
    return r?.kind === "array" ? r.node.elements : undefined;
  }

  private value(e: ts.Expression): Value | undefined {
    const r = this.ref(e);
    return r?.kind === "value" ? r.value : undefined;
  }

  private ref(e: ts.Expression): Ref | undefined {
    const u = unwrap(e);
    const lit = literal(u);
    if (lit !== undefined) return { kind: "value", value: lit };
    if (ts.isTemplateExpression(u)) {
      let s = u.head.text;
      for (const span of u.templateSpans) {
        const v = this.value(span.expression);
        if (v === undefined) return undefined;
        s += String(v) + span.literal.text;
        if (s.length > MAX_LENGTH) return undefined;
      }
      return { kind: "value", value: s };
    }
    if (ts.isBinaryExpression(u) && u.operatorToken.kind === ts.SyntaxKind.PlusToken) {
      const l = this.value(u.left);
      const r = l === undefined ? undefined : this.value(u.right);
      if (l === undefined || r === undefined) return undefined;
      const v = typeof l === "string" || typeof r === "string" ? String(l) + String(r) : l + r;
      return typeof v === "string" && v.length > MAX_LENGTH ? undefined : { kind: "value", value: v };
    }
    if (ts.isIdentifier(u)) {
      const d = declarationOf(u);
      return d ? this.declaration(d) : undefined;
    }
    if (ts.isPropertyAccessExpression(u)) return ts.isIdentifier(u.name) ? this.member(this.ref(u.expression), u.name.text) : undefined;
    if (ts.isElementAccessExpression(u)) {
      const key = this.value(u.argumentExpression);
      return key === undefined ? undefined : this.member(this.ref(u.expression), String(key));
    }
    if (ts.isArrayLiteralExpression(u)) return { kind: "array", node: u };
    // Written in place, nothing can change it before it is read.
    if (ts.isObjectLiteralExpression(u)) return { kind: "object", node: u, deep: true };
    return undefined;
  }

  /** What a declaration binds its name to; a cycle of constants ends unread. */
  private declaration(d: ts.Node): Ref | undefined {
    if (this.refs.has(d)) return this.refs.get(d);
    if (this.pending.has(d)) return undefined;
    this.pending.add(d);
    const r = this.bound(d);
    this.pending.delete(d);
    this.refs.set(d, r);
    return r;
  }

  private bound(d: ts.Node): Ref | undefined {
    if (ts.isVariableDeclaration(d)) {
      // A `const`: `let`, `var` and `using` may hold another value by the time it is read.
      const isConst = (d.parent.flags & ts.NodeFlags.Const) !== 0 && (d.parent.flags & (ts.NodeFlags.Let | ts.NodeFlags.Using)) === 0;
      if (!ts.isIdentifier(d.name) || !d.initializer || !isConst) return undefined;
      return this.held(d.initializer, true);
    }
    if (ts.isEnumDeclaration(d)) return this.enumOf(d);
    const file = d.getSourceFile().fileName;
    if (ts.isImportSpecifier(d)) {
      const decl = d.parent.parent.parent;
      if (d.isTypeOnly || decl.importClause?.isTypeOnly || !ts.isStringLiteral(decl.moduleSpecifier)) return undefined;
      return this.exportedRef(this.imported(file, decl.moduleSpecifier.text, (d.propertyName ?? d.name).text));
    }
    if (ts.isImportClause(d)) {
      if (d.isTypeOnly || !ts.isStringLiteral(d.parent.moduleSpecifier)) return undefined;
      return this.exportedRef(this.imported(file, d.parent.moduleSpecifier.text, "default"));
    }
    if (ts.isNamespaceImport(d)) {
      const decl = d.parent.parent;
      if (decl.importClause?.isTypeOnly || !ts.isStringLiteral(decl.moduleSpecifier)) return undefined;
      const target = this.resolve(file, decl.moduleSpecifier.text);
      return target ? { kind: "module", file: target.file } : undefined;
    }
    return undefined;
  }

  /**
   * What an expression a name or a property holds is. An object literal is read only where it cannot change: `as const`
   * (deeply), frozen (its own properties), or nested in one that is deeply constant (`mutable` false).
   */
  private held(init: ts.Expression, mutable: boolean): Ref | undefined {
    const freeze = frozen(init);
    if (freeze) return { kind: "object", node: freeze, deep: false };
    const r = this.ref(init);
    if (r?.kind !== "object" || !ts.isObjectLiteralExpression(unwrap(init))) return r;
    if (constAsserted(init)) return { ...r, deep: true };
    return mutable ? undefined : r;
  }

  /** A member of what a reference is: an enum's, an object's own property, a module's export. */
  private member(r: Ref | undefined, key: string): Ref | undefined {
    if (!r) return undefined;
    if (r.kind === "enum") {
      const v = r.members.has(key) ? r.members.get(key) : r.reverse?.get(key);
      return v === undefined || v === null ? undefined : { kind: "value", value: v };
    }
    if (r.kind === "module") return this.exportedRef(this.exported(r.file, key));
    if (r.kind !== "object" || key === "__proto__") return undefined;
    // A computed name that refers back to the object (`{ [O.x]: "a" }`) ends unread.
    const value = (e: ts.Expression) => {
      if (this.pending.has(e)) return undefined;
      this.pending.add(e);
      try {
        return this.value(e);
      } finally {
        this.pending.delete(e);
      }
    };
    // The last property of the name is the one the object holds; one before it that may set any name hides nothing.
    for (let i = r.node.properties.length - 1; i >= 0; i--) {
      const p = r.node.properties[i]!;
      if (ts.isSpreadAssignment(p)) return undefined;
      const k = p.name ? keyOf(p.name, value) : undefined;
      if (k === undefined) return undefined;
      if (k !== key) continue;
      if (!ts.isShorthandPropertyAssignment(p) && !ts.isPropertyAssignment(p)) return undefined;
      // A property that refers back to itself (`{ a: A.b, b: A.a }`) ends unread.
      if (this.pending.has(p)) return undefined;
      this.pending.add(p);
      try {
        return ts.isShorthandPropertyAssignment(p) ? this.ref(p.name) : this.held(p.initializer, !r.deep);
      } finally {
        this.pending.delete(p);
      }
    }
    return undefined;
  }

  /** The members of an enum and of the declarations of its name it merges with in the same scope. */
  private enumOf(d: ts.EnumDeclaration): Ref {
    const scope = d.parent as ts.SourceFile | ts.ModuleBlock;
    const all = scope.statements.filter((s): s is ts.EnumDeclaration => ts.isEnumDeclaration(s) && s.name.text === d.name.text);
    const members = new Map<string, Value | null>();
    const value = (e: ts.Expression) => this.value(e);
    let unreadName = false;
    for (const decl of all) {
      // A member of an ambient enum that is not const takes its value from the code that defines the enum at run time,
      // not from its place: TypeScript counts it computed, so only an initializer gives it one.
      const counted = hasModifier(decl, ts.SyntaxKind.ConstKeyword) || !ambient(decl);
      // Each declaration counts from 0 again; TypeScript requires an initializer on the first member of all but one.
      let previous: Value | null | undefined;
      for (const m of decl.members) {
        const v = m.initializer ? (literal(m.initializer) ?? null) : !counted ? null : previous === undefined ? 0 : typeof previous === "number" ? previous + 1 : null;
        previous = v;
        const name = keyOf(m.name, value);
        if (name === undefined) unreadName = true;
        else members.set(name, v);
      }
    }
    // A const enum is inlined and keeps no object to map back from; a member not read may hold any number.
    const constant = all.some((x) => hasModifier(x, ts.SyntaxKind.ConstKeyword));
    let reverse: Map<string, string> | undefined;
    if (!constant && !unreadName && ![...members.values()].includes(null)) {
      reverse = new Map();
      for (const [name, v] of members) if (typeof v === "number") reverse.set(String(v), name);
      for (const name of members.keys()) reverse.delete(name);
    }
    // A member whose name is not read may be the one asked for.
    return unreadName ? { kind: "enum", members: new Map(), reverse: undefined } : { kind: "enum", members, reverse };
  }

  /**
   * What the module an import names exports under a name, followed through its re-exports as `exported` follows them:
   * the node that declares it, or the expression `export default` gives; a module; or the package and name of a binding
   * it passes on from a package the repository does not hold. Undefined where it is not read.
   */
  exportOf(from: string, spec: string, name: string): Exported | undefined {
    return this.imported(from, spec, name) ?? undefined;
  }

  private exportedRef(x: Found): Ref | undefined {
    if (!x || "module" in x) return undefined;
    if ("file" in x) return { kind: "module", file: x.file };
    // What `export default` gives may be changed by any module that imports it, as a `let` may.
    if (ts.isExpression(x.node)) return this.held(x.node, true);
    return this.declaration(x.node);
  }

  private parse(file: string): ts.SourceFile | undefined {
    if (!this.parsed.has(file)) {
      const text = isScript(file) ? this.source.read(file) : undefined;
      this.parsed.set(file, text === undefined ? null : ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true, /x$/.test(file) ? ts.ScriptKind.TSX : ts.ScriptKind.TS));
    }
    return this.parsed.get(file) ?? undefined;
  }

  /** The name a module imports from `spec`, in the module it resolves to; null where that module is not read. */
  private imported(from: string, spec: string, name: string): Found {
    const target = this.resolve(from, spec);
    if (target) return this.exported(target.file, name);
    // A package the repository does not hold exports what its own code says; only its name and the binding's are known.
    return spec.startsWith(".") || spec.startsWith("/") || /^[a-z][\w+.-]*:/i.test(spec) ? null : { module: spec, name };
  }

  /**
   * What a module exports under a name, followed through its re-exports. A name asked again while it is being resolved
   * is a circular request, which ECMAScript's ResolveExport answers with no export.
   */
  private exported(file: string, name: string): Found {
    const key = `${file}\0${name}`;
    const sf = this.parse(file);
    if (!sf) return null;
    if (this.visiting.has(key)) return undefined;
    this.visiting.add(key);
    try {
      return this.exportedFrom(sf, name);
    } finally {
      this.visiting.delete(key);
    }
  }

  private exportedFrom(sf: ts.SourceFile, name: string): Found {
    const file = sf.fileName;
    const stars: string[] = [];
    for (const st of sf.statements) {
      if (ts.isExportAssignment(st)) {
        if (!st.isExportEquals && name === "default") return { node: st.expression };
        continue;
      }
      if (ts.isExportDeclaration(st)) {
        if (st.isTypeOnly) continue;
        const spec = st.moduleSpecifier && ts.isStringLiteral(st.moduleSpecifier) ? st.moduleSpecifier.text : undefined;
        if (st.moduleSpecifier && spec === undefined) continue;
        if (!st.exportClause) {
          if (spec !== undefined) stars.push(spec);
          continue;
        }
        if (ts.isNamespaceExport(st.exportClause)) {
          if (spec === undefined || st.exportClause.name.text !== name) continue;
          const target = this.resolve(file, spec);
          return target ? { file: target.file } : null;
        }
        for (const el of st.exportClause.elements) {
          if (el.isTypeOnly || el.name.text !== name) continue;
          const local = (el.propertyName ?? el.name).text;
          // The module exports the name: what it is, where it cannot be followed, is not read.
          if (spec !== undefined) return this.imported(file, spec, local) ?? null;
          return this.local(sf, local);
        }
        continue;
      }
      if (!hasModifier(st, ts.SyntaxKind.ExportKeyword)) continue;
      // The module's own export of the name hides any `export *` that gives it, read or not.
      const isDefault = hasModifier(st, ts.SyntaxKind.DefaultKeyword);
      const d = isDefault ? (name === "default" ? st : undefined) : binding(st, name);
      if (d) return { node: d };
    }
    // `export *` passes on no default, and a name two of them give differently is exported by neither.
    if (name === "default") return undefined;
    let found: Exported | undefined;
    for (const spec of stars) {
      const target = this.resolve(file, spec);
      // A module not read, or one that may give the name, may give it differently.
      const x = target ? this.exported(target.file, name) : null;
      if (x === null) return null;
      if (!x) continue;
      if (found && !sameExport(found, x)) return null;
      found = x;
    }
    return found;
  }

  /**
   * What `export { local }` exports: the module's own binding, or, for a name it imports, the binding that import
   * resolves to (ECMAScript's indirect export), so two modules that pass on one binding give the same.
   */
  private local(sf: ts.SourceFile, local: string): Found {
    const node = topLevel(sf, local);
    if (!node) return null;
    const decl = ts.isImportSpecifier(node) ? node.parent.parent.parent : ts.isImportClause(node) ? node.parent : ts.isNamespaceImport(node) ? node.parent.parent : undefined;
    if (!decl) return { node };
    // A type imported is exported as a type only.
    if (decl.importClause?.isTypeOnly || (ts.isImportSpecifier(node) && node.isTypeOnly) || !ts.isStringLiteral(decl.moduleSpecifier)) return null;
    const spec = decl.moduleSpecifier.text;
    if (ts.isNamespaceImport(node)) {
      const target = this.resolve(sf.fileName, spec);
      return target ? { file: target.file } : null;
    }
    return this.imported(sf.fileName, spec, ts.isImportSpecifier(node) ? (node.propertyName ?? node.name).text : "default") ?? null;
  }

  /** A module specifier resolved as TypeScript and the workspace resolve it: relative, by `paths` and `baseUrl`, to a package. */
  private resolve(from: string, spec: string): Resolved | undefined {
    const exists = (f: string) => isScript(f) && this.source.read(f) !== undefined;
    if (spec.startsWith(".")) {
      const file = resolveModule(from, spec, exists);
      return file ? { file } : undefined;
    }
    if (spec.startsWith("/") || /^[a-z][\w+.-]*:/i.test(spec)) return undefined;
    const config = this.configFor(from);
    if (config?.paths) {
      const base = config.baseUrl ?? config.pathsDir ?? "";
      for (const target of matchPaths(config.paths, spec)) {
        const path = joinPath(base, target);
        const file = path === undefined ? undefined : resolvePath(path, exists);
        if (file) return { file };
      }
    }
    if (config?.baseUrl !== undefined) {
      const path = joinPath(config.baseUrl, spec);
      const file = path === undefined ? undefined : resolvePath(path, exists);
      if (file) return { file };
    }
    return this.packageEntry(spec, exists);
  }

  /** The configuration of the nearest `tsconfig.json` above a file. */
  private configFor(file: string): TsConfig | undefined {
    const parts = file.split("/").slice(0, -1);
    for (let i = parts.length; i >= 0; i--) {
      const dir = parts.slice(0, i).join("/");
      if (!this.configs.has(dir)) {
        const path = dir ? `${dir}/tsconfig.json` : "tsconfig.json";
        this.configs.set(dir, this.source.read(path) === undefined ? undefined : this.loadConfig(path, []));
      }
      const config = this.configs.get(dir);
      if (config) return config;
    }
    return undefined;
  }

  /**
   * A tsconfig's `baseUrl` and `paths`, those of the configurations it extends by a relative path coming first, each in
   * the order listed. `ancestors` are the configurations extending this one, which it cannot extend again; a base that
   * two of its bases extend is read under each.
   */
  private loadConfig(path: string, ancestors: string[]): TsConfig {
    const text = this.source.read(path);
    if (text === undefined || ancestors.includes(path)) return {};
    const json = ts.parseConfigFileTextToJson(path, text).config as { extends?: unknown; compilerOptions?: { baseUrl?: unknown; paths?: unknown } } | undefined;
    if (!json || typeof json !== "object") return {};
    const dir = path.split("/").slice(0, -1).join("/");
    let out: TsConfig = {};
    const bases = typeof json.extends === "string" ? [json.extends] : Array.isArray(json.extends) ? json.extends : [];
    for (const b of bases) {
      if (typeof b !== "string" || !b.startsWith(".")) continue;
      const p = joinPath(dir, b);
      const file = p === undefined ? undefined : [p, `${p}.json`].find((f) => this.source.read(f) !== undefined);
      if (file) out = { ...out, ...this.loadConfig(file, [...ancestors, path]) };
    }
    const options = json.compilerOptions;
    if (options && typeof options.baseUrl === "string" && !options.baseUrl.startsWith("/")) {
      const base = joinPath(dir, options.baseUrl);
      if (base !== undefined) out.baseUrl = base;
    }
    if (options?.paths && typeof options.paths === "object" && !Array.isArray(options.paths)) {
      out.paths = options.paths as Record<string, unknown>;
      out.pathsDir = dir;
    }
    return out;
  }

  /** The packages of the workspace by name: the directories the root package.json's `workspaces` or pnpm-workspace.yaml list. */
  private packages(): Map<string, string[]> {
    if (this.workspace) return this.workspace;
    this.workspace = new Map();
    const globs: string[] = [];
    try {
      const root = JSON.parse(this.source.read("package.json") ?? "{}") as { workspaces?: unknown };
      const ws = root.workspaces;
      const list = Array.isArray(ws) ? ws : ws && typeof ws === "object" && Array.isArray((ws as { packages?: unknown }).packages) ? (ws as { packages: unknown[] }).packages : [];
      globs.push(...list.filter((g): g is string => typeof g === "string"));
    } catch {
      // A package.json that does not parse lists no workspace.
    }
    try {
      const pnpm = parseYaml(this.source.read("pnpm-workspace.yaml") ?? "") as { packages?: unknown } | null;
      if (Array.isArray(pnpm?.packages)) globs.push(...pnpm.packages.filter((g): g is string => typeof g === "string"));
    } catch {
      // Nor does a pnpm-workspace.yaml that does not parse.
    }
    const clean = (g: string) => g.replace(/^\.\//, "").replace(/\/+$/, "");
    const positive = globs.filter((g) => !g.startsWith("!")).map(clean);
    const negative = globs.filter((g) => g.startsWith("!")).map((g) => clean(g.slice(1)));
    if (!positive.length) return this.workspace;
    const include = picomatch(positive);
    const exclude = negative.length ? picomatch(negative) : () => false;
    for (const f of this.source.list()) {
      if (!f.endsWith("/package.json") || f.includes("node_modules/")) continue;
      const dir = f.slice(0, -"/package.json".length);
      if (!include(dir) || exclude(dir)) continue;
      try {
        const name = (JSON.parse(this.source.read(f) ?? "") as { name?: unknown }).name;
        if (typeof name === "string") this.workspace.set(name, [...(this.workspace.get(name) ?? []), dir]);
      } catch {
        // A package.json that does not parse names no package.
      }
    }
    return this.workspace;
  }

  /**
   * A specifier that names a package of the workspace (`pkg`, `@scope/pkg`, `pkg/sub`): the file Node.js loads for it.
   * With `exports`, the subpath (exact, else the `*` pattern Node.js prefers: the longest text before `*`, then the
   * longest key) and the target its conditions select; every condition set Node.js may resolve under must select the
   * same file, and a subpath `exports` does not list, or blocks with null, names nothing. Without `exports`, the subpath
   * as a file, or `main` (else `index.js`). A target not committed is a build output: see `built`.
   */
  private packageEntry(spec: string, exists: (f: string) => boolean): Resolved | undefined {
    const m = /^((?:@[^/]+\/)?[^/@][^/]*)(\/.*)?$/.exec(spec);
    const dirs = m ? this.packages().get(m[1]!) : undefined;
    if (!m || dirs?.length !== 1) return undefined;
    const dir = dirs[0]!;
    const sub = m[2] ? `.${m[2]}` : ".";
    let manifest: { exports?: unknown; main?: unknown };
    try {
      manifest = JSON.parse(this.source.read(`${dir}/package.json`) ?? "{}") as typeof manifest;
    } catch {
      return undefined;
    }
    // A target as a file of the repository, or the source a build output not committed is made from.
    const located = (target: string): string | undefined => {
      const p = joinPath(dir, target);
      if (p === undefined || (p !== dir && !p.startsWith(`${dir}/`))) return undefined;
      return resolvePath(p, exists) ?? this.built(dir, p);
    };
    if (manifest.exports !== undefined && manifest.exports !== null) {
      const e = manifest.exports;
      const subpaths = typeof e === "object" && !Array.isArray(e) && Object.keys(e).some((k) => k.startsWith(".")) ? (e as Record<string, unknown>) : { ".": e };
      let target: unknown;
      let star = "";
      if (!sub.includes("*") && own(subpaths, sub)) target = subpaths[sub];
      else {
        let best: { pre: number; key: number } | undefined;
        for (const k of Object.keys(subpaths)) {
          const i = k.indexOf("*");
          if (i < 0 || k.indexOf("*", i + 1) >= 0) continue;
          const [pre, post] = [k.slice(0, i), k.slice(i + 1)];
          if (sub.length < pre.length + post.length || !sub.startsWith(pre) || !sub.endsWith(post)) continue;
          // Node.js's PATTERN_KEY_COMPARE: the longer text before `*`, then the longer key.
          if (best && (pre.length < best.pre || (pre.length === best.pre && k.length <= best.key))) continue;
          best = { pre: pre.length, key: k.length };
          target = subpaths[k];
          star = sub.slice(pre.length, sub.length - post.length);
        }
      }
      const picks = CONDITIONS.map((c) => selected(target, c));
      if (picks.some((t) => typeof t !== "string")) return undefined;
      const files = new Set(picks.map((t) => located(t!.replaceAll("*", star))));
      const [file] = files;
      return files.size === 1 && file !== undefined ? { file } : undefined;
    }
    const file = located(sub !== "." ? sub : typeof manifest.main === "string" ? manifest.main : "index.js");
    return file ? { file } : undefined;
  }

  /**
   * The source a package's build output is made from, where the output is not committed: the one TypeScript file of the
   * package (its nested packages left out) whose path, below its first directory or from the package's root, is the
   * output's below its first directory, extension and `index` aside, as an outDir mirrors a source directory
   * (`dist/types/index.d.ts` and `dist/types.mjs` from `src/types/index.ts`). Any other or none is not read.
   */
  private built(dir: string, output: string): string | undefined {
    const key = `${dir}\0${output}`;
    if (this.sources.has(key)) return this.sources.get(key);
    const plain = (r: string) => r.replace(/\.d\.(m|c)?ts$|\.(m|c)?[jt]sx?$/, "").replace(/(^|\/)index$/, "");
    const below = (r: string) => (r.includes("/") ? r.slice(r.indexOf("/") + 1) : r);
    const want = plain(below(output.slice(dir.length + 1)));
    const files = this.source.list().filter((f) => f.startsWith(`${dir}/`) && !f.includes("/node_modules/"));
    const nested = new Set(files.filter((f) => f.endsWith("/package.json")).map((f) => f.slice(0, -"/package.json".length)));
    const inPackage = (f: string) => {
      for (let d = f.slice(0, f.lastIndexOf("/")); d.length > dir.length; d = d.slice(0, d.lastIndexOf("/"))) if (nested.has(d)) return false;
      return true;
    };
    const found = files.filter((f) => {
      if (!/\.(m|c)?tsx?$/.test(f) || /\.d\.(m|c)?ts$/.test(f) || !inPackage(f)) return false;
      const r = f.slice(dir.length + 1);
      return plain(r) === want || (r.includes("/") && plain(below(r)) === want);
    });
    const file = found.length === 1 ? found[0] : undefined;
    this.sources.set(key, file);
    return file;
  }
}

/**
 * The target a conditional `exports` value selects under a set of conditions, as Node.js's PACKAGE_TARGET_RESOLVE: the
 * first key, in order, that is active; an array's first valid target. Null where the subpath is blocked, undefined
 * where no condition applies.
 */
function selected(t: unknown, conditions: Set<string>): string | null | undefined {
  if (typeof t === "string") return t.startsWith("./") ? t : undefined;
  if (t === null) return null;
  if (Array.isArray(t)) {
    for (const x of t) {
      const r = selected(x, conditions);
      if (r !== undefined) return r;
    }
    return undefined;
  }
  if (t && typeof t === "object") {
    for (const [k, v] of Object.entries(t)) {
      if (!conditions.has(k)) continue;
      const r = selected(v, conditions);
      if (r !== undefined) return r;
    }
  }
  return undefined;
}

/** Whether two exports are one binding: the same node, the same module, or the same name of the same package. */
function sameExport(a: Exported, b: Exported): boolean {
  if ("node" in a) return "node" in b && a.node === b.node;
  if ("file" in a) return "file" in b && a.file === b.file;
  return "module" in b && a.module === b.module && a.name === b.name;
}

/** Whether a declaration is ambient: `declare`, in a `declare namespace`, or in a declaration file. */
function ambient(node: ts.Node): boolean {
  for (let n: ts.Node | undefined = node; n; n = n.parent) {
    if (ts.isSourceFile(n)) return n.isDeclarationFile;
    if (hasModifier(n, ts.SyntaxKind.DeclareKeyword)) return true;
  }
  return false;
}

/** The names a binding pattern binds. */
function namesOf(name: ts.BindingName): string[] {
  return ts.isIdentifier(name) ? [name.text] : name.elements.flatMap((e) => (ts.isOmittedExpression(e) ? [] : namesOf(e.name)));
}

/**
 * The node of a top-level statement that binds a value under a name: a variable's declaration (one that destructures
 * included, which is not read), an enum, a class, a function, a namespace or an `import X =`. Types bind no value.
 */
function binding(st: ts.Statement, name: string): ts.Node | undefined {
  if (ts.isVariableStatement(st)) return st.declarationList.declarations.find((d) => namesOf(d.name).includes(name));
  if (ts.isModuleDeclaration(st)) return ts.isIdentifier(st.name) && st.name.text === name ? st : undefined;
  if (ts.isEnumDeclaration(st) || ts.isClassDeclaration(st) || ts.isFunctionDeclaration(st) || ts.isImportEqualsDeclaration(st)) return st.name?.text === name ? st : undefined;
  return undefined;
}

/** The declaration or import of a module's top level that binds a name. */
function topLevel(sf: ts.SourceFile, name: string): ts.Node | undefined {
  for (const st of sf.statements) {
    if (ts.isVariableStatement(st)) {
      const d = st.declarationList.declarations.find((x) => ts.isIdentifier(x.name) && x.name.text === name);
      if (d) return d;
    }
    if ((ts.isEnumDeclaration(st) || ts.isClassDeclaration(st) || ts.isFunctionDeclaration(st)) && st.name?.text === name) return st;
    if (ts.isImportDeclaration(st) && st.importClause) {
      const clause = st.importClause;
      if (clause.name?.text === name) return clause;
      const nb = clause.namedBindings;
      if (nb && ts.isNamespaceImport(nb) && nb.name.text === name) return nb;
      if (nb && ts.isNamedImports(nb)) for (const el of nb.elements) if (el.name.text === name) return el;
    }
  }
  return undefined;
}

/**
 * The substitutions `paths` gives a specifier, as TypeScript matches them: a pattern without `*` exactly, else the
 * pattern with one `*` whose text before it is the longest that matches.
 */
function matchPaths(paths: Record<string, unknown>, spec: string): string[] {
  const list = (v: unknown, star: string) => (Array.isArray(v) ? v.filter((t): t is string => typeof t === "string").map((t) => t.replace("*", star)) : []);
  if (!spec.includes("*") && own(paths, spec)) return list(paths[spec], "");
  let best: { pre: number; key: string; star: string } | undefined;
  for (const key of Object.keys(paths)) {
    const i = key.indexOf("*");
    if (i < 0 || key.indexOf("*", i + 1) >= 0) continue;
    const [pre, post] = [key.slice(0, i), key.slice(i + 1)];
    if (spec.length >= pre.length + post.length && spec.startsWith(pre) && spec.endsWith(post) && (!best || pre.length > best.pre)) {
      best = { pre: pre.length, key, star: spec.slice(pre.length, spec.length - post.length) };
    }
  }
  return best ? list(paths[best.key], best.star) : [];
}
