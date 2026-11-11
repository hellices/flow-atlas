import ts from "typescript";
import { baseOf, type CallSource, type Config } from "../config.js";
import type { Call, Coverage, Draft, Place, Surface } from "../model.js";
import { callPath, HOLE, hostOf, isLoopback, joinRoute, onBase, pathsMatch, relativePath, resolveReference, type Base, type CallPath } from "../paths.js";
import { lineOf, matcher, select, type Source } from "../source.js";
import { Clients } from "./clients.js";
import { httpExchanges } from "./spring.js";
import { addCoverage } from "./coverage.js";
import { declarationOf, importedFrom, isReference, references, unwrap } from "./binding.js";
import { Constants } from "./constants.js";
import { Importers } from "./importers.js";
import type { Spans } from "./spans.js";
import { scopeOf, textScopes } from "./reach.js";
import { packageRanges } from "./syntax.js";

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
 * The root path `/` where a string is in a request's place (`requestPosition`), or names another origin where a client
 * router takes a route (`<Link to="https://...">`), which the browser loads; elsewhere a lone `/` is a separator far
 * more often than a request.
 */
function rootRequest(node: ts.Node, raw: string, wrappers: CallSource["wrappers"] = []): CallPath | undefined {
  const parsed = callPath(raw, true);
  return parsed && (requestPosition(node, wrappers) || (hostOf(raw) !== undefined && clientRoute(node) === "route")) ? parsed : undefined;
}

/**
 * Whether a string is in a request's place: the URL, the first argument, of a call that requests or navigates (the
 * global fetch, a call named after an HTTP method, a configured wrapper, Next.js's navigations, the window Location's
 * `assign` and `replace`); a JSX `href`, `action`, `formAction` or `src`; a URL the window's Location is set to; a
 * client router's navigation that loads the document.
 */
function requestPosition(node: ts.Node, wrappers: CallSource["wrappers"] = []): boolean {
  if (locationNavigation(node) || clientRoute(node) === "document") return true;
  const value = valuePlace(node);
  const holder = ts.isJsxExpression(value.parent) ? value.parent.parent : value.parent;
  if (ts.isJsxAttribute(holder)) return /^(href|action|formAction|src)$/.test(holder.name.getText());
  const place = argumentPlace(value);
  if (!place || place.at !== 0 || !ts.isCallExpression(place.call)) return false;
  if (navigates(place.callee) || wrappers.some((w) => w.name === place.call.expression.getText().replace(/\s+/g, ""))) return true;
  if (VERBS.has(place.name.toLowerCase())) return true;
  const m = member(place.callee);
  return place.name === "fetch" && (isGlobal(place.callee, FETCH) || (!!m && isGlobal(unwrap(m.receiver), FETCH_GLOBALS)));
}

const FETCH = new Set(["fetch"]);
const FETCH_GLOBALS = new Set(["window", "globalThis", "self"]);

/**
 * Whether a string is a URL the window's Location navigates to, as the HTML standard defines it: the argument of its
 * `assign` or `replace`, or a value its `href` (or the Location itself) is set to. Each navigates with GET.
 */
function locationNavigation(node: ts.Node): boolean {
  const value = valuePlace(node);
  const parent = value.parent;
  if (ts.isBinaryExpression(parent) && parent.operatorToken.kind === ts.SyntaxKind.EqualsToken && parent.right === value) {
    const target = unwrap(parent.left);
    const m = member(target);
    return isLocation(target) || (m?.name === "href" && isLocation(m.receiver));
  }
  const place = argumentPlace(value);
  const m = place && member(place.callee);
  return !!place && !!m && place.at === 0 && ts.isCallExpression(place.call) && /^(assign|replace)$/.test(m.name) && isLocation(m.receiver);
}

/**
 * Whether a string is an address the browser goes to with GET, as the HTML standard and Next.js define: the `href` of
 * an `<a>` or `<area>`, or of Next.js's `<Link>`, and the address its router's `push` or `replace` navigates to, either
 * branch of a conditional included; a URL the window's Location navigates to; a client router's navigation that loads
 * the document. A `redirect` keeps the request's method (307, 308) where it answers one that is not a page's GET, so its
 * method is left open.
 */
function navigatesWithGet(node: ts.Node): boolean {
  if (locationNavigation(node) || clientRoute(node) === "document") return true;
  const value = valuePlace(node);
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
 * Whether a string is in the `matcher` of the `config` a Next.js middleware or proxy file exports: the paths the
 * middleware runs on, as strings or as objects' `source`, not requests (Next.js, Proxy: Matcher).
 */
function middlewareMatcher(node: ts.Node, file: string): boolean {
  if (!/(?:^|\/)(?:middleware|proxy)\.(?:c|m)?[jt]s$/.test(file)) return false;
  for (let a = node.parent; a && !ts.isSourceFile(a); a = a.parent) {
    if (!ts.isPropertyAssignment(a) || keyOf(a) !== "matcher") continue;
    const holder = outermost(a.parent).parent;
    const statement = ts.isVariableDeclaration(holder) ? holder.parent.parent : undefined;
    return (
      ts.isVariableDeclaration(holder) &&
      ts.isIdentifier(holder.name) &&
      holder.name.text === "config" &&
      !!statement &&
      ts.isVariableStatement(statement) &&
      !!ts.getModifiers(statement)?.some((m) => m.kind === ts.SyntaxKind.ExportKeyword)
    );
  }
  return false;
}

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

const TANSTACK_ROUTER = ["@tanstack/react-router"];

/**
 * A client-side router, known by the modules it is imported from: the components and functions that take the app's own
 * routes, which the router renders in the browser with no request for them (React Router's `Link` is "a progressively
 * enhanced `<a href>` wrapper to enable navigation with client-side routing"), and those that load the document instead.
 */
interface ClientRouter {
  modules: string[];
  /** Components whose attributes name routes. */
  elements: string[];
  /** Functions whose arguments name routes. */
  functions: string[];
  /** Functions that return a navigate function, or a router whose `navigate` method navigates. */
  navigators: string[];
  /** Functions that return a history, whose `push` and `replace` navigate. */
  histories: string[];
  /** Functions that answer with a redirect the browser follows by loading the document. */
  documents: string[];
}

const CLIENT_ROUTERS: ClientRouter[] = [
  {
    // React Router 6 and 7, and the components, hooks and functions of version 5 (`Redirect`, `useHistory`,
    // `useRouteMatch`), which `react-router-dom` 5 exports.
    modules: ["react-router", "react-router-dom"],
    elements: ["Link", "NavLink", "Navigate", "Route", "Redirect"],
    functions: [
      "redirect",
      "replace",
      "useNavigate",
      "createBrowserRouter",
      "createHashRouter",
      "createMemoryRouter",
      "useRoutes",
      "matchPath",
      "matchRoutes",
      "generatePath",
      "useMatch",
      "useHref",
      "useResolvedPath",
      "useLinkClickHandler",
      "useRouteMatch",
    ],
    navigators: ["useNavigate", "createBrowserRouter", "createHashRouter", "createMemoryRouter"],
    histories: ["useHistory"],
    documents: ["redirectDocument"],
  },
  {
    modules: TANSTACK_ROUTER,
    elements: ["Link", "Navigate"],
    functions: ["createFileRoute", "createLazyFileRoute", "createRoute", "redirect", "useNavigate", "getRouteApi"],
    navigators: ["useNavigate", "useRouter", "createRouter"],
    histories: [],
    documents: [],
  },
];

const routerFiles = new WeakMap<ts.SourceFile, boolean>();

/**
 * The constants of the repository a parsed file is read with, which follow its imports to the modules they name;
 * a file read alone has none.
 */
const repositories = new WeakMap<ts.SourceFile, Constants>();

/** Whether a file imports a client router (`CLIENT_ROUTERS`), or may through a module of the repository. */
function importsRouter(sf: ts.SourceFile): boolean {
  let found = routerFiles.get(sf);
  if (found === undefined) {
    found = sf.statements.some((s) => ts.isImportDeclaration(s) && ts.isStringLiteral(s.moduleSpecifier) && CLIENT_ROUTERS.some((r) => r.modules.includes((s.moduleSpecifier as ts.StringLiteral).text)));
    routerFiles.set(sf, found);
  }
  return found || repositories.has(sf);
}

type RouterName = { router: ClientRouter; name: string };

/**
 * The client router a name is imported from, and the name it is exported as ("default" for a default import): a binding
 * imported by name, or a member of a namespace import (`RR.Link` after `import * as RR`), straight from the router or
 * through a module of the repository that passes it on (`projectRouter`).
 */
function routerImport(e: ts.Node, depth = 0): RouterName | undefined {
  const m = ts.isPropertyAccessExpression(e) ? { receiver: e.expression, name: e.name.text } : undefined;
  const id = m ? unwrap(m.receiver) : e;
  if (!ts.isIdentifier(id)) return undefined;
  const d = declarationOf(id);
  if (!d || !(m ? ts.isNamespaceImport(d) : ts.isImportSpecifier(d) || ts.isImportClause(d))) return undefined;
  const declaration = ts.isImportSpecifier(d) ? d.parent.parent.parent : ts.isNamespaceImport(d) ? d.parent.parent : (d as ts.ImportClause).parent;
  const module = ts.isStringLiteral(declaration.moduleSpecifier) ? declaration.moduleSpecifier.text : "";
  const name = m ? m.name : ts.isImportSpecifier(d) ? (d.propertyName ?? d.name).text : "default";
  const router = CLIENT_ROUTERS.find((r) => r.modules.includes(module));
  if (router) return { router, name };
  return module && !declaration.importClause?.isTypeOnly ? projectRouter(id.getSourceFile(), module, name, depth) : undefined;
}

const projectRouters = new WeakMap<Constants, Map<string, RouterName | undefined>>();

/**
 * A router's component or function that a module of the repository exports under a name: one it passes on from the
 * router (`export { Route } from "react-router-dom"`), or a value it holds that is one (`routerValue`), as outline's
 * `components/ProfiledRoute` exports React Router's `Route`, wrapped by Sentry or not.
 */
function projectRouter(sf: ts.SourceFile, spec: string, name: string, depth: number): RouterName | undefined {
  const constants = repositories.get(sf);
  if (!constants || depth > 4) return undefined;
  const cache = projectRouters.get(constants) ?? projectRouters.set(constants, new Map()).get(constants)!;
  const key = `${sf.fileName}\0${spec}\0${name}`;
  if (cache.has(key)) return cache.get(key);
  // A module that leads back to itself is read as no router.
  cache.set(key, undefined);
  const x = constants.exportOf(sf.fileName, spec, name);
  let found: RouterName | undefined;
  if (x && "module" in x) {
    const router = CLIENT_ROUTERS.find((r) => r.modules.includes(x.module));
    found = router && { router, name: x.name };
  } else if (x && "node" in x) {
    repositories.set(x.node.getSourceFile(), constants);
    found = routerValue(x.node, depth + 1);
  }
  cache.set(key, found);
  return found;
}

const SENTRY = ["@sentry/react"];

/**
 * The router's component or function a declaration or expression of a module holds: a name it imports from the
 * router; Sentry's `withSentryRouting(Route)`, which renders the Route it is given with the props it is given
 * (@sentry/react, reactrouter.tsx); a `const` holding one; a `let` or `var` every value written to which is the same
 * one (`Component = Route` in one branch, `Component = Sentry.withSentryRouting(Route)` in the other).
 */
function routerValue(node: ts.Node, depth: number): RouterName | undefined {
  if (depth > 6) return undefined;
  if (ts.isVariableDeclaration(node)) {
    if (!ts.isIdentifier(node.name)) return undefined;
    if (node.parent.flags & ts.NodeFlags.Const) return node.initializer && routerValue(node.initializer, depth + 1);
    const values = writesTo(node);
    if (!values?.length) return undefined;
    const found = values.map((v) => routerValue(v, depth + 1));
    return found.every((f) => f && f.router === found[0]!.router && f.name === found[0]!.name) ? found[0] : undefined;
  }
  if (!ts.isExpression(node)) return undefined;
  const e = unwrap(node);
  if (ts.isCallExpression(e) && e.arguments.length === 1) {
    const callee = unwrap(e.expression);
    const m = member(callee);
    const wraps = m
      ? m.name === "withSentryRouting" && ts.isIdentifier(unwrap(m.receiver)) && namespaceOf(unwrap(m.receiver) as ts.Identifier, SENTRY)
      : ts.isIdentifier(callee) && importedFrom(callee, SENTRY) === "withSentryRouting";
    return wraps ? routerValue(e.arguments[0]!, depth + 1) : undefined;
  }
  if (ts.isPropertyAccessExpression(e)) return routerImport(e, depth);
  if (!ts.isIdentifier(e)) return undefined;
  const d = declarationOf(e);
  if (d && (ts.isImportSpecifier(d) || ts.isImportClause(d))) return routerImport(e, depth);
  return d && ts.isVariableDeclaration(d) ? routerValue(d, depth + 1) : undefined;
}

/** Whether a name is a namespace import of one of these modules (`import * as Sentry from "@sentry/react"`). */
function namespaceOf(id: ts.Identifier, modules: string[]): boolean {
  const d = declarationOf(id);
  return !!d && ts.isNamespaceImport(d) && ts.isStringLiteral(d.parent.parent.moduleSpecifier) && modules.includes(d.parent.parent.moduleSpecifier.text);
}

/**
 * The values written to a variable: its initializer and the right side of each `=` to it in its file. Undefined where it
 * is written in any other way (`+=`, `++`, a destructuring, a loop's variable), so another value may be held.
 */
function writesTo(d: ts.VariableDeclaration): ts.Expression[] | undefined {
  const name = d.name as ts.Identifier;
  const values = d.initializer ? [d.initializer] : [];
  if (ts.isForInStatement(d.parent.parent) || ts.isForOfStatement(d.parent.parent)) return undefined;
  for (const ref of references(name)) {
    const place = outermost(ref);
    const parent = place.parent;
    if (ts.isBinaryExpression(parent) && parent.left === place && parent.operatorToken.kind >= ts.SyntaxKind.FirstAssignment && parent.operatorToken.kind <= ts.SyntaxKind.LastAssignment) {
      if (parent.operatorToken.kind !== ts.SyntaxKind.EqualsToken) return undefined;
      values.push(parent.right);
    } else if (written(place)) return undefined;
  }
  return values;
}

/** Whether an expression is written to other than by a plain `=`: `++`, `--`, a destructuring's target, a loop's. */
function written(e: ts.Node): boolean {
  const parent = e.parent;
  if ((ts.isPrefixUnaryExpression(parent) || ts.isPostfixUnaryExpression(parent)) && (parent.operator === ts.SyntaxKind.PlusPlusToken || parent.operator === ts.SyntaxKind.MinusMinusToken)) return true;
  if ((ts.isForInStatement(parent) || ts.isForOfStatement(parent)) && parent.initializer === e) return true;
  // In an array or object literal that is the target of an assignment or a loop, the name is written.
  let target: ts.Node = e;
  while (
    ts.isArrayLiteralExpression(target.parent) ||
    ts.isSpreadElement(target.parent) ||
    ts.isShorthandPropertyAssignment(target.parent) ||
    ts.isSpreadAssignment(target.parent) ||
    (ts.isPropertyAssignment(target.parent) && target.parent.initializer === target) ||
    ts.isObjectLiteralExpression(target.parent) ||
    ts.isParenthesizedExpression(target.parent)
  )
    target = target.parent;
  if (target === e) return false;
  const holder = target.parent;
  return (ts.isBinaryExpression(holder) && holder.left === target && holder.operatorToken.kind === ts.SyntaxKind.EqualsToken) || ((ts.isForInStatement(holder) || ts.isForOfStatement(holder)) && holder.initializer === target);
}

/** Whether an expression is a call of one of a router's functions that return a value, by name (`navigators`, `histories`). */
function routerHookCall(e: ts.Expression | undefined, kind: "navigators" | "histories"): boolean {
  const call = e && unwrap(e);
  if (!call || !ts.isCallExpression(call)) return false;
  const imported = routerImport(unwrap(call.expression));
  return !!imported && imported.router[kind].includes(imported.name);
}

/**
 * Whether an expression is what a router's navigator returns (`kind` "navigators"), or a history (`kind` "histories"):
 * on the spot, held in a variable, or one of its navigating methods taken apart (`const { navigate } = useRouter()`,
 * `const { push } = useHistory()`).
 */
function routerHookValue(e: ts.Expression, kind: "navigators" | "histories"): boolean {
  if (routerHookCall(e, kind)) return true;
  if (!ts.isIdentifier(e)) return false;
  const d = declarationOf(e);
  if (d && ts.isVariableDeclaration(d)) return routerHookCall(d.initializer, kind);
  if (!d || !ts.isBindingElement(d) || !ts.isObjectBindingPattern(d.parent) || !ts.isVariableDeclaration(d.parent.parent)) return false;
  const key = d.propertyName ?? d.name;
  const names = kind === "navigators" ? ["navigate"] : ["push", "replace"];
  return ts.isIdentifier(key) && names.includes(key.text) && routerHookCall(d.parent.parent.initializer, kind);
}

/** What a call is to a client router: a navigation or route definition ("route"), a document load, or neither. */
function routerCall(callee: ts.Expression): "route" | "document" | undefined {
  const imported = routerImport(callee);
  if (imported) return imported.router.documents.includes(imported.name) ? "document" : imported.router.functions.includes(imported.name) ? "route" : undefined;
  const m = member(callee);
  if (m) {
    const receiver = unwrap(m.receiver);
    const navigates = (m.name === "navigate" && routerHookValue(receiver, "navigators")) || ((m.name === "push" || m.name === "replace") && routerHookValue(receiver, "histories"));
    return navigates ? "route" : undefined;
  }
  if (!ts.isIdentifier(callee)) return undefined;
  // A navigate function, or a history's `push` or `replace` taken apart: a history itself is no function.
  const d = declarationOf(callee);
  return routerHookValue(callee, "navigators") || (!!d && ts.isBindingElement(d) && routerHookValue(callee, "histories")) ? "route" : undefined;
}

/**
 * Whether a navigation's options or a component's attributes set `reloadDocument`, to anything but `false`: the last
 * one set wins, in a spread of an object literal too.
 */
function reloads(props: ts.ObjectLiteralExpression | ts.JsxAttributes): boolean {
  let reload = false;
  for (const p of props.properties) {
    if (ts.isJsxAttribute(p) && p.name.getText() === "reloadDocument") {
      const v = p.initializer && ts.isJsxExpression(p.initializer) ? p.initializer.expression : p.initializer;
      reload = !v || unwrap(v).kind !== ts.SyntaxKind.FalseKeyword;
    } else if (ts.isPropertyAssignment(p) && keyOf(p) === "reloadDocument") reload = unwrap(p.initializer).kind !== ts.SyntaxKind.FalseKeyword;
    else if (ts.isShorthandPropertyAssignment(p) && p.name.text === "reloadDocument") reload = true;
    else if (ts.isSpreadAssignment(p) || ts.isJsxSpreadAttribute(p)) {
      const spread = unwrap(p.expression);
      if (ts.isObjectLiteralExpression(spread) && setsReload(spread)) reload = reloads(spread);
    }
  }
  return reload;
}

/** Whether an object literal sets `reloadDocument`, itself or in a spread of another. */
function setsReload(o: ts.ObjectLiteralExpression): boolean {
  return o.properties.some((p) => {
    if (ts.isSpreadAssignment(p)) {
      const spread = unwrap(p.expression);
      return ts.isObjectLiteralExpression(spread) && setsReload(spread);
    }
    return (ts.isPropertyAssignment(p) && keyOf(p) === "reloadDocument") || (ts.isShorthandPropertyAssignment(p) && p.name.text === "reloadDocument");
  });
}

/**
 * What a string is to a client router (`CLIENT_ROUTERS`): "route" where it names one of the app's own routes, in an
 * attribute of the router's component or in the arguments of its function, through the objects, arrays and spreads
 * written there (a call or a function inside runs on its own); "document" where the navigation loads the document
 * instead, which the browser requests with GET: a `to` or `href` beside `reloadDocument`, or the URL React Router's
 * `redirectDocument` takes first (its response options are the router's, as `redirect`'s are). Undefined anywhere
 * else, and in a file that imports no client router. With `within`, `node` is an object followed to where it goes and
 * what is asked about is its property `within.key`, as if written there.
 */
function clientRoute(node: ts.Node, within?: { key: string; object: ts.ObjectLiteralExpression }): "route" | "document" | undefined {
  if (!importsRouter(node.getSourceFile())) return undefined;
  let value: ts.Node = valuePlace(node);
  // An object followed to where it goes, as the options holding the property followed.
  let key: string | undefined = within?.key;
  let options: ts.ObjectLiteralExpression | undefined = within?.object;
  for (;;) {
    const parent = value.parent;
    if (ts.isPropertyAssignment(parent) && parent.initializer === value) {
      key = keyOf(parent);
      options = parent.parent;
      value = valuePlace(parent.parent);
    } else if (ts.isSpreadAssignment(parent)) {
      options = parent.parent;
      value = valuePlace(parent.parent);
    } else if (ts.isArrayLiteralExpression(parent)) value = valuePlace(parent);
    else if (ts.isJsxExpression(parent)) value = parent;
    else break;
  }
  const holder = value.parent;
  const reloaded = (props: ts.ObjectLiteralExpression | ts.JsxAttributes) => (reloads(props) && (key === "to" || key === "href") ? "document" : "route");
  if (ts.isJsxAttribute(holder) || ts.isJsxSpreadAttribute(holder)) {
    if (ts.isJsxAttribute(holder)) key = holder.name.getText();
    const imported = routerImport(holder.parent.parent.tagName);
    return imported?.router.elements.includes(imported.name) ? reloaded(holder.parent) : undefined;
  }
  const place = argumentPlace(value);
  if (!place || !ts.isCallExpression(place.call)) return undefined;
  const call = routerCall(place.callee);
  if (call === "document") return place.at === 0 && key === undefined ? "document" : "route";
  return call === "route" && options ? reloaded(options) : call;
}

/**
 * The attributes the HTML standard and WAI-ARIA define as text for people (a hint, an advisory title, an image's
 * alternative text, an accessible name or description), never a URL. A component's prop of the same name is read as
 * the attribute it is named after.
 */
const TEXT_ATTRIBUTES = new Set(["placeholder", "title", "alt", "aria-label", "aria-description", "aria-placeholder", "aria-roledescription", "aria-valuetext"]);

/** Whether a value is a JSX attribute that holds text for people (`TEXT_ATTRIBUTES`). */
function textAttribute(value: ts.Node): boolean {
  const holder = ts.isJsxExpression(value.parent) ? value.parent.parent : value.parent;
  return ts.isJsxAttribute(holder) && TEXT_ATTRIBUTES.has(holder.name.getText());
}

/** The modules Lingui's macros are imported from: `@lingui/macro` up to version 4, the other two from version 5. */
const LINGUI = ["@lingui/macro", "@lingui/core/macro", "@lingui/react/macro"];

/** Lingui's macros that take a message to translate, as a tagged template or as arguments (Lingui, Macros reference). */
const LINGUI_MESSAGES = new Set(["t", "msg", "defineMessage", "plural", "select", "selectOrdinal"]);

/**
 * Whether an expression is one of Lingui's message macros (`LINGUI_MESSAGES`), imported by name, or the `t` that
 * `useLingui()` of `@lingui/react/macro` gives (`const { t } = useLingui()`).
 */
function linguiMacro(e: ts.Expression): boolean {
  const id = unwrap(e);
  if (!ts.isIdentifier(id)) return false;
  const imported = importedFrom(id, LINGUI);
  if (imported) return LINGUI_MESSAGES.has(imported);
  const d = declarationOf(id);
  if (!d || !ts.isBindingElement(d) || !ts.isObjectBindingPattern(d.parent) || !ts.isVariableDeclaration(d.parent.parent)) return false;
  const key = d.propertyName ?? d.name;
  const init = d.parent.parent.initializer && unwrap(d.parent.parent.initializer);
  return ts.isIdentifier(key) && key.text === "t" && !!init && ts.isCallExpression(init) && ts.isIdentifier(init.expression) && importedFrom(init.expression, ["@lingui/react/macro"]) === "useLingui";
}

/**
 * Whether a value is a message given to Lingui to translate (`` t`/month` ``, `t({ message })`, `plural(n, { one })`):
 * the text shown to people, which the macro turns into a lookup of its translation, not a URL.
 */
function message(value: ts.Node): boolean {
  if (ts.isTaggedTemplateExpression(value.parent) && value.parent.template === value) return linguiMacro(value.parent.tag);
  let v = value;
  while (ts.isPropertyAssignment(v.parent) && v.parent.initializer === v) v = valuePlace(v.parent.parent);
  const place = argumentPlace(v);
  return !!place && ts.isCallExpression(place.call) && linguiMacro(place.callee);
}

/**
 * Whether a value is only tested for truth: negated, the condition of an `if`, a loop or a conditional, the left of
 * `&&` (a path is truthy, so `&&` never gives it), or given to `typeof` or `void`.
 */
function testedForTruth(value: ts.Node): boolean {
  const p = value.parent;
  if (ts.isPrefixUnaryExpression(p)) return p.operator === ts.SyntaxKind.ExclamationToken;
  if (ts.isTypeOfExpression(p) || ts.isVoidExpression(p)) return true;
  if (ts.isConditionalExpression(p)) return p.condition === value;
  if (ts.isIfStatement(p) || ts.isWhileStatement(p) || ts.isDoStatement(p)) return p.expression === value;
  if (ts.isForStatement(p)) return p.condition === value;
  return ts.isBinaryExpression(p) && p.operatorToken.kind === ts.SyntaxKind.AmpersandAmpersandToken && p.left === value;
}

/** Methods of strings that test text and answer with a boolean or a number, not with any of the text. */
const TEXT_PREDICATES = new Set(["startsWith", "endsWith", "includes", "indexOf", "lastIndexOf", "search", "localeCompare"]);

/** Whether a value is the string a test is made on (`prefix.startsWith(x)`), or whose `length` is read. */
function testedText(value: ts.Node): boolean {
  const p = value.parent;
  const m = (ts.isPropertyAccessExpression(p) || ts.isElementAccessExpression(p)) && p.expression === value ? member(p) : undefined;
  if (!m) return false;
  const called = ts.isCallExpression(p.parent) && p.parent.expression === p;
  return m.name === "length" ? !called : called && TEXT_PREDICATES.has(m.name);
}

/** The text a URL expression starts with, where the code spells it out: its literal head, or the value of its lead. */
function leadingText(e: ts.Node): string | undefined {
  const u = ts.isExpression(e) ? unwrap(e) : e;
  if (ts.isStringLiteral(u) || ts.isNoSubstitutionTemplateLiteral(u)) return u.text;
  if (ts.isTemplateExpression(u)) return u.head.text || constantText(u.templateSpans[0]!.expression);
  if (isPlus(u)) return leadingText(operands(u)[0]!);
  return ts.isExpression(u) ? constantText(u) : undefined;
}

/** The string an expression is where the code of the repository spells it out (see `Constants`), in its file or one it imports. */
function constantText(e: ts.Expression): string | undefined {
  return repositories.get(e.getSourceFile())?.text(e);
}

/**
 * The host a URL's leading value names, where that value is a constant the code spells out in another file (a constant
 * of the same file is read with the URL): an origin such as `DOCUMENTATION_BASE_URL = "https://docs.twenty.com"`.
 */
function leadHost(node: ts.Node): string | undefined {
  const lead = ts.isTemplateExpression(node) && !node.head.text ? node.templateSpans[0]!.expression : isPlus(node) ? operands(node)[0] : undefined;
  const text = lead && constantText(unwrap(lead));
  return text === undefined ? undefined : hostOf(text);
}

/**
 * What `new URL(url, base)` (the global URL) resolves a string against, where it is the URL and a base is given: the
 * page ("page") where the base is the page's own address or that of the request a Next.js handler answers; the host a
 * base the code spells out names; or "value" for a base held in any other value, whose host the code does not state.
 * A root-relative URL takes the base's origin and none of its path (the URL Standard's basic URL parser), so the
 * request goes to the base's host, with no prefix the client puts before its own paths.
 */
function resolvedAgainst(node: ts.Node): "page" | "value" | { host: string } | undefined {
  const place = argumentPlace(valuePlace(node));
  if (!place || place.at !== 0 || !ts.isNewExpression(place.call) || !isGlobal(place.callee, new Set(["URL"])) || place.args.length < 2) return undefined;
  const base = unwrap(place.args[1]!);
  if (pageAddress(base) || requestAddress(base)) return "page";
  const text = ts.isStringLiteralLike(base) ? base.text : constantText(base);
  const host = text === undefined ? undefined : hostOf(text);
  return host === undefined ? "value" : { host };
}

/**
 * Whether a URL's text starts at the root of a host it does not name (`/orders`), as `new URL` resolves against its
 * base. One that starts with a value (`${API}/orders`) may be absolute already, and then takes no base.
 */
const rootRelative = (raw: string): boolean => raw.trim().startsWith("/") && !raw.trim().startsWith("//");

/** Whether a value is the base `new URL(url, base)` (the global URL) resolves a URL against, no request of its own. */
function urlBase(value: ts.Node): boolean {
  const place = argumentPlace(value);
  return !!place && place.at === 1 && ts.isNewExpression(place.call) && isGlobal(place.callee, new Set(["URL"]));
}

/**
 * Whether an expression is the page's own address, as the HTML standard names it: the Location (`location`,
 * `window.location`, `document.location`), its `href` or `origin`, the document's `baseURI`, `URL` or `documentURI`,
 * or the global `origin`. A binding the code declares under one of those names is its own value.
 */
function pageAddress(e: ts.Expression): boolean {
  if (isLocation(e) || isGlobal(e, new Set(["origin"]))) return true;
  const m = member(e);
  if (!m) return false;
  const receiver = unwrap(m.receiver);
  if (isLocation(receiver)) return m.name === "href" || m.name === "origin";
  if (isGlobal(receiver, new Set(["document"]))) return m.name === "baseURI" || m.name === "URL" || m.name === "documentURI";
  return m.name === "origin" && isGlobal(receiver, new Set(["window", "self", "globalThis"]));
}

/** The methods an App Router route handler may export (Next.js, route.js: Supported HTTP Methods). */
const ROUTE_HANDLERS = new Set(["GET", "HEAD", "POST", "PUT", "DELETE", "PATCH", "OPTIONS"]);

/**
 * Whether an expression is the address of the request a Next.js middleware, proxy or route handler answers: the `url`
 * or `nextUrl` (or its `href` or `origin`) of the request parameter of the handler Next.js calls with it (Next.js,
 * Middleware: `NextResponse.redirect(new URL('/home', request.url))`). That is the app's own address.
 */
function requestAddress(e: ts.Expression): boolean {
  let m = member(e);
  if (m && (m.name === "href" || m.name === "origin")) {
    const inner = member(unwrap(m.receiver));
    if (inner?.name !== "nextUrl") return false;
    m = inner;
  }
  if (!m || (m.name !== "url" && m.name !== "nextUrl")) return false;
  const receiver = unwrap(m.receiver);
  const d = ts.isIdentifier(receiver) ? declarationOf(receiver) : undefined;
  return !!d && ts.isParameter(d) && d.parent.parameters[0] === d && nextHandler(d.parent);
}

/**
 * Whether a function is one Next.js calls with the request it answers, the first parameter: in a `middleware` or
 * `proxy` file, the function exported as `middleware`, `proxy` or the default, or the one given to next-auth's
 * `withAuth`, which calls it with the request (next-auth, Middleware: `withAuth(function middleware(req) {...})`), where
 * that call is what the file exports; in an App Router `route` file, a function exported under an HTTP method's name.
 */
function nextHandler(fn: ts.SignatureDeclaration): boolean {
  const file = fn.getSourceFile().fileName;
  const middleware = /(?:^|\/)(?:middleware|proxy)\.(?:c|m)?[jt]s$/.test(file);
  const route = /(?:^|\/)app\/(?:.+\/)?route\.(?:c|m)?[jt]s$/.test(file);
  if (!middleware && !route) return false;
  const names = route ? ROUTE_HANDLERS : new Set(["middleware", "proxy"]);
  const exportedAs = (node: ts.Node): boolean => {
    // `export function GET(request)`, `export default function middleware(req)`.
    if (ts.isFunctionDeclaration(node)) {
      const modifiers = ts.getModifiers(node);
      if (!modifiers?.some((x) => x.kind === ts.SyntaxKind.ExportKeyword)) return false;
      return (middleware && modifiers.some((x) => x.kind === ts.SyntaxKind.DefaultKeyword)) || (!!node.name && names.has(node.name.text));
    }
    const place = valuePlace(node);
    const holder = place.parent;
    // `export default (req) => ...`, `export const GET = (request) => ...`.
    if (ts.isExportAssignment(holder)) return middleware && !holder.isExportEquals;
    if (ts.isVariableDeclaration(holder) && holder.initializer === place && ts.isIdentifier(holder.name) && names.has(holder.name.text)) {
      const statement = holder.parent.parent;
      return ts.isVariableStatement(statement) && !!ts.getModifiers(statement)?.some((x) => x.kind === ts.SyntaxKind.ExportKeyword);
    }
    return false;
  };
  if (exportedAs(fn)) return true;
  if (!middleware || !(ts.isFunctionExpression(fn) || ts.isArrowFunction(fn))) return false;
  const place = argumentPlace(valuePlace(fn));
  return !!place && place.at === 0 && ts.isCallExpression(place.call) && ts.isIdentifier(place.callee) && importedFrom(place.callee, ["next-auth/middleware"]) === "withAuth" && exportedAs(place.call);
}

/** Whether a variable is declared `const` (not `let`, `var` or `using`), exported or not, under a name or a pattern. */
function constList(d: ts.VariableDeclaration): boolean {
  const list = d.parent;
  return ts.isVariableDeclarationList(list) && !!(list.flags & ts.NodeFlags.Const) && !(list.flags & (ts.NodeFlags.Let | ts.NodeFlags.Using));
}

/** Whether a variable is a `const` (not a `let`, a `var` or a `using`) under a name, exported or not. */
function constDeclaration(d: ts.VariableDeclaration): d is ts.VariableDeclaration & { name: ts.Identifier } {
  return ts.isIdentifier(d.name) && constList(d);
}

/** The key a property of an object literal is written with, a computed key where it is a literal; undefined otherwise, and for `__proto__`, which sets the prototype. */
function writtenKey(p: ts.PropertyAssignment | ts.MethodDeclaration): string | undefined {
  const key = propertyName(p.name);
  return key === "__proto__" && !ts.isComputedPropertyName(p.name) ? undefined : key;
}

/**
 * Whether an object literal holds data alone, apart from `except`: properties written with a value that is no
 * `function` expression, or in short. A method, an accessor or a `function` may read its other properties through
 * `this`, and a spread may give any.
 */
function plainObject(o: ts.ObjectLiteralExpression, except?: ts.Node): boolean {
  return o.properties.every((p) => {
    if (p === except || ts.isShorthandPropertyAssignment(p)) return true;
    if (!ts.isPropertyAssignment(p)) return false;
    const v = unwrap(p.initializer);
    return !ts.isFunctionExpression(v) && !ts.isClassExpression(v);
  });
}

/** Whether an object literal writes a property of this name itself: reading another name may reach its prototype. */
function ownKey(o: ts.ObjectLiteralExpression, name: string): boolean {
  return o.properties.some((p) =>
    ts.isShorthandPropertyAssignment(p) ? p.name.text === name : (ts.isPropertyAssignment(p) || ts.isMethodDeclaration(p)) && writtenKey(p) === name,
  );
}

/**
 * Whether a function's body may read its arguments through `arguments`: an arrow function has none of its own, and
 * `arguments` in a nested function other than an arrow function is that function's.
 */
function readsArguments(fn: ts.SignatureDeclaration): boolean {
  if (ts.isArrowFunction(fn)) return false;
  let found = false;
  const visit = (n: ts.Node): void => {
    if (found || (n !== fn && ts.isFunctionLike(n) && !ts.isArrowFunction(n))) return;
    if (ts.isIdentifier(n) && n.text === "arguments" && isReference(n) && !declarationOf(n)) found = true;
    else ts.forEachChild(n, visit);
  };
  visit(fn);
  return found;
}

/** Whether a binding is written after it is declared (`f = other`, `f++`, a destructuring or a loop writing it). */
function reassigned(name: ts.Identifier): boolean {
  return references(name).some((ref) => {
    const place = outermost(ref);
    const p = place.parent;
    const assigned = ts.isBinaryExpression(p) && p.left === place && p.operatorToken.kind >= ts.SyntaxKind.FirstAssignment && p.operatorToken.kind <= ts.SyntaxKind.LastAssignment;
    return assigned || written(place);
  });
}

type Callable = ts.FunctionDeclaration | ts.FunctionExpression | ts.ArrowFunction | ts.MethodDeclaration;

/**
 * The function a call's callee names, with its body: one the file declares (`function f`, `const f = () => ...`), or one
 * a module of the repository exports and the file imports, as `Constants` follows imports. Undefined for any other
 * callee (a member, a parameter, a `let`, a function of a package), and for a function declaration the code writes
 * another value to (`send = fetch`), which may be what is called.
 */
function functionCalled(callee: ts.Expression): Callable | undefined {
  if (!ts.isIdentifier(callee)) return undefined;
  const d = declarationOf(callee);
  if (!d) return undefined;
  if (ts.isImportSpecifier(d) || ts.isImportClause(d)) {
    const declaration = ts.isImportSpecifier(d) ? d.parent.parent.parent : d.parent;
    const constants = repositories.get(callee.getSourceFile());
    if (!constants || declaration.importClause?.isTypeOnly || (ts.isImportSpecifier(d) && d.isTypeOnly) || !ts.isStringLiteral(declaration.moduleSpecifier)) return undefined;
    const x = constants.exportOf(callee.getSourceFile().fileName, declaration.moduleSpecifier.text, ts.isImportSpecifier(d) ? (d.propertyName ?? d.name).text : "default");
    if (!x || !("node" in x)) return undefined;
    repositories.set(x.node.getSourceFile(), constants);
    return callableOf(x.node);
  }
  return callableOf(d);
}

function callableOf(node: ts.Node): Callable | undefined {
  if (ts.isFunctionDeclaration(node)) return node.body && !(node.name && reassigned(node.name)) ? node : undefined;
  const init = ts.isVariableDeclaration(node) ? (constDeclaration(node) ? node.initializer : undefined) : ts.isExpression(node) ? node : undefined;
  const fn = init && unwrap(init);
  return fn && (ts.isArrowFunction(fn) || ts.isFunctionExpression(fn)) ? fn : undefined;
}

/** Array methods whose test compares each element with the value given, answering with a boolean or an index. */
const MEMBERSHIP = new Set(["includes", "indexOf", "lastIndexOf"]);

/**
 * Array methods that hand each element to the function given and answer with no element: a boolean, an index, nothing,
 * or what the function returns (`map`, `flatMap`), which is followed as the function's own value.
 */
const ITERATION = new Set(["some", "every", "findIndex", "findLastIndex", "forEach", "map", "flatMap"]);

/** The modules of the repository and where other files use what they export, by the constants that read them. */
const importersOf = new WeakMap<Constants, Importers>();

/**
 * What following a value needs: the URL's text, the call source's target, and where route registrations write paths;
 * what each binding was found to reach, and how many times the property followed was read.
 */
interface Follow {
  raw: string;
  origin: string | undefined;
  registered: (node: ts.Node) => boolean;
  /** What each binding followed, by what is followed in it, was found to reach; null while it is followed. */
  seen: Map<ts.Node, Map<string, boolean | null>>;
  reads: number;
}

/** A property path within a value followed: each key, with the object literal that writes it. Empty for the value itself. */
type Path = ReadonlyArray<{ key: string; object: ts.ObjectLiteralExpression }>;

const pathKey = (path: Path): string => path.map((p) => p.key).join("\0");

/**
 * Whether what a binding (or a function) reaches, by what is followed in it, is no request: found once for each, a
 * binding met again while it is followed being a cycle, which is left as it is read.
 */
function remembered(node: ts.Node, key: string, follow: Follow, find: () => boolean): boolean {
  const keys = follow.seen.get(node) ?? follow.seen.set(node, new Map()).get(node)!;
  const known = keys.get(key);
  if (known !== undefined) return known ?? false;
  keys.set(key, null);
  const found = find();
  keys.set(key, found);
  return found;
}

/** How many bindings deep a value is followed. */
const FOLLOW_DEPTH = 8;

/**
 * The value an expression is part of: past what `valuePlace` passes, the template or `+` it is written into, and a
 * `??`, `||` or the right of `&&`, which may give it; with the URLs (templates and `+`) it is written into on the way.
 */
function wholeValue(node: ts.Node): { value: ts.Node; urls: ts.Node[] } {
  const urls: ts.Node[] = [];
  let value = valuePlace(node);
  for (;;) {
    const parent = value.parent;
    const op = ts.isBinaryExpression(parent) ? parent.operatorToken.kind : undefined;
    if (ts.isTemplateSpan(parent) && parent.expression === value) {
      urls.push(parent.parent);
      value = valuePlace(parent.parent);
    } else if (isPlus(parent)) {
      urls.push(parent);
      value = valuePlace(parent);
    } else if (op === ts.SyntaxKind.QuestionQuestionToken || op === ts.SyntaxKind.BarBarToken) value = valuePlace(parent);
    else if (op === ts.SyntaxKind.AmpersandAmpersandToken && (parent as ts.BinaryExpression).right === value) value = valuePlace(parent);
    else return { value, urls };
  }
}

/**
 * Whether a value reaches no request. With no `path`, the value itself: the place it is used in is no request
 * (`unrequestedPlace`), it is written into a URL on a host other than the target's, or it goes on, as the code states,
 * only to such places (`goesOnUnrequested`). With one, the property at that path of the object the expression is:
 * each read of it is followed; a read of another property the object writes itself gives another value; a test for
 * truth, or a client router's navigation or route definition taking the object whole, reads none. Anything not followed
 * may be a request.
 */
function unrequestedValue(node: ts.Node, follow: Follow, depth: number, path: Path = []): boolean {
  if (!path.length) {
    const { value, urls } = wholeValue(node);
    // A URL read where it is written names its own host, which a limit names where it is another's (`urlHosts`).
    if (depth > 0 && urls.some((u) => otherHost(u, follow.origin))) return true;
    return unrequestedPlace(value, follow) || goesOnUnrequested(value, follow, depth, path);
  }
  const value = valuePlace(node);
  const read = value.parent;
  const m = (ts.isPropertyAccessExpression(read) || ts.isElementAccessExpression(read)) && read.expression === value ? member(read) : undefined;
  if (m) {
    if (m.name !== path[0]!.key) return ownKey(path[0]!.object, m.name);
    if (path.length === 1) follow.reads++;
    return unrequestedValue(read, follow, depth, path.slice(1));
  }
  if (testedForTruth(value) || (clientRoute(value, path[0]) === "route" && hostOf(follow.raw) === undefined)) return true;
  return goesOnUnrequested(value, follow, depth, path);
}

/**
 * Whether the place a value is used in is no request: a route registration's path, a comparison, a text test or the
 * text it is made on, a test for truth, a client router's own route, a Next.js middleware's matcher, the base a URL
 * is resolved against, an attribute of text for people, or a message to translate.
 */
function unrequestedPlace(value: ts.Node, follow: Follow): boolean {
  return (
    follow.registered(value) ||
    comparedOrTested(value) ||
    testedText(value) ||
    testedForTruth(value) ||
    textAttribute(value) ||
    message(value) ||
    middlewareMatcher(value, value.getSourceFile().fileName) ||
    urlBase(value) ||
    (clientRoute(value) === "route" && hostOf(follow.raw) === undefined)
  );
}

/** Whether a value is a URL whose leading text names a host other than the target's. */
function otherHost(value: ts.Node, origin: string | undefined): boolean {
  if (!(ts.isTemplateExpression(value) || isPlus(value))) return false;
  const lead = leadingText(value);
  const host = lead === undefined ? undefined : hostOf(lead);
  return host !== undefined && !reachesTarget(host, origin);
}

/**
 * Whether a value (or the property at `path` of it) goes on only to places that are no request, where the code states
 * where it goes: a `const` holding it, to every use of that const; an element of an array, held in a `const` or
 * written in place, to the array's tests and the functions its iterations hand each element to; a property of an
 * object literal, to where the object goes; an argument of a function the file declares or imports from the
 * repository, to every use of its parameter; a function's result, to every call of that function. A `const` or a
 * function a module exports is followed into the other files of the repository that import it (`Importers`). A
 * binding no code uses is left as it is read.
 */
function goesOnUnrequested(value: ts.Node, follow: Follow, depth: number, path: Path): boolean {
  if (depth >= FOLLOW_DEPTH) return false;
  const parent = value.parent;
  if (ts.isVariableDeclaration(parent) && parent.initializer === value) return constList(parent) && bindingUnrequested(parent.name, path, follow, depth);
  if (ts.isArrayLiteralExpression(parent)) return elementsUnrequested(parent, path, follow, depth);
  if (ts.isPropertyAssignment(parent) && parent.initializer === value) {
    const key = writtenKey(parent);
    const object = parent.parent;
    if (key === undefined || !plainObject(object)) return false;
    return unrequestedValue(object, follow, depth, [{ key, object }, ...path]);
  }
  if ((ts.isReturnStatement(parent) && parent.expression === value) || (ts.isArrowFunction(parent) && parent.body === value)) return returnedUnrequested(parent, path, follow, depth);
  return argumentUnrequested(value, path, follow, depth);
}

/**
 * Where a binding is used: its references in its file, and, where its module exports it (`export`, `export { name }`),
 * those of the other files of the repository that import it (`Importers`). Null where a use cannot be read: a default
 * export, or an import not read.
 */
function usesOf(name: ts.Identifier, declaration: ts.Node): ts.Expression[] | null {
  const uses: ts.Expression[] = [];
  const exported: string[] = [];
  const statement = ts.isVariableDeclaration(declaration) ? declaration.parent.parent : declaration;
  const modifiers = ts.canHaveModifiers(statement) ? ts.getModifiers(statement) : undefined;
  if (modifiers?.some((m) => m.kind === ts.SyntaxKind.ExportKeyword)) {
    if (modifiers.some((m) => m.kind === ts.SyntaxKind.DefaultKeyword)) return null;
    exported.push(name.text);
  }
  for (const ref of references(name)) {
    const p = ref.parent;
    if (ts.isExportSpecifier(p)) exported.push(p.name.text);
    else if (ts.isExportAssignment(p)) return null;
    else uses.push(ref);
  }
  if (!exported.length) return uses;
  const sf = name.getSourceFile();
  const constants = repositories.get(sf);
  const others = constants && importersOf.get(constants)?.uses(sf.fileName, declaration, exported);
  if (!others) return null;
  for (const o of others) repositories.set(o.getSourceFile(), constants);
  return [...uses, ...others];
}

/**
 * Whether what a binding holds (the property at `path` of it) reaches no request, at each of its uses (`usesOf`). A
 * destructuring follows every binding that takes the path's first key; a rest element, a computed key not read, an
 * array pattern, or a binding or property no code reads leave the value as it is read.
 */
function bindingUnrequested(name: ts.BindingName, path: Path, follow: Follow, depth: number): boolean {
  if (ts.isObjectBindingPattern(name)) {
    if (!path.length) return false;
    const [first, ...rest] = path;
    const keys = name.elements.map((e) => (e.dotDotDotToken ? undefined : e.propertyName ? propertyName(e.propertyName) : ts.isIdentifier(e.name) ? e.name.text : undefined));
    // A key computed from a value may be the one followed.
    if (keys.some((k, i) => k === undefined && !name.elements[i]!.dotDotDotToken)) return false;
    const taking = name.elements.filter((_, i) => keys[i] === first!.key);
    if (!taking.length) return false;
    if (!rest.length) follow.reads++;
    return taking.every((e) => bindingUnrequested(e.name, rest, follow, depth));
  }
  if (!ts.isIdentifier(name)) return false;
  return remembered(name.parent, pathKey(path), follow, () => {
    const uses = usesOf(name, name.parent);
    if (!uses?.length) return false;
    const reads = follow.reads;
    return uses.every((use) => unrequestedValue(use, follow, depth + 1, path)) && (!path.length || follow.reads > reads);
  });
}

/**
 * Whether the elements of an array (the property at `path` of each) reach no request: every use of the array, in place
 * or through the `const` holding it, is a test of membership (`includes`, `indexOf`), its `length`, an iteration that
 * hands each element to a function written there (`ITERATION`), or a `for...of`, whose element is followed through the
 * binding it is given to.
 */
function elementsUnrequested(array: ts.ArrayLiteralExpression, path: Path, follow: Follow, depth: number): boolean {
  const holder = valuePlace(array);
  const declaration = holder.parent;
  if (!(ts.isVariableDeclaration(declaration) && declaration.initializer === holder)) return elementUseUnrequested(holder, path, follow, depth);
  if (!constDeclaration(declaration)) return false;
  return remembered(holder, pathKey(path), follow, () => {
    const uses = usesOf(declaration.name, declaration);
    return !!uses?.length && uses.every((use) => elementUseUnrequested(outermost(use), path, follow, depth));
  });
}

function elementUseUnrequested(use: ts.Node, path: Path, follow: Follow, depth: number): boolean {
  const p = use.parent;
  if (ts.isForOfStatement(p) && p.expression === use) {
    const init = p.initializer;
    return ts.isVariableDeclarationList(init) && init.declarations.length === 1 && bindingUnrequested(init.declarations[0]!.name, path, follow, depth + 1);
  }
  const m = (ts.isPropertyAccessExpression(p) || ts.isElementAccessExpression(p)) && p.expression === use ? member(p) : undefined;
  if (!m) return false;
  const call = p.parent;
  const called = ts.isCallExpression(call) && call.expression === p;
  if (m.name === "length") return !called;
  if (!called) return false;
  if (MEMBERSHIP.has(m.name)) return true;
  if (!ITERATION.has(m.name)) return false;
  const fn = call.arguments[0] && unwrap(call.arguments[0]);
  // A third parameter, or a rest parameter anywhere, is given the array itself, which may then go anywhere.
  if (!fn || !(ts.isArrowFunction(fn) || ts.isFunctionExpression(fn)) || fn.parameters.length > 2 || fn.parameters.some((q) => q.dotDotDotToken) || readsArguments(fn)) return false;
  const first = fn.parameters[0];
  return !!first && bindingUnrequested(first.name, path, follow, depth + 1);
}

/**
 * Whether an argument (the property at `path` of it) reaches no request in the function called (`functionCalled`):
 * through the parameter in its place, which a spread before it, a rest parameter or the function's `arguments` would
 * leave unknown.
 */
function argumentUnrequested(value: ts.Node, path: Path, follow: Follow, depth: number): boolean {
  const place = argumentPlace(value);
  if (!place || !ts.isCallExpression(place.call) || place.args.slice(0, place.at + 1).some((a) => ts.isSpreadElement(a))) return false;
  const fn = functionCalled(place.callee);
  if (!fn || readsArguments(fn)) return false;
  const parameter = fn.parameters[place.at];
  return !!parameter && !parameter.dotDotDotToken && bindingUnrequested(parameter.name, path, follow, depth + 1);
}

/** The function a `return` (or an arrow function's body) gives its value from. */
function returningFunction(place: ts.Node): Callable | undefined {
  if (ts.isArrowFunction(place)) return place;
  for (let a = place.parent; a && !ts.isSourceFile(a); a = a.parent) {
    if (!ts.isFunctionLike(a)) continue;
    return ts.isFunctionDeclaration(a) || ts.isFunctionExpression(a) || ts.isArrowFunction(a) || ts.isMethodDeclaration(a) ? a : undefined;
  }
  return undefined;
}

/**
 * Whether a function's result (the property at `path` of it) reaches no request: at every call of the function, which
 * is a function the code declares (`function homePath()`), a `const` holding one, or a method of an object held in a
 * `const` whose other properties are data (`Route = { albums: () => "/albums" }`, called as `Route.albums()`), called
 * where it is written, in its file or, where its module exports it, in the files that import it. An `async` function or
 * a generator gives a promise or an iterator, a function written over (`f = other`) may be another, and a function
 * used in any other way (handed on, `call`, `bind`) may be called anywhere: each leaves the value as it is read.
 */
function returnedUnrequested(place: ts.Node, path: Path, follow: Follow, depth: number): boolean {
  const fn = returningFunction(place);
  if (!fn || !fn.body || fn.asteriskToken || ts.getModifiers(fn)?.some((m) => m.kind === ts.SyntaxKind.AsyncKeyword)) return false;
  const value = ts.isFunctionDeclaration(fn) || ts.isMethodDeclaration(fn) ? fn : valuePlace(fn);
  const parent = value.parent;
  // Called on the spot.
  if (ts.isCallExpression(parent) && parent.expression === value) return unrequestedValue(parent, follow, depth + 1, path);
  if (ts.isFunctionDeclaration(fn)) return !!fn.name && !reassigned(fn.name) && callsUnrequested(fn.name, fn, undefined, path, follow, depth);
  if (ts.isVariableDeclaration(parent) && parent.initializer === value) return constDeclaration(parent) && callsUnrequested(parent.name, parent, undefined, path, follow, depth);
  const holder = ts.isMethodDeclaration(fn) ? fn : parent;
  if (!((ts.isPropertyAssignment(holder) && holder.initializer === value) || ts.isMethodDeclaration(holder)) || !ts.isObjectLiteralExpression(holder.parent)) return false;
  const key = writtenKey(holder);
  const object = holder.parent;
  if (key === undefined || !plainObject(object, holder)) return false;
  const declaration = valuePlace(object).parent;
  if (!ts.isVariableDeclaration(declaration) || declaration.initializer !== valuePlace(object) || !constDeclaration(declaration)) return false;
  return callsUnrequested(declaration.name, declaration, { key, object }, path, follow, depth);
}

/**
 * Whether every use of a function's name (with `method`, of the object holding it as that method) is a call whose
 * result, the property at `path` of it, reaches no request (`usesOf`). A read of another property the object writes
 * itself is another value.
 */
function callsUnrequested(
  name: ts.Identifier,
  declaration: ts.Node,
  method: { key: string; object: ts.ObjectLiteralExpression } | undefined,
  path: Path,
  follow: Follow,
  depth: number,
): boolean {
  if (depth >= FOLLOW_DEPTH) return false;
  return remembered(declaration, `()${method?.key ?? ""}\0${pathKey(path)}`, follow, () => {
    const uses = usesOf(name, declaration);
    if (!uses?.length) return false;
    return uses.every((use) => {
      let callee: ts.Node = outermost(use);
      if (method) {
        const read = callee.parent;
        const m = (ts.isPropertyAccessExpression(read) || ts.isElementAccessExpression(read)) && read.expression === callee ? member(read) : undefined;
        if (!m) return false;
        if (m.name !== method.key) return ownKey(method.object, m.name);
        callee = outermost(read);
      }
      const call = callee.parent;
      return ts.isCallExpression(call) && call.expression === callee && unrequestedValue(call, follow, depth + 1, path);
    });
  });
}

/**
 * Whether a file is the route tree TanStack Router's generator writes (`routeTree.gen.ts`), which registers the routes
 * it holds by declaring `FileRoutesByPath` in `@tanstack/react-router`: every path in it is one of the app's own routes.
 */
function generatedRouteTree(sf: ts.SourceFile): boolean {
  return sf.statements.some(
    (s) =>
      ts.isModuleDeclaration(s) &&
      ts.isStringLiteral(s.name) &&
      TANSTACK_ROUTER.includes(s.name.text) &&
      !!s.body &&
      ts.isModuleBlock(s.body) &&
      s.body.statements.some((d) => ts.isInterfaceDeclaration(d) && d.name.text === "FileRoutesByPath"),
  );
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
export type ReadCall = Draft<Call> & { span?: [number, number]; host?: string; relative?: true; base?: Base };

/**
 * A path as a URL's place reads it: `relative` where it is written without a leading `/` against a client's base, the
 * base its client states, the method its library sends and the host its base names.
 */
type Requested = CallPath & { relative?: true; base?: Base; method?: string; host?: string };

/**
 * Whether a URL is written over the URL a request config holds, built from it (`config.url = `/v2${config.url}``), as an
 * interceptor rewrites each request's URL: the requests it rewrites are read where they are made.
 */
function rewritesOwnUrl(node: ts.Node): boolean {
  const value = valuePlace(node);
  const write = value.parent;
  const assigned = ts.isBinaryExpression(write) && write.right === value && write.operatorToken.kind === ts.SyntaxKind.EqualsToken ? member(unwrap(write.left))?.name : undefined;
  const property = ts.isPropertyAssignment(write) && write.initializer === value ? writtenKey(write) : undefined;
  if ((assigned ?? property) !== "url") return false;
  // Built from the `url` of a parameter: the config the function is given.
  let own = false;
  const visit = (n: ts.Node): void => {
    const m = ts.isExpression(n) ? member(n) : undefined;
    const receiver = m && unwrap(m.receiver);
    const d = receiver && ts.isIdentifier(receiver) ? declarationOf(receiver) : undefined;
    if (m?.name === "url" && d && ts.isParameter(d)) own = true;
    else ts.forEachChild(n, visit);
  };
  visit(value);
  return own;
}

/** Whether a path is the path of a base, a trailing `/` aside; the root is the base of everything, and no path's. */
function sameBase(path: string, base: string): boolean {
  const b = joinRoute(base);
  return b !== "/" && joinRoute(path) === b;
}

/**
 * The text a function puts straight before the path it is given at a parameter, where it requests a URL built so and
 * hands the parameter to no other call: `` fetch(`/api${path}`) `` puts `/api` before each path passed as `path`.
 * Undefined for a function that does otherwise, a rest parameter, one read through `arguments` or written to.
 */
function helperPrefix(fn: Callable, index: number): string | undefined {
  if (helpers.has(fn) && helpers.get(fn)!.has(index)) return helpers.get(fn)!.get(index);
  const found = helperPrefixOf(fn, index);
  (helpers.get(fn) ?? helpers.set(fn, new Map()).get(fn)!).set(index, found);
  return found;
}

const helpers = new WeakMap<Callable, Map<number, string | undefined>>();

function helperPrefixOf(fn: Callable, index: number): string | undefined {
  const p = fn.parameters[index];
  if (!p || p.dotDotDotToken || !ts.isIdentifier(p.name) || readsArguments(fn) || reassigned(p.name)) return undefined;
  let found: string | undefined;
  for (const ref of references(p.name)) {
    const place = valuePlace(ref);
    const url = ts.isTemplateSpan(place.parent) ? place.parent.parent : isPlus(place.parent) ? place.parent : undefined;
    const lead = url && helperLead(url, place);
    if (lead !== undefined) {
      if (!requestPosition(url!) || (found !== undefined && found !== lead)) return undefined;
      found = lead;
    } else if (argumentPlace(place) || ts.isSpreadElement(place.parent)) return undefined;
  }
  // `/users/${id}` takes a segment, not a path: the text before a path ends in no `/`, and what the function is given
  // there is a path from the root, wherever the code passes it text.
  return found !== undefined && !found.endsWith("/") && passesPaths(fn, index) ? found : undefined;
}

/**
 * Whether the calls of a function, where the code names it (`usesOf`), pass it text at a position, and every text
 * passed there is a path from the root: a string, or a template or `+` that starts with one.
 */
function passesPaths(fn: Callable, index: number): boolean {
  const name = ts.isFunctionDeclaration(fn) ? fn.name : ts.isVariableDeclaration(valuePlace(fn).parent) ? (valuePlace(fn).parent as ts.VariableDeclaration).name : undefined;
  if (!name || !ts.isIdentifier(name)) return false;
  const uses = usesOf(name, name.parent);
  let text = false;
  for (const use of uses ?? []) {
    const call = outermost(use).parent;
    if (!ts.isCallExpression(call) || outermost(call.expression) !== outermost(use)) continue;
    const arg = call.arguments[index] && unwrap(call.arguments[index]);
    if (!arg) continue;
    const lead = ts.isStringLiteralLike(arg) ? arg.text : ts.isTemplateExpression(arg) ? arg.head.text : isPlus(arg) && ts.isStringLiteralLike(unwrap(operands(arg)[0]!)) ? (unwrap(operands(arg)[0]!) as ts.StringLiteral).text : undefined;
    if (lead === undefined) continue;
    if (!lead.startsWith("/") || lead.startsWith("//")) return false;
    text = true;
  }
  return text;
}

/** The text a URL puts straight before a value, `` `/api${value}` `` or `"/api" + value`, where it is a path from the root. */
function helperLead(url: ts.Node, value: ts.Node): string | undefined {
  let lead: string | undefined;
  if (ts.isTemplateExpression(url) && url.templateSpans.length === 1 && url.templateSpans[0]!.expression === unwrap(value as ts.Expression) && !url.templateSpans[0]!.literal.text) lead = url.head.text;
  else if (isPlus(url) && !isPlus(url.parent)) {
    const parts = operands(url).map(unwrap);
    if (parts.length === 2 && ts.isStringLiteralLike(parts[0]!) && parts[1] === unwrap(value as ts.Expression)) lead = parts[0].text;
  }
  return lead !== undefined && callPath(lead) && !callPath(lead)!.based ? lead : undefined;
}

/** The text a helper's URL puts before its path parameter, where the URL is such a helper's (`helperPrefix`). */
function helperUrl(node: ts.Node): string | undefined {
  const value = ts.isTemplateExpression(node) && node.templateSpans.length === 1 ? node.templateSpans[0]!.expression : isPlus(node) ? operands(node)[1] : undefined;
  const id = value && unwrap(value);
  if (!id || !ts.isIdentifier(id)) return undefined;
  const d = declarationOf(id);
  if (!d || !ts.isParameter(d)) return undefined;
  const fn = d.parent;
  if (!(ts.isFunctionDeclaration(fn) || ts.isFunctionExpression(fn) || ts.isArrowFunction(fn) || ts.isMethodDeclaration(fn))) return undefined;
  const lead = helperLead(node, id);
  return lead !== undefined && helperPrefix(fn, fn.parameters.indexOf(d)) === lead ? lead : undefined;
}

/** The text a helper the string is handed to puts before it (`helperPrefix`), where the helper is one the code names. */
function helperBefore(node: ts.Node): string | undefined {
  const place = argumentPlace(valuePlace(node));
  if (!place || !ts.isCallExpression(place.call)) return undefined;
  const fn = functionCalled(place.callee);
  return fn ? helperPrefix(fn, place.at) : undefined;
}

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
  /** Whether a route of the target serves a path; a path with a file extension is read only then. */
  served?: (path: string) => boolean;
  /** Per template, the paths of the routes that render it, against which a URL relative to the page is resolved. */
  pages?: Map<string, string[]>;
  /** Collects the Thymeleaf links whose URL is a value, not text (`@{${url}}`, `@{__${link}__}`). */
  unread?: Place[];
  /** Collects the page-relative URLs and forms with no action of a template no route atlas reads renders. */
  unpaged?: Place[];
  /** Collects the other hosts a URL's leading hole may name (`leadingHosts`), where the URL is still read. */
  elsewhere?: Array<{ host: string; at: Place }>;
  /** Collects the URLs resolved against a base held in a value (`new URL(path, base)`), whose host is not read. */
  unbased?: Place[];
  /** The base the call source's configuration gives its client (`base` and `join`, or `prefix`). */
  base?: Base;
  /** The client instances the code creates, with their bases (see `Clients`). */
  clients?: Clients;
  /** Collects where the configured base is written as a value of its own, which is the base and no request. */
  written?: Place[];
  /** Collects the requests through a client left unread because how they join its base is not read, with why. */
  unjoined?: Array<{ why: string; at: Place }>;
  /** Collects the URLs of a helper that puts a path before the path it is given, read before its callers' paths. */
  helpers?: Array<{ prefix: string; at: Place }>;
  /** Collects the paths written relative to a base the call source does not give (code read as text). */
  unbaseRelative?: Place[];
  /**
   * The strings the repository's code spells out, which follow imports to the modules of the repository (see
   * `Constants`); without them, a file is read alone.
   */
  constants?: Constants;
}

/**
 * The hosts the branches of a conditional in a URL's leading hole name, `undefined` for a branch that names none
 * (`${prod ? "https://x.example" : ""}/api`, or the same joined with `+`); empty when the hole is no such conditional.
 * The hole is looked for at the start of a template or concatenation the URL starts with, and in the value of a `const`
 * it starts with, as the URL's text is read. A branch that is not a literal may hold any host, so it is left out.
 */
function leadingHosts(node: ts.Node, depth = 0): { hosts: Array<string | undefined>; literal: boolean } {
  const none = { hosts: [], literal: false };
  const lead = ts.isTemplateExpression(node) && !node.head.text ? node.templateSpans[0]!.expression : isPlus(node) ? operands(node)[0] : undefined;
  const choice = lead && unwrap(lead);
  if (!choice || depth > 4) return none;
  if (ts.isTemplateExpression(choice) || isPlus(choice)) return leadingHosts(choice, depth + 1);
  if (ts.isIdentifier(choice)) {
    const value = constFor(choice)?.initializer;
    return value ? leadingHosts(unwrap(value), depth + 1) : none;
  }
  if (!ts.isConditionalExpression(choice)) return none;
  const branches = [unwrap(choice.whenTrue), unwrap(choice.whenFalse)].filter((b) => ts.isStringLiteral(b) || ts.isNoSubstitutionTemplateLiteral(b));
  return { hosts: branches.map((b) => hostOf((b as ts.StringLiteral).text)), literal: branches.length === 2 };
}

/**
 * The host a URL is read as requesting (`undefined` where it may be the target's) and the other hosts it may name, from
 * the host its text names, the base `new URL` resolves it against (`resolvedAgainst`), the host a constant of another
 * file it starts with names (`leadHost`), or else the conditional in its leading hole (`leadingHosts`): a URL every
 * branch of which names another host requests the first of them.
 */
function urlHosts(node: ts.Node, raw: string, origin: string | undefined): { host: string | undefined; other: string[] } {
  const against = rootRelative(raw) ? resolvedAgainst(node) : undefined;
  const named = hostOf(raw) ?? (typeof against === "object" ? against.host : leadHost(node));
  if (named !== undefined) return { host: named, other: [] };
  const { hosts, literal } = leadingHosts(node);
  const other = hosts.filter((h): h is string => h !== undefined && !reachesTarget(h, origin));
  return { host: literal && other.length === hosts.length ? other[0] : undefined, other };
}

/**
 * Whether an absolute URL's host (undefined for a relative URL, or a host held in a value) is the call source's
 * target: a loopback address, where the repository's components run side by side, or the host its origin names.
 */
export const reachesTarget = (host: string | undefined, origin: string | undefined): boolean => host === undefined || isLoopback(host) || host === origin;

export function callsFromTypeScript(file: string, text: string, spec: CallSource, context: ReadContext = {}): ReadCall[] {
  const { spans, passed, origin, prefixed, elsewhere } = context;
  const sf = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true, file.endsWith("x") ? ts.ScriptKind.TSX : ts.ScriptKind.TS);
  if (generatedRouteTree(sf)) return [];
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
  const constants = context.constants ?? new Constants({ read: (f) => (f === file ? text : undefined), list: () => [file] });
  repositories.set(sf, constants);
  const clients = context.clients ?? new Clients(constants, importersOf.get(constants), () => undefined);
  const base = context.base;
  // The base a configured client appends its paths to, which a helper of the client may write once more.
  const appended = base?.join === "append" ? base.path : undefined;
  const at = (node: ts.Node): Place => ({ file, line: lineAt(node) });
  /** The path a URL reads as where it is written, or undefined where its place says it is no request. */
  const requested = (node: ts.Node, raw: string, report: boolean): Requested | undefined => {
    if (registered(node) || comparedOrTested(node) || pathOffRoot(node, raw) || middlewareMatcher(node, file)) return undefined;
    // A client router's own route, unless it names another origin (`<Link to="https://...">`), which the browser loads.
    if (clientRoute(node) === "route" && hostOf(raw) === undefined) return undefined;
    // A client's base option is where its requests start, and an interceptor's rewrite of a request's own URL is that
    // request's: neither is a request of its own.
    if (clients.baseOption(node) || rewritesOwnUrl(node)) return undefined;
    if (appended && prefixing(node, appended)) {
      if (report) prefixed?.push(at(node));
      return undefined;
    }
    const helper = helperUrl(node);
    if (helper !== undefined && joinRoute(helper) !== joinRoute(appended ?? "")) {
      if (report) context.helpers?.push({ prefix: helper, at: at(node) });
      return undefined;
    }
    const client = clients.requestOf(node);
    // A path a helper of the module puts text before (`` fetch(`/api${path}`) ``) is sent with that text.
    const before = helperBefore(node);
    const written = before !== undefined && joinRoute(before) !== joinRoute(appended ?? "") ? before + raw.trimStart() : raw;
    let parsed: Requested | undefined = callPath(written, false, context.served) ?? rootRequest(node, written, spec.wrappers);
    if (!parsed && client?.relative) parsed = relativePath(written, context.served);
    if (!parsed) return undefined;
    const follow: Follow = { raw: written, origin, registered: (n) => n.getSourceFile() === sf && registered(n), seen: new Map(), reads: 0 };
    if (unrequestedValue(node, follow, 0)) return undefined;
    if (client) {
      if (client.rejected && !parsed.based && !parsed.relative) {
        if (report) context.unjoined?.push({ why: client.rejected, at: at(node) });
        return undefined;
      }
      // A base not read leaves the path a request joins it at unknown, unless the configuration gives the base, or the
      // path starts at the root of a base it resolves against; an interceptor or a hook not read may change any URL.
      const unread = client.unread;
      if (unread && (!unread.join || (!base && !parsed.based && !(unread.join === "resolve" && !parsed.relative)))) {
        if (report) context.unjoined?.push({ why: unread.join ? `${unread.why} (set base and join)` : unread.why, at: at(node) });
        return undefined;
      }
      // On a client whose base is read, a URL that starts with a value may be absolute, and take no base, or a path
      // the base takes: which, the code does not say.
      if (client.base && client.relative && written.trimStart().startsWith(HOLE) && hostOf(written) === undefined) {
        if (report) context.unjoined?.push({ why: `it starts with a value, an absolute URL or a path ${client.name}'s base takes`, at: at(node) });
        return undefined;
      }
      if (parsed.relative && !client.base && !base) {
        if (report) context.unjoined?.push({ why: `${client.name} states no base a path without a leading / joins (set base and join)`, at: at(node) });
        return undefined;
      }
      if (!parsed.based) {
        if (client.before !== undefined) {
          const rewritten = callPath(client.before + (parsed.relative ? parsed.path.slice(1) : parsed.path));
          if (!rewritten) return undefined;
          parsed = { ...rewritten, ...(parsed.slash ? { slash: true as const } : {}) };
        }
        if (client.base) parsed = { ...parsed, base: client.base };
      }
      if (client.method) parsed = { ...parsed, method: client.method };
      if (client.host && !parsed.based) parsed = { ...parsed, host: client.host };
    } else if (base && !parsed.based && sameBase(parsed.path, base.path)) {
      // The configured base written once more (`baseUrl: "/api/v1/"`, `this.baseUrl = options.baseUrl || "/api"`).
      if (report) context.written?.push(at(node));
      return undefined;
    } else if (base && parsed.based && hostOf(written) === undefined && sameBase(parsed.path, base.path) && written.trimStart().startsWith(HOLE)) {
      // `${API_URL}/api/v1/`: the base after the origin a value holds.
      if (report) context.written?.push(at(node));
      return undefined;
    }
    const against = rootRelative(written) ? resolvedAgainst(node) : undefined;
    if (against === "value") {
      if (report) context.unbased?.push(at(node));
      return undefined;
    }
    if (typeof against === "object") parsed = { ...parsed, based: true };
    const callee = laterArgument(node);
    if (callee === undefined) return parsed;
    if (report) passed?.push({ callee, at: at(node) });
    return undefined;
  };
  const add = (node: ts.Node, parsed: Requested, host: string | undefined): void => {
    found.push({ node, call: {
      from: spec.from,
      to: spec.to,
      method: parsed.method ?? (navigatesWithGet(node) ? "GET" : methodNear(node, spec.wrappers)),
      path: parsed.path,
      based: parsed.based,
      ...(parsed.slash ? { slash: true as const } : {}),
      ...(parsed.relative ? { relative: true as const } : {}),
      ...(parsed.base ? { base: parsed.base } : {}),
      at: at(node),
      evidence: "static",
      scope: scopeOf(node),
      span: [node.getStart(sf), node.getEnd()],
      host: host ?? parsed.host,
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
    // one joined to a base) are two requests, as is a branch to another host or one that differs in a trailing slash:
    // each is read on its own.
    if (ts.isConditionalExpression(node)) {
      const branches = [unwrap(node.whenTrue), unwrap(node.whenFalse)];
      const read = branches.map((b) => {
        const raw = ts.isStringLiteral(b) || ts.isNoSubstitutionTemplateLiteral(b) || ts.isTemplateExpression(b) || isPlus(b) ? urlText(b, 0) : undefined;
        const parsed = raw === undefined ? undefined : requested(b, raw, false);
        return parsed && { raw: raw!, parsed, ...urlHosts(b, raw!, origin) };
      });
      const [a, b] = read;
      const hosts = [a?.host, b?.host];
      const one = hosts[0] === hosts[1] || hosts.every((h) => reachesTarget(h, origin));
      const effective = (p: Requested) => {
        const on = p.base ?? base;
        return p.based || !on ? p.path : onBase(on, p.path, p.relative);
      };
      if (a && b && effective(a.parsed) === effective(b.parsed) && !a.parsed.slash === !b.parsed.slash && one) {
        // The path the base completes, where a branch has one, so the base is joined once.
        const chosen = a.parsed.based ? b.parsed : a.parsed;
        add(node, { ...chosen, based: a.parsed.based && b.parsed.based }, hosts[0] === hosts[1] ? hosts[0] : undefined);
        branches.forEach((branch) => merged.add(branch));
        for (const host of [...a.other, ...b.other]) elsewhere?.push({ host, at: { file, line: lineAt(node) } });
      }
    }
    let raw: string | undefined;
    if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node) || ts.isTemplateExpression(node)) raw = urlText(node, 0);
    // A whole concatenation is one URL; its pieces alone are not requests.
    const whole = isPlus(node) && !isPlus(node.parent) && !(ts.isParenthesizedExpression(node.parent) && isPlus(node.parent.parent));
    if (whole) raw = urlText(node, 0);
    if (raw !== undefined) {
      const parsed = merged.has(node) ? undefined : requested(node, raw, true);
      // A host chosen in the leading hole is another server's, as in a whole conditional: the URL is a request to the
      // target only where a branch names none of those hosts, and a limit names them.
      const { host, other } = parsed ? urlHosts(node, raw, origin) : { host: undefined, other: [] };
      if (parsed) add(node, parsed, host);
      for (const host of other) elsewhere?.push({ host, at: { file, line: lineAt(node) } });
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

/** A string literal written as an argument of a call, in code read as text, from its opening quote to just past its closing one. */
export interface Argument {
  start: number;
  end: number;
  /** The name the call is made by, whether on a receiver (`url.endsWith(`), and that receiver where it is a name. */
  name: string;
  method: boolean;
  receiver?: string;
  /** The argument's position, and the name it is given by (`prefixText: "/s/"`), if any. */
  index: number;
  label?: string;
  /** The exception it is given to, by the name it is called by. */
  exception?: string;
  /** Where the call's `(` is, which tells the arguments of one call from another's. */
  call: number;
  /** The call is an annotation (`@GET(`) or an attribute (`[Get(`), not a call. */
  annotation?: true;
}

/**
 * The string literals in code read as text that are arguments of a call, directly in its parentheses. A request
 * written inside those parentheses is inside a call of its own, so it is that call's.
 *
 * An argument is given to an exception when the call is thrown (`throw X(...)`, `raise X(...)`), or names a class as
 * Java's, Kotlin's, Dart's and Python's own exceptions are named (`...Error`, `...Exception`), or in Kotlin is one of
 * the standard library's throwing functions.
 */
export function callArguments(file: string, text: string): Argument[] {
  const kotlin = /\.kts?$/.test(file);
  const hash = /\.(py|pyi|rb|sh|bash)$/.test(file);
  const out: Argument[] = [];
  const frames: Array<{ open: string; name?: string; method?: boolean; receiver?: string; exception?: string; annotation?: boolean; index: number; from: number; at: number }> = [];
  const opener: Record<string, string> = { ")": "(", "]": "[", "}": "{" };
  for (let i = 0; i < text.length; ) {
    const c = text[i]!;
    const quote = text.startsWith('"""', i) ? '"""' : text.startsWith("'''", i) && hash ? "'''" : /["'`]/.test(c) ? c : undefined;
    if (quote) {
      const frame = frames.at(-1);
      const end = literalEnd(text, i, quote, file);
      if (frame?.name !== undefined) {
        const label = /^\s*([A-Za-z_]\w*)\s*(?::(?!:)|=(?!=))/.exec(text.slice(frame.from, i))?.[1];
        out.push({
          start: i,
          end,
          name: frame.name,
          method: !!frame.method,
          ...(frame.receiver ? { receiver: frame.receiver } : {}),
          index: frame.index,
          ...(label ? { label } : {}),
          ...(frame.exception ? { exception: frame.exception } : {}),
          call: frame.at,
          ...(frame.annotation ? { annotation: true as const } : {}),
        });
      }
      i = end;
      continue;
    }
    if (c === "(") {
      const before = withoutTypeArguments(text.slice(Math.max(0, i - 200), i));
      const m = CALLEE_BEFORE.exec(before);
      const [, thrown, receivers = "", name = ""] = m ?? [];
      const exception = !!thrown || /^(?:[A-Z]\w*)?(?:Error|Exception)$/.test(name) || (kotlin && !receivers && KOTLIN_THROWING.has(name));
      // A method is called on whatever comes before its dot, a call's result too (`get(x).replaceFirst(`). A keyword's
      // parentheses (`if ("/x")`) are no call.
      const method = /(?:\?\.|\.)\s*([A-Za-z_]\w*)\s*$/.exec(before);
      const bare = method ? undefined : /(?<![\w$])([A-Za-z_]\w*)\s*$/.exec(before)?.[1];
      frames.push({
        open: c,
        name: method ? method[1] : bare && !CONTROL_KEYWORDS.has(bare) ? bare : undefined,
        method: !!method,
        receiver: method ? /(?<![\w$.])([A-Za-z_]\w*)\s*(?:\?\.|\.)\s*[A-Za-z_]\w*\s*$/.exec(before)?.[1] : undefined,
        exception: m && exception ? (receivers + name).replace(/\s+/g, "") : undefined,
        // `@GET(` in Java and Kotlin, `[Get(` in C#: the callee written after `@`, or first in an attribute's brackets.
        annotation: /(?:@|\[\s*)(?:[A-Za-z_]\w*\s*\.\s*)*[A-Za-z_]\w*\s*$/.test(before),
        index: 0,
        from: i + 1,
        at: i,
      });
    } else if (c === "<" && /[\w$]/.test(text[i - 1] ?? "")) {
      // A call's type arguments (`helper<T, U>(`): their commas separate no arguments.
      const close = typeArgumentsEnd(text, i);
      if (close !== undefined) {
        i = close;
        continue;
      }
    } else if (c === "[" || c === "{") frames.push({ open: c, index: 0, from: i + 1, at: i });
    else if (c === ",") {
      const frame = frames.at(-1);
      if (frame) {
        frame.index++;
        frame.from = i + 1;
      }
    } else if (opener[c]) {
      // A bracket left open by text the scan misreads closes with the bracket around it.
      const at = frames.map((f) => f.open).lastIndexOf(opener[c]);
      if (at >= 0) frames.length = at;
    }
    i++;
  }
  return out;
}

/** Keywords of the languages read as text that are written before parentheses that hold no call's arguments. */
const CONTROL_KEYWORDS = new Set(["if", "elif", "while", "for", "foreach", "switch", "when", "catch", "using", "lock", "fixed", "return", "assert", "synchronized", "with", "in", "is", "not", "and", "or", "await", "yield", "throw", "raise", "case", "typeof", "sizeof", "nameof", "default", "else", "do"]);

/**
 * Where a call's type arguments that open at `open` (`<`) close, just past the `>` followed by the call's `(`; undefined
 * where they do not balance over characters type arguments are written with, or no `(` follows, as in a comparison.
 */
function typeArgumentsEnd(text: string, open: number): number | undefined {
  let depth = 0;
  for (let j = open; j < text.length && j < open + 200; j++) {
    const c = text[j]!;
    if (c === "<") depth++;
    else if (c === ">") {
      if (--depth === 0) return /^\s*\(/.test(text.slice(j + 1, j + 40)) ? j + 1 : undefined;
    } else if (!/[\w\s.,?*[\]$:]/.test(c)) return undefined;
  }
  return undefined;
}

/**
 * Methods of strings that test, search or cut text with their arguments, in each language read as text by its files:
 * Java's, Kotlin's and the JVM's (`java.lang.String`, `kotlin.text`), Dart's (`dart:core` String, whose `replaceFirst`
 * and `replaceAll` cut text; `Uri.replace` builds a URL and is no such method), Python's `str`, C#'s `System.String`,
 * Swift's `StringProtocol` and Foundation's, and Go's `strings` package (called on `strings`). An argument of one is no
 * request; other languages have none here.
 */
const TEXT_METHODS: Array<{ files: RegExp; names: Set<string>; receiver?: string }> = [
  {
    files: /\.(java|kt|kts|scala|groovy)$/,
    names: new Set(["startsWith", "endsWith", "contains", "indexOf", "lastIndexOf", "replace", "replaceFirst", "replaceAll", "split", "matches", "equals", "equalsIgnoreCase", "compareTo", "removePrefix", "removeSuffix", "substringBefore", "substringAfter", "substringBeforeLast", "substringAfterLast"]),
  },
  { files: /\.dart$/, names: new Set(["startsWith", "endsWith", "contains", "indexOf", "lastIndexOf", "replaceFirst", "replaceAll", "split", "compareTo"]) },
  { files: /\.pyi?$/, names: new Set(["startswith", "endswith", "removeprefix", "removesuffix", "find", "rfind", "index", "rindex", "count", "split", "rsplit", "partition", "rpartition", "replace"]) },
  { files: /\.cs$/, names: new Set(["StartsWith", "EndsWith", "Contains", "IndexOf", "LastIndexOf", "Replace", "Split", "Equals", "CompareTo"]) },
  { files: /\.swift$/, names: new Set(["hasPrefix", "hasSuffix", "contains", "replacingOccurrences", "components"]) },
  { files: /\.go$/, receiver: "strings", names: new Set(["HasPrefix", "HasSuffix", "TrimPrefix", "TrimSuffix", "CutPrefix", "CutSuffix", "Contains", "Index", "LastIndex", "Split", "Replace", "ReplaceAll", "EqualFold", "Count"]) },
];

/** The text properties of Flutter's `InputDecoration`, shown in or around a text field (Flutter API, InputDecoration). */
const INPUT_DECORATION_TEXT = new Set(["labelText", "hintText", "helperText", "prefixText", "suffixText", "counterText", "errorText", "semanticCounterText"]);

/**
 * ASP.NET Core's methods whose first argument is a route pattern the application serves (`app.MapGet("/x", ...)`,
 * `MapGroup`, YARP's `MapForwarder(pattern, destinationPrefix, targetPath)`, whose `targetPath` is the path it sends
 * the requests it forwards to), or a path the request is re-executed at inside the application
 * (`UseExceptionHandler("/Error")`, `UseStatusCodePagesWithReExecute`), each with the name of that parameter, by which a
 * named argument gives it in any position.
 */
const ASPNET_PATHS = new Map([
  ["Map", "pattern"],
  ["MapGet", "pattern"],
  ["MapPost", "pattern"],
  ["MapPut", "pattern"],
  ["MapDelete", "pattern"],
  ["MapPatch", "pattern"],
  ["MapMethods", "pattern"],
  ["MapGroup", "prefix"],
  ["MapForwarder", "pattern"],
  ["MapFallback", "pattern"],
  ["MapHub", "pattern"],
  ["MapHealthChecks", "pattern"],
  ["MapBlazorHub", "path"],
  ["UseExceptionHandler", "errorHandlingPath"],
  ["UseStatusCodePagesWithReExecute", "pathFormat"],
]);

/** ASP.NET Core's methods every argument of which names a file or a page of the application (`MapFallbackToFile`). */
const ASPNET_FILES = new Set(["MapFallbackToFile", "MapFallbackToPage"]);

/**
 * Whether a string argument is no request by the call it is given to: a text method of its file's language
 * (`TEXT_METHODS`) on a receiver; in Dart, a text property of Flutter's `InputDecoration`; in C#, a path ASP.NET Core
 * serves or re-executes at.
 */
function unrequestedArgument(file: string, a: Argument): boolean {
  const text = TEXT_METHODS.find((t) => t.files.test(file));
  if (a.method && text?.names.has(a.name) && (!text.receiver || a.receiver === text.receiver)) return true;
  if (/\.dart$/.test(file)) return a.name === "InputDecoration" && a.label !== undefined && INPUT_DECORATION_TEXT.has(a.label);
  if (!/\.cs$/.test(file)) return false;
  const path = ASPNET_PATHS.get(a.name);
  // A named argument is the parameter it names; a positional one is in the parameter's place.
  return (path !== undefined && (a.label === undefined ? a.index === 0 : a.label === path)) || ASPNET_FILES.has(a.name);
}

/** The argument whose literal holds an offset, among arguments in the order of their place. */
function argumentAt(list: Argument[], index: number): Argument | undefined {
  let lo = 0;
  let hi = list.length - 1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (list[mid]!.start <= index) lo = mid + 1;
    else hi = mid - 1;
  }
  const a = list[hi];
  return a && index < a.end ? a : undefined;
}

/**
 * Kotlin, Java, Swift, Python and other languages: double- or single-quoted string literals with `$x`, `${x}`, `{x}` or
 * `%s` holes. `labels` collects the paths left unread because they are given to an exception (`callArguments`); a path given to a
 * text method, or to an API that takes no request (`unrequestedArgument`), is not read either.
 */
/** What a reader of code read as text is told of the call source's base, and where it notes what it leaves unread. */
export interface TextContext {
  /** The base the call source's configuration gives its client. */
  base?: Base;
  /** Collects where the configured base is written as a value of its own. */
  written?: Place[];
  /** Collects the paths written relative to a base the configuration does not give. */
  unbaseRelative?: Place[];
  /** Collects the paths a type-level prefix is not read for, with why. */
  untyped?: Array<{ why: string; at: Place }>;
}

/** Retrofit's annotations of an interface method that name its method and its URL relative to the base URL. */
const RETROFIT_VERBS = new Set(["GET", "POST", "PUT", "PATCH", "DELETE", "HEAD", "OPTIONS"]);

/** Refit's attributes of an interface method that name its method and its route. */
const REFIT_VERBS = new Set(["Get", "Post", "Put", "Patch", "Delete", "Head", "Options"]);

/**
 * Where a string written without a leading `/` is a path, in code read as text: `base` where it is relative to the
 * client's base, `root` where it is the path of a URL whose host is given beside it. Retrofit's verb annotations
 * (`@GET("users/{id}")`, `@HTTP(path = ...)`), the URI of .NET's `new HttpRequestMessage(method, uri)`, and the URL a
 * call on one of the call source's `receivers` takes first (or after a method written as a string) are relative to
 * the base; the path Dart's `Uri.http(host, path)` and `Uri.https` take is from the root of that host.
 */
function pathPlace(file: string, a: Argument, args: Argument[], text: string, receivers: string[] | undefined): "base" | "root" | undefined {
  const jvm = /\.(java|kt|kts)$/.test(file);
  if (jvm && a.annotation && RETROFIT_VERBS.has(a.name) && a.index === 0 && (a.label === undefined || a.label === "value")) return "base";
  if (jvm && a.annotation && a.name === "HTTP" && a.label === "path") return "base";
  if (/\.cs$/.test(file) && a.name === "HttpRequestMessage" && !a.method && (a.label === "requestUri" || (a.label === undefined && a.index === 1))) return "base";
  if (/\.dart$/.test(file) && a.method && a.receiver === "Uri" && (a.name === "http" || a.name === "https") && a.index === 1 && a.label === undefined) return "root";
  if (!a.method || a.receiver === undefined || !receivers?.includes(a.receiver)) return undefined;
  const methodAt = (b: Argument | undefined) => !!b && METHODS.has(text.slice(b.start, b.end).replace(/^["'`]+|["'`]+$/g, "").toUpperCase());
  if (a.index === 0) return methodAt(a) ? undefined : "base";
  return a.index === 1 && methodAt(args.find((b) => b.call === a.call && b.index === 0)) ? "base" : undefined;
}

/**
 * Whether a string is a call's argument whole, not a piece of one joined to others (`"users/" + id`): between its
 * opening parenthesis, comma or name and the next comma or closing parenthesis there is nothing but the string.
 */
function wholeArgument(text: string, a: Argument): boolean {
  const before = text.slice(Math.max(0, a.start - 80), a.start).replace(/[$@fFrRbBuU]*$/, "");
  return /(?:[(,]|[A-Za-z_]\w*\s*(?::|=))\s*$/.test(before) && /^\s*[,)]/.test(text.slice(a.end, a.end + 80));
}

/**
 * The interfaces Refit's `[PathPrefix("/p")]` decorates, by where their bodies lie, with the prefix (Refit,
 * PathPrefixAttribute: joined before each method's route with one `/`), or why it is not read: an interface that
 * extends another, or that another of the file extends, takes or gives its methods another prefix.
 */
function refitPrefixes(file: string, text: string, args: Argument[]): Array<{ start: number; end: number; prefix?: string; why?: string; at: number }> {
  const out: Array<{ start: number; end: number; prefix?: string; why?: string; at: number }> = [];
  const interfaces = [...text.matchAll(/\binterface\s+(\w+)(?:\s*<[^>{]*>)?\s*(:[^{]*)?\{/g)];
  const bases = interfaces.flatMap((m) => (m[2] ?? "").slice(1).split(",").map((b) => b.trim().replace(/<.*$/, "")));
  for (const a of args) {
    if (!a.annotation || a.name !== "PathPrefix" || a.index !== 0) continue;
    const next = interfaces.find((m) => (m.index ?? 0) > a.end);
    if (!next) continue;
    const at = next.index ?? 0;
    const open = at + next[0].length - 1;
    const end = blockEnd(file, text, open) ?? text.length;
    // Between the attribute and the interface: its own brackets closing, other attributes, modifiers.
    const plain = /^\s*\)\s*\](?:\s*\[[^\]]*\])*\s*(?:(?:public|internal|partial|private|protected|unsafe)\s+)*$/.test(text.slice(a.end, at));
    const name = next[1]!;
    const why = !plain ? `the [PathPrefix] before ${name} is written with more than its path` : next[2] ? `${name} extends another interface` : bases.includes(name) ? `another interface extends ${name}` : undefined;
    out.push({ start: open, end, ...(why ? { why } : { prefix: text.slice(a.start + 1, a.end - 1) }), at: a.start });
  }
  return out;
}

/** Where the brace that opens at `open` closes, past the string literals in between; undefined where it does not. */
function blockEnd(file: string, text: string, open: number): number | undefined {
  let depth = 0;
  for (let i = open; i < text.length; i++) {
    const c = text[i]!;
    if (c === '"' || c === "'") {
      i = literalEnd(text, i, text.startsWith('"""', i) ? '"""' : c, file) - 1;
      continue;
    }
    if (c === "{") depth++;
    else if (c === "}" && --depth === 0) return i;
  }
  return undefined;
}

/** The calls the `@HttpExchange` interfaces of a Java or Kotlin file declare: each method's path under its interface's, and its method, else the interface's. */
function exchangeCalls(file: string, text: string, spec: CallSource, untyped?: TextContext["untyped"]): ReadCall[] {
  if (!/\.(java|kt|kts)$/.test(file)) return [];
  const out: ReadCall[] = [];
  for (const iface of httpExchanges(new Map([[file, text]])).values()) {
    if (!iface) continue;
    if (iface.inherits) untyped?.push({ why: "an @HttpExchange interface extends another, whose mappings are not read for it", at: { file, line: iface.line } });
    for (const member of iface.members) {
      const methods = member.methods?.length ? member.methods : iface.methods;
      if (!iface.paths || !member.paths || !methods) {
        untyped?.push({ why: "an @HttpExchange mapping is not spelled out in the file", at: { file, line: member.line } });
        continue;
      }
      for (const typePath of iface.paths)
        for (const path of member.paths) {
          const parsed = callPath(joinRoute(typePath, path).replace(/\{[^{}]*\}/g, HOLE));
          if (!parsed) continue;
          for (const method of methods.length ? methods : ["*"])
            out.push({ from: spec.from, to: spec.to, method, path: parsed.path, based: false, at: { file, line: member.line }, evidence: "text", scope: member.name });
        }
    }
  }
  return out;
}

export function callsFromText(file: string, original: string, spec: CallSource, spans?: Spans, labels?: Passed[], served?: (path: string) => boolean, context: TextContext = {}): ReadCall[] {
  const out: ReadCall[] = exchangeCalls(file, original, spec, context.untyped);
  const text = withoutComments(file, original);
  const scopeAt = textScopes(text);
  const args = callArguments(file, text);
  const csharp = /\.cs$/.test(file);
  const prefixes = csharp ? refitPrefixes(file, text, args) : [];
  for (const p of prefixes) if (p.why) context.untyped?.push({ why: `Refit's [PathPrefix] is not read where ${p.why}`, at: { file, line: lineOf(text, p.at) } });
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
    const before = text.slice(Math.max(0, index - 200), index);
    // The reader's strings are quoted pairs on one line, so it reads `"""/my"""` from its third quote: what decides is
    // the exception's literal the string lies in. A string in an f-string field is in code of its own.
    const argument = field ? undefined : argumentAt(args, index);
    // An `@HttpExchange` interface's mappings are read whole above; Refit's prefix is read before its routes.
    if (argument?.annotation && /^(?:Http|Get|Post|Put|Patch|Delete)Exchange$/.test(argument.name) && /\.(java|kt|kts)$/.test(file)) return;
    if (csharp && argument?.annotation && argument.name === "PathPrefix") return;
    const typed = csharp && argument?.annotation && REFIT_VERBS.has(argument.name) ? prefixes.find((p) => p.start < index && index < p.end) : undefined;
    if (typed?.why) return;
    const path = typed?.prefix ? `${typed.prefix.replace(/\/+$/, "")}/${inner.replace(/^\/+/, "")}` : inner;
    // The root path only as a verb call's URL.
    const place = argument && wholeArgument(text, argument) ? pathPlace(file, argument, args, text, spec.receivers) : undefined;
    let parsed: (CallPath & { relative?: true }) | undefined =
      place === "root" ? undefined : (callPath(path, false, served) ?? (VERB_BEFORE.test(before) ? callPath(path, true, served) : undefined));
    // The path of a URL whose host is given beside it starts at that host's root, a leading `/` written or not.
    let host = hostOf(inner);
    if (place === "root") {
      const root = callPath(`/${path.trim().replace(/^\/+/, "")}`, false, served);
      parsed = root && { ...root, based: true };
      // `Uri.https("maps.example.com", "/x")`: the host written beside the path.
      const authority = args.find((b) => b.call === argument!.call && b.index === 0);
      if (authority) host = hostOf(`http://${text.slice(authority.start + 1, authority.end - 1).replace(/\$\{[^}]*\}|\$[A-Za-z_]\w*/g, HOLE)}`);
    } else if (!parsed && place === "base") {
      parsed = relativePath(path, served);
      if (parsed && !context.base) {
        context.unbaseRelative?.push({ file, line: lineOf(text, index) });
        return;
      }
    }
    if (!parsed) return;
    if (argument?.exception) {
      labels?.push({ callee: argument.exception, at: { file, line: lineOf(text, index) } });
      return;
    }
    if (argument && unrequestedArgument(file, argument)) return;
    // The configured base written once more (`base_url=f"{API_URL}/api/v1"`, `SetBaseURL(gatewayURL + "/billing/v1")`).
    if (context.base && !parsed.relative && sameBase(parsed.path, context.base.path) && (!parsed.based || (inner.trimStart().startsWith(HOLE) && hostOf(inner) === undefined))) {
      context.written?.push({ file, line: lineOf(text, index) });
      return;
    }
    const lineStart = text.lastIndexOf("\n", index) + 1;
    const lineEnd = text.indexOf("\n", index);
    const line = text.slice(lineStart, lineEnd === -1 ? undefined : lineEnd);
    const verb = before.match(VERB_BEFORE)?.[1] ?? enumMethodNear(line, index - lineStart, index - lineStart + length);
    out.push({
      from: spec.from,
      to: spec.to,
      method: verb ? verb.toUpperCase() : "*",
      path: parsed.path,
      based: parsed.based,
      ...(parsed.slash ? { slash: true as const } : {}),
      ...(parsed.relative ? { relative: true as const } : {}),
      at: { file, line: lineOf(text, index) },
      evidence: "text",
      scope: scopeAt(index),
      host,
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
 * An attribute value with Thymeleaf's preprocessing (`__${...}__`, tutorial section 4.15) done as far as it can be
 * without the model: each preprocessed expression becomes a `{...}` group of the same length, a value written into the
 * text where it stands, as a path variable is.
 */
function preprocessed(value: string): string {
  return value.replace(/__[\s\S]*?__/g, (m) => `{${m.slice(1, -1).replace(/[^\n]/g, " ")}}`);
}

/** Where the `{` of a `${...}` (or a `{...}` group) at `open` closes, nested braces counted. */
function braceEnd(text: string, open: number): number | undefined {
  let depth = 0;
  for (let i = open; i < text.length; i++) {
    if (text[i] === "{") depth++;
    else if (text[i] === "}" && --depth === 0) return i;
  }
  return undefined;
}

/**
 * The URL a Thymeleaf link expression starting at `@{` writes, as text with `{...}` groups for the values in it, up to
 * its parameter list; null when its base is an expression whose value is the URL. Thymeleaf's Standard URL Syntax:
 * `@{/order/details(...)}` is a shortcut for `@{'/order/details'(...)}`, and the base may be any expression. Read are a
 * literal token, and text expressions that start with literal text: quoted literals and literal substitutions
 * (`|/a/${x}|`) appended with `+` (tutorial sections 4.7 and 4.8), any `${...}` in them a value. A base that starts with
 * a value (`${url}`, `|${base}/x|`) or is any other expression (a conditional) is the URL itself, and is not read.
 */
function linkUrl(text: string, at: number): string | null {
  let i = at + 2;
  const skip = () => {
    while (/\s/.test(text[i] ?? "")) i++;
  };
  skip();
  let url = "";
  if (text[i] === "'" || text[i] === "|") {
    for (let first = true; ; first = false) {
      skip();
      const c = text[i];
      if (c === "'") {
        let end = i + 1;
        while (end < text.length && text[end] !== "'") end += text[end] === "\\" ? 2 : 1;
        if (end >= text.length) return null;
        url += text.slice(i + 1, end).replace(/\\(.)/g, "$1");
        i = end + 1;
      } else if (c === "|") {
        const end = text.indexOf("|", i + 1);
        if (end < 0) return null;
        const body = text.slice(i + 1, end);
        if (first && /^[$*#]\{/.test(body)) return null;
        url += body.replace(/[$*#]\{[^}]*\}/g, HOLE);
        i = end + 1;
      } else if (!first && (/^[$*#]\{/.test(text.slice(i, i + 2)) || c === "{")) {
        const end = braceEnd(text, c === "{" ? i : i + 1);
        if (end === undefined) return null;
        url += HOLE;
        i = end + 1;
      } else return null;
      skip();
      if (text[i] !== "+") break;
      i++;
    }
  } else {
    if (/^[$*#(]/.test(text[i] ?? "")) return null;
    while (i < text.length) {
      const c = text[i]!;
      if (c === "{") {
        const close = text.indexOf("}", i);
        if (close < 0) return null;
        url += text.slice(i, close + 1);
        i = close + 1;
        continue;
      }
      if (c === "(" || c === "}" || /\s/.test(c)) break;
      url += c;
      i++;
    }
  }
  skip();
  return text[i] === "(" || text[i] === "}" ? url : null;
}

/**
 * What a link's URL requests: a path from the root (context-relative, or server-relative `~/...`), or a path relative
 * to the page (`edit`, `{id}/edit`, `?page=2`); undefined for a URL that requests nothing here (another site, another
 * scheme, a fragment of the same page); null for one whose path has no text of its own, only values (`{link}`).
 */
function linkTarget(url: string): { path: string; relative: boolean } | null | undefined {
  const u = url.trim().replace(/^~\//, "/");
  if (!u || u.startsWith("#") || u.startsWith("//") || /^[A-Za-z][A-Za-z0-9+.-]*:/.test(u)) return undefined;
  const path = u.split(/[?#]/)[0]!;
  if (/\{[^{}]*\}/.test(path) && !/[^/\s]/.test(path.replace(/\{[^{}]*\}/g, ""))) return null;
  return { path: u, relative: !u.startsWith("/") };
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
 *   attribute; a form with no action, or an empty one, submits to its page's URL;
 * - a link relative to the page, or a form with no action, once for each path in `context.pages` the template is
 *   rendered at, resolved against it (the call's `page`); with none, `context.unpaged` collects it;
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
  const at = (index: number): Place => ({ file, line: lineOf(text, index) });
  const add = (raw: string, index: number, tag: StartTag | undefined, name: string, from?: string) => {
    const base = name.startsWith("data-") && raw.length > 1 && raw.endsWith("/");
    // The root path in a link, a form target or a source; a script reads a `data-*` URL, which may be a base.
    const parsed = callPath(`${raw.replace(/\{[^{}]*\}/g, HOLE)}${base ? HOLE : ""}`, tag !== undefined && !name.startsWith("data-"), context.served);
    const method = tag ? templateMethod(page, tag, name) : "*";
    if (!parsed || method === null) return;
    out.push({
      from: spec.from,
      to: spec.to,
      method,
      path: parsed.path,
      based: false,
      ...(parsed.slash ? { slash: true as const } : {}),
      at: at(index),
      evidence: "text",
      ...(from === undefined ? {} : { page: from }),
    });
  };
  // A URL relative to the page is resolved against the URL of each page the template is rendered on: the path of each
  // route whose view it is. A route ending in a catch-all has no one path to resolve against.
  const pages = (context.pages?.get(file) ?? []).filter((p) => !/\{\*|\*\*/.test(p));
  const relative = (url: string, index: number, tag: StartTag | undefined, name: string) => {
    if (tag && templateMethod(page, tag, name) === null) return;
    if (!pages.length) context.unpaged?.push(at(index));
    for (const p of pages) add(resolveReference(p, url), index, tag, name, p);
  };
  /** A link expression at `index` of `value` (which starts at `start` in the template), in an attribute that requests. */
  const link = (value: string, index: number, start: number, tag: StartTag | undefined, name: string) => {
    const url = linkUrl(value, index);
    const target = url === null ? null : linkTarget(url);
    if (target === null) context.unread?.push(at(start + index));
    else if (target?.relative) relative(target.path, start + index, tag, name);
    else if (target) add(target.path, start + index, tag, name);
  };

  for (const tag of page.tags) {
    const plain = new Map(tag.attributes.filter((a) => !a.name.startsWith("th:") && !a.name.startsWith("data-th-")).map((a) => [a.name, a]));
    const replaced = new Set<string>();
    const joined = new Set<string>();
    for (const a of tag.attributes) {
      const th = /^(?:th:|data-th-)(.+)$/.exec(a.name)?.[1];
      if (!th) continue;
      const family = /^attr(append|prepend)?$/.exec(th);
      const value = preprocessed(a.value);
      for (let i = value.indexOf("@{"); i >= 0; i = value.indexOf("@{", i + 2)) {
        const name = family ? itemName(value, i) : th;
        if (!name || !requests(name)) continue;
        if (!family || !family[1]) {
          replaced.add(name);
          link(value, i, a.at, tag, name);
          continue;
        }
        // attrappend / attrprepend: the request is the static value with this added, if the static value is known.
        joined.add(name);
        const url = linkUrl(value, i);
        const target = url === null ? null : linkTarget(url);
        if (target === null) context.unread?.push(at(a.at + i));
        const fixed = plain.get(name);
        if (!target || !fixed) continue;
        // The joined URL is read as a written one is: from the root, or relative to the page.
        const joinedTarget = linkTarget(family[1] === "append" ? `${fixed.value}${target.path}` : `${target.path}${fixed.value}`);
        if (joinedTarget?.relative) relative(joinedTarget.path, fixed.at, tag, name);
        else if (joinedTarget) add(joinedTarget.path, fixed.at, tag, name);
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
    // A form with no action, or an empty one, submits to the URL of its document (HTML's form submission algorithm).
    const action = plain.get("action");
    if (tag.name === "form" && !replaced.has("action") && !joined.has("action") && !action?.value.trim()) relative("", action?.at ?? tag.start, tag, "action");
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
    const elsewhere: Array<{ host: string; at: Place }> = [];
    const unbased: Place[] = [];
    const written: Place[] = [];
    const helpers: Array<{ prefix: string; at: Place }> = [];
    const unjoined: Array<{ why: string; at: Place }> = [];
    const read = callsFromTypeScript(`${file}.js`, body, spec, { passed: inScript, origin: context.origin, prefixed, elsewhere, unbased, base: context.base, written, helpers, unjoined });
    for (const c of read) out.push({ ...withoutSpan(c), at: { file, line: c.at.line + shift } });
    const moved = (p: Place): Place => ({ file, line: p.line + shift });
    context.unbased?.push(...unbased.map(moved));
    context.written?.push(...written.map(moved));
    context.helpers?.push(...helpers.map((h) => ({ prefix: h.prefix, at: moved(h.at) })));
    context.unjoined?.push(...unjoined.map((u) => ({ why: u.why, at: moved(u.at) })));
    context.passed?.push(...inScript.map((p) => ({ ...p, at: { file, line: p.at.line + shift } })));
    context.prefixed?.push(...prefixed.map((p) => ({ file, line: p.line + shift })));
    context.elsewhere?.push(...elsewhere.map((e) => ({ host: e.host, at: { file, line: e.at.line + shift } })));
    if (attribute("th:inline")?.toLowerCase() === "javascript") {
      const inlined = preprocessed(body);
      for (const e of inlined.matchAll(/\[[[(]\s*@\{/g)) link(inlined, (e.index ?? 0) + e[0].length - 2, script.bodyStart, undefined, "script");
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
 * Whether one of the routes serves a path with a file extension: one that matches the path and spells the extension out
 * (`@GetMapping("/vets.html")`), so the path names a page the application serves, not a file.
 */
export const serves =
  (routes: Array<Pick<Surface, "path" | "patterns">>) =>
  (path: string): boolean => {
    const extension = /\.\w+$/.exec(path)?.[0];
    return !!extension && routes.some((s) => s.path.endsWith(extension) && pathsMatch(s.path, path, s.patterns));
  };

/**
 * The header @hey-api/openapi-ts writes at the top of every file it generates (`getHeaderLines` in its file writer).
 * Such a client holds one function per operation of the document, whether or not the app calls it.
 */
const GENERATED_CLIENT = /^\uFEFF?\s*\/\/ This file is auto-generated by @hey-api\/openapi-ts\b/;

const SCRIPT = /\.(c|m)?[tj]sx?$/;

const parseScript = (file: string, text: string): ts.SourceFile =>
  ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true, file.endsWith("x") ? ts.ScriptKind.TSX : ts.ScriptKind.TS);

/** The identifiers a node's code uses, into `names`: not the words of comments or strings, nor an import's names alone. */
function identifiersIn(node: ts.Node, names: Set<string>): Set<string> {
  const visit = (n: ts.Node): void => {
    if (ts.isImportDeclaration(n)) return;
    if (ts.isIdentifier(n) || ts.isPrivateIdentifier(n)) names.add(n.text);
    ts.forEachChild(n, visit);
  };
  visit(node);
  return names;
}

/**
 * The top-level declarations of a generated file by name, and the members of its classes and object literals by
 * theirs: what naming one of them puts to use.
 */
function generatedDeclarations(file: string, text: string): Map<string, ts.Node[]> {
  const out = new Map<string, ts.Node[]>();
  const add = (name: ts.Node | undefined, node: ts.Node): void => {
    if (name && (ts.isIdentifier(name) || ts.isPrivateIdentifier(name) || ts.isStringLiteral(name))) (out.get(name.text) ?? out.set(name.text, []).get(name.text)!).push(node);
  };
  const members = (list: readonly ts.Node[]): void => list.forEach((m) => add((m as { name?: ts.Node }).name, m));
  for (const statement of parseScript(file, text).statements) {
    if (ts.isClassDeclaration(statement)) members(statement.members);
    else if (ts.isFunctionDeclaration(statement)) add(statement.name, statement);
    else if (ts.isVariableStatement(statement))
      for (const d of statement.declarationList.declarations) {
        if (d.initializer && ts.isObjectLiteralExpression(d.initializer)) members(d.initializer.properties);
        else add(d.name, d);
      }
  }
  return out;
}

/** A list of names for a limit: all of them, or the first ten and how many more. */
const listed = (names: string[]): string => (names.length > 10 ? `${names.slice(0, 10).join(", ")} and ${names.length - 10} more` : names.join(", "));

/**
 * `spans`: where route registrations write their paths (see `extractRoutes`); strings there are not requests.
 *
 * An absolute URL is a request to a source's target when its host is a loopback address, where the repository's
 * components run side by side, or the host of the target's `origins` entry. Any other host is another server's: its
 * URLs are left out. A limit names those hosts, the functions paths were handed to after their first argument, the
 * exceptions paths were given to in code read as text, and where a helper puts the configured prefix before a path.
 *
 * A request in a function of a generated client is the app's only when the app calls that function: it is read when
 * the code of a configured call file of the same component that the generator did not write names the function, or
 * names a generated declaration (a query helper) that names it, and a limit names the functions left out. Where every configured file of the component is generated, nothing could call them,
 * so each is read, and a limit says so.
 */
export function extractCalls(
  source: Source,
  config: Config,
  coverage: Coverage[] = [],
  spans?: Spans,
  limits: string[] = [],
  read: { surfaces?: Surface[]; pages?: Map<string, string[]> } = {},
): ReadCall[] {
  const out: ReadCall[] = [];
  const constants = new Constants(source);
  importersOf.set(constants, new Importers(source, constants, matcher(config.exclude)));
  const clients = new Clients(constants, importersOf.get(constants), packageRanges(source));
  // The names each calling component's configured files use, outside generated clients, and those that generated
  // declarations they name use in turn; undefined where the component has no such file.
  const used = new Map<string, Set<string> | undefined>();
  const namesUsedBy = (from: string): Set<string> | undefined => {
    if (!used.has(from)) {
      let names: Set<string> | undefined;
      const generated: Array<Map<string, ts.Node[]>> = [];
      const files = new Set(config.calls.filter((c) => c.from === from).flatMap((c) => select(source, c.files, config.exclude)));
      for (const file of files) {
        const text = source.read(file);
        if (text === undefined) continue;
        if (GENERATED_CLIENT.test(text)) {
          if (SCRIPT.test(file)) generated.push(generatedDeclarations(file, text));
          continue;
        }
        names ??= new Set();
        if (SCRIPT.test(file)) identifiersIn(parseScript(file, text), names);
        else for (const m of text.matchAll(/[A-Za-z_$][\w$]*/g)) names.add(m[0]);
      }
      // A generated helper the app names, such as a TanStack Query plugin's `usersListOptions`, uses the functions it calls.
      const queue = [...(names ?? [])];
      for (let name = queue.pop(); name !== undefined; name = queue.pop()) {
        for (const declarations of generated)
          for (const node of declarations.get(name) ?? [])
            for (const next of identifiersIn(node, new Set()))
              if (!names!.has(next)) {
                names!.add(next);
                queue.push(next);
              }
      }
      used.set(from, names);
    }
    return used.get(from);
  };
  for (const spec of config.calls) {
    const files = select(source, spec.files, config.exclude);
    const origin = config.origins[spec.to] === undefined ? undefined : hostOf(config.origins[spec.to]!);
    const foreign = new Map<string, string>();
    const passed: Passed[] = [];
    const labels: Passed[] = [];
    const prefixed: Place[] = [];
    const unread: Place[] = [];
    const unpaged: Place[] = [];
    const routes = serves((read.surfaces ?? []).filter((s) => s.component === spec.to));
    const base = baseOf(spec);
    const served = (path: string): boolean => routes(path) || (!!base && routes(onBase(base, path)));
    const written: Place[] = [];
    const unjoined: Array<{ why: string; at: Place }> = [];
    const helpers: Array<{ prefix: string; at: Place }> = [];
    const unbaseRelative: Place[] = [];
    const untyped: Array<{ why: string; at: Place }> = [];
    // Generated client files: the functions no other file names, and the files nothing else could call.
    const uncalled = new Map<string, string[]>();
    const alone: string[] = [];
    const elsewhere: Array<{ host: string; at: Place }> = [];
    const unbased: Place[] = [];
    const before = out.length;
    for (const file of files) {
      const text = source.read(file);
      if (text === undefined) continue;
      let calls = SCRIPT.test(file)
        ? callsFromTypeScript(file, text, spec, { spans, passed, origin, prefixed, served, elsewhere, unbased, constants, clients, base, written, unjoined, helpers })
        : /\.html?$/.test(file)
          ? callsFromTemplate(file, text, spec, { passed, origin, prefixed, served, pages: read.pages, unread, unpaged, elsewhere, unbased, base, written, unjoined, helpers })
          : callsFromText(file, text, spec, spans, labels, served, { base, written, unbaseRelative, untyped });
      // A host is named at the leading hole that writes it, ahead of the URLs built on it.
      for (const { host, at } of elsewhere.splice(0)) if (!foreign.has(host)) foreign.set(host, `${at.file}:${at.line}`);
      if (calls.length && GENERATED_CLIENT.test(text)) {
        const names = namesUsedBy(spec.from);
        if (!names) alone.push(file);
        else {
          const left = new Set(calls.filter((c) => c.scope !== undefined && !names.has(c.scope)).map((c) => c.scope!));
          if (left.size) uncalled.set(file, [...left]);
          calls = calls.filter((c) => c.scope === undefined || !left.has(c.scope));
        }
      }
      for (const c of calls) {
        const { host, relative, base: own, ...call } = c;
        if (host !== undefined && !reachesTarget(host, origin)) {
          if (!foreign.has(host)) foreign.set(host, `${c.at.file}:${c.at.line}`);
          continue;
        }
        // The path joins the base of its client: the one the code states for it, else the configured one. A URL with a
        // base of its own keeps its path, and so does one resolved against a page, whose route's path is whole.
        const on = own ?? base;
        out.push(on && !call.based && call.page === undefined ? { ...call, path: onBase(on, call.path, relative) } : call);
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
      limits.push(`${edge}: the configured ${spec.prefix ? "prefix" : "base"} ${spec.prefix ?? spec.base} put before a function's path parameter (${places}) is not read as a request; the paths passed to that function are`);
    }
    const places = (list: Place[]) => [...new Set(list.map((p) => `${p.file}:${p.line}`))].join(", ");
    if (written.length) limits.push(`${edge}: the configured ${spec.prefix ? "prefix" : "base"} ${spec.prefix ?? spec.base}, written as a value (${places(written)}), is the client's base, not a request`);
    if (helpers.length) {
      const byPrefix = new Map<string, Place[]>();
      for (const h of helpers) (byPrefix.get(h.prefix) ?? byPrefix.set(h.prefix, []).get(h.prefix)!).push(h.at);
      for (const [prefix, at] of byPrefix) limits.push(`${edge}: ${prefix}, which a function puts before the path it is given (${places(at)}), is read before the paths passed to it, not as a request of its own`);
    }
    if (unjoined.length) {
      const byWhy = new Map<string, Place[]>();
      for (const u of unjoined) (byWhy.get(u.why) ?? byWhy.set(u.why, []).get(u.why)!).push(u.at);
      for (const [why, at] of byWhy) limits.push(`${edge}: requests through a client are not read where ${why}: ${places(at)}`);
    }
    if (untyped.length) {
      const byWhy = new Map<string, Place[]>();
      for (const u of untyped) (byWhy.get(u.why) ?? byWhy.set(u.why, []).get(u.why)!).push(u.at);
      for (const [why, at] of byWhy) limits.push(`${edge}: the requests are not read where ${why}: ${places(at)}`);
    }
    if (unbaseRelative.length) limits.push(`${edge}: paths without a leading / are relative to a client's base, which the call source does not give (set base and join): ${places(unbaseRelative)}`);
    if (unread.length) limits.push(`${edge}: Thymeleaf links whose URL is a value (a model attribute, a fragment parameter) are not read: ${places(unread)}`);
    if (unbased.length) limits.push(`${edge}: URLs resolved against a base held in a value (new URL(path, base)), whose host the code does not state, are not read: ${places(unbased)}`);
    if (unpaged.length) limits.push(`${edge}: page-relative URLs and forms with no action in a template no route atlas reads renders are not read: ${places(unpaged)}`);
    for (const [file, names] of uncalled) {
      const n = names.length === 1 ? "1 function" : `${names.length} functions`;
      limits.push(`${edge}: ${n} of ${file}, which @hey-api/openapi-ts generated, ${names.length === 1 ? "is" : "are"} named in no other configured file, so ${names.length === 1 ? "its requests are" : "their requests are"} not read: ${listed(names)}`);
    }
    if (alone.length)
      limits.push(
        `${edge}: ${alone.join(", ")}, which @hey-api/openapi-ts generated, ${alone.length === 1 ? "is" : "are"} all that ${spec.from}'s call files hold, so nothing configured could call ${alone.length === 1 ? "its" : "their"} functions: each is read as a request, called or not; add the files that call the client to read only the functions they call`,
      );
  }
  return out;
}
