import ts from "typescript";
import type { CallSource, Config } from "../config.js";
import type { Call, Coverage, Draft, Place } from "../model.js";
import { callPath, HOLE, hostOf, isLoopback, joinRoute, type CallPath } from "../paths.js";
import { lineOf, select, type Source } from "../source.js";
import { addCoverage } from "./coverage.js";
import { declarationOf, unwrap } from "./binding.js";
import type { Spans } from "./spans.js";
import { scopeOf, textScopes } from "./reach.js";

const VERBS = new Set(["get", "post", "put", "patch", "delete", "head", "options"]);
const METHODS = new Set(["GET", "POST", "PUT", "PATCH", "DELETE", "HEAD", "OPTIONS"]);

/** What a URL expression's leading value stands for, when the code states it; undefined leaves a hole. */
type Lead = (expr: ts.Expression) => string | undefined;

function templateText(node: ts.TemplateExpression, lead?: Lead): string {
  let s = node.head.text;
  node.templateSpans.forEach((span, i) => {
    s += (i === 0 && !s && lead?.(span.expression)) || HOLE;
    s += span.literal.text;
  });
  return s;
}

const isPlus = (node: ts.Node): node is ts.BinaryExpression => ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.PlusToken;

/**
 * The text a string concatenation builds, its operands in order, with a hole for each operand that is not a literal:
 * `BASE + "/reviews"` reads as a template `${BASE}/reviews` would. Undefined when no operand is a string.
 */
function concatenationText(node: ts.BinaryExpression, lead?: Lead): string | undefined {
  const parts: string[] = [];
  let strings = 0;
  const walk = (written: ts.Expression): void => {
    // `(BASE)`, `BASE as string` and `BASE!` are BASE; a parenthesized sum is still one sum.
    const n = unwrap(written);
    const first = !parts.length && !isPlus(n) ? lead?.(n) : undefined;
    if (first !== undefined) {
      parts.push(first);
      strings++;
      return;
    }
    if (isPlus(n)) {
      walk(n.left);
      walk(n.right);
    } else if (ts.isStringLiteral(n) || ts.isNoSubstitutionTemplateLiteral(n)) {
      parts.push(n.text);
      strings++;
    } else if (ts.isTemplateExpression(n)) {
      parts.push(templateText(n, lead));
      strings++;
    } else parts.push(HOLE);
  };
  walk(node);
  if (!strings) return undefined;
  let text = parts.join("");
  while (text.includes(HOLE + HOLE)) text = text.replace(HOLE + HOLE, HOLE);
  return text;
}

/**
 * The method a `fetch(url, init)` call uses: GET when there is no init, or an init without a `method`; the stated
 * method when it is a known one; `*` when the method or the init is built at run time. A configured wrapper around
 * fetch sends its own default where fetch sends GET.
 */
function fetchMethod(init: ts.Expression | undefined, absent = "GET"): string {
  if (!init) return absent;
  if (!ts.isObjectLiteralExpression(init)) return "*";
  return initMethod(init) ?? absent;
}

/**
 * The method an init object sets, read in order as the object is built: the last of the properties that may set it
 * decides. A known method stated as `method: "PUT"` is that method; a spread, a computed key, a getter or a
 * `__proto__` may carry any, so they leave it `*`. Undefined when nothing in the object may set a method.
 */
function initMethod(init: ts.ObjectLiteralExpression): string | undefined {
  let method: string | undefined;
  let prototype = false;
  for (const p of init.properties) {
    const name = p.name && propertyName(p.name);
    if (ts.isSpreadAssignment(p) || (p.name && name === undefined)) method = "*";
    else if (name === "method") method = (ts.isPropertyAssignment(p) && statedMethod(p.initializer)) || "*";
    else if (name === "__proto__" && ts.isPropertyAssignment(p) && !ts.isComputedPropertyName(p.name)) prototype = true;
  }
  return method ?? (prototype ? "*" : undefined);
}

/** The name a property key states: an identifier, a string, or a computed key that is a literal; undefined otherwise. */
function propertyName(name: ts.PropertyName): string | undefined {
  if (ts.isComputedPropertyName(name)) {
    const key = unwrap(name.expression);
    return ts.isStringLiteralLike(key) || ts.isNumericLiteral(key) ? key.text : undefined;
  }
  return name.text;
}

/**
 * The method a configured wrapper's call sends when the string is its URL, the first argument, read as fetch with the
 * wrapper's default; a known method stated as the second argument is kept, in any case, as one stated in the init.
 */
function wrapperMethod(call: ts.CallExpression, url: ts.Node, defaultMethod: string): string {
  if (call.arguments[0] !== url) return "*";
  const init = call.arguments[1];
  const stated = init && statedMethod(init);
  if (stated) return stated;
  if (init && ts.isObjectLiteralExpression(init)) return initMethod(init) ?? defaultMethod;
  return fetchMethod(init, defaultMethod);
}

/** The HTTP method a call site states near the string: `http.post(url)`, `request(url, "POST")`, `{ method: "POST" }`, otherwise `*`. */
function methodNear(node: ts.Node, wrappers: CallSource["wrappers"] = []): string {
  let current: ts.Node | undefined = node;
  for (let depth = 0; current && depth < 6; depth++, current = current.parent) {
    const parent: ts.Node | undefined = current.parent;
    if (!parent) break;
    if (ts.isCallExpression(parent) && parent.arguments.includes(current as ts.Expression)) {
      const callee = parent.expression;
      // A configured wrapper, by the name it is called with, comes before what its name would say without it.
      const wrapper = wrappers.find((w) => w.name === callee.getText().replace(/\s+/g, ""));
      if (wrapper) return wrapperMethod(parent, current, wrapper.defaultMethod);
      const name = ts.isPropertyAccessExpression(callee) ? callee.name.text : ts.isIdentifier(callee) ? callee.text : "";
      if (VERBS.has(name.toLowerCase())) return name.toUpperCase();
      // The global fetch (also as window.fetch or globalThis.fetch) defaults to GET; the URL is its first argument.
      const global = ts.isIdentifier(callee) || (ts.isPropertyAccessExpression(callee) && /^(window|globalThis|self)$/.test(callee.expression.getText()));
      if (name === "fetch" && global && parent.arguments[0] === current) return fetchMethod(parent.arguments[1]);
      for (const arg of parent.arguments) {
        if (arg === current) continue;
        if ((ts.isStringLiteral(arg) || ts.isNoSubstitutionTemplateLiteral(arg)) && METHODS.has(arg.text)) return arg.text;
        const m = ts.isObjectLiteralExpression(arg) ? methodProperty(arg) : undefined;
        if (m) return m;
      }
    }
    if (ts.isObjectLiteralExpression(parent)) {
      const m = methodProperty(parent);
      if (m) return m;
    }
  }
  return "*";
}

function methodProperty(obj: ts.ObjectLiteralExpression): string | undefined {
  for (const p of obj.properties) {
    if (ts.isPropertyAssignment(p) && p.name.getText().replace(/["']/g, "") === "method") {
      const v = p.initializer;
      if (ts.isStringLiteral(v) || ts.isNoSubstitutionTemplateLiteral(v)) return statedMethod(v);
    }
  }
  return undefined;
}

/** A known method a string states, in any case. */
function statedMethod(v: ts.Expression): string | undefined {
  const method = ts.isStringLiteralLike(v) ? v.text.toUpperCase() : undefined;
  return method && METHODS.has(method) ? method : undefined;
}

/** The operands a `+` chain joins, through the parentheses around a part of it. */
function operands(e: ts.Expression): ts.Expression[] {
  const u = ts.isParenthesizedExpression(e) && isPlus(e.expression) ? e.expression : e;
  return isPlus(u) ? [...operands(u.left), ...operands(u.right)] : [e];
}

/**
 * The home page `/` where a string is plainly an address to go to: a JSX `href`, or the first argument of
 * `push`, `replace` or `redirect`. Elsewhere a lone `/` is a separator far more often than a request.
 */
function rootNavigation(node: ts.Node, raw: string): CallPath | undefined {
  if (raw.replace(/[?#].*$/, "") !== "/") return undefined;
  const value = outermost(node);
  const parent = ts.isJsxExpression(value.parent) ? value.parent.parent : value.parent;
  if (ts.isJsxAttribute(parent) && parent.name.getText() === "href") return { path: "/", based: false };
  if (ts.isCallExpression(value.parent) && value.parent.arguments[0] === value && navigates(unwrap(value.parent.expression))) return { path: "/", based: false };
  return undefined;
}

/**
 * Whether a string is an address the browser goes to with GET, as the HTML standard and Next.js define: the `href` of
 * an `<a>` or `<area>`, or of Next.js's `<Link>`, and the address its router's `push` or `replace` navigates to. A
 * `redirect` keeps the request's method (307, 308) where it answers one that is not a page's GET, so its method is
 * left open.
 */
function navigatesWithGet(node: ts.Node): boolean {
  const value = outermost(node);
  const holder = ts.isJsxExpression(value.parent) ? value.parent.parent : value.parent;
  if (ts.isJsxAttribute(holder) && holder.name.getText() === "href") {
    const tag = holder.parent.parent.tagName;
    return /^(?:a|area)$/.test(tag.getText()) || (ts.isIdentifier(tag) && importedFrom(tag, ["next/link"]) === "default");
  }
  return ts.isCallExpression(value.parent) && value.parent.arguments[0] === value && navigates(unwrap(value.parent.expression)) === "router";
}

/** The outermost expression a string stands for: parentheses, `as`, `satisfies` and `!` leave the value as it is. */
function outermost(node: ts.Node): ts.Node {
  let value = node;
  while (
    ts.isParenthesizedExpression(value.parent) ||
    ts.isAsExpression(value.parent) ||
    ts.isSatisfiesExpression(value.parent) ||
    ts.isNonNullExpression(value.parent) ||
    ts.isTypeAssertionExpression(value.parent)
  )
    value = value.parent;
  return value;
}

/** The expression a URL is the value of: past what `outermost` passes, and past the branches of a conditional. */
function valuePlace(node: ts.Node): ts.Node {
  let value = outermost(node);
  while (ts.isConditionalExpression(value.parent) && value !== value.parent.condition) value = outermost(value.parent);
  return value;
}

const COMPARISONS = new Set([
  ts.SyntaxKind.EqualsEqualsEqualsToken,
  ts.SyntaxKind.ExclamationEqualsEqualsToken,
  ts.SyntaxKind.EqualsEqualsToken,
  ts.SyntaxKind.ExclamationEqualsToken,
]);

/** Methods of strings, arrays and regular expressions that test, search or cut text with their arguments. */
const TEXT_TESTS = new Set(["startsWith", "endsWith", "includes", "indexOf", "lastIndexOf", "match", "matchAll", "search", "test", "split", "replace", "replaceAll"]);

/** A member access by a name the code fixes: `a.b`, `a["b"]` or `` a[`b`] ``. */
function member(e: ts.Expression): { receiver: ts.Expression; name: string } | undefined {
  if (ts.isPropertyAccessExpression(e)) return { receiver: e.expression, name: e.name.text };
  if (!ts.isElementAccessExpression(e)) return undefined;
  const key = unwrap(e.argumentExpression);
  return ts.isStringLiteral(key) || ts.isNoSubstitutionTemplateLiteral(key) ? { receiver: e.expression, name: key.text } : undefined;
}

/** The call or `new` a value is an argument of, with its position and the name the callee is written with. */
function argumentPlace(value: ts.Node): { call: ts.CallExpression | ts.NewExpression; args: ts.Expression[]; at: number; callee: ts.Expression; name: string } | undefined {
  const call = value.parent;
  if (!(ts.isCallExpression(call) || ts.isNewExpression(call))) return undefined;
  const args = [...(call.arguments ?? [])];
  const at = args.indexOf(value as ts.Expression);
  if (at < 0) return undefined;
  const callee = unwrap(call.expression);
  const name = member(callee)?.name ?? (ts.isIdentifier(callee) ? callee.text : "");
  return { call, args, at, callee, name };
}

/**
 * Whether an expression is the window's Location, as the HTML standard names it: the global `location`, or `location`
 * on a window or the document. A binding the code declares under that name is its own value.
 */
function isLocation(e: ts.Expression): boolean {
  const value = unwrap(e);
  if (isGlobal(value, new Set(["location"]))) return true;
  const m = member(value);
  return m?.name === "location" && isGlobal(unwrap(m.receiver), WINDOWS);
}

/**
 * Whether a string is compared (`===`, `!==`, `==`, `!=`, a `case`) or an argument of a method that tests, searches or
 * cuts text, as `path.startsWith("/api")`: no request either way. A `replace` on the window's Location
 * (`location.replace(url)`) or on Next.js's router navigates instead.
 */
function comparedOrTested(node: ts.Node): boolean {
  const value = valuePlace(node);
  const parent = value.parent;
  if (ts.isBinaryExpression(parent)) return COMPARISONS.has(parent.operatorToken.kind);
  if (ts.isCaseClause(parent)) return parent.expression === value;
  const place = argumentPlace(value);
  if (!place || !ts.isCallExpression(place.call) || !member(place.callee) || !TEXT_TESTS.has(place.name)) return false;
  return !(place.name === "replace" && (navigates(place.callee) || isLocation(member(place.callee)!.receiver)));
}

/**
 * The function a string is handed to after its first argument, as in `requireAsset(assets, id, "/devices")`: fetch,
 * axios, ky, got, Node's http and project wrappers take their URL first, so a later argument is no request. It still
 * is where a literal method comes before it (`request("POST", "/x")`) and in the APIs documented to take it there:
 * XMLHttpRequest's `open(method, url)` and Angular's `request(method, url)`, with a method held in a value first, and
 * `redirect(status, url)` as Express and SvelteKit write it. The window's `open(url, target)` takes the URL first.
 * Undefined where the string may be a request.
 */
function laterArgument(node: ts.Node): string | undefined {
  const place = argumentPlace(valuePlace(node));
  if (!place || place.at === 0) return undefined;
  if (place.name === "redirect") return undefined;
  const first = place.args[0]!;
  const methodFirst = !(ts.isStringLiteral(first) || ts.isNoSubstitutionTemplateLiteral(first) || ts.isTemplateExpression(first));
  if ((place.name === "open" || place.name === "request") && place.at === 1 && methodFirst && !windowOpen(place.callee)) return undefined;
  if (place.args.slice(0, place.at).some((a) => (ts.isStringLiteral(a) || ts.isNoSubstitutionTemplateLiteral(a)) && METHODS.has(a.text))) return undefined;
  return place.name || place.callee.getText().replace(/\s+/g, " ");
}

const WINDOWS = new Set(["window", "self", "globalThis", "top", "parent", "opener", "frames", "document"]);

/** Whether an expression is a global of one of these names: one the code does not declare. */
const isGlobal = (e: ts.Expression, names: Set<string>): boolean => ts.isIdentifier(e) && names.has(e.text) && declarationOf(e) === undefined;

/**
 * Whether a callee is the window's `open(url, target)`: the global `open`, or `open` on a global window or document. A
 * binding the code declares under one of those names is its own value.
 */
function windowOpen(callee: ts.Expression): boolean {
  if (isGlobal(callee, new Set(["open"]))) return true;
  const m = member(callee);
  return m?.name === "open" && isGlobal(unwrap(m.receiver), WINDOWS);
}

/** The key a property is written with, quoted or not. */
const keyOf = (p: ts.PropertyAssignment): string => (ts.isIdentifier(p.name) || ts.isStringLiteral(p.name) ? p.name.text : "");

/**
 * Whether a string is a `path` option that does not start at the root. Node's `http.request` takes the request path
 * alone in `path` (`/index.html?page=12`), as clients modelled on it do; a `path` joined to another value is a file
 * path, or a path under something else.
 */
function pathOffRoot(node: ts.Node, raw: string): boolean {
  const parent = valuePlace(node).parent;
  return ts.isPropertyAssignment(parent) && keyOf(parent) === "path" && !raw.trim().startsWith("/");
}

/**
 * Whether a URL is the configured prefix put straight before a path its function is given, as a client's helper writes
 * `` `/api/v1${path}` `` or `"/api/v1" + path`: the prefix the configuration already puts before every path the client
 * requests, written once more. Its requests are the paths passed to the function, read where they are written. A path
 * with a hole (`` `/orders/${id}` ``), another base, text after the value, or a value built from anything but one
 * parameter is read as before.
 */
function prefixing(node: ts.Node, prefix: string): boolean {
  const base = joinRoute(prefix);
  let rest: ts.Expression | undefined;
  if (ts.isTemplateExpression(node) && node.templateSpans.length === 1) {
    const span = node.templateSpans[0]!;
    if (node.head.text === base && span.literal.text === "") rest = span.expression;
  } else if (isPlus(node)) {
    const parts = operands(node).map(unwrap);
    const first = parts[0]!;
    if (parts.length === 2 && (ts.isStringLiteral(first) || ts.isNoSubstitutionTemplateLiteral(first)) && first.text === base) rest = parts[1];
  }
  return rest !== undefined && fromOneParameter(rest);
}

/** Whether an expression is built from one parameter of a function around it and literal text alone. */
function fromOneParameter(e: ts.Expression): boolean {
  const parameters = new Set<ts.Node>();
  let other = false;
  const visit = (n: ts.Node): void => {
    // `this` and `super` are inputs too, though neither is an identifier.
    if (n.kind === ts.SyntaxKind.ThisKeyword || n.kind === ts.SyntaxKind.SuperKeyword) other = true;
    else if (ts.isIdentifier(n)) {
      const d = declarationOf(n);
      if (d && ts.isParameter(d)) parameters.add(d);
      else other = true;
    } else if (ts.isPropertyAccessExpression(n)) visit(n.expression);
    else ts.forEachChild(n, visit);
  };
  visit(e);
  return !other && parameters.size === 1;
}

const NEXT_ROUTERS = ["next/navigation", "next/router"];

/** The name a binding imports from one of `modules` ("default" for a default import), or undefined. */
function importedFrom(id: ts.Identifier, modules: string[]): string | undefined {
  const d = declarationOf(id);
  const spec = (n: ts.Node | undefined) => (n && ts.isImportDeclaration(n) && ts.isStringLiteral(n.moduleSpecifier) ? n.moduleSpecifier.text : undefined);
  if (d && ts.isImportSpecifier(d) && modules.includes(spec(d.parent.parent.parent) ?? "")) return (d.propertyName ?? d.name).text;
  if (d && ts.isImportClause(d) && modules.includes(spec(d.parent) ?? "")) return "default";
  return undefined;
}

/** Whether an expression is Next.js's router: what `useRouter()` returns, or the `Router` `next/router` exports. */
function isNextRouter(e: ts.Expression): boolean {
  // `useRouter().push("/")` on the spot.
  if (ts.isCallExpression(e)) return ts.isIdentifier(e.expression) && importedFrom(e.expression, NEXT_ROUTERS) === "useRouter";
  if (!ts.isIdentifier(e)) return false;
  const imported = importedFrom(e, ["next/router"]);
  if (imported === "default" || imported === "Router") return true;
  const d = declarationOf(e);
  const init = d && ts.isVariableDeclaration(d) && d.initializer ? unwrap(d.initializer) : undefined;
  return !!init && ts.isCallExpression(init) && ts.isIdentifier(init.expression) && importedFrom(init.expression, NEXT_ROUTERS) === "useRouter";
}

/**
 * Whether a callee is a Next.js navigation: `redirect` or `permanentRedirect` from `next/navigation`, or `push` and
 * `replace` on its router, also taken apart (`const { push } = useRouter()`). An array's `push` is no navigation.
 */
function navigates(callee: ts.Expression): "router" | "redirect" | undefined {
  const m = member(callee);
  if (m) return /^(push|replace)$/.test(m.name) && isNextRouter(unwrap(m.receiver)) ? "router" : undefined;
  if (!ts.isIdentifier(callee)) return undefined;
  const imported = importedFrom(callee, ["next/navigation"]);
  if (imported === "redirect" || imported === "permanentRedirect") return "redirect";
  const d = declarationOf(callee);
  if (!d || !ts.isBindingElement(d) || !ts.isObjectBindingPattern(d.parent)) return undefined;
  const key = (d.propertyName ?? d.name) as ts.Identifier;
  const holder = d.parent.parent;
  const init = ts.isVariableDeclaration(holder) && holder.initializer ? unwrap(holder.initializer) : undefined;
  const router = /^(push|replace)$/.test(key.text) && !!init && ts.isCallExpression(init) && ts.isIdentifier(init.expression) && importedFrom(init.expression, NEXT_ROUTERS) === "useRouter";
  return router ? "router" : undefined;
}

/** The `const` with an initializer that the name used at `id` refers to, by its lexical scopes; undefined otherwise. */
function constFor(id: ts.Identifier): ts.VariableDeclaration | undefined {
  const d = declarationOf(id);
  return d && ts.isVariableDeclaration(d) && ts.isIdentifier(d.name) && d.initializer && d.parent.flags & ts.NodeFlags.Const ? d : undefined;
}

/**
 * A call as read, with the offsets of the expression that holds its URL in a parsed file and the host an absolute URL
 * names. The offsets join it to the strings a handler runs (`Reach.from`); the host decides whether the URL is a
 * request to the configured target (`extractCalls`). Neither is part of the graph.
 */
export type ReadCall = Draft<Call> & { span?: [number, number]; host?: string };

/** A path left unread because it is handed to a function after its first argument (`laterArgument`). */
export interface Passed {
  callee: string;
  at: Place;
}

/** The call as the graph holds it, without the offsets it was read at. */
export function withoutSpan(c: ReadCall): Draft<Call> {
  const out = { ...c };
  delete out.span;
  return out;
}

/** What a reader is told about where it reads, and where it notes what it leaves unread. */
export interface ReadContext {
  /** Where route registrations write their paths (see `extractRoutes`); strings there are not requests. */
  spans?: Spans;
  /** Collects the paths left unread because they are handed to a function after its first argument. */
  passed?: Passed[];
  /** The host of the target's `origins` entry. */
  origin?: string;
  /** Collects where the configured prefix is put before a function's path parameter (`prefixing`). */
  prefixed?: Place[];
}

/**
 * Whether an absolute URL's host (undefined for a relative URL, or a host held in a value) is the call source's
 * target: a loopback address, where the repository's components run side by side, or the host its origin names.
 */
export const reachesTarget = (host: string | undefined, origin: string | undefined): boolean => host === undefined || isLoopback(host) || host === origin;

export function callsFromTypeScript(file: string, text: string, spec: CallSource, context: ReadContext = {}): ReadCall[] {
  const { spans, passed, origin, prefixed } = context;
  const sf = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true, file.endsWith("x") ? ts.ScriptKind.TSX : ts.ScriptKind.TS);
  const found: Array<{ node: ts.Node; call: ReadCall }> = [];
  // A `const` URL that other URLs start with, and that nothing else uses, is their base, not a request of its own.
  const leads = new Map<ts.VariableDeclaration, Set<ts.Identifier>>();
  const urlText = (node: ts.Node, depth: number): string | undefined => {
    const lead: Lead = (expr) => {
      if (depth > 4 || !ts.isIdentifier(expr)) return undefined;
      const decl = constFor(expr);
      const value = decl?.initializer ? urlText(decl.initializer, depth + 1) : undefined;
      // An origin with no path (`https://api.example.com`) is a base too; its host decides the target.
      const origin = value !== undefined && !callPath(value) && hostOf(value) !== undefined;
      if (value === undefined || (!callPath(value) && !origin)) return undefined;
      (leads.get(decl!) ?? leads.set(decl!, new Set()).get(decl!)!).add(expr);
      return origin ? value.replace(/\/+$/, "") : value;
    };
    if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) return node.text;
    // A const that names another (`const BASE = API`) has its value.
    if (ts.isIdentifier(node)) return lead(node);
    if (ts.isTemplateExpression(node)) return templateText(node, lead);
    if (isPlus(node)) return concatenationText(node, lead);
    if (unwrap(node as ts.Expression) !== node) return urlText(unwrap(node as ts.Expression), depth);
    return undefined;
  };
  const lineAt = (node: ts.Node) => sf.getLineAndCharacterOfPosition(node.getStart(sf)).line + 1;
  /** The path a URL reads as where it is written, or undefined where its place says it is no request. */
  const requested = (node: ts.Node, raw: string, report: boolean): CallPath | undefined => {
    if (registered(node) || comparedOrTested(node) || pathOffRoot(node, raw)) return undefined;
    if (spec.prefix && prefixing(node, spec.prefix)) {
      if (report) prefixed?.push({ file, line: lineAt(node) });
      return undefined;
    }
    const parsed = callPath(raw) ?? rootNavigation(node, raw);
    const callee = parsed && laterArgument(node);
    if (callee === undefined) return parsed;
    if (report) passed?.push({ callee, at: { file, line: lineAt(node) } });
    return undefined;
  };
  const add = (node: ts.Node, parsed: CallPath, host: string | undefined): void => {
    found.push({ node, call: {
      from: spec.from,
      to: spec.to,
      method: navigatesWithGet(node) ? "GET" : methodNear(node, spec.wrappers),
      path: parsed.path,
      based: parsed.based,
      at: { file, line: lineAt(node) },
      evidence: "static",
      scope: scopeOf(node),
      span: [node.getStart(sf), node.getEnd()],
      host,
    } });
  };
  // Branches of a conditional read as one call, at the conditional.
  const merged = new Set<ts.Node>();
  const visit = (node: ts.Node): void => {
    // A literal type (`path: "/m" | "/r"`) names values; it is no request. `extends make(fetch(x))` runs its expression.
    if (ts.isExpressionWithTypeArguments(node)) return visit(node.expression);
    if (ts.isImportDeclaration(node) || ts.isExportDeclaration(node) || ts.isTypeNode(node)) return;
    // `base ? `${base}/chat` : "/chat"` is one request, whichever branch runs: one call, joining a base only when both
    // branches do. Branches the configured prefix leaves on different paths (it goes before a root-relative path, not
    // one joined to a base) are two requests, as is a branch to another host: each is read on its own.
    if (ts.isConditionalExpression(node)) {
      const branches = [unwrap(node.whenTrue), unwrap(node.whenFalse)];
      const read = branches.map((b) => {
        const raw = ts.isStringLiteral(b) || ts.isNoSubstitutionTemplateLiteral(b) || ts.isTemplateExpression(b) || isPlus(b) ? urlText(b, 0) : undefined;
        const parsed = raw === undefined ? undefined : requested(b, raw, false);
        return parsed && { raw: raw!, parsed };
      });
      const [a, b] = read;
      const hosts = [a && hostOf(a.raw), b && hostOf(b.raw)];
      const one = hosts[0] === hosts[1] || hosts.every((h) => reachesTarget(h, origin));
      const effective = (p: CallPath) => (p.based || !spec.prefix ? p.path : joinRoute(spec.prefix, p.path));
      if (a && b && effective(a.parsed) === effective(b.parsed) && one) {
        // The path the prefix completes, where a branch has one, so the prefix is put before it once.
        const path = (a.parsed.based ? b.parsed : a.parsed).path;
        add(node, { path, based: a.parsed.based && b.parsed.based }, hosts[0] === hosts[1] ? hosts[0] : undefined);
        branches.forEach((branch) => merged.add(branch));
      }
    }
    let raw: string | undefined;
    if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node) || ts.isTemplateExpression(node)) raw = urlText(node, 0);
    // A whole concatenation is one URL; its pieces alone are not requests.
    const whole = isPlus(node) && !isPlus(node.parent) && !(ts.isParenthesizedExpression(node.parent) && isPlus(node.parent.parent));
    if (whole) raw = urlText(node, 0);
    if (raw !== undefined) {
      const parsed = merged.has(node) ? undefined : requested(node, raw, true);
      if (parsed) add(node, parsed, hostOf(raw));
      // A URL built with `+` is read whole; the calls among its operands still run (`base + encode(get("/x"))`).
      if (whole) {
        for (const o of operands(node)) {
          if (ts.isTemplateExpression(o)) o.templateSpans.forEach((part) => visit(part.expression));
          else if (!ts.isStringLiteral(o) && !ts.isNoSubstitutionTemplateLiteral(o)) visit(o);
        }
        return;
      }
      if (!ts.isTemplateExpression(node)) return;
    }
    ts.forEachChild(node, visit);
  };
  // A string in a registration's path is the path, unless a call written inside that path takes it: that call runs.
  const registered = (node: ts.Node): boolean => {
    if (!spans?.holds(file, node.getStart(sf))) return false;
    for (let a = node.parent; a && spans.holds(file, a.getStart(sf)); a = a.parent) if (ts.isCallExpression(a)) return false;
    return true;
  };
  visit(sf);
  // One pass over the file: a base used anywhere but at the start of a URL is a request of its own too.
  const names = new Set([...leads.keys()].map((d) => (d.name as ts.Identifier).text));
  const usedElsewhere = new Set<ts.VariableDeclaration>();
  const uses = (n: ts.Node): void => {
    if (ts.isIdentifier(n) && names.has(n.text)) {
      const decl = declarationOf(n);
      if (decl && ts.isVariableDeclaration(decl) && n !== decl.name && leads.has(decl) && !leads.get(decl)!.has(n)) usedElsewhere.add(decl);
    }
    ts.forEachChild(n, uses);
  };
  if (names.size) uses(sf);
  const bases = new Set<ts.Node>();
  // The request list holds the literal itself, inside any parentheses or assertion around it.
  for (const decl of leads.keys()) if (!usedElsewhere.has(decl)) bases.add(unwrap(decl.initializer!));
  // A URL held in a `const` is requested where the const is used: when every use that requests it states one method,
  // that is its method. A use that starts or builds another URL is that URL's request.
  const held = new Map<ts.VariableDeclaration, ReadCall>();
  for (const f of found) {
    const decl = valuePlace(f.node).parent;
    if (f.call.method === "*" && ts.isVariableDeclaration(decl) && ts.isIdentifier(decl.name) && decl.parent.flags & ts.NodeFlags.Const) held.set(decl, f.call);
  }
  if (held.size) {
    const methods = new Map<ts.VariableDeclaration, string[]>();
    const names = new Set([...held.keys()].map((d) => (d.name as ts.Identifier).text));
    const find = (n: ts.Node): void => {
      if (ts.isIdentifier(n) && names.has(n.text)) {
        const decl = declarationOf(n);
        const place = valuePlace(n).parent;
        const building = ts.isTemplateSpan(place) || isPlus(place);
        if (decl && ts.isVariableDeclaration(decl) && held.has(decl) && n !== decl.name && !building && !leads.get(decl)?.has(n)) {
          (methods.get(decl) ?? methods.set(decl, []).get(decl)!).push(navigatesWithGet(n) ? "GET" : methodNear(n, spec.wrappers));
        }
      }
      ts.forEachChild(n, find);
    };
    find(sf);
    for (const [decl, used] of methods) if (used[0] !== "*" && used.every((m) => m === used[0])) held.get(decl)!.method = used[0]!;
  }
  return found.filter((f) => !bases.has(f.node)).map((f) => f.call);
}

const STRING = /"((?:[^"\\\n]|\\.)*)"|'((?:[^'\\\n]|\\.)*)'/g;

/**
 * Where the f-string replacement field whose text starts at `from` ends, after its `}`. In the expression, quoted strings
 * (`{'}'}`) and brackets hold their braces; after a top-level `:` comes the format spec, literal text in which only a
 * nested field (`{width}`) opens.
 */
function fieldEnd(body: string, from: number, expression?: (start: number, end: number) => void): number {
  let depth = 0;
  let spec = false;
  for (let i = from; i < body.length; i++) {
    const c = body[i]!;
    if (spec) {
      if (c === "{") i = fieldEnd(body, i + 1, expression) - 1;
      else if (c === "}") return i + 1;
    } else if (c === "'" || c === '"') {
      const quote = body.startsWith(c.repeat(3), i) ? c.repeat(3) : c;
      for (i += quote.length; i < body.length && !body.startsWith(quote, i); i++) if (body[i] === "\\") i++;
      i += quote.length - 1;
    } else if (c === "(" || c === "[" || c === "{") depth++;
    else if (c === ")" || c === "]") depth--;
    else if (c === "}") {
      if (depth === 0) {
        expression?.(from, i);
        return i + 1;
      }
      depth--;
    } else if (c === ":" && depth === 0) {
      expression?.(from, i);
      spec = true;
    }
  }
  return body.length;
}

/**
 * Where the f-string whose quote is at `open` closes: the next unescaped quote of its kind outside its replacement
 * fields; undefined when the line ends first.
 */
function fStringEnd(text: string, open: number): number | undefined {
  const quote = text[open]!;
  for (let i = open + 1; i < text.length; i++) {
    const c = text[i]!;
    if (c === "\n") return undefined;
    if (c === "\\") i++;
    else if ((c === "{" || c === "}") && text[i + 1] === c) i++;
    else if (c === "{") i = fieldEnd(text, i + 1) - 1;
    else if (c === quote) return i;
  }
  return undefined;
}

/**
 * A Python f-string's text with each replacement field a hole, nested fields (`{value:{width}}`) included, and `{{`
 * and `}}` the literal braces they write.
 */
function fStringText(body: string, expression?: (start: number, end: number) => void): string {
  let out = "";
  for (let i = 0; i < body.length; ) {
    const c = body[i]!;
    if ((c === "{" || c === "}") && body[i + 1] === c) {
      out += c;
      i += 2;
    } else if (c === "{") {
      i = fieldEnd(body, i + 1, expression);
      out += HOLE;
    } else {
      out += c;
      i++;
    }
  }
  return out;
}
/** A verb call whose first argument the string is, also when the string starts the next line; `\w{0,2}` takes a prefix such as `f` or `rb`. */
const VERB_BEFORE = /\.(get|post|put|patch|delete|head|options)\s*(?:<[^()]*>\s*)?\(\s*\w{0,2}$/i;
const ENUM_METHOD = /HttpMethod\.(Get|Post|Put|Patch|Delete|Head|Options)\b/g;

/** The `HttpMethod.X` nearest to a string within its statement on the line, so each of two calls on one line keeps its own. */
function enumMethodNear(line: string, start: number, end: number): string | undefined {
  const from = line.lastIndexOf(";", start) + 1;
  const stop = line.indexOf(";", end);
  const statement = line.slice(from, stop === -1 ? undefined : stop);
  let best: { method: string; distance: number } | undefined;
  for (const m of statement.matchAll(ENUM_METHOD)) {
    const at = from + (m.index ?? 0);
    const distance = at < start ? start - at : at - end;
    if (!best || distance < best.distance) best = { method: m[1]!, distance };
  }
  return best?.method;
}

/**
 * The text with every comment blanked (newlines kept, offsets unchanged) and strings left as they are: `#` comments in
 * Python, Ruby and shell, `//` and `/* *\/` in the C family (Kotlin, Java, Swift, Go, C#, Dart and the like).
 */
/**
 * Where a string literal opened by `quote` at `start` ends (just past its closing quote). A backslash escapes the next
 * character, except in a Kotlin raw string (`"""` in a `.kt` file), which has no escapes and whose run of closing
 * quotes ends at its last three. A one-character quote other than a backtick ends at a line break.
 */
export function literalEnd(text: string, start: number, quote: string, file: string): number {
  const raw = quote === '"""' && /\.kts?$/.test(file);
  let j = start + quote.length;
  while (j < text.length && !text.startsWith(quote, j)) {
    if (text[j] === "\\" && !raw) j++;
    else if (quote.length === 1 && quote !== "`" && text[j] === "\n") return j;
    j++;
  }
  if (raw) while (text[j + 3] === '"') j++;
  return Math.min(j + quote.length, text.length);
}

export function withoutComments(file: string, text: string): string {
  const hash = /\.(py|pyi|rb|sh|bash)$/.test(file);
  const out = text.split("");
  const blank = (from: number, to: number) => {
    for (let k = from; k < to; k++) if (out[k] !== "\n") out[k] = " ";
  };
  let i = 0;
  while (i < text.length) {
    const quote = text.startsWith('"""', i) ? '"""' : text.startsWith("'''", i) && hash ? "'''" : /["'`]/.test(text[i]!) ? text[i]! : undefined;
    if (quote) {
      i = literalEnd(text, i, quote, file);
      continue;
    }
    const line = hash ? text[i] === "#" : text.startsWith("//", i);
    if (line) {
      const end = text.indexOf("\n", i);
      blank(i, end === -1 ? text.length : end);
      i = end === -1 ? text.length : end;
      continue;
    }
    if (!hash && text.startsWith("/*", i)) {
      const end = text.indexOf("*/", i + 2);
      const stop = end === -1 ? text.length : end + 2;
      blank(i, stop);
      i = stop;
      continue;
    }
    i++;
  }
  return out.join("");
}

/**
 * A callee written before an opening parenthesis, its type arguments taken off (`withoutTypeArguments`): `throw` (or
 * Python's `raise`) before it, a `new`, the receivers it is named on, and its name.
 */
const CALLEE_BEFORE = /(?<![\w.$])(?:(throw|raise)\s+)?(?:new\s+)?((?:[A-Za-z_]\w*\s*\??\.\s*)*)([A-Za-z_]\w*)\s*$/;

/**
 * The text before a call's opening parenthesis without the type arguments it ends in (`<Map<String, List<Int>>>`),
 * nested ones included. Text that ends in anything else, or whose angle brackets do not balance over characters type
 * arguments are written with, is returned as it is.
 */
function withoutTypeArguments(before: string): string {
  const end = before.trimEnd().length;
  if (before[end - 1] !== ">") return before;
  let depth = 0;
  for (let j = end - 1; j >= 0; j--) {
    const c = before[j]!;
    if (c === ">") depth++;
    else if (c === "<") {
      if (--depth === 0) return before.slice(0, j);
    } else if (!/[\w\s.,?*[\]$]/.test(c)) break;
  }
  return before;
}

/** Kotlin's standard functions that throw: `error` and `TODO` with the message given, `require` and `check` when the condition given is false. */
const KOTLIN_THROWING = new Set(["error", "TODO", "require", "check"]);

/**
 * The string literals in code read as text that are arguments of an exception, from their opening quote to just past
 * their closing one, with the name it is called by: the arguments of a call that is thrown (`throw X(...)`, `raise X(...)`) or of a class named
 * as Java's, Kotlin's, Dart's and Python's own exceptions are (`...Error`, `...Exception`), and in Kotlin of the
 * standard library's throwing functions. A request written inside those parentheses is inside a call of its own, so it
 * is still read.
 */
function exceptionArguments(file: string, text: string): Array<{ start: number; end: number; exception: string }> {
  const kotlin = /\.kts?$/.test(file);
  const hash = /\.(py|pyi|rb|sh|bash)$/.test(file);
  const out: Array<{ start: number; end: number; exception: string }> = [];
  const frames: Array<{ open: string; exception?: string }> = [];
  const opener: Record<string, string> = { ")": "(", "]": "[", "}": "{" };
  for (let i = 0; i < text.length; ) {
    const c = text[i]!;
    const quote = text.startsWith('"""', i) ? '"""' : text.startsWith("'''", i) && hash ? "'''" : /["'`]/.test(c) ? c : undefined;
    if (quote) {
      const exception = frames.at(-1)?.exception;
      const end = literalEnd(text, i, quote, file);
      if (exception) out.push({ start: i, end, exception });
      i = end;
      continue;
    }
    if (c === "(") {
      const m = CALLEE_BEFORE.exec(withoutTypeArguments(text.slice(Math.max(0, i - 200), i)));
      const [, thrown, receivers = "", name = ""] = m ?? [];
      const exception = !!thrown || /^(?:[A-Z]\w*)?(?:Error|Exception)$/.test(name) || (kotlin && !receivers && KOTLIN_THROWING.has(name));
      frames.push({ open: c, exception: m && exception ? (receivers + name).replace(/\s+/g, "") : undefined });
    } else if (c === "[" || c === "{") frames.push({ open: c });
    else if (opener[c]) {
      // A bracket left open by text the scan misreads closes with the bracket around it.
      const at = frames.map((f) => f.open).lastIndexOf(opener[c]);
      if (at >= 0) frames.length = at;
    }
    i++;
  }
  return out;
}

/**
 * Kotlin, Java, Swift, Python and other languages: double- or single-quoted string literals with `$x`, `${x}`, `{x}` or
 * `%s` holes. `labels` collects the paths left unread because they are given to an exception (`exceptionArguments`).
 */
export function callsFromText(file: string, original: string, spec: CallSource, spans?: Spans, labels?: Passed[]): ReadCall[] {
  const out: ReadCall[] = [];
  const text = withoutComments(file, original);
  const scopeAt = textScopes(text);
  const exceptions = exceptionArguments(file, text);
  const python = /\.pyi?$/.test(file);
  const read = (segment: string, offset: number, field = false): void => {
    const re = new RegExp(STRING.source, "g");
    for (let m = re.exec(segment); m; m = re.exec(segment)) {
      const at = m.index;
      const fString = python && /(?<![\w])(?:[fF][rR]?|[rR][fF])$/.test(segment.slice(Math.max(0, at - 2), at));
      // An f-string ends at its own closing quote, past fields that hold strings in the same quote (Python 3.12).
      const end = fString ? fStringEnd(segment, at) : undefined;
      const body = end !== undefined ? segment.slice(at + 1, end) : (m[1] ?? m[2]!);
      if (end !== undefined) re.lastIndex = end + 1;
      read1(body, offset + at, body.length + 2, fString, field);
    }
  };
  const read1 = (body: string, index: number, length: number, fString: boolean, field: boolean): void => {
    // A route's own path is no request; the code in its f-string fields still runs, and is read below.
    const registered = spans?.holds(file, index);
    // In a Python f-string every replacement field is a value, however it is written; `{{` and `}}` are braces. The
    // code in a field runs, so the requests written in it are read too.
    const fields: Array<[number, number]> = [];
    const inner = fString ? fStringText(body, (start, end) => fields.push([start, end])) : body.replace(/\$\{[^}]*\}|\$[A-Za-z_]\w*|%[sd]|\{[A-Za-z_]\w*\}/g, HOLE);
    for (const [start, end] of fields) read(body.slice(start, end), index + 1 + start, true);
    if (registered) return;
    const parsed = callPath(inner);
    if (!parsed) return;
    // The reader's strings are quoted pairs on one line, so it reads `"""/my"""` from its third quote: what decides is
    // the exception's literal the string lies in. A string in an f-string field is in code of its own.
    const exception = field ? undefined : exceptions.find((e) => e.start <= index && index < e.end)?.exception;
    if (exception) {
      labels?.push({ callee: exception, at: { file, line: lineOf(text, index) } });
      return;
    }
    const lineStart = text.lastIndexOf("\n", index) + 1;
    const lineEnd = text.indexOf("\n", index);
    const before = text.slice(Math.max(0, index - 200), index);
    const line = text.slice(lineStart, lineEnd === -1 ? undefined : lineEnd);
    const verb = before.match(VERB_BEFORE)?.[1] ?? enumMethodNear(line, index - lineStart, index - lineStart + length);
    out.push({
      from: spec.from,
      to: spec.to,
      method: verb ? verb.toUpperCase() : "*",
      path: parsed.path,
      based: parsed.based,
      at: { file, line: lineOf(text, index) },
      evidence: "text",
      scope: scopeAt(index),
      host: hostOf(inner),
    });
  };
  read(text, 0);
  return out;
}

/** A `<script>` or `<style>` element: its start tag and where its raw-text body lies in the template. */
interface RawText {
  name: string;
  attributes: Attribute[];
  bodyStart: number;
  bodyEnd: number;
}

// The template as HTML reads it, in one pass: comments blanked (newlines and offsets kept), and the <script> and
// <style> elements found, whose bodies are raw text, where neither a comment nor markup can start. Thymeleaf's
// parser-level comments start with "<!--" too and are blanked; its prototype-only block, opened by "<!--/*/" and
// closed by "/*/-->", is processed, so only the two markers are blanked and comments inside it still are.
function scanHtml(original: string): { text: string; raw: RawText[] } {
  const out = original.split("");
  const blank = (from: number, to: number) => {
    for (let k = from; k < to; k++) if (out[k] !== "\n") out[k] = " ";
  };
  const raw: RawText[] = [];
  const tag = new RegExp(START_TAG.source, "y");
  let prototype = false;
  let i = 0;
  while (i < original.length) {
    if (prototype && original.startsWith("/*/-->", i)) {
      blank(i, i + 6);
      prototype = false;
      i += 6;
    } else if (original.startsWith("<!--/*/", i)) {
      blank(i, i + 7);
      prototype = true;
      i += 7;
    } else if (original.startsWith("<!--", i)) {
      const close = original.indexOf("-->", i + 4);
      const end = close < 0 ? original.length : close + 3;
      blank(i, end);
      i = end;
    } else if (original[i] === "<" && /^<(script|style)(?=[\s/>])/i.test(original.slice(i, i + 8))) {
      tag.lastIndex = i;
      const m = tag.exec(original);
      if (!m) {
        i++;
        continue;
      }
      const name = m[1]!.toLowerCase();
      const bodyStart = i + m[0].length;
      // The end tag names the element exactly: `</script-widget>` in a script body does not close it.
      const end = new RegExp(`</${name}(?=[\\s/>])`, "gi");
      end.lastIndex = bodyStart;
      const close = end.exec(original)?.index;
      const bodyEnd = close ?? original.length;
      raw.push({ name, attributes: attributesOf(m[2]!, i + 1 + m[1]!.length), bodyStart, bodyEnd });
      i = bodyEnd;
    } else i++;
  }
  return { text: out.join(""), raw };
}

/**
 * The path of the Thymeleaf link expression starting at `@{`: its `/...` literal with `{name}` placeholders, up to
 * the parameter list or the closing brace. The parameters may hold any expression; they are not read.
 */
function linkPath(text: string, at: number): string | undefined {
  let i = at + 2;
  while (/\s/.test(text[i] ?? "")) i++;
  if (text[i] === "~") i++;
  if (text[i] !== "/") return undefined;
  let path = "";
  while (i < text.length) {
    const c = text[i]!;
    if (c === "{") {
      const close = text.indexOf("}", i);
      if (close < 0) return undefined;
      path += text.slice(i, close + 1);
      i = close + 1;
      continue;
    }
    if (c === "(" || c === "}" || /\s/.test(c)) break;
    path += c;
    i++;
  }
  return path;
}

const valueOf = (tag: StartTag, name: string): string | undefined => tag.attributes.find((a) => a.name === name)?.value;

/**
 * The method a submission named by `method` or `formmethod` (`plain`) uses, or undefined when the tag names none; null
 * when it sends nothing.
 *
 * Thymeleaf's attribute (`th:` or the HTML-friendly `data-th-`) replaces the plain one. For a form's `method` it writes
 * `method="post"` and, for any other method, a hidden `_method` field that Spring turns into that method only when its
 * HiddenHttpMethodFilter is on, which Spring Boot leaves off: GET and POST are kept, any other value is `*`.
 *
 * The plain attribute is the HTML standard's enumerated one: `get` and `post`; `dialog`, which closes a dialog and sends
 * nothing; and GET for any other value, as a browser does.
 */
function submitMethod(tag: StartTag, plain: string): string | null | undefined {
  const th = [`th:${plain}`, `data-th-${plain}`].map((name) => valueOf(tag, name)).find((v) => v !== undefined)?.trim().toLowerCase();
  // A Thymeleaf value is an expression: a literal token (`post`, `'post'`) writes itself; anything else (`${m}`) is
  // known only when the page renders.
  const literal = th === undefined ? undefined : /^'?([a-z]+)'?$/.exec(th)?.[1];
  // Only a form's method gets the hidden `_method` field; `th:formmethod` just writes the `formmethod` attribute.
  if (th !== undefined && plain === "method") return literal === "get" || literal === "post" ? literal.toUpperCase() : "*";
  if (th !== undefined && literal === undefined) return "*";
  const value = literal ?? valueOf(tag, plain)?.trim().toLowerCase();
  if (value === undefined) return undefined;
  if (value === "post") return "POST";
  return value === "dialog" ? null : "GET";
}

/**
 * The `<form>` a submit control belongs to: the one its `form` attribute names, else the one around it. Both are
 * found among the template's start tags and in its markup, so text in a script body is neither.
 */
function formOf(page: Page, control: StartTag): StartTag | undefined {
  // A `form` attribute decides the owner: the form with that id, or none when no form has it.
  const id = valueOf(control, "form");
  if (id !== undefined) return page.tags.find((t) => t.name === "form" && valueOf(t, "id") === id);
  const open = page.tags.filter((t) => t.name === "form" && t.start < control.start).pop();
  if (!open || page.markup.toLowerCase().lastIndexOf("</form", control.start) > open.start) return undefined;
  return open;
}

interface Attribute {
  /** Lower-cased. */
  name: string;
  value: string;
  /** Where the value starts in the template. */
  at: number;
}

interface StartTag {
  /** Lower-cased. */
  name: string;
  start: number;
  text: string;
  attributes: Attribute[];
}

const START_TAG = /<([a-zA-Z][\w:-]*)((?:\s+[^\s"'>/=]+(?:\s*=\s*(?:"[^"]*"|'[^']*'|[^\s"'>]+))?)*)\s*\/?>/g;
const ATTRIBUTE = /([^\s"'>/=]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'>]+)))?/g;

/** The attributes of a start tag's attribute list, which begins at `listAt` in the template. */
function attributesOf(list: string, listAt: number): Attribute[] {
  const out: Attribute[] = [];
  for (const a of list.matchAll(ATTRIBUTE)) {
    const value = a[2] ?? a[3] ?? a[4];
    if (value === undefined) continue;
    const eq = a[0].indexOf("=");
    let k = eq + 1;
    while (/\s/.test(a[0][k] ?? "")) k++;
    if (a[0][k] === '"' || a[0][k] === "'") k++;
    out.push({ name: a[1]!.toLowerCase(), value, at: listAt + (a.index ?? 0) + k });
  }
  return out;
}

/** A template's markup (raw-text bodies blanked, offsets kept) and its start tags, values located in the template. */
interface Page {
  markup: string;
  tags: StartTag[];
}

function pageOf(text: string, raw: RawText[]): Page {
  const chars = text.split("");
  for (const r of raw) for (let k = r.bodyStart; k < r.bodyEnd; k++) if (chars[k] !== "\n") chars[k] = " ";
  const markup = chars.join("");
  const tags: StartTag[] = [];
  for (const m of markup.matchAll(START_TAG)) {
    const start = m.index ?? 0;
    tags.push({ name: m[1]!.toLowerCase(), start, text: text.slice(start, start + m[0].length), attributes: attributesOf(m[2]!, start + 1 + m[1]!.length) });
  }
  return { markup, tags };
}

/** The MIME type essences a browser runs a script of, besides `module`. */
const JAVASCRIPT_TYPES = new Set([
  "module",
  "text/javascript",
  "application/javascript",
  "text/ecmascript",
  "application/ecmascript",
  "application/x-javascript",
  "application/x-ecmascript",
  "text/x-javascript",
  "text/x-ecmascript",
  "text/jscript",
  "text/livescript",
]);

/**
 * Attributes that make a request: links, form targets and sources, as HTML defines them; and the `data-*` attributes
 * the configuration names (`dataUrls`), whose URL the project's scripts request. A `data-*` value has no meaning of its
 * own in HTML.
 */
const requestAttributes =
  (dataUrls: Set<string>) =>
  (name: string): boolean =>
    /^(href|src|action|formaction)$/.test(name) || dataUrls.has(name);

/**
 * The items of a `th:attr` family value (`src=@{/a}, title='x, y'`), each with the attribute it names. Items are split
 * at the commas outside quoted text and brackets: a comma inside `'x, src=y'` or `${f(a, b)}` belongs to its item.
 */
function attrItems(value: string): Array<{ name: string | undefined; start: number; end: number }> {
  const items: Array<{ name: string | undefined; start: number; end: number }> = [];
  let depth = 0;
  let quote: string | undefined;
  let start = 0;
  const close = (end: number) => {
    items.push({ name: /^\s*([\w:.-]+)\s*=/.exec(value.slice(start, end))?.[1]?.toLowerCase(), start, end });
    start = end + 1;
  };
  for (let i = 0; i < value.length; i++) {
    const c = value[i]!;
    if (quote) {
      if (c === "\\") i++;
      else if (c === quote) quote = undefined;
    // `|x, y|` is Thymeleaf's literal substitution: its text, commas included, is one value.
    } else if (c === "'" || c === '"' || c === "|") quote = c;
    else if (c === "(" || c === "{" || c === "[") depth++;
    else if (c === ")" || c === "}" || c === "]") depth = Math.max(0, depth - 1);
    else if (c === "," && depth === 0) close(i);
  }
  close(value.length);
  return items;
}

/**
 * Whether a Thymeleaf attribute value surely writes the attribute: a link expression `@{...}` (nested braces and
 * parentheses included, as in `@{/a/{id}(id=${v})}`), or a literal (`'x'`, `|x|`). A value computed at render may be
 * null, which removes it.
 */
function surelyWritten(value: string | undefined): boolean {
  const v = value?.trim() ?? "";
  if (/^'[^']*'$|^\|[^|]*\|$/.test(v)) return true;
  if (!v.startsWith("@{")) return false;
  // Braces inside quoted text (`p='}'`) are text.
  let depth = 0;
  let quoted = false;
  for (let i = 1; i < v.length; i++) {
    const c = v[i]!;
    if (quoted) {
      if (c === "\\") i++;
      else if (c === "'") quoted = false;
    } else if (c === "'") quoted = true;
    else if (c === "{") depth++;
    else if (c === "}" && --depth === 0) return i === v.length - 1;
  }
  return false;
}

/** The `th:attr` family item a value belongs to: the attribute its item names. */
function itemName(value: string, offset: number): string | undefined {
  return attrItems(value).find((item) => offset >= item.start && offset <= item.end)?.name;
}

/**
 * The method a request from an attribute uses, or null when it sends none: GET for links and sources; a form's method
 * (`submitMethod`), GET when it names none; a submit control's `formmethod`, else its form's; any method for a `data-*`
 * URL, which a script reads.
 */
function templateMethod(page: Page, tag: StartTag, name: string): string | null {
  if (name === "href" || name === "src") return "GET";
  // `??` would also replace null, which means no request.
  const or = (method: string | null | undefined, fallback: string | null) => (method === undefined ? fallback : method);
  if (name === "action") return or(submitMethod(tag, "method"), "GET");
  if (name === "formaction") {
    // A submit control with no form owner submits nothing.
    const form = formOf(page, tag);
    if (!form) return null;
    return or(submitMethod(tag, "formmethod"), or(submitMethod(form, "method"), "GET"));
  }
  return "*";
}

/**
 * Requests an HTML template makes, read from start tags only:
 * - Thymeleaf link expressions (`@{/reviews/{id}(id=${...})}`) in `th:href`, `th:src`, `th:action`, `th:formaction`,
 *   the configured `th:data-*` and the items of `th:attr` naming those attributes. `th:attrappend` and `th:attrprepend` add their
 *   value to the static attribute, so the request is the two joined, and nothing when there is no static value;
 * - root-relative URLs in `href`, `src`, `action`, `formaction` and the configured `data-*`, unless Thymeleaf replaces the
 *   attribute;
 * - in inline scripts, the requests the JavaScript makes and, where Thymeleaf inlines JavaScript, link expressions in
 *   `[[...]]` or `[(...)]`.
 * A `{name}` placeholder is any segment text; a `data-*` URL ending in `/` is a base a script appends one segment to.
 * Text that is not an attribute, commented-out markup and absolute URLs, which name other sites, are not read.
 */
export function callsFromTemplate(file: string, original: string, spec: CallSource, context: ReadContext = {}): ReadCall[] {
  const { text, raw } = scanHtml(original);
  const page = pageOf(text, raw);
  const requests = requestAttributes(new Set((spec.dataUrls ?? []).map((n) => n.toLowerCase())));
  const out: ReadCall[] = [];
  const add = (raw: string, index: number, tag: StartTag | undefined, name: string) => {
    const base = name.startsWith("data-") && raw.length > 1 && raw.endsWith("/");
    const parsed = callPath(`${raw.replace(/\{[^{}]*\}/g, HOLE)}${base ? HOLE : ""}`);
    const method = tag ? templateMethod(page, tag, name) : "*";
    if (!parsed || method === null) return;
    out.push({
      from: spec.from,
      to: spec.to,
      method,
      path: parsed.path,
      based: false,
      at: { file, line: lineOf(text, index) },
      evidence: "text",
    });
  };

  for (const tag of page.tags) {
    const plain = new Map(tag.attributes.filter((a) => !a.name.startsWith("th:") && !a.name.startsWith("data-th-")).map((a) => [a.name, a]));
    const replaced = new Set<string>();
    const joined = new Set<string>();
    for (const a of tag.attributes) {
      const th = /^(?:th:|data-th-)(.+)$/.exec(a.name)?.[1];
      if (!th) continue;
      const family = /^attr(append|prepend)?$/.exec(th);
      for (let i = a.value.indexOf("@{"); i >= 0; i = a.value.indexOf("@{", i + 2)) {
        const name = family ? itemName(a.value, i) : th;
        const path = linkPath(a.value, i);
        if (!name || !requests(name) || !path) continue;
        if (!family || !family[1]) {
          replaced.add(name);
          add(path, a.at + i, tag, name);
          continue;
        }
        // attrappend / attrprepend: the request is the static value with this added, if the static value is known.
        joined.add(name);
        const fixed = plain.get(name);
        if (!fixed || !fixed.value.startsWith("/")) continue;
        add(family[1] === "append" ? `${fixed.value}${path}` : `${path}${fixed.value}`, fixed.at, tag, name);
      }
      if (!family) replaced.add(th);
      else if (!family[1]) for (const item of a.value.split(",")) {
        const n = /^\s*([\w:.-]+)\s*=/.exec(item)?.[1]?.toLowerCase();
        if (n) replaced.add(n);
      }
    }
    for (const a of plain.values()) {
      if (!requests(a.name) || replaced.has(a.name) || joined.has(a.name)) continue;
      if (!a.value.startsWith("/") || a.value.startsWith("//")) continue;
      add(a.value.replace(/[?#].*$/, ""), a.at, tag, a.name);
    }
  }

  // Inline scripts, without a src: their requests, at their lines in the template.
  for (const script of raw.filter((r) => r.name === "script")) {
    const attribute = (name: string) => script.attributes.find((a) => a.name === name)?.value;
    // A MIME type's essence, without parameters such as `; charset=utf-8`; no type or an empty one is JavaScript.
    const type = attribute("type")?.split(";")[0]!.trim().toLowerCase();
    // A src, written or rendered by Thymeleaf, makes the script external: the browser does not run its body.
    // A plain src makes the script external. Thymeleaf's makes it so only where it surely writes one (a link expression
    // or a literal): `src=null` removes the attribute, and a computed value may, so the body is read then.
    const rendered =
      ["th:src", "data-th-src"].some((n) => surelyWritten(attribute(n))) ||
      ["th:attr", "data-th-attr"].some((n) => {
        const value = attribute(n) ?? "";
        return attrItems(value).some((item) => item.name === "src" && surelyWritten(value.slice(item.start, item.end).replace(/^\s*src\s*=/i, "")));
      });
    const external = attribute("src") !== undefined || rendered;
    if (external || (type && !JAVASCRIPT_TYPES.has(type))) continue;
    const body = text.slice(script.bodyStart, script.bodyEnd);
    const shift = lineOf(text, script.bodyStart) - 1;
    // Offsets in the script body are not offsets in the template; no handler runs a template's script anyway.
    const inScript: Passed[] = [];
    const prefixed: Place[] = [];
    for (const c of callsFromTypeScript(`${file}.js`, body, spec, { passed: inScript, origin: context.origin, prefixed })) out.push({ ...withoutSpan(c), at: { file, line: c.at.line + shift } });
    context.passed?.push(...inScript.map((p) => ({ ...p, at: { file, line: p.at.line + shift } })));
    context.prefixed?.push(...prefixed.map((p) => ({ file, line: p.line + shift })));
    if (attribute("th:inline")?.toLowerCase() === "javascript") {
      for (const e of body.matchAll(/\[[[(]\s*@\{/g)) {
        const at = (e.index ?? 0) + e[0].length - 2;
        const path = linkPath(body, at);
        if (path) add(path, script.bodyStart + at, undefined, "script");
      }
    }
  }
  return out.sort((a, b) => a.at.line - b.at.line);
}

/** Each function paths were passed to, with how many and where the first was. */
function byCallee(passed: Passed[]): string {
  const callees = new Map<string, { count: number; at: Place }>();
  for (const p of passed) {
    const entry = callees.get(p.callee) ?? callees.set(p.callee, { count: 0, at: p.at }).get(p.callee)!;
    entry.count++;
  }
  return [...callees].map(([callee, { count, at }]) => `${callee} (${count}, first at ${at.file}:${at.line})`).join(", ");
}

/**
 * `spans`: where route registrations write their paths (see `extractRoutes`); strings there are not requests.
 *
 * An absolute URL is a request to a source's target when its host is a loopback address, where the repository's
 * components run side by side, or the host of the target's `origins` entry. Any other host is another server's: its
 * URLs are left out. A limit names those hosts, the functions paths were handed to after their first argument, the
 * exceptions paths were given to in code read as text, and where a helper puts the configured prefix before a path.
 */
export function extractCalls(source: Source, config: Config, coverage: Coverage[] = [], spans?: Spans, limits: string[] = []): ReadCall[] {
  const out: ReadCall[] = [];
  for (const spec of config.calls) {
    const files = select(source, spec.files, config.exclude);
    const origin = config.origins[spec.to] === undefined ? undefined : hostOf(config.origins[spec.to]!);
    const foreign = new Map<string, string>();
    const passed: Passed[] = [];
    const labels: Passed[] = [];
    const prefixed: Place[] = [];
    const before = out.length;
    for (const file of files) {
      const text = source.read(file);
      if (text === undefined) continue;
      const read = /\.(c|m)?[tj]sx?$/.test(file)
        ? callsFromTypeScript(file, text, spec, { spans, passed, origin, prefixed })
        : /\.html?$/.test(file)
          ? callsFromTemplate(file, text, spec, { passed, origin, prefixed })
          : callsFromText(file, text, spec, spans, labels);
      for (const c of read) {
        const { host, ...call } = c;
        if (host !== undefined && !reachesTarget(host, origin)) {
          if (!foreign.has(host)) foreign.set(host, `${c.at.file}:${c.at.line}`);
          continue;
        }
        // The path a configured client puts before each root-relative path; a URL with a base of its own keeps it.
        out.push(spec.prefix && !call.based ? { ...call, path: joinRoute(spec.prefix, call.path) } : call);
      }
    }
    addCoverage(coverage, `calls ${spec.from}->${spec.to}`, files.length, out.length - before);
    const edge = `calls ${spec.from}->${spec.to}`;
    if (foreign.size) {
      const hosts = [...foreign].map(([host, at]) => `${host} (${at})`).join(", ");
      limits.push(`${edge}: URLs to ${hosts} are not read as requests to ${spec.to}; set origins.${spec.to} if that is its host`);
    }
    if (passed.length) limits.push(`${edge}: paths handed to a function after its first argument are not read as requests: ${byCallee(passed)}`);
    if (labels.length) limits.push(`${edge}: paths given to an exception or to a function that throws are not read as requests: ${byCallee(labels)}`);
    if (prefixed.length) {
      const places = prefixed.map((p) => `${p.file}:${p.line}`).join(", ");
      limits.push(`${edge}: the configured prefix ${spec.prefix} put before a function's path parameter (${places}) is not read as a request; the paths passed to that function are`);
    }
  }
  return out;
}
