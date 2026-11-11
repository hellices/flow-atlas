import { posix } from "node:path";
import ts from "typescript";
import type { Source } from "../source.js";
import { declarationOf, importedFrom, unwrap } from "./binding.js";
import type { Constants } from "./constants.js";

/** The text an expression is, or why it is not read. */
export type Read = { text: string } | { unread: string };

/** How many values deep one is followed, and the longest text read. */
const DEPTH = 8;
const MAX_LENGTH = 2048;

const ANGULAR = ["@angular/core"];

/** A file Angular CLI's application builder may swap for another per build (`fileReplacements`): `environments/environment*.ts`. */
const ENVIRONMENT = /(?:^|\/)environments\/environment[^/]*\.ts$/;

/** The outermost node a value is, through the parentheses and assertions around it. */
const valueOf = (n: ts.Node): ts.Node => {
  let v = n;
  while (ts.isParenthesizedExpression(v.parent) || ts.isAsExpression(v.parent) || ts.isSatisfiesExpression(v.parent)) v = v.parent;
  return v;
};

/** Where a node is, the same across the parses of one file. */
const where = (n: ts.Node): string => `${n.getSourceFile().fileName}@${n.getStart()}`;

/**
 * The values an Angular app's code gives its URLs where Angular, not the language, fixes them:
 *
 * - a property of the `environment` object an `environments/environment*.ts` file exports, as Angular CLI documents it
 *   (angular.dev, "Configuring application environments"): the build puts the file each `fileReplacements` entry of
 *   angular.json (or of an Nx project.json) names in its place, so the value is read where every such file gives the
 *   same one and no code writes it, and is not where they differ;
 * - an `InjectionToken`'s value, `inject(TOKEN)` or a constructor parameter `@Inject(TOKEN)`: what the providers of the
 *   repository give it (`{ provide: TOKEN, useValue: v }`, or `useFactory: () => v` with no dependencies), where they
 *   all agree, else its own `factory` (angular.dev, "Defining dependency providers");
 * - a `readonly` or `private` field of a class, initialized with one of these (or a constructor parameter
 *   `@Inject(TOKEN)` that declares it) and written nowhere in the class.
 *
 * Anything else is read as the repository's constants are (`Constants`).
 */
export class AngularValues {
  private readonly cache = new Map<string, Read | undefined>();
  private readonly pending = new Set<string>();
  private files: string[] | undefined;

  constructor(
    private readonly source: Pick<Source, "read" | "list">,
    private readonly constants: Constants,
  ) {}

  /**
   * The text an expression is where Angular fixes it: an environment's property, an injection token's value, a readonly
   * field holding one; undefined for any other expression, which is read as the repository's constants are.
   */
  fixed(e: ts.Expression): Read | undefined {
    const u = unwrap(e);
    if (!ts.isPropertyAccessExpression(u) && !ts.isCallExpression(u)) return undefined;
    return this.angular(u, 0);
  }

  /**
   * Whether a value is what a provider gives an `InjectionToken` (`{ provide: API_URL, useValue: "/api" }`, or what
   * its `useFactory` returns): the token's value, which the code injects where it uses it, no request of its own.
   */
  provided(node: ts.Node): boolean {
    const value = valueOf(node);
    let p = value.parent;
    if (ts.isArrowFunction(p) && p.body === value) p = valueOf(p).parent;
    if (!ts.isPropertyAssignment(p) || (p.initializer !== value && !ts.isArrowFunction(p.initializer))) return false;
    const key = p.name.getText();
    if (key !== "useValue" && key !== "useFactory") return false;
    const provide = p.parent.properties.find((x): x is ts.PropertyAssignment => ts.isPropertyAssignment(x) && x.name.getText() === "provide");
    const target = provide && unwrap(provide.initializer);
    return !!target && ts.isIdentifier(target) && this.isToken(target);
  }

  /** Whether a name binds an `InjectionToken` of `@angular/core`, through imports. */
  private isToken(id: ts.Identifier): boolean {
    const declared = this.declared(id);
    const init = declared && ts.isVariableDeclaration(declared) && declared.initializer ? unwrap(declared.initializer) : undefined;
    return !!init && ts.isNewExpression(init) && ts.isIdentifier(init.expression) && importedFrom(init.expression, ANGULAR) === "InjectionToken";
  }

  /** The text an expression is, where the code and Angular fix it; undefined where it is nothing of the kind. */
  private value(e: ts.Expression, depth = 0): Read | undefined {
    if (depth > DEPTH) return undefined;
    const u = unwrap(e);
    const known = this.constants.text(u);
    if (known !== undefined) return { text: known };
    if (ts.isStringLiteralLike(u)) return { text: u.text };
    if (ts.isTemplateExpression(u)) {
      let text = u.head.text;
      for (const span of u.templateSpans) {
        const v = this.value(span.expression, depth + 1);
        if (!v || "unread" in v) return v;
        text += v.text + span.literal.text;
      }
      return text.length > MAX_LENGTH ? undefined : { text };
    }
    if (ts.isBinaryExpression(u) && u.operatorToken.kind === ts.SyntaxKind.PlusToken) {
      const l = this.value(u.left, depth + 1);
      if (!l || "unread" in l) return l;
      const r = this.value(u.right, depth + 1);
      if (!r || "unread" in r) return r;
      return l.text.length + r.text.length > MAX_LENGTH ? undefined : { text: l.text + r.text };
    }
    return this.angular(u, depth);
  }

  /** An environment's property, an injection token's value, or a readonly field holding one. */
  private angular(u: ts.Expression, depth: number): Read | undefined {
    const key = where(u);
    if (this.cache.has(key)) return this.cache.get(key);
    if (this.pending.has(key)) return undefined;
    this.pending.add(key);
    const found = this.environment(u) ?? this.injected(u, depth) ?? this.field(u, depth);
    this.pending.delete(key);
    this.cache.set(key, found);
    return found;
  }

  /** `environment.apiUrl`: a property of the object an environment file exports, the same in each file the build may use. */
  private environment(e: ts.Expression): Read | undefined {
    if (!ts.isPropertyAccessExpression(e) || !ts.isIdentifier(e.expression)) return undefined;
    const declared = this.declared(e.expression);
    if (!declared || !ts.isVariableDeclaration(declared) || !ts.isIdentifier(declared.name)) return undefined;
    const file = declared.getSourceFile().fileName;
    if (!ENVIRONMENT.test(file)) return undefined;
    const name = declared.name.text;
    const replaced = this.replacements(file);
    if (this.writes(declared, e.name.text)) return { unread: `the code writes ${name}.${e.name.text}` };
    const files = [file, ...replaced];
    const values = files.map((f) => this.property(f, name, e.name.text));
    const read = values.filter((v): v is string => v !== undefined);
    if (read.length !== values.length) return { unread: `${name}.${e.name.text} is not read in ${files.filter((_, i) => values[i] === undefined).join(", ")}` };
    if (new Set(read).size > 1) return { unread: `${files.join(" and ")} give ${name}.${e.name.text} different values` };
    return { text: read[0]! };
  }

  /** A property of the object literal a file exports as a `const` of that name: its own, last, literal value. */
  private property(file: string, name: string, key: string): string | undefined {
    const sf = this.constants.sourceFile(file);
    for (const st of sf?.statements ?? []) {
      if (!ts.isVariableStatement(st) || !(st.declarationList.flags & ts.NodeFlags.Const)) continue;
      for (const d of st.declarationList.declarations) {
        if (!ts.isIdentifier(d.name) || d.name.text !== name || !d.initializer) continue;
        const o = unwrap(d.initializer);
        if (!ts.isObjectLiteralExpression(o)) return undefined;
        for (let i = o.properties.length - 1; i >= 0; i--) {
          const p = o.properties[i]!;
          if (ts.isSpreadAssignment(p) || !p.name || ts.isComputedPropertyName(p.name)) return undefined;
          if (p.name.getText().replace(/^["']|["']$/g, "") !== key) continue;
          return ts.isPropertyAssignment(p) ? this.constants.text(p.initializer) : undefined;
        }
        return undefined;
      }
    }
    return undefined;
  }

  /**
   * The files an Angular build puts in a file's place (`fileReplacements`, in any configuration of any project), read
   * from the angular.json above the file, whose paths start at its directory, and the Nx project.json above it, whose
   * paths start at the workspace's root (the directory of nx.json).
   */
  private replacements(file: string): string[] {
    const parts = file.split("/").slice(0, -1);
    const configs: Array<{ json: unknown; root: string }> = [];
    for (let n = parts.length; n >= 0; n--) {
      const dir = parts.slice(0, n).join("/");
      const at = (name: string) => (dir ? `${dir}/${name}` : name);
      const workspace = this.json(at("angular.json"));
      if (workspace !== undefined) configs.push({ json: workspace, root: dir });
      const project = this.json(at("project.json"));
      if (project !== undefined) configs.push({ json: project, root: this.nxRoot(parts.slice(0, n)) });
    }
    const out = new Set<string>();
    for (const { json, root } of configs) {
      const visit = (v: unknown): void => {
        if (Array.isArray(v)) v.forEach(visit);
        else if (v && typeof v === "object") {
          for (const [k, x] of Object.entries(v)) {
            if (k === "fileReplacements" && Array.isArray(x)) {
              for (const r of x as Array<Record<string, unknown>>) {
                if (typeof r?.replace !== "string" || typeof r.with !== "string") continue;
                if (posix.normalize(posix.join(root, r.replace)) === file) out.add(posix.normalize(posix.join(root, r.with)));
              }
            } else visit(x);
          }
        }
      };
      visit(json);
    }
    return [...out];
  }

  /** A JSON file's value, undefined where it is absent or not JSON. */
  private json(file: string): unknown {
    const text = this.source.read(file);
    if (text === undefined) return undefined;
    try {
      return JSON.parse(text) as unknown;
    } catch {
      return undefined;
    }
  }

  /** The workspace root of an Nx project in a directory: the nearest directory above it with nx.json, else the repository's. */
  private nxRoot(parts: string[]): string {
    for (let n = parts.length; n > 0; n--) if (this.source.read(`${parts.slice(0, n).join("/")}/nx.json`) !== undefined) return parts.slice(0, n).join("/");
    return "";
  }

  /**
   * Whether a script of the repository writes the property of the object a declaration holds (`environment.apiUrl =
   * ...`, `environment["apiUrl"] ??= ...`) or the object whole (`Object.assign(environment, ...)`), through any name
   * that binds it.
   */
  private writes(declared: ts.Node, key: string): boolean {
    const same = (e: ts.Expression): boolean => {
      const u = unwrap(e);
      if (!ts.isIdentifier(u)) return false;
      const d = this.declared(u);
      return !!d && where(d) === where(declared);
    };
    const assigned = (n: ts.BinaryExpression) => n.operatorToken.kind >= ts.SyntaxKind.FirstAssignment && n.operatorToken.kind <= ts.SyntaxKind.LastAssignment;
    for (const file of this.scripts()) {
      if (!(this.source.read(file) ?? "").includes(key)) continue;
      const sf = this.constants.sourceFile(file);
      let found = false;
      const visit = (n: ts.Node): void => {
        if (found) return;
        if (ts.isBinaryExpression(n) && assigned(n)) {
          const left = unwrap(n.left);
          const name = ts.isPropertyAccessExpression(left) ? left.name.text : ts.isElementAccessExpression(left) && ts.isStringLiteralLike(left.argumentExpression) ? left.argumentExpression.text : undefined;
          if (name === key && same((left as ts.PropertyAccessExpression | ts.ElementAccessExpression).expression)) found = true;
        }
        if (ts.isCallExpression(n) && n.arguments[0] && same(n.arguments[0])) {
          const callee = unwrap(n.expression);
          if (ts.isPropertyAccessExpression(callee) && ts.isIdentifier(callee.expression) && callee.expression.text === "Object" && ["assign", "defineProperty", "defineProperties"].includes(callee.name.text)) found = true;
        }
        ts.forEachChild(n, visit);
      };
      if (sf) visit(sf);
      if (found) return true;
    }
    return false;
  }

  /** `inject(TOKEN)`: the value the providers of the repository give the token, where they agree, else its factory's. */
  private injected(e: ts.Expression, depth: number): Read | undefined {
    if (!ts.isCallExpression(e) || !ts.isIdentifier(e.expression) || importedFrom(e.expression, ANGULAR) !== "inject" || !e.arguments[0]) return undefined;
    return this.token(e.arguments[0], depth);
  }

  private token(t: ts.Expression, depth: number): Read | undefined {
    const id = unwrap(t);
    if (!ts.isIdentifier(id)) return undefined;
    const declared = this.declared(id);
    const init = declared && ts.isVariableDeclaration(declared) && declared.initializer ? unwrap(declared.initializer) : undefined;
    if (!init || !ts.isNewExpression(init) || !ts.isIdentifier(init.expression) || importedFrom(init.expression, ANGULAR) !== "InjectionToken") return undefined;
    const name = id.text;
    const provided: Read[] = [];
    for (const file of this.providerFiles()) {
      const sf = this.constants.sourceFile(file);
      if (!sf) continue;
      const visit = (n: ts.Node): void => {
        if (ts.isObjectLiteralExpression(n)) {
          const provide = n.properties.find((p): p is ts.PropertyAssignment => ts.isPropertyAssignment(p) && p.name.getText() === "provide");
          const target = provide && unwrap(provide.initializer);
          const same = target && ts.isIdentifier(target) ? this.declared(target) : undefined;
          if (same && where(same) === where(declared!)) provided.push(this.provider(n, name, depth));
        }
        ts.forEachChild(n, visit);
      };
      visit(sf);
    }
    if (!provided.length) {
      const factory = this.factory(init, depth);
      return factory ?? { unread: `no provider the code writes gives ${name} a value` };
    }
    const unread = provided.find((p): p is { unread: string } => "unread" in p);
    if (unread) return unread;
    const texts = new Set(provided.map((p) => (p as { text: string }).text));
    return texts.size === 1 ? provided[0] : { unread: `the providers of ${name} give it different values` };
  }

  /** What a provider gives: `useValue`, or what `useFactory`, a function of no dependencies, returns. */
  private provider(o: ts.ObjectLiteralExpression, name: string, depth: number): Read {
    const own = (key: string) => o.properties.find((p): p is ts.PropertyAssignment => ts.isPropertyAssignment(p) && p.name.getText() === key);
    if (o.properties.some((p) => ts.isSpreadAssignment(p) || (p.name && ts.isComputedPropertyName(p.name)))) return { unread: `a provider of ${name} is not read` };
    const value = own("useValue");
    if (value) return this.value(value.initializer, depth + 1) ?? { unread: `a provider of ${name} gives it a value atlas does not read` };
    const factory = own("useFactory");
    const fn = factory && unwrap(factory.initializer);
    if (fn && ts.isArrowFunction(fn) && !fn.parameters.length && !own("deps") && !ts.isBlock(fn.body)) return this.value(fn.body, depth + 1) ?? { unread: `a provider of ${name} gives it a value atlas does not read` };
    return { unread: `a provider of ${name} gives it a value atlas does not read` };
  }

  /** The value `new InjectionToken(desc, { factory: () => v })` gives where no provider does. */
  private factory(init: ts.NewExpression, depth: number): Read | undefined {
    const options = init.arguments?.[1] && unwrap(init.arguments[1]);
    if (!options || !ts.isObjectLiteralExpression(options)) return undefined;
    const f = options.properties.find((p): p is ts.PropertyAssignment => ts.isPropertyAssignment(p) && p.name.getText() === "factory");
    const fn = f && unwrap(f.initializer);
    return fn && ts.isArrowFunction(fn) && !ts.isBlock(fn.body) ? this.value(fn.body, depth + 1) : undefined;
  }

  /**
   * `this.base`: a `readonly` or `private` field of the class around it, initialized with a value read here (or a
   * constructor parameter `@Inject(TOKEN)` the field is), that no code of the class writes.
   */
  private field(e: ts.Expression, depth: number): Read | undefined {
    if (!ts.isPropertyAccessExpression(e) || e.expression.kind !== ts.SyntaxKind.ThisKeyword || !ts.isIdentifier(e.name)) return undefined;
    const cls = ts.findAncestor(e, ts.isClassLike);
    if (!cls) return undefined;
    const name = e.name.text;
    // A readonly field, or a private one (which no code outside the class may write), holds what it is given.
    const readonly = (m: ts.Node) => !!ts.getModifiers(m as ts.HasModifiers)?.some((x) => x.kind === ts.SyntaxKind.ReadonlyKeyword || x.kind === ts.SyntaxKind.PrivateKeyword);
    let written = false;
    const visit = (n: ts.Node): void => {
      if (ts.isBinaryExpression(n) && n.operatorToken.kind >= ts.SyntaxKind.FirstAssignment && n.operatorToken.kind <= ts.SyntaxKind.LastAssignment) {
        const left = unwrap(n.left);
        if (ts.isPropertyAccessExpression(left) && left.expression.kind === ts.SyntaxKind.ThisKeyword && left.name.text === name) written = true;
      }
      ts.forEachChild(n, visit);
    };
    visit(cls);
    if (written) return undefined;
    for (const m of cls.members) {
      if (ts.isPropertyDeclaration(m) && ts.isIdentifier(m.name) && m.name.text === name) return readonly(m) && m.initializer ? this.value(m.initializer, depth + 1) : undefined;
      if (ts.isConstructorDeclaration(m)) {
        const p = m.parameters.find((x) => ts.isIdentifier(x.name) && x.name.text === name && readonly(x));
        const inject = p && ts.getDecorators(p)?.map((d) => d.expression).find((d): d is ts.CallExpression => ts.isCallExpression(d) && ts.isIdentifier(d.expression) && importedFrom(d.expression, ANGULAR) === "Inject");
        if (inject?.arguments[0]) return this.token(inject.arguments[0], depth);
      }
    }
    return undefined;
  }

  /** The declaration a name binds, followed through imports to the module that declares it. */
  private declared(id: ts.Identifier): ts.Node | undefined {
    const d = declarationOf(id);
    if (!d || !(ts.isImportSpecifier(d) || ts.isImportClause(d))) return d;
    const decl = ts.isImportSpecifier(d) ? d.parent.parent.parent : d.parent;
    if (!ts.isStringLiteral(decl.moduleSpecifier)) return undefined;
    const x = this.constants.exportOf(id.getSourceFile().fileName, decl.moduleSpecifier.text, ts.isImportSpecifier(d) ? (d.propertyName ?? d.name).text : "default");
    return x && "node" in x ? x.node : undefined;
  }

  /** The script files of the repository. */
  private scripts(): string[] {
    this.files ??= this.source.list().filter((f) => /\.(m|c)?[jt]sx?$/.test(f) && !/(?:^|\/)node_modules\//.test(f));
    return this.files;
  }

  /** The script files of the repository that may write a provider. */
  private providerFiles(): string[] {
    return this.scripts().filter((f) => (this.source.read(f) ?? "").includes("provide"));
  }
}
