import ts from "typescript";
import { declarationOf, importedFrom, resolveModule, unwrap } from "./binding.js";
import type { Source } from "../source.js";

const MAX_FUNCTIONS = 400;
/** Response methods that return the response itself, in Express (`res.status(500)`) and Fastify (`reply.code(201)`). */
const CHAINABLE = new Set(["status", "set", "header", "headers", "type", "cookie", "clearCookie", "location", "links", "vary", "append", "attachment", "code", "removeHeader", "serializer"]);
/**
 * Whether a callee surely makes a request: the global `fetch`, also as `window.fetch` or `globalThis.fetch`. A `get`
 * of some object may as well build a string, so it is not taken for one.
 */
function requestCallee(e: ts.Expression): boolean {
  if (ts.isIdentifier(e)) return e.text === "fetch" && declarationOf(e) === undefined;
  return ts.isPropertyAccessExpression(e) && e.name.text === "fetch" && ts.isIdentifier(e.expression) && /^(?:window|globalThis|self)$/.test(e.expression.text) && declarationOf(e.expression) === undefined;
}

/** JSX props the browser acts on after the page renders: addresses it requests and handlers it runs. */
const LATER_PROPS = /^(?:href|src|srcSet|poster|action|formAction|on[A-Z]\w*)$/;

/**
 * The functions of Next.js that read the request a page is rendered for, by the module they come from: calling one
 * while Next.js prerenders a page stops it, and the page is rendered on each request (`cookies`, `headers`:
 * server/request/cookies.ts, headers.ts; `connection`: connection.ts; `unstable_noStore`: dynamic-rendering.ts).
 */
const REQUEST_TIME: Record<string, string[]> = { "next/headers": ["cookies", "headers"], "next/server": ["connection"], "next/cache": ["unstable_noStore"] };

/**
 * The request-time API a call makes, as `cookies()` or `fetch(..., { cache: "no-store" })`, where it is one: a function
 * of `REQUEST_TIME` called by its imported name (aliased or not) or through a namespace import, and a `fetch` whose
 * options it spells out as `cache: "no-store"` or `next: { revalidate: 0 }`, which Next.js renders on each request
 * (server/lib/patch-fetch.ts).
 */
export function requestTimeCall(call: ts.CallExpression): string | undefined {
  const callee = unwrap(call.expression);
  if (ts.isIdentifier(callee)) {
    for (const [module, names] of Object.entries(REQUEST_TIME)) {
      const name = importedFrom(callee, [module]);
      if (name !== undefined && names.includes(name)) return `${name}()`;
    }
  }
  if (ts.isPropertyAccessExpression(callee) && ts.isIdentifier(callee.expression)) {
    const decl = declarationOf(callee.expression);
    const from = decl && ts.isNamespaceImport(decl) && ts.isStringLiteral(decl.parent.parent.moduleSpecifier) ? decl.parent.parent.moduleSpecifier.text : undefined;
    if (from !== undefined && Object.hasOwn(REQUEST_TIME, from) && REQUEST_TIME[from]!.includes(callee.name.text)) return `${callee.name.text}()`;
  }
  if (requestCallee(callee) && call.arguments[1]) {
    const options = unwrap(call.arguments[1]);
    if (!ts.isObjectLiteralExpression(options)) return undefined;
    const cache = ownProperty(options, "cache");
    if (cache && ts.isStringLiteralLike(cache) && cache.text === "no-store") return 'fetch with cache: "no-store"';
    const next = ownProperty(options, "next");
    const revalidate = next && ts.isObjectLiteralExpression(next) ? ownProperty(next, "revalidate") : undefined;
    if (revalidate && ts.isNumericLiteral(revalidate) && Number(revalidate.text) === 0) return "fetch with next: { revalidate: 0 }";
  }
  return undefined;
}

/** The value an object literal holds under a name, where nothing after it (a spread, a computed name) may replace it. */
function ownProperty(o: ts.ObjectLiteralExpression, name: string): ts.Expression | undefined {
  for (let i = o.properties.length - 1; i >= 0; i--) {
    const p = o.properties[i]!;
    if (ts.isSpreadAssignment(p) || !p.name) return undefined;
    const key = ts.isComputedPropertyName(p.name) ? (ts.isStringLiteralLike(unwrap(p.name.expression)) ? (unwrap(p.name.expression) as ts.StringLiteral).text : undefined) : ts.isIdentifier(p.name) || ts.isStringLiteralLike(p.name) ? p.name.text : undefined;
    if (key === undefined) return undefined;
    if (key === name) return ts.isPropertyAssignment(p) ? unwrap(p.initializer) : undefined;
  }
  return undefined;
}
/**
 * Whether a JSX prop holds the address a link or a form the page renders goes to: the `href` of an `<a>` or `<area>`,
 * the `action` of a `<form>` and the `formAction` of a `<button>` or `<input>` (HTML, Links and Form submission), and
 * the `href` of Next.js's `<Link>` and the `action` of its `<Form>`, which render those (Next.js, Link and Form). A prop
 * of another component holds whatever that component makes of it; a `<link>` loads a resource with the page.
 */
function offeredProp(attr: ts.JsxAttribute): boolean {
  const name = attr.name.getText();
  const tag = attr.parent.parent.tagName;
  if (!ts.isIdentifier(tag)) return false;
  const intrinsic = /^[a-z]/.test(tag.text) ? tag.text : undefined;
  if (name === "href") return intrinsic === "a" || intrinsic === "area" || (!intrinsic && importedFrom(tag, ["next/link"]) === "default");
  if (name === "action") return intrinsic === "form" || (!intrinsic && importedFrom(tag, ["next/form"]) === "default");
  if (name === "formAction") return intrinsic === "button" || intrinsic === "input";
  return false;
}

interface Parsed {
  sf: ts.SourceFile;
  /** Top-level functions and function-valued constants by name. */
  functions: Map<string, ts.Node>;
  /** Local name to the relatively imported module and the name it has there. */
  imports: Map<string, { file: string; name: string }>;
  /** Names re-exported from other modules: `export { a as b } from "./x"` and `export * from "./y"`. */
  reexports: Map<string, { file: string; name: string }>;
  stars: string[];
  /** `import * as ns from "./x"`: the namespace's local name to the module. */
  namespaces: Map<string, string>;
  /** What `export default` gives: a function node, or the name of a top-level function. */
  defaultExport?: ts.Node | string;
  /** Names this module exports as values under their own name (`export function GET`, `export { run }`). */
  exports: Set<string>;
  /** Whether the module uses ES export syntax at all; one that does not (CommonJS) is read by its top-level names. */
  esm: boolean;
}

const isFunctionValue = (n: ts.Node | undefined): boolean =>
  !!n && (ts.isArrowFunction(n) || ts.isFunctionExpression(n));

const hasDefault = (n: ts.Node): boolean =>
  ts.canHaveModifiers(n) && !!ts.getModifiers(n)?.some((m) => m.kind === ts.SyntaxKind.DefaultKeyword);

const hasExport = (n: ts.Node): boolean =>
  ts.canHaveModifiers(n) &&
  !!ts.getModifiers(n)?.some((m) => m.kind === ts.SyntaxKind.ExportKeyword) &&
  !ts.getModifiers(n)?.some((m) => m.kind === ts.SyntaxKind.DeclareKeyword);

function bindingNames(name: ts.BindingName, out: string[] = []): string[] {
  if (ts.isIdentifier(name)) out.push(name.text);
  else for (const el of name.elements) if (!ts.isOmittedExpression(el)) bindingNames(el.name, out);
  return out;
}

/**
 * A `var` of a function's own scope by name, wherever it is declared in the body (blocks and loop heads included,
 * nested functions not): JavaScript hoists it to the whole function.
 */
function functionVar(fn: ts.SignatureDeclaration, name: string): ts.VariableDeclaration | undefined {
  const body = "body" in fn ? (fn.body as ts.Node | undefined) : undefined;
  let found: ts.VariableDeclaration | undefined;
  const visit = (n: ts.Node): void => {
    if (found || (n !== body && ts.isFunctionLike(n))) return;
    if (ts.isVariableDeclarationList(n) && !(n.flags & (ts.NodeFlags.Let | ts.NodeFlags.Const))) {
      for (const d of n.declarations) if (bindingNames(d.name).includes(name)) found = d;
    }
    ts.forEachChild(n, visit);
  };
  if (body) visit(body);
  return found;
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
      const hoisted = functionVar(a, name);
      if (hoisted) return ts.isIdentifier(hoisted.name) && isFunctionValue(hoisted.initializer) ? hoisted.initializer! : null;
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
    const parsed: Parsed = { sf, functions: new Map(), imports: new Map(), reexports: new Map(), stars: [], namespaces: new Map(), exports: new Set(), esm: false };
    for (const st of sf.statements) {
      if (ts.isExportDeclaration(st) || ts.isExportAssignment(st) || hasExport(st)) parsed.esm = true;
      if (hasExport(st) && !hasDefault(st)) {
        if ((ts.isFunctionDeclaration(st) || ts.isClassDeclaration(st)) && st.name) parsed.exports.add(st.name.text);
        if (ts.isVariableStatement(st)) for (const d of st.declarationList.declarations) if (ts.isIdentifier(d.name)) parsed.exports.add(d.name.text);
      }
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
        if (target && nb && ts.isNamespaceImport(nb)) parsed.namespaces.set(nb.name.text, target);
        if (target && nb && ts.isNamedImports(nb)) {
          for (const el of nb.elements) parsed.imports.set(el.name.text, { file: target, name: (el.propertyName ?? el.name).text });
        }
      } else if (ts.isExportDeclaration(st) && !st.isTypeOnly && !st.moduleSpecifier && st.exportClause && ts.isNamedExports(st.exportClause)) {
        // `export { run as handler }` names a binding of this file under another name; `export { type run as GET }`
        // and `export type { run as GET }` name only its type.
        for (const el of st.exportClause.elements) {
          if (el.isTypeOnly) continue;
          const local = (el.propertyName ?? el.name).text;
          if (local !== el.name.text) parsed.reexports.set(el.name.text, { file, name: local });
          else parsed.exports.add(local);
        }
      } else if (ts.isExportDeclaration(st) && !st.isTypeOnly && st.moduleSpecifier && ts.isStringLiteral(st.moduleSpecifier)) {
        // A type-only re-export carries no value, so nothing is followed through it.
        const target = this.resolve(file, st.moduleSpecifier.text);
        if (!target) continue;
        if (!st.exportClause) parsed.stars.push(target);
        else if (ts.isNamedExports(st.exportClause)) {
          for (const el of st.exportClause.elements) {
            if (!el.isTypeOnly) parsed.reexports.set(el.name.text, { file: target, name: (el.propertyName ?? el.name).text });
          }
        }
      }
    }
    this.cache.set(file, parsed);
    return parsed;
  }

  /**
   * A relative module specifier resolved to a file of the source: the TypeScript file a `.js` specifier stands for
   * first, then the specifier as written, then the extensions and index files TypeScript and Node try.
   */
  resolve(from: string, spec: string): string | undefined {
    return resolveModule(from, spec, (f) => this.source.read(f) !== undefined);
  }

  /**
   * The function a module exports under a name, following re-exports to any depth; a re-export cycle ends the search.
   * Only what the module exports as a value counts: a name it keeps to itself, or exports only as a type, is not
   * reached through `export *` or an import.
   */
  exported(file: string, name: string, visiting = new Set<string>()): { file: string; node: ts.Node } | undefined {
    const key = `${file}#${name}`;
    const p = this.parse(file);
    if (!p || visiting.has(key)) return undefined;
    visiting.add(key);
    // A binding of this module: a top-level function, or an import, followed to the module that exports it.
    const binding = (local: string): { file: string; node: ts.Node } | undefined => {
      const fn = p.functions.get(local);
      if (fn) return { file, node: fn };
      const imported = p.imports.get(local);
      return imported ? this.exported(imported.file, imported.name, visiting) : undefined;
    };
    if (name === "default" && p.defaultExport !== undefined) {
      return typeof p.defaultExport !== "string" ? { file, node: p.defaultExport } : binding(p.defaultExport);
    }
    const re = p.reexports.get(name);
    if (re) return re.file === file ? binding(re.name) : this.exported(re.file, re.name, visiting);
    if (p.exports.has(name) || !p.esm) {
      const found = binding(name);
      if (found) return found;
    }
    for (const star of p.stars) {
      const found = this.exported(star, name, visiting);
      if (found) return found;
    }
    return undefined;
  }

  /**
   * Member method names called under `start` in `file`, sorted; `executed` collects `file@offset` of each expression the code
   * hands to a call it runs, so a request written directly in it is known even when it sits in no method of its own. A function declared inside the code, or bound to a
   * local name, is followed only where it is used; a function written inline counts as run when it is a callback
   * argument or called on the spot, and not when it is returned or stored.
   */
  /**
   * `render`: the start is a server-rendered page. What runs while it renders is followed, prop values included; client
   * modules (`"use client"`), addresses (`href`, `src`, `action`), event handlers (`onClick`) and functions passed as
   * props are left out: the browser makes those requests later. `offered` collects the `file@offset` of each address a
   * link or a form the page renders holds (see `offeredProp`), through a comma's last operand, a conditional's branches
   * and the `const`s it names: the requests the page offers to make next. `requestTime` collects each request-time API
   * the code calls (see `requestTimeCall`), as `cookies() at file:line`.
   */
  from(file: string, start: ts.Node, executed?: Set<string>, render = false, offered?: Set<string>, requestTime?: Set<string>): string[] {
    const names = new Set<string>();
    const seen = new Set<string>();
    const queue: Array<{ file: string; node: ts.Node }> = [{ file, node: start }];
    // The handler's own parameters are what the framework hands it (`req`, `res`, `reply`): `res.send()` is the
    // framework's method, not a port of the component, so it names nothing to follow.
    // The start is the handler, the registration call that holds it, or its body (a re-exported function's).
    const handlers = ts.isFunctionLike(start)
      ? [start]
      : ts.isCallExpression(start)
        ? start.arguments.map((a) => unwrap(a)).filter((a) => ts.isFunctionLike(a))
        : ts.isBlock(start) && ts.isFunctionLike(start.parent)
          ? [start.parent]
          : [];
    const framework = new Set<ts.Node>(handlers.flatMap((h) => [...h.parameters]));
    // What each call hands a function's parameter, decided once every call is known: a parameter is the framework's
    // only when every call that reaches it hands it the framework's object.
    const handed: Array<{ arg: ts.Expression; param: ts.ParameterDeclaration }> = [];
    const handedTo = new Map<ts.Node, { framework: boolean; other: boolean }>();
    // `res.send()`, and `res.status(500).send()` on what a chainable response method returns (Express's and Fastify's
    // return the response). Something kept on a parameter (`req.services.mail.send()`), or returned by another of its
    // methods (`req.getClient().send()`), is the component's own, and is followed.
    // A const that holds one (`const reply = res`) is the same object.
    const fromFramework = (receiver: ts.Expression): boolean => {
      let at = unwrap(receiver);
      while (ts.isCallExpression(at) && ts.isPropertyAccessExpression(at.expression) && CHAINABLE.has(at.expression.name.text)) at = unwrap(at.expression.expression);
      // Through any number of aliases; one seen twice is a cycle.
      const visited = new Set<ts.Node>();
      while (ts.isIdentifier(at)) {
        const decl = declarationOf(at);
        const passed = decl && handedTo.get(decl);
        if (decl && (framework.has(decl) || (passed?.framework && !passed.other))) return true;
        if (!decl || visited.has(decl)) return false;
        visited.add(decl);
        const alias = decl && ts.isVariableDeclaration(decl) && decl.initializer && decl.parent.flags & ts.NodeFlags.Const ? unwrap(decl.initializer) : undefined;
        if (!alias || !ts.isIdentifier(alias)) return false;
        at = alias;
      }
      return false;
    };
    // A function the handler hands its response to (`helpers.respond(res)`) gets the framework's object in that
    // parameter: `reply.send()` there is the framework's too.
    const handOn = (call: ts.CallExpression, target: { node: ts.Node }): void => {
      const fn = ts.isFunctionLike(target.node) ? target.node : ts.isBlock(target.node) && ts.isFunctionLike(target.node.parent) ? target.node.parent : undefined;
      if (!fn) return;
      call.arguments.forEach((arg, i) => {
        const param = fn.parameters[i];
        if (param && !param.dotDotDotToken) handed.push({ arg, param });
      });
    };
    const calls: Array<{ member: string; receiver: ts.Expression }> = [];
    while (queue.length && seen.size < MAX_FUNCTIONS) {
      const { file: f, node } = queue.shift()!;
      const parsed = this.parse(f);
      if (!parsed) continue;
      if (render && clientModule(parsed.sf)) continue;
      const classOf = enclosingClass(node);
      // `inCall`: inside a call the code runs, other than the registration call a route handler may start from.
      // `notes`: whether a string the code passes to a call counts as a request it makes; not inside a prop's address
      // or handler, whose text is what the browser uses later.
      const visit = (n: ts.Node, inCall = false, notes = true): void => {
        // `extends make(fetch(x))` runs its expression; its type arguments, like every other type, do not.
        if (ts.isExpressionWithTypeArguments(n)) return visit(n.expression, inCall, notes);
        if (ts.isTypeNode(n) || ts.isImportDeclaration(n)) return;
        if (render && ts.isJsxAttribute(n)) {
          // A prop's value is computed while the page renders (`data={load()}`). An address (`href`, `src`) the browser
          // requests later, a handler it runs later (`onClick`), and a function handed down as a prop are not.
          const name = n.name.getText(parsed.sf);
          const value = n.initializer && ts.isJsxExpression(n.initializer) ? n.initializer.expression : undefined;
          // An address or a handler is used later, but what computes it runs now: `onClick={makeHandler()}` calls
          // makeHandler while rendering. Only the value it ends in is the address: `(track(), "/next")` runs track,
          // and `ok() ? "/a" : "/b"` runs ok.
          const later = LATER_PROPS.test(name);
          const offers = offered && offeredProp(n) ? offered : undefined;
          if (offers && n.initializer && ts.isStringLiteral(n.initializer)) offers.add(`${f}@${n.initializer.getStart(parsed.sf)}`);
          // Each value the address may end in: past a comma's discarded left operand, into a conditional's branches and
          // the initializer of a `const` it names. A conditional's own start stays too, where its branches are read as one.
          const offer = (v: ts.Expression, through: Set<ts.Node>): void => {
            const e = unwrap(v);
            if (ts.isBinaryExpression(e) && e.operatorToken.kind === ts.SyntaxKind.CommaToken) return offer(e.right, through);
            offers!.add(`${f}@${e.getStart(parsed.sf)}`);
            if (ts.isConditionalExpression(e)) {
              offer(e.whenTrue, through);
              offer(e.whenFalse, through);
            }
            const held = ts.isIdentifier(e) ? declarationOf(e) : undefined;
            if (held && !through.has(held) && ts.isVariableDeclaration(held) && held.initializer && held.parent.flags & ts.NodeFlags.Const) {
              through.add(held);
              offer(held.initializer, through);
            }
          };
          if (offers && value) offer(value, new Set());
          const prop = (v: ts.Expression): void => {
            if (ts.isParenthesizedExpression(v)) return prop(v.expression);
            if (ts.isBinaryExpression(v) && v.operatorToken.kind === ts.SyntaxKind.CommaToken) {
              visit(v.left, false, true);
              return prop(v.right);
            }
            if (ts.isConditionalExpression(v)) {
              visit(v.condition, false, true);
              prop(v.whenTrue);
              return prop(v.whenFalse);
            }
            if (isFunctionValue(v) || ts.isIdentifier(v)) return;
            // `fetch("/api").url`, `load().result`: what the receiver computes runs now; a name (`this.onClick`) runs nothing.
            if (ts.isPropertyAccessExpression(v)) return prop(v.expression);
            // A call that builds the value runs now; only the text it is given is the address or handler's
            // (`address("/later")`), while a call among its arguments makes its own requests (`build(fetch("/api"))`).
            // A request call itself (`href={fetch("/api")}`) makes its request now; any other call only builds the value.
            if (later && ts.isCallExpression(v)) {
              const request = requestCallee(unwrap(v.expression));
              visit(v.expression, false, true);
              for (const arg of v.arguments) {
                if (request || !(ts.isStringLiteral(arg) || ts.isNoSubstitutionTemplateLiteral(arg) || ts.isTemplateExpression(arg))) visit(arg, true, true);
              }
              return;
            }
            visit(v, false, !later);
          };
          if (value) prop(value);
          return;
        }
        if (n !== node && (ts.isFunctionDeclaration(n) || (ts.isVariableDeclaration(n) && isFunctionValue(n.initializer)))) return;
        // An inline function runs when it is handed to a call (`then(() => ...)`, `new Promise(...)`) or called on the
        // spot; one returned or stored is run by whoever receives it, which is not known here.
        if (n !== node && (ts.isArrowFunction(n) || ts.isFunctionExpression(n)) && !handedToCall(n)) return;
        // What a call it runs is handed: each argument and the expressions it is made of (`fetch(BASE + id)`,
        // `fetch(ok ? "/a" : "/b")`), down to a call or function inside it, whose own arguments are its own. A URL is
        // run when one of these starts where it does; a URL built around a call's result is not that call's argument.
        // A constructor's arguments count as a call's: `fetch(new Request("/x"))` requests "/x". While rendering, an
        // element's attributes are left to the JSX rules above: `<a href="/next">` handed to a call is still a link.
        const handed = !!n.parent && (ts.isCallExpression(n.parent) || ts.isNewExpression(n.parent)) && !!n.parent.arguments?.some((a) => a === n);
        if (executed && inCall && notes && handed) {
          const mark = (m: ts.Node): void => {
            if (render && ts.isJsxAttribute(m)) return;
            executed.add(`${f}@${m.getStart(parsed.sf)}`);
            if (!ts.isCallExpression(m) && !ts.isNewExpression(m) && !ts.isFunctionLike(m)) ts.forEachChild(m, mark);
          };
          mark(n);
        }
        if (requestTime && ts.isCallExpression(n)) {
          const api = requestTimeCall(n);
          if (api) requestTime.add(`${api} at ${f}:${parsed.sf.getLineAndCharacterOfPosition(n.getStart(parsed.sf)).line + 1}`);
        }
        // The registration call a handler starts from (`app.get(...)`) is the framework's, not a port of the component.
        if (n !== start && ts.isCallExpression(n) && ts.isPropertyAccessExpression(n.expression)) {
          const member = n.expression.name.text;
          const receiver = n.expression.expression;
          // `ns.run()` on an imported namespace runs that module's function: follow it rather than count a member call.
          const namespace = ts.isIdentifier(receiver) && localBinding(receiver) === undefined ? parsed.namespaces.get(receiver.text) : undefined;
          const implementation = namespace ? this.exported(namespace, member) : undefined;
          if (implementation) {
            handOn(n, implementation);
            const key = `${implementation.file}#${implementation.node.pos}`;
            if (!seen.has(key)) {
              seen.add(key);
              queue.push(implementation);
            }
          } else calls.push({ member, receiver });
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
            if (ts.isCallExpression(n.parent) && n.parent.expression === n) handOn(n.parent, target);
            const key = `${target.file}#${target.node.pos}`;
            if (!seen.has(key)) {
              seen.add(key);
              queue.push(target);
            }
          }
        }
        const childInCall = inCall || (ts.isCallExpression(n) && n !== node);
        ts.forEachChild(n, (child) => visit(child, childInCall, notes));
      };
      visit(node);
    }
    // What each parameter is handed settles in as many rounds as hand-offs can chain.
    for (let round = 0; round <= handed.length; round++) {
      let changed = false;
      for (const { arg, param } of handed) {
        const state = handedTo.get(param) ?? handedTo.set(param, { framework: false, other: false }).get(param)!;
        const key = fromFramework(arg) ? "framework" : "other";
        if (!state[key]) {
          state[key] = true;
          changed = true;
        }
      }
      if (!changed) break;
    }
    for (const { member, receiver } of calls) if (!fromFramework(receiver)) names.add(member);
    return [...names].sort();
  }
}

/** A module the `"use client"` directive marks as running in the browser. */
/** Whether an inline function is an argument of a call or `new`, or the callee of a call made on the spot. */
function handedToCall(fn: ts.Expression): boolean {
  let at: ts.Node = fn;
  // Parentheses and type assertions (`as`, `!`, `satisfies`, `<T>`) leave the function as it is.
  while (
    ts.isParenthesizedExpression(at.parent) ||
    ts.isAsExpression(at.parent) ||
    ts.isNonNullExpression(at.parent) ||
    ts.isSatisfiesExpression(at.parent) ||
    ts.isTypeAssertionExpression(at.parent)
  )
    at = at.parent;
  const p = at.parent;
  return (ts.isCallExpression(p) || ts.isNewExpression(p)) && (p.expression === at || !!p.arguments?.includes(at as ts.Expression));
}

/** Whether the module's directive prologue, the string statements it starts with, holds `"use client"`. */
const clientModule = (sf: ts.SourceFile): boolean => {
  for (const st of sf.statements) {
    if (!ts.isExpressionStatement(st) || !ts.isStringLiteral(st.expression)) return false;
    if (st.expression.text === "use client") return true;
  }
  return false;
};

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
