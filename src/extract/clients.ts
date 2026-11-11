import ts from "typescript";
import { HOLE, hostOf, type Base, type Join } from "../paths.js";
import { declarationOf, importedFrom, references, unwrap } from "./binding.js";
import type { Constants } from "./constants.js";
import type { Importers } from "./importers.js";
import { rangeMajor } from "./syntax.js";

/** The client libraries whose instances' bases atlas reads, each by the base options its documentation names. */
type Library = "axios" | "ky" | "openapi-fetch" | "rtk-query";

const RTK = ["@reduxjs/toolkit/query", "@reduxjs/toolkit/query/react"];

/** How many bindings an instance is followed through, and the longest base text read. */
const DEPTH = 8;
const MAX_LENGTH = 2048;

/** A base the code states, as its text (a hole for each value not read), or why it is not read. */
/** A base the code states, as its text (a hole for each value not read), or why it is not read and how it joins where that is known. */
type Stated = { text: string; join: Join } | { unread: string; join?: Join };

/** A client instance: its library, the base its options state (none stated: undefined), what changes its URLs. */
interface Instance {
  library: Library;
  name: string;
  base: Stated | undefined;
  /** The text a request interceptor puts before each URL (axios), or why its interceptors are not read. */
  before?: string | { unread: string };
  /** Ky's options as each major version reads them; ky 1 rejects an input with a leading `/` under `prefixUrl`. */
  ky?: { major: number | undefined; file: string };
  rejectsSlash?: boolean;
}

/** A request made through a client instance, as the code states it. */
export interface ClientRequest {
  library: Library;
  /** The instance, by the name it is held in, for limits. */
  name: string;
  /** The base the request joins: the call's own, else its instance's; undefined where the code states none. */
  base?: Base;
  /** The host the base names, where it is an absolute URL. */
  host?: string;
  /**
   * Why the base the code states is not read, with how it joins a path where the option says (a configured base takes
   * its place then); without a join, something may rewrite any of the client's URLs (an interceptor, a hook).
   */
  unread?: { why: string; join?: Join };
  /** Whether a path without a leading `/` joins the base; openapi-fetch's paths are a document's, which start with one. */
  relative: boolean;
  /** Text an interceptor puts before the URL, before it joins the base. */
  before?: string;
  /** The method the request is sent with, where the library gives one the call does not state (RTK Query's GET). */
  method?: string;
  /** The library refuses the URL: Ky 1 with `prefixUrl` and an input that starts with `/`. */
  rejected?: string;
}

/** A property an object literal sets last under a name: its value, `unread` where a spread or a key not read may set it. */
function lastProperty(o: ts.ObjectLiteralExpression, key: string): ts.Expression | "unread" | undefined {
  for (let i = o.properties.length - 1; i >= 0; i--) {
    const p = o.properties[i]!;
    if (ts.isSpreadAssignment(p)) return "unread";
    const name = p.name && nameOf(p.name);
    if (name === undefined) return "unread";
    if (name !== key) continue;
    if (ts.isPropertyAssignment(p)) return p.initializer;
    if (ts.isShorthandPropertyAssignment(p)) return p.name;
    return "unread";
  }
  // `__proto__: value` (not a computed key) sets the object's prototype, through which the object may have any key.
  return o.properties.some((p) => ts.isPropertyAssignment(p) && !ts.isComputedPropertyName(p.name) && nameOf(p.name) === "__proto__") ? "unread" : undefined;
}

/** The name a property key states: an identifier, a string, a number, or a computed key that is a literal. */
function nameOf(name: ts.PropertyName): string | undefined {
  if (ts.isComputedPropertyName(name)) {
    const key = unwrap(name.expression);
    return ts.isStringLiteralLike(key) || ts.isNumericLiteral(key) ? key.text : undefined;
  }
  if (ts.isPrivateIdentifier(name)) return undefined;
  return ts.isNumericLiteral(name) ? String(Number(name.text)) : name.text;
}

/** A member access by a name the code fixes: `a.b`, `a["b"]`. */
function member(e: ts.Expression): { receiver: ts.Expression; name: string } | undefined {
  if (ts.isPropertyAccessExpression(e)) return { receiver: e.expression, name: e.name.text };
  if (!ts.isElementAccessExpression(e)) return undefined;
  const key = unwrap(e.argumentExpression);
  return ts.isStringLiteralLike(key) ? { receiver: e.expression, name: key.text } : undefined;
}

/** The expression a value stands for: past parentheses, assertions and the branches of a conditional. */
function valuePlace(node: ts.Node): ts.Node {
  let value = node;
  for (;;) {
    const p = value.parent;
    if (ts.isParenthesizedExpression(p) || ts.isAsExpression(p) || ts.isSatisfiesExpression(p) || ts.isNonNullExpression(p) || ts.isTypeAssertionExpression(p)) value = p;
    else if (ts.isConditionalExpression(p) && p.condition !== value) value = p;
    else return value;
  }
}

/** The text a base expression is, with a hole for each part not read; undefined where it is no string the code builds. */
function baseText(e: ts.Expression, constants: Constants): string | undefined {
  const known = constants.text(e);
  if (known !== undefined) return known.length > MAX_LENGTH ? undefined : known;
  const u = unwrap(e);
  if (ts.isTemplateExpression(u)) {
    let s = u.head.text;
    for (const span of u.templateSpans) s += (constants.text(span.expression) ?? HOLE) + span.literal.text;
    return s.length > MAX_LENGTH ? undefined : s;
  }
  if (ts.isBinaryExpression(u) && u.operatorToken.kind === ts.SyntaxKind.PlusToken) {
    const left = baseText(u.left, constants) ?? HOLE;
    const right = baseText(u.right, constants) ?? HOLE;
    const s = `${left}${right}`;
    return s.length > MAX_LENGTH ? undefined : s;
  }
  return HOLE;
}

/**
 * The base a base's text names: the path of an absolute URL (and its host), a path from the root, or the path after a
 * leading value, which is taken as an origin as a URL that starts with one is (`${API_URL}/api`). A value alone, a path
 * relative to the page, or one relative to the scheme is not read.
 */
export function parseBase(text: string, join: Join): { base: Base; host?: string } | { unread: string } {
  const s = text.trim().split(/[?#]/)[0]!;
  const absolute = /^https?:\/\/[^/]+(.*)$/i.exec(s);
  if (absolute) {
    const host = hostOf(s);
    return { base: { path: absolute[1] || "/", join }, ...(host ? { host } : {}) };
  }
  const rest = s.replace(/^(?:\{\})+/, "");
  if (rest.startsWith("/") && !rest.startsWith("//")) return { base: { path: rest, join } };
  if (!s || s === rest && !s.startsWith("/")) return { unread: `\`${text}\`, relative to the page that loads it` };
  return { unread: rest ? `\`${text}\`` : "a value atlas does not read" };
}

const AXIOS_PATH_FIRST = new Set(["get", "delete", "head", "options", "post", "put", "patch", "postForm", "putForm", "patchForm"]);
const AXIOS_WITH_DATA = new Set(["post", "put", "patch", "postForm", "putForm", "patchForm"]);
const KY_METHODS = new Set(["get", "post", "put", "patch", "delete", "head", "query"]);
const OPENAPI_FETCH_METHODS = new Set(["GET", "PUT", "POST", "DELETE", "OPTIONS", "HEAD", "PATCH", "TRACE"]);
const RTK_ENDPOINTS = new Set(["query", "mutation", "infiniteQuery"]);

/**
 * The client instances of axios, Ky, openapi-fetch and RTK Query the code creates, with the base each one's options
 * state, followed from a call's receiver through `const`s and imports to the call that creates it; and the requests
 * made through them.
 *
 * - axios (`axios.create({ baseURL })`, a call's own `baseURL`): `combineURLs` appends a path to the base with one `/`.
 *   A request interceptor (`instance.interceptors.request.use(fn)`) that sets `config.url` to text before the URL it
 *   had is read as that text; one that changes the URL or the base otherwise, or hands its config on, leaves the base
 *   unread.
 * - Ky (`ky.create`, `ky.extend`, `instance.extend`, with an object or a function of the parent's options; a call's
 *   own options): from version 2, `prefix` is appended with one `/` and `baseUrl` resolves the input as a URL; before,
 *   `prefixUrl` is appended and an input with a leading `/` is refused. A `beforeRequest` or `beforeRetry` hook that may
 *   return a request, or an `init` hook, leaves the base unread.
 * - openapi-fetch (`createClient({ baseUrl })`, a call's own `baseUrl`): the path is written after the base.
 * - RTK Query (`createApi` with `fetchBaseQuery({ baseUrl })`, and `injectEndpoints` on it): an endpoint's `query`
 *   returns its URL, or an object with `url` and `method`; `joinUrls` appends it to the base with one `/`, and
 *   fetchBaseQuery sends GET unless `method` says otherwise.
 */
export class Clients {
  private readonly instances = new Map<ts.Node, Instance | undefined>();
  private readonly pending = new Set<ts.Node>();

  constructor(
    private readonly constants: Constants,
    private readonly importers: Importers | undefined,
    private readonly ranges: (file: string, pkg: string) => string | undefined,
  ) {}

  /** Whether a value is the base option of a client's options (`baseURL`, `prefix`, `baseUrl`, `prefixUrl`): no request. */
  baseOption(node: ts.Node): boolean {
    let value = valuePlace(node);
    // A template or `+` that builds the option holds it.
    while (ts.isTemplateSpan(value.parent) || (ts.isBinaryExpression(value.parent) && value.parent.operatorToken.kind === ts.SyntaxKind.PlusToken)) value = valuePlace(ts.isTemplateSpan(value.parent) ? value.parent.parent : value.parent);
    const p = value.parent;
    if (!ts.isPropertyAssignment(p) || p.initializer !== value) return false;
    const key = nameOf(p.name);
    if (key === undefined || !["baseURL", "baseUrl", "prefix", "prefixUrl"].includes(key)) return false;
    return this.optionsOf(p.parent) !== undefined;
  }

  /** The library whose options an object literal is: a factory's, `fetchBaseQuery`'s, or a request's through an instance. */
  private optionsOf(o: ts.ObjectLiteralExpression): Library | undefined {
    const place = valuePlace(o);
    const call = place.parent;
    // `extend((options) => ({ prefix }))`: the object a function of the parent's options returns.
    const returned = ts.isArrowFunction(call) && call.body === place ? call : ts.isReturnStatement(call) ? ts.findAncestor(call, ts.isFunctionLike) : undefined;
    if (returned && (ts.isArrowFunction(returned) || ts.isFunctionExpression(returned))) {
      const outer = valuePlace(returned).parent;
      return ts.isCallExpression(outer) && outer.arguments[0] === valuePlace(returned) && member(unwrap(outer.expression))?.name === "extend" ? this.created(outer)?.library : undefined;
    }
    if (!ts.isCallExpression(call) || !call.arguments.includes(place as ts.Expression)) return undefined;
    const callee = unwrap(call.expression);
    if (ts.isIdentifier(callee) && RTK.some((m) => importedFrom(callee, [m]) === "fetchBaseQuery")) return "rtk-query";
    const created = this.created(call);
    if (created) return created.library;
    return this.requestCall(call)?.instance.library;
  }

  /**
   * The request a URL is the URL of, made through a client instance: the path argument of its methods (axios's, Ky's,
   * openapi-fetch's) or of the instance called; the `url` of an axios request config; the URL an RTK Query endpoint's
   * `query` returns. Undefined anywhere else.
   */
  requestOf(node: ts.Node): ClientRequest | undefined {
    const value = valuePlace(node);
    const rtk = this.endpointOf(value);
    if (rtk) return rtk;
    const p = value.parent;
    // `api({ url })`, `api.request({ url })`: an axios request config.
    if (ts.isPropertyAssignment(p) && p.initializer === value && nameOf(p.name) === "url") {
      const config = p.parent;
      if (lastProperty(config, "url") !== value) return undefined;
      const place = valuePlace(config);
      const call = place.parent;
      if (!ts.isCallExpression(call) || call.arguments[0] !== place) return undefined;
      const found = this.requestCall(call);
      if (!found || found.instance.library !== "axios" || !found.config) return undefined;
      return this.request(found.instance, config);
    }
    if (!ts.isCallExpression(p) || p.arguments[0] !== value) return undefined;
    const found = this.requestCall(p);
    if (!found || found.config) return undefined;
    return this.request(found.instance, found.options);
  }

  /**
   * The instance a call is made through and the options it is given: `api.get(url, options)`, `api(url, options)`; with
   * `config` where the call takes an axios request config first (`api(config)`, `api.request(config)`).
   */
  private requestCall(call: ts.CallExpression): { instance: Instance; options: ts.Expression | undefined; config?: true } | undefined {
    const callee = unwrap(call.expression);
    const m = member(callee);
    const on = m ? this.instanceOf(m.receiver) : undefined;
    if (on && m) {
      if (on.library === "axios") {
        if (m.name === "request") return { instance: on, options: call.arguments[0], config: true };
        if (!AXIOS_PATH_FIRST.has(m.name)) return undefined;
        return { instance: on, options: call.arguments[AXIOS_WITH_DATA.has(m.name) ? 2 : 1] };
      }
      if (on.library === "ky" && KY_METHODS.has(m.name)) return { instance: on, options: call.arguments[1] };
      if (on.library === "openapi-fetch" && OPENAPI_FETCH_METHODS.has(m.name)) return { instance: on, options: call.arguments[1] };
      return undefined;
    }
    const self = this.instanceOf(callee);
    if (!self || (self.library !== "axios" && self.library !== "ky")) return undefined;
    const first = call.arguments[0] && unwrap(call.arguments[0]);
    if (self.library === "axios" && first && ts.isObjectLiteralExpression(first)) return { instance: self, options: first, config: true };
    return { instance: self, options: call.arguments[1] };
  }

  /** A request through an instance, with the base the call's own options set in place of the instance's. */
  private request(instance: Instance, options: ts.Expression | undefined): ClientRequest {
    const own = options === undefined ? undefined : this.callBase(instance, options);
    const stated = own ?? instance.base;
    const out: ClientRequest = { library: instance.library, name: instance.name, relative: instance.library !== "openapi-fetch" };
    if (stated && "unread" in stated) out.unread = { why: stated.unread, ...(stated.join ? { join: stated.join } : {}) };
    else if (stated) {
      const parsed = parseBase(stated.text, stated.join);
      if ("unread" in parsed) out.unread = { why: `${instance.name}'s base is ${parsed.unread}`, join: stated.join };
      else {
        out.base = parsed.base;
        if (parsed.host) out.host = parsed.host;
      }
    }
    if (typeof instance.before === "object") out.unread = { why: instance.before.unread };
    else if (instance.before) out.before = instance.before;
    if (instance.rejectsSlash && !own) out.rejected = "Ky 1 refuses an input that starts with / under prefixUrl";
    return out;
  }

  /** The base a request's own options set, where they may set one: undefined where they set none. */
  private callBase(instance: Instance, options: ts.Expression): Stated | undefined {
    const o = unwrap(options);
    if (!ts.isObjectLiteralExpression(o)) {
      const join: Join | undefined = instance.library === "ky" ? undefined : "append";
      return { unread: `options held in a value (${short(options)}) may set ${instance.name}'s base`, ...(join ? { join } : {}) };
    }
    // Ky merges a request's options over the instance's: a prefix it sets still resolves against the instance's baseUrl.
    return this.optionsBase(instance.library, o, instance.ky, `a request through ${instance.name}`, instance.base);
  }

  /** The base an options object states for a library, where it states one. */
  private optionsBase(library: Library, o: ts.ObjectLiteralExpression, ky: Instance["ky"], who: string, parent?: Stated): Stated | undefined {
    const read = (key: string, join: Join): Stated | undefined => {
      const v = lastProperty(o, key);
      if (v === undefined) return undefined;
      if (v === "unread") return { unread: `${who} sets ${key} where a spread, a computed key or a prototype may`, join };
      const text = baseText(v, this.constants);
      return text === undefined ? { unread: `${who} sets ${key} to ${short(v)}`, join } : { text, join };
    };
    if (library === "axios") return read("baseURL", "append");
    if (library === "openapi-fetch" || library === "rtk-query") return read("baseUrl", "append");
    const major = ky?.major;
    const stated = ["prefix", "baseUrl", "prefixUrl"].filter((k) => lastProperty(o, k) !== undefined);
    if (!stated.length) return undefined;
    if (major === undefined) return { unread: `no package.json above ${ky?.file} gives one major version of ky, whose prefixUrl, prefix and baseUrl differ between versions` };
    if (major < 2) return stated.includes("prefixUrl") ? read("prefixUrl", "append") : undefined;
    if (stated.includes("prefixUrl")) return { unread: `${who} sets prefixUrl, which Ky ${major} refuses` };
    // What the options do not set, the parent's options give (an option of the parent not read, too).
    const inherited = (join: Join): Stated | undefined => (parent && (parent.join === join || ("unread" in parent && !parent.join)) ? parent : undefined);
    const prefix = stated.includes("prefix") ? read("prefix", "append") : inherited("append");
    const base = stated.includes("baseUrl") ? read("baseUrl", "resolve") : inherited("resolve");
    if (prefix && "unread" in prefix) return prefix;
    if (!prefix || !base) return prefix ?? base;
    // A prefix from the root or with an origin leaves only the origin of `baseUrl`; one relative to it is not read.
    const rooted = /^(?:\/(?!\/)|\{\}|https?:)/i.test(prefix.text.trim());
    if (!rooted) return { unread: `${who} sets a prefix that baseUrl resolves` };
    if (!prefix.text.trim().startsWith("/")) return prefix;
    // A baseUrl not read gives an origin the code does not state, as a URL's leading value does.
    if ("unread" in base) return prefix;
    const origin = /^https?:\/\/[^/?#]+/i.exec(base.text.trim())?.[0];
    return origin ? { text: origin + prefix.text.trim(), join: "append" } : prefix;
  }

  /** The instance an expression is: a call that creates one, or a `const` holding one, through imports. */
  private instanceOf(e: ts.Expression, depth = 0): Instance | undefined {
    const u = unwrap(e);
    if (depth > DEPTH) return undefined;
    if (ts.isCallExpression(u)) return this.created(u, depth);
    if (!ts.isIdentifier(u)) return undefined;
    let d = declarationOf(u);
    if (d && (ts.isImportSpecifier(d) || ts.isImportClause(d))) {
      const decl = ts.isImportSpecifier(d) ? d.parent.parent.parent : d.parent;
      if (decl.importClause?.isTypeOnly || (ts.isImportSpecifier(d) && d.isTypeOnly) || !ts.isStringLiteral(decl.moduleSpecifier)) return undefined;
      const x = this.constants.exportOf(u.getSourceFile().fileName, decl.moduleSpecifier.text, ts.isImportSpecifier(d) ? (d.propertyName ?? d.name).text : "default");
      d = x && "node" in x ? x.node : undefined;
    }
    if (!d || !ts.isVariableDeclaration(d) || !ts.isIdentifier(d.name) || !d.initializer) return undefined;
    const list = d.parent;
    if (!ts.isVariableDeclarationList(list) || !(list.flags & ts.NodeFlags.Const) || list.flags & (ts.NodeFlags.Let | ts.NodeFlags.Using)) return undefined;
    if (this.instances.has(d)) return this.instances.get(d);
    if (this.pending.has(d)) return undefined;
    this.pending.add(d);
    let found = this.instanceOf(d.initializer, depth + 1);
    if (found) found = { ...found, name: d.name.text };
    if (found?.library === "axios") found = { ...found, ...this.interceptors(d as ts.VariableDeclaration & { name: ts.Identifier }) };
    if (found?.library === "openapi-fetch") found = { ...found, ...this.middleware(d as ts.VariableDeclaration & { name: ts.Identifier }) };
    this.pending.delete(d);
    this.instances.set(d, found);
    return found;
  }

  /** The instance a call creates: a library's factory, or `extend`, `injectEndpoints` on an instance. */
  private created(call: ts.CallExpression, depth = 0): Instance | undefined {
    const callee = unwrap(call.expression);
    const opts = call.arguments[0] && unwrap(call.arguments[0]);
    const object = opts && ts.isObjectLiteralExpression(opts) ? opts : undefined;
    const holder = valuePlace(call).parent;
    const name = ts.isVariableDeclaration(holder) && ts.isIdentifier(holder.name) ? holder.name.text : short(call);
    if (ts.isIdentifier(callee)) {
      if (importedFrom(callee, ["openapi-fetch"]) === "default") return { library: "openapi-fetch", name, base: object ? this.optionsBase("openapi-fetch", object, undefined, name) : opts ? { unread: `${name}'s options are held in a value`, join: "append" } : undefined };
      if (RTK.some((m) => importedFrom(callee, [m]) === "createApi")) return { library: "rtk-query", name, base: object ? this.rtkBase(object, name) : undefined };
      return undefined;
    }
    const m = member(callee);
    if (!m) return undefined;
    const root = unwrap(m.receiver);
    const file = call.getSourceFile().fileName;
    if (ts.isIdentifier(root) && importedFrom(root, ["axios"]) === "default" && m.name === "create") {
      return { library: "axios", name, base: object ? this.optionsBase("axios", object, undefined, name) : opts ? { unread: `${name}'s options are held in a value`, join: "append" } : undefined };
    }
    if (ts.isIdentifier(root) && importedFrom(root, ["ky"]) === "default" && (m.name === "create" || m.name === "extend")) {
      const range = this.ranges(file, "ky");
      const ky = { major: range === undefined ? undefined : rangeMajor(range), file };
      return this.kyInstance(name, ky, opts, undefined);
    }
    const parent = this.instanceOf(root, depth + 1);
    if (!parent) return undefined;
    if (parent.library === "ky" && m.name === "extend") return this.kyInstance(name, parent.ky, opts, parent);
    if (parent.library === "rtk-query" && m.name === "injectEndpoints") return parent;
    return undefined;
  }

  /** A Ky instance from options (an object, or a function of the parent's), merged over its parent's. */
  private kyInstance(name: string, ky: Instance["ky"], opts: ts.Expression | undefined, parent: Instance | undefined): Instance {
    const out: Instance = { library: "ky", name, base: parent?.base, ky, ...(parent?.rejectsSlash ? { rejectsSlash: true } : {}), ...(parent?.before ? { before: parent.before } : {}) };
    if (!opts) return out;
    let object: ts.ObjectLiteralExpression | undefined;
    let param: ts.Identifier | undefined;
    if (ts.isObjectLiteralExpression(opts)) object = opts;
    else if (ts.isArrowFunction(opts) || ts.isFunctionExpression(opts)) {
      const first = opts.parameters[0];
      if (first && !ts.isIdentifier(first.name)) return { ...out, base: { unread: `${name} takes its options from a function whose parameter is destructured` } };
      param = first?.name as ts.Identifier | undefined;
      const body = ts.isBlock(opts.body) ? undefined : unwrap(opts.body);
      if (body && ts.isObjectLiteralExpression(body)) object = body;
      else return { ...out, base: { unread: `${name} takes its options from a function atlas does not read` } };
    } else return { ...out, base: { unread: `${name}'s options are held in a value` } };
    // A hook that may change the URL stays with every instance extended from this one, whatever base they set.
    const hooks = this.kyHooks(object, name);
    if (hooks) out.before = { unread: hooks };
    const inherited = parent?.base;
    // `${options.prefix}/admin`: the parent's option, where the function names it on its parameter (Ky 2's options).
    const withParent = param && ky?.major !== undefined && ky.major >= 2 ? this.parentText(object, param, inherited) : undefined;
    if (withParent) return { ...out, base: withParent };
    const stated = this.optionsBase("ky", object, ky, name, inherited);
    if (stated && "text" in stated && ky?.major !== undefined && ky.major < 2) out.rejectsSlash = true;
    return { ...out, base: stated ?? inherited };
  }

  /**
   * Where a function of the parent's options sets an option from the parent's (`({ prefix: `${options.prefix}/admin` })`),
   * that option's text with the parent's put in; undefined where it names no parent option.
   */
  private parentText(object: ts.ObjectLiteralExpression, param: ts.Identifier, inherited: Stated | undefined): Stated | undefined {
    for (const key of ["prefix", "baseUrl"]) {
      const v = lastProperty(object, key);
      if (v === undefined || v === "unread") continue;
      const u = unwrap(v);
      const uses = references(param).filter((r) => r.pos >= u.pos && r.end <= u.end);
      if (!uses.length) continue;
      const join: Join = key === "prefix" ? "append" : "resolve";
      if (!inherited || "unread" in inherited || inherited.join !== join) return { unread: `the parent's ${key} it builds on is not read`, join };
      const part = (e: ts.Expression): string | undefined => {
        const x = unwrap(e);
        const m = member(x);
        if (m && ts.isIdentifier(unwrap(m.receiver)) && declarationOf(unwrap(m.receiver) as ts.Identifier) === param.parent) return m.name === key ? inherited.text : undefined;
        return this.constants.text(x);
      };
      if (!ts.isTemplateExpression(u)) return { unread: `the parent's ${key} is built on in a way atlas does not read`, join };
      let s = u.head.text;
      for (const span of u.templateSpans) {
        const t = part(span.expression);
        if (t === undefined) return { unread: `the parent's ${key} is built on in a way atlas does not read`, join };
        s += t + span.literal.text;
      }
      return s.length > MAX_LENGTH ? { unread: "the base is too long", join } : { text: s, join };
    }
    return undefined;
  }

  /** Why Ky's hooks may change a request's URL: an `init` hook, or a `beforeRequest`/`beforeRetry` hook that may return a request. */
  private kyHooks(object: ts.ObjectLiteralExpression, name: string): string | undefined {
    const v = lastProperty(object, "hooks");
    if (v === undefined) return undefined;
    const hooks = v === "unread" ? undefined : unwrap(v);
    if (!hooks || !ts.isObjectLiteralExpression(hooks)) return `${name}'s hooks are not read`;
    for (const p of hooks.properties) {
      const key = p.name && nameOf(p.name);
      if (!ts.isPropertyAssignment(p) || key === undefined || key === "__proto__") return `${name}'s hooks are not read`;
      if (key === "init") return `${name}'s init hook may change its options`;
      if (key !== "beforeRequest" && key !== "beforeRetry") continue;
      const list = unwrap(p.initializer);
      if (!ts.isArrayLiteralExpression(list) || !list.elements.every((h) => returnsNothing(unwrap(h)))) return `${name}'s ${key} hook may return another request`;
    }
    return undefined;
  }

  /** The base `createApi`'s `fetchBaseQuery` states; a base query of any other kind is not read. */
  private rtkBase(object: ts.ObjectLiteralExpression, name: string): Stated | undefined {
    const q = lastProperty(object, "baseQuery");
    if (q === undefined) return undefined;
    const call = q === "unread" ? undefined : unwrap(q);
    if (!call || !ts.isCallExpression(call) || !ts.isIdentifier(unwrap(call.expression)) || !RTK.some((m) => importedFrom(unwrap(call.expression) as ts.Identifier, [m]) === "fetchBaseQuery")) {
      return { unread: `${name}'s baseQuery is not fetchBaseQuery written in place` };
    }
    const opts = call.arguments[0] && unwrap(call.arguments[0]);
    if (!opts) return undefined;
    if (!ts.isObjectLiteralExpression(opts)) return { unread: `${name}'s fetchBaseQuery options are held in a value`, join: "append" };
    return this.optionsBase("rtk-query", opts, undefined, name);
  }

  /**
   * The request an RTK Query endpoint's `query` returns: its URL alone, or an object's `url`, with the method the object
   * states, GET where it states none.
   */
  private endpointOf(value: ts.Node): ClientRequest | undefined {
    let returned = value;
    let object: ts.ObjectLiteralExpression | undefined;
    const p = value.parent;
    if (ts.isPropertyAssignment(p) && p.initializer === value && nameOf(p.name) === "url") {
      object = p.parent;
      if (lastProperty(object, "url") !== value) return undefined;
      returned = valuePlace(object);
    }
    const holder = returned.parent;
    const fn = ts.isArrowFunction(holder) && holder.body === returned ? holder : ts.isReturnStatement(holder) ? ts.findAncestor(holder, ts.isFunctionLike) : undefined;
    if (!fn || !(ts.isArrowFunction(fn) || ts.isFunctionExpression(fn) || ts.isMethodDeclaration(fn))) return undefined;
    // `query: (id) => ...` or `query(id) { ... }`, in the definition `build.query({ ... })` takes.
    const definition = ts.isMethodDeclaration(fn) ? (nameOf(fn.name) === "query" ? fn.parent : undefined) : (() => {
      const place = valuePlace(fn);
      return ts.isPropertyAssignment(place.parent) && nameOf(place.parent.name) === "query" ? place.parent.parent : undefined;
    })();
    if (!definition || !ts.isObjectLiteralExpression(definition)) return undefined;
    const build = valuePlace(definition).parent;
    if (!ts.isCallExpression(build) || build.arguments[0] !== valuePlace(definition)) return undefined;
    const kind = member(unwrap(build.expression));
    if (!kind || !RTK_ENDPOINTS.has(kind.name) || !ts.isIdentifier(unwrap(kind.receiver))) return undefined;
    const builder = declarationOf(unwrap(kind.receiver) as ts.Identifier);
    if (!builder || !ts.isParameter(builder) || builder.parent.parameters[0] !== builder) return undefined;
    const endpoints = builder.parent;
    const place = ts.isMethodDeclaration(endpoints) ? endpoints : valuePlace(endpoints);
    const holderOf = ts.isMethodDeclaration(place) ? place : place.parent;
    if (!(ts.isPropertyAssignment(holderOf) || ts.isMethodDeclaration(holderOf)) || nameOf(holderOf.name) !== "endpoints") return undefined;
    const options = holderOf.parent;
    if (!ts.isObjectLiteralExpression(options)) return undefined;
    const call = valuePlace(options).parent;
    if (!ts.isCallExpression(call) || call.arguments[0] !== valuePlace(options)) return undefined;
    const instance = this.created(call);
    if (!instance || instance.library !== "rtk-query") return undefined;
    const out = this.request(instance, undefined);
    out.method = object ? rtkMethod(object) : "GET";
    return out;
  }

  /** The URL rewrite an axios instance's request interceptors make, where they are read. */
  private interceptors(d: ts.VariableDeclaration & { name: ts.Identifier }): Pick<Instance, "before" | "base"> | object {
    const uses = this.usesOf(d);
    if (!uses) return { before: { unread: `the uses of ${d.name.text} in other files are not all read, and an interceptor there may change its URLs` } };
    let before: string | undefined;
    for (const use of uses) {
      const at = member(use.parent as ts.Expression);
      if (!at || (use.parent as ts.Expression & { expression?: ts.Node }).expression !== use) continue;
      // `api.defaults.headers.common.X = token` leaves the URL alone; the defaults whole, or their base, may change it.
      if (at.name === "defaults") {
        const inner = member(use.parent.parent as ts.Expression);
        if (!inner || (use.parent.parent as ts.PropertyAccessExpression).expression !== use.parent || inner.name === "baseURL" || inner.name === "url") return { before: { unread: `${d.name.text}'s defaults are changed in the code` } };
        continue;
      }
      if (at.name !== "interceptors") continue;
      const kind = member(use.parent.parent as ts.Expression);
      if (!kind || kind.name !== "request") continue;
      const method = member(use.parent.parent.parent as ts.Expression);
      const call = use.parent.parent.parent.parent;
      if (!method || method.name !== "use" || !ts.isCallExpression(call) || call.arguments.length > 2) return { before: { unread: `${d.name.text}'s request interceptors are not read` } };
      const fn = call.arguments[0] && callable(unwrap(call.arguments[0]));
      const rewrite = fn ? urlRewrite(fn) : undefined;
      if (rewrite === undefined) return { before: { unread: `a request interceptor of ${d.name.text} may change its URLs` } };
      if (rewrite === "") continue;
      if (before !== undefined) return { before: { unread: `${d.name.text} has more than one interceptor that changes its URLs` } };
      before = rewrite;
    }
    return before === undefined ? {} : { before };
  }

  /** Whether an openapi-fetch client's middleware may change a request's URL: an `onRequest` that may return another request. */
  private middleware(d: ts.VariableDeclaration & { name: ts.Identifier }): Pick<Instance, "before"> | object {
    const uses = this.usesOf(d);
    if (!uses) return { before: { unread: `the uses of ${d.name.text} in other files are not all read, and a middleware there may change its URLs` } };
    for (const use of uses) {
      const at = member(use.parent as ts.Expression);
      if (!at || at.name !== "use" || !ts.isCallExpression(use.parent.parent)) continue;
      for (const arg of use.parent.parent.arguments) {
        const mw = objectOf(unwrap(arg));
        const on = mw && lastProperty(mw, "onRequest");
        if (!mw) return { before: { unread: `a middleware of ${d.name.text} is not read` } };
        if (on === undefined) continue;
        const method = mw.properties.find((p) => p.name && nameOf(p.name) === "onRequest");
        const fn = method && ts.isMethodDeclaration(method) ? method : on !== "unread" ? callable(unwrap(on)) : undefined;
        if (!fn || !returnsOwnRequest(fn)) return { before: { unread: `a middleware of ${d.name.text} may return another request` } };
      }
    }
    return {};
  }

  /** The uses of a `const`, in its file and in the files that import it; null where those cannot all be read. */
  private usesOf(d: ts.VariableDeclaration & { name: ts.Identifier }): ts.Identifier[] | null {
    const uses = references(d.name);
    const statement = d.parent.parent;
    const exported = ts.isVariableStatement(statement) && ts.getModifiers(statement)?.some((m) => m.kind === ts.SyntaxKind.ExportKeyword);
    const names = exported ? [d.name.text] : [];
    for (const ref of uses) if (ts.isExportSpecifier(ref.parent)) names.push(ref.parent.name.text);
    if (!names.length) return uses;
    const others = this.importers?.uses(d.getSourceFile().fileName, d, names);
    if (!others) return null;
    return [...uses, ...others.filter((o): o is ts.Identifier => ts.isIdentifier(o))];
  }
}

/** The method an RTK Query request object states: a known one, `*` for one held in a value, GET for none. */
function rtkMethod(o: ts.ObjectLiteralExpression): string {
  const v = lastProperty(o, "method");
  if (v === undefined) return "GET";
  if (v === "unread") return "*";
  const u = unwrap(v);
  const m = ts.isStringLiteralLike(u) ? u.text.toUpperCase() : undefined;
  return m && /^(GET|POST|PUT|PATCH|DELETE|HEAD|OPTIONS)$/.test(m) ? m : "*";
}

/** A function written in place, or one a `const` or a declaration of the same file holds. */
function callable(e: ts.Expression): ts.SignatureDeclaration | undefined {
  if (ts.isArrowFunction(e) || ts.isFunctionExpression(e)) return e;
  if (!ts.isIdentifier(e)) return undefined;
  const d = declarationOf(e);
  if (d && ts.isFunctionDeclaration(d) && d.body) return d;
  if (d && ts.isVariableDeclaration(d) && d.initializer && d.parent.flags & ts.NodeFlags.Const) {
    const init = unwrap(d.initializer);
    if (ts.isArrowFunction(init) || ts.isFunctionExpression(init)) return init;
  }
  return undefined;
}

/** An object literal written in place, or held in a `const` of the same file. */
function objectOf(e: ts.Expression): ts.ObjectLiteralExpression | undefined {
  if (ts.isObjectLiteralExpression(e)) return e;
  if (!ts.isIdentifier(e)) return undefined;
  const d = declarationOf(e);
  const init = d && ts.isVariableDeclaration(d) && d.initializer && d.parent.flags & ts.NodeFlags.Const ? unwrap(d.initializer) : undefined;
  return init && ts.isObjectLiteralExpression(init) ? init : undefined;
}

/** Whether a hook returns no value: a block with no `return` of a value of its own. */
function returnsNothing(e: ts.Expression): boolean {
  const fn = callable(e);
  if (!fn || !("body" in fn) || !fn.body || !ts.isBlock(fn.body)) return false;
  let value = false;
  const visit = (n: ts.Node): void => {
    if (value || (n !== fn && ts.isFunctionLike(n))) return;
    if (ts.isReturnStatement(n) && n.expression) value = true;
    ts.forEachChild(n, visit);
  };
  visit(fn.body);
  return !value;
}

/** Whether an `onRequest` returns nothing or the request it is given (`{ request }`), unchanged in its URL. */
function returnsOwnRequest(fn: ts.SignatureDeclaration): boolean {
  const body = "body" in fn ? fn.body : undefined;
  if (!body || !ts.isBlock(body)) return false;
  const first = fn.parameters[0];
  const request = first && ts.isObjectBindingPattern(first.name) ? first.name.elements.find((e) => !e.dotDotDotToken && (e.propertyName ? nameOf(e.propertyName) : ts.isIdentifier(e.name) ? e.name.text : undefined) === "request") : undefined;
  let ok = true;
  const visit = (n: ts.Node): void => {
    if (!ok || (n !== fn && ts.isFunctionLike(n))) return;
    if (ts.isReturnStatement(n) && n.expression) {
      const r = unwrap(n.expression);
      ok = !!request && ts.isIdentifier(r) && declarationOf(r) === request;
    }
    ts.forEachChild(n, visit);
  };
  visit(body);
  return ok;
}

/**
 * The text an axios request interceptor puts before the URL: `config.url = `/v2${config.url}``, a statement of its own
 * in the function's body; "" where it leaves the URL and the base alone; undefined where it may change them otherwise:
 * another write of `url` or `baseURL`, the config handed on or returned as another object.
 */
function urlRewrite(fn: ts.SignatureDeclaration): string | undefined {
  const param = fn.parameters[0];
  const body = "body" in fn ? fn.body : undefined;
  if (!param || !body) return undefined;
  if (!ts.isIdentifier(param.name)) return undefined;
  let before = "";
  for (const ref of references(param.name)) {
    const place = valuePlace(ref);
    const p = place.parent;
    if (ts.isReturnStatement(p) || (ts.isArrowFunction(p) && p.body === place)) continue;
    const m = member(p as ts.Expression);
    if (!m || (p as ts.PropertyAccessExpression).expression !== place) return undefined;
    if (m.name !== "url" && m.name !== "baseURL") continue;
    const write = p.parent;
    const assigned = ts.isBinaryExpression(write) && write.left === p && write.operatorToken.kind >= ts.SyntaxKind.FirstAssignment && write.operatorToken.kind <= ts.SyntaxKind.LastAssignment;
    if (!assigned) {
      // A read of the URL: in the value of its own rewrite, or anywhere else, which changes nothing.
      if (ts.isPrefixUnaryExpression(write) || ts.isPostfixUnaryExpression(write)) return undefined;
      continue;
    }
    if (m.name !== "url" || write.operatorToken.kind !== ts.SyntaxKind.EqualsToken || before) return undefined;
    if (!ts.isExpressionStatement(write.parent) || !ts.isBlock(body) || write.parent.parent !== body) return undefined;
    const value = unwrap(write.right);
    const own = (e: ts.Expression): boolean => {
      const x = member(unwrap(e));
      return !!x && x.name === "url" && ts.isIdentifier(unwrap(x.receiver)) && declarationOf(unwrap(x.receiver) as ts.Identifier) === param;
    };
    if (ts.isTemplateExpression(value) && value.templateSpans.length === 1 && own(value.templateSpans[0]!.expression) && !value.templateSpans[0]!.literal.text) before = value.head.text;
    else if (ts.isBinaryExpression(value) && value.operatorToken.kind === ts.SyntaxKind.PlusToken && ts.isStringLiteralLike(unwrap(value.left)) && own(value.right)) before = (unwrap(value.left) as ts.StringLiteral).text;
    else return undefined;
    if (!before) return undefined;
  }
  return before;
}

/** An expression as written, shortened for a limit. */
function short(node: ts.Node): string {
  const text = node.getText().replace(/\s+/g, " ");
  return text.length > 60 ? `${text.slice(0, 57)}...` : text;
}
