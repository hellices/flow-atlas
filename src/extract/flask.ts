import { posix } from "node:path";
import type { Dispatch } from "../model.js";
import { lineOf } from "../source.js";
import { blockEnd, plainImports, pythonBindings, pythonImports, scopesOf, shadowed, statementValue, valueAt, type Imports, type Scope, type Value } from "./python.js";
import { closingParen, pythonArg, pythonArgStarts, pythonCode, pythonStrings } from "./routes.js";

/**
 * The routes Flask serves, and Quart, which takes Flask's application, blueprints and views and Werkzeug's routing
 * (quart/app.py `Quart(App)`, quart/blueprints.py, quart/routing.py `QuartRule(Rule)`), as Flask 3.1 and Werkzeug 3.1
 * register and match them:
 *
 * - `@app.route(rule, methods=[...])`, its shortcuts `@app.get(rule)` and the like, and `app.add_url_rule(rule,
 *   endpoint, view_func)`, on an application (`Flask(...)`, `Quart(...)`) or a `Blueprint(...)`. A rule's methods are
 *   the ones given, else the view's (`View.methods`, or those a `MethodView` defines), else GET; Werkzeug adds HEAD
 *   beside GET (`Rule`), and Flask OPTIONS unless the methods or the view say otherwise (`App.add_url_rule`).
 * - A blueprint's rules are served under the `url_prefix` of each registration (`register_blueprint`'s, else the
 *   blueprint's own), each nested registration's joined to its parent's, as `BlueprintSetupState.add_url_rule` and
 *   `Blueprint.register` join them: as text, so `/admin` and `/` are `/admin/`.
 * - The static files route, `<static_url_path>/<path:filename>`, of an application (on by default) and of a blueprint
 *   with a `static_folder`, under its registrations.
 * - Each rule's text read as Werkzeug parses it (`Rule._parse_rule`): its converters, and the parts and weights its
 *   `StateMachineMatcher` matches a request by.
 */

/** A route Flask serves: its path in atlas's form, with the regexps of its parameters and how Werkzeug dispatches it. */
export interface FlaskRoute {
  method: string;
  path: string;
  patterns?: Record<string, string>;
  file: string;
  line: number;
  implicit?: true;
  convention?: string;
  dispatch: Dispatch;
}

const HTTP_METHOD_FUNCS = ["get", "post", "head", "options", "delete", "put", "trace", "patch"];
/** The names a class is imported from that atlas reads, fully qualified. */
const FLASK = new Set(["flask.Flask", "flask.app.Flask"]);
const QUART = new Set(["quart.Quart", "quart.app.Quart"]);
const BLUEPRINT = new Set(["flask.Blueprint", "flask.blueprints.Blueprint", "quart.Blueprint", "quart.blueprints.Blueprint"]);
const VIEW = new Set(["flask.views.View", "quart.views.View"]);
const METHOD_VIEW = new Set(["flask.views.MethodView", "quart.views.MethodView"]);
const BASE_CONVERTER = new Set(["werkzeug.routing.BaseConverter", "werkzeug.routing.converters.BaseConverter"]);
/** The convertor names atlas's path form reads as Starlette's (see `paths.ts`): a Werkzeug converter of one of these names is written otherwise. */
const STARLETTE_NAMES = new Set(["str", "int", "float", "uuid", "path"]);

/** An argument as a call gives it: not given, or its value; `spread` where a `*` or `**` argument may give it. */
type Given = { given: false } | { given: true; value: Value } | { given: "spread"; text: string };

interface StaticFolder {
  /** Where the call that sets it is. */
  at: number;
  /** The rule of the static files route, or none (`static_folder=None`), or why it is not read. */
  rule: string | null | { why: string };
}

interface App {
  kind: "app";
  framework: "flask" | "quart";
  at: number;
  static: StaticFolder;
  /** Why the application's rules match by host, which atlas does not read (`host_matching`). */
  hosts?: string;
}

interface Blueprint {
  kind: "blueprint";
  framework: "flask" | "quart";
  at: number;
  prefix: Value | null;
  subdomain: Value | null;
  static: StaticFolder;
}

type Binding = App | Blueprint;

/** A route registration: a decorator, or a call of `add_url_rule`. */
interface Registration {
  receiver: string;
  at: number;
  verb: string;
  /** Where its arguments start and end. */
  args: [number, number];
  rule: Given;
  /** The methods given, undefined where not given, or why they are not read. */
  methods: string[] | undefined | { why: string };
  /** The view given to `add_url_rule`, as written. */
  view?: string;
  /** `provide_automatic_options` as given: true, false, or null where it is not spelled out. */
  automatic: boolean | undefined | null;
  strict: boolean | undefined | null;
  /** `merge_slashes` as given: true, false, undefined where not given or None, null where not spelled out. */
  merge: boolean | undefined | null;
  /** Options the file gives that make the rule one atlas does not read, by why. */
  unread?: string;
  /** Rules that serve nothing (`build_only=True`) or WebSocket handshakes only. */
  skip?: string;
  /** The definition a decorator is on, and the keys of its `defaults` (null where they are not spelled out). */
  definition?: number;
  /** A decorator called on a view rather than written over a definition: no receiver of it is said not traced. */
  called?: true;
  /** The endpoint the rule is registered under (the view's name where none is given), null where it is not spelled out. */
  endpoint: string | null;
  defaults?: string[] | null;
}

interface Register {
  receiver: string;
  target: string;
  at: number;
  prefix: Given;
  subdomain: Given;
}

interface ClassFacts {
  bases: string[];
  /** The names its body binds: methods it defines and attributes it assigns, with the text assigned. */
  members: Map<string, string | undefined>;
}

interface Facts {
  code: string;
  scopes: Scope[];
  imports: Imports;
  plain: Set<string>;
  bindings: Map<string, Binding | null>;
  registrations: Registration[];
  registers: Register[];
  classes: Map<string, ClassFacts>;
  /**
   * `url_map.converters[name] = Converter`, on the application written before `.url_map`: the name (undefined where it is
   * not spelled out, or the converters are set otherwise) and the class as written.
   */
  converters: Array<{ receiver: string; name: string | undefined; cls: string; at: number }>;
  /** `url_map.strict_slashes = value` and `url_map.merge_slashes = value`, on an application, as written. */
  strictSlashes: Array<{ receiver: string; value: string; at: number }>;
  mergeSlashes: Array<{ receiver: string; value: string; at: number }>;
  /** Functions defined at any depth, and those whose `methods` or `provide_automatic_options` the file assigns. */
  functions: Set<string>;
  attributed: Set<string>;
}

/** The fully qualified name an expression names through the file's imports, for a module outside the files read. */
function qualified(f: Pick<Facts, "imports" | "plain">, expr: string): string | undefined {
  const [head, ...rest] = expr.replace(/\s+/g, "").split(".");
  const imported = f.imports.get(head!);
  if (imported) {
    if (imported.module.startsWith(".")) return undefined;
    return [imported.member ? `${imported.module}.${imported.member}` : imported.module, ...rest].join(".");
  }
  return f.plain.has(head!) ? [head, ...rest].join(".") : undefined;
}

/** An argument by its keyword, or by its position among those before the first keyword or `*` one. */
function argument(text: string, code: string, from: number, name: string, position?: number): Given {
  const starts = pythonArgStarts(code, from).filter((at) => at < closingParen(code, from));
  for (const at of starts) {
    const m = new RegExp(`^${name}\\s*=(?!=)\\s*`).exec(code.slice(at));
    if (m) return { given: true, value: valueAt(text, code, at + m[0].length) };
  }
  const positional: number[] = [];
  for (const at of starts) {
    if (/^[A-Za-z_]\w*\s*=(?!=)/.test(code.slice(at)) || code.startsWith("**", at)) break;
    if (code.startsWith("*", at)) return { given: "spread", text: pythonArg(text, code, at) };
    positional.push(at);
  }
  if (position !== undefined && positional[position] !== undefined) return { given: true, value: valueAt(text, code, positional[position]) };
  const spread = starts.find((at) => code.startsWith("**", at));
  return spread === undefined ? { given: false } : { given: "spread", text: pythonArg(text, code, spread) };
}

/** A Python constant an argument holds: `True`, `False` or `None`. */
const constant = (g: Given): boolean | null | undefined | "other" => {
  if (g.given === false) return undefined;
  if (g.given === "spread" || typeof g.value === "string") return "other";
  return g.value.unread === "True" ? true : g.value.unread === "False" ? false : g.value.unread === "None" ? null : "other";
};

/** A `True` or `False` an option gives: undefined where it is not given or `None`, null where it is not spelled out. */
const flag = (g: Given): boolean | undefined | null => {
  const c = constant(g);
  return c === "other" ? null : c === null ? undefined : c;
};

/** The text an argument holds, for a limit. */
const shown = (g: Given): string => (g.given === "spread" ? g.text : g.given && typeof g.value === "object" ? g.value.unread : JSON.stringify(g.given ? g.value : ""));

/**
 * The methods a literal list, tuple or set of strings names, upper-cased as Flask does; why not, where it is built at
 * run time or is a string, which Flask refuses.
 */
function methodList(text: string, code: string, at: number): string[] | { why: string } {
  const arg = pythonArg(text, code, at);
  const open = code[at];
  const shape = open === "[" || open === "{" || open === "(";
  if (!shape || closingParen(code, at + 1) !== at + arg.length - 1) return { why: `methods the file does not spell out (${arg.replace(/\s+/g, " ")})` };
  const items = pythonArgStarts(code, at + 1)
    .filter((s) => s < at + arg.length - 1)
    .map((s) => pythonArg(text, code, s))
    .filter(Boolean);
  // `("GET")` is a string, not a tuple.
  if (open === "(" && items.length === 1 && !/,\s*\)$/.test(code.slice(at, at + arg.length))) return { why: `methods given as a string (${arg}), which Flask refuses` };
  const methods = items.map((item) => {
    const s = pythonStrings(item);
    return s && s.length === item.length ? s.value.toUpperCase() : undefined;
  });
  return methods.every((m): m is string => m !== undefined) ? [...new Set(methods)] : { why: `methods the file does not spell out (${arg.replace(/\s+/g, " ")})` };
}

/** The literal keys of a dict literal (`{"page": "index"}`, `dict(page="index")`), or null where they are not spelled out. */
function dictKeys(text: string, code: string, at: number): string[] | null {
  const arg = pythonArg(text, code, at);
  if (code[at] === "{") {
    const keys = pythonArgStarts(code, at + 1)
      .filter((s) => s < at + arg.length - 1)
      .map((s) => {
        const item = pythonArg(text, code, s);
        const k = pythonStrings(item);
        return k && /^\s*:/.test(item.slice(k.length)) ? k.value : undefined;
      });
    return keys.every((k): k is string => k !== undefined) ? keys : null;
  }
  const call = /^dict\s*\(/.exec(code.slice(at));
  if (!call) return null;
  const keys = pythonArgStarts(code, at + call[0].length).map((s) => /^([A-Za-z_]\w*)\s*=(?!=)/.exec(code.slice(s))?.[1]);
  return keys.every((k): k is string => k !== undefined) ? keys : null;
}

/**
 * The rule of the static files route a `Flask(...)` or `Blueprint(...)` call adds (`Scaffold.static_url_path`): the
 * `static_url_path` given, a trailing `/` removed, else `/` and the last name of `static_folder`; none where
 * `static_folder` is None (a blueprint's default).
 */
function staticRule(text: string, code: string, from: number, at: number, positions: { folder: number; path: number }, folder: string | null): StaticFolder {
  const given = argument(text, code, from, "static_folder", positions.folder);
  const path = argument(text, code, from, "static_url_path", positions.path);
  for (const g of [given, path]) {
    if (g.given === "spread" || (g.given && typeof g.value === "object" && g.value.unread !== "None")) return { at, rule: { why: `static settings the file does not spell out (${shown(g)})` } };
  }
  const value = (g: Given, fallback: string | null) => (g.given === true ? (typeof g.value === "string" ? g.value : null) : fallback);
  const static_folder = value(given, folder);
  if (static_folder === null) return { at, rule: null };
  const url = value(path, null);
  if (url !== null) return { at, rule: `${url.replace(/\/+$/, "")}/<path:filename>` };
  // `os.path.join(root_path, folder)`: an empty folder joins as the root path itself, whose last name is empty.
  const name = static_folder.replace(/[\\/]+$/, "") === "" ? "" : posix.basename(static_folder.replace(/[\\/]+$/, ""));
  return { at, rule: `${`/${name}`.replace(/\/+$/, "")}/<path:filename>` };
}

function factsOf(text: string): Facts {
  const code = pythonCode(text);
  const base = { imports: pythonImports(code), plain: plainImports(code) };
  const callee = (expr: string) => qualified(base, expr);
  const constructs = (assigned: string) => {
    const m = /^([A-Za-z_][\w.]*)[ \t]*\(/.exec(assigned);
    const name = m && callee(m[1]!);
    return !!name && (FLASK.has(name) || QUART.has(name) || BLUEPRINT.has(name));
  };
  // A name assigned an application or blueprint in a function (an application factory) is the file's.
  const f: Facts = {
    code,
    scopes: scopesOf(code, constructs),
    ...base,
    bindings: new Map(),
    registrations: [],
    registers: [],
    classes: new Map(),
    converters: [],
    strictSlashes: [],
    mergeSlashes: [],
    functions: new Set([...code.matchAll(/^[ \t]*(?:async[ \t]+)?def[ \t]+([A-Za-z_]\w*)/gm)].map((m) => m[1]!)),
    attributed: new Set([...code.matchAll(/^[ \t]*([A-Za-z_]\w*)\.(?:methods|provide_automatic_options|required_methods)[ \t]*=(?!=)/gm)].map((m) => m[1]!)),
  };
  for (const m of code.matchAll(/^[ \t]*([A-Za-z_]\w*)[ \t]*(?::[^=\n]+)?=[ \t]*([A-Za-z_][\w.]*)[ \t]*\(/gm)) {
    const name = callee(m[2]!);
    if (!name || !(FLASK.has(name) || QUART.has(name) || BLUEPRINT.has(name))) continue;
    const at = (m.index ?? 0) + m[0].search(/\S/);
    const from = (m.index ?? 0) + m[0].length;
    const framework = name.startsWith("quart.") ? "quart" : "flask";
    let binding: Binding;
    if (BLUEPRINT.has(name)) {
      const prefix = argument(text, code, from, "url_prefix", 5);
      const subdomain = argument(text, code, from, "subdomain", 6);
      binding = {
        kind: "blueprint",
        framework,
        at,
        prefix: prefix.given === "spread" ? { unread: prefix.text } : prefix.given && constant(prefix) !== null ? prefix.value : null,
        subdomain: subdomain.given === "spread" ? { unread: subdomain.text } : subdomain.given && constant(subdomain) !== null ? subdomain.value : null,
        static: staticRule(text, code, from, at, { folder: 2, path: 3 }, null),
      };
    } else {
      const host = argument(text, code, from, "host_matching", 4);
      const hosts = flag(host);
      const staticHost = argument(text, code, from, "static_host", 3);
      const app: App = { kind: "app", framework, at, static: staticRule(text, code, from, at, { folder: 2, path: 1 }, "static") };
      if (hosts !== false && hosts !== undefined) app.hosts = `host_matching ${shown(host)}`;
      // The static route of an application with a `static_host` is that host's only (`host_matching` required).
      else if (staticHost.given && constant(staticHost) !== null && !("why" in Object(app.static.rule))) app.static = { at, rule: { why: `a static_host (${shown(staticHost)}), whose route only that host serves` } };
      binding = app;
    }
    // A name bound twice (in two branches) is read where both make the same: the routes either serves.
    const before = f.bindings.get(m[1]!);
    const same = (a: Binding, b: Binding) => JSON.stringify({ ...a, at: 0, static: a.static.rule }) === JSON.stringify({ ...b, at: 0, static: b.static.rule });
    f.bindings.set(m[1]!, before === undefined ? binding : before && same(before, binding) ? before : null);
  }
  for (const m of code.matchAll(/^[ \t]*@([A-Za-z_][\w.]*)\.(route|get|post|put|delete|patch|websocket)\(\s*/gm)) {
    const at = (m.index ?? 0) + m[0].search(/@/);
    const from = (m.index ?? 0) + m[0].length;
    const definition = /^[ \t]*(?:async[ \t]+)?(?:def|class)\b/gm;
    definition.lastIndex = from;
    f.registrations.push(registration(text, code, m[1]!, m[2]!, at, from, definition.exec(code)?.index));
  }
  // The decorator called on a view, `app.route("/x")(view)`, registers it as `@app.route` does.
  for (const m of code.matchAll(/(?<![\w.@])([A-Za-z_][\w.]*)\.(route|get|post|put|delete|patch|websocket)\(\s*/g)) {
    const from = (m.index ?? 0) + m[0].length;
    if (/^\s*\(/.test(code.slice(closingParen(code, from) + 1))) f.registrations.push({ ...registration(text, code, m[1]!, m[2]!, m.index ?? 0, from), called: true });
  }
  for (const m of code.matchAll(/(?<![\w.])([A-Za-z_][\w.]*)\.(add_url_rule|add_websocket)\(\s*/g)) {
    f.registrations.push(registration(text, code, m[1]!, m[2]!, m.index ?? 0, (m.index ?? 0) + m[0].length));
  }
  for (const m of code.matchAll(/(?<![\w.])([A-Za-z_][\w.]*)\.register_blueprint\(\s*/g)) {
    const from = (m.index ?? 0) + m[0].length;
    const target = argument(text, code, from, "blueprint", 0);
    if (target.given !== true) continue;
    f.registers.push({
      receiver: m[1]!,
      target: typeof target.value === "string" ? JSON.stringify(target.value) : target.value.unread,
      at: m.index ?? 0,
      prefix: argument(text, code, from, "url_prefix"),
      subdomain: argument(text, code, from, "subdomain"),
    });
  }
  for (const m of code.matchAll(/^([ \t]*)class[ \t]+([A-Za-z_]\w*)[ \t]*(\(?)/gm)) {
    const open = (m.index ?? 0) + m[0].length;
    const bases = m[3] ? pythonArgStarts(code, open).map((s) => pythonArg(text, code, s)).filter((b) => b && !/^[A-Za-z_]\w*\s*=(?!=)/.test(b)) : [];
    const colon = code.indexOf(":", m[3] ? closingParen(code, open) : open);
    if (colon < 0) continue;
    const end = blockEnd(code, colon, m[1]!);
    const body = code.slice(colon + 1, end);
    const indent = /\n([ \t]+)\S/.exec(body)?.[1];
    const members = new Map<string, string | undefined>();
    if (indent !== undefined) {
      for (const line of body.matchAll(new RegExp(`\\n${indent}(?:async[ \\t]+)?def[ \\t]+([A-Za-z_]\\w*)`, "g"))) members.set(line[1]!, undefined);
      for (const line of body.matchAll(new RegExp(`\\n${indent}([A-Za-z_]\\w*)[ \\t]*(?::[^=\\n]+)?=(?!=)[ \\t]*`, "g"))) {
        const valueAt = colon + 1 + (line.index ?? 0) + line[0].length;
        members.set(line[1]!, statementValue(text, code, valueAt));
      }
    }
    // A class defined twice is not read.
    f.classes.set(m[2]!, f.classes.has(m[2]!) ? { bases: ["<redefined>"], members: new Map() } : { bases, members });
  }
  for (const m of code.matchAll(/(?<![\w.])([A-Za-z_][\w.]*)\.url_map\.converters\[\s*/g)) {
    const from = (m.index ?? 0) + m[0].length;
    const close = closingParen(code, from);
    const key = pythonStrings(text.slice(from, close).trim());
    const assigned = /^\]\s*=(?!=)\s*/.exec(code.slice(close));
    if (!assigned) continue;
    f.converters.push({ receiver: m[1]!, name: key && key.length === text.slice(from, close).trim().length ? key.value : undefined, cls: statementValue(text, code, close + assigned[0].length), at: m.index ?? 0 });
  }
  for (const m of code.matchAll(/(?<![\w.])([A-Za-z_][\w.]*)\.url_map\.converters\s*(?:\.\s*(?:update|setdefault)\s*\(|=(?!=))/g)) {
    f.converters.push({ receiver: m[1]!, name: undefined, cls: "", at: m.index ?? 0 });
  }
  for (const m of code.matchAll(/(?<![\w.])([A-Za-z_][\w.]*)\.url_map\.(strict|merge)_slashes[ \t]*=(?!=)[ \t]*/g)) {
    (m[2] === "strict" ? f.strictSlashes : f.mergeSlashes).push({ receiver: m[1]!, value: statementValue(text, code, (m.index ?? 0) + m[0].length), at: m.index ?? 0 });
  }
  return f;
}

/** A decorator's or a call's registration: its rule, and the options that decide its methods and slashes. */
function registration(text: string, code: string, receiver: string, verb: string, at: number, from: number, definition?: number): Registration {
  const end = closingParen(code, from);
  const call = verb === "add_url_rule" || verb === "add_websocket";
  const out: Registration = {
    receiver,
    at,
    verb,
    args: [from, end],
    rule: argument(text, code, from, "rule", 0),
    methods: undefined,
    automatic: undefined,
    strict: flag(argument(text, code, from, "strict_slashes")),
    endpoint: null,
    merge: flag(argument(text, code, from, "merge_slashes")),
    ...(definition !== undefined ? { definition } : {}),
  };
  if (verb === "websocket" || verb === "add_websocket") out.skip = "a WebSocket route, which answers only a WebSocket handshake";
  const starts = pythonArgStarts(code, from).filter((s) => s < end);
  const spread = starts.find((s) => code.startsWith("*", s));
  const methods = starts.find((s) => /^methods\s*=(?!=)/.test(code.slice(s)));
  if (methods !== undefined) {
    const value = methods + /^methods\s*=\s*/.exec(code.slice(methods))![0].length;
    if (verb !== "route" && verb !== "add_url_rule") out.unread = `methods given to ${verb}, which Flask refuses`;
    else if (code.startsWith("None", value) && pythonArg(text, code, value) === "None") out.methods = undefined;
    else out.methods = methodList(text, code, value);
  } else if (!call && verb !== "route" && verb !== "websocket") out.methods = [verb.toUpperCase()];
  const automatic = argument(text, code, from, "provide_automatic_options", call ? 3 : undefined);
  out.automatic = flag(automatic);
  if (call) {
    const view = argument(text, code, from, "view_func", 2);
    if (view.given === true && typeof view.value === "object" && view.value.unread !== "None") out.view = view.value.unread;
    else if (view.given === "spread") out.view = view.text;
  }
  // `endpoint` given, else the view's `__name__` (`_endpoint_from_view_func`): the function's, or the name `as_view` is given.
  const endpoint = argument(text, code, from, "endpoint", call ? 1 : undefined);
  if (endpoint.given === true) out.endpoint = typeof endpoint.value === "string" ? endpoint.value : null;
  else if (endpoint.given === false && definition !== undefined) out.endpoint = /^[ \t]*(?:async[ \t]+)?def[ \t]+([A-Za-z_]\w*)/.exec(code.slice(definition))?.[1] ?? null;
  else if (endpoint.given === false && out.view !== undefined) {
    const as = /\.\s*as_view\s*\(\s*/.exec(out.view);
    const named = as ? pythonStrings(out.view.slice(as.index + as[0].length)) : undefined;
    out.endpoint = as ? (named?.value ?? null) : (/(?:^|\.)([A-Za-z_]\w*)$/.exec(out.view)?.[1] ?? null);
  }
  for (const [name, why] of [
    ["subdomain", "a subdomain"],
    ["host", "a host"],
  ] as const) {
    const g = argument(text, code, from, name);
    if (g.given && constant(g) !== null) out.unread = `${why} (${shown(g)}), which atlas does not read`;
  }
  const only = constant(argument(text, code, from, "build_only"));
  if (only === true) out.skip = "a rule only built, never matched (build_only)";
  else if (only === "other") out.unread = "build_only the file does not spell out";
  // A rule that redirects (`redirect_to`), or an alias of its view's main rule, is answered with a redirect by
  // `MapAdapter.match` (RequestRedirect, RequestAliasRedirect) whenever it matches.
  const redirect = argument(text, code, from, "redirect_to");
  if (redirect.given === true && constant(redirect) !== null) out.skip = `a rule Werkzeug answers with a redirect (redirect_to ${shown(redirect)})`;
  const alias = constant(argument(text, code, from, "alias"));
  if (alias === true) out.skip = "an alias, which Werkzeug answers with a redirect to its view's main rule";
  else if (alias === "other") out.unread = "alias the file does not spell out";
  const ws = constant(argument(text, code, from, "websocket"));
  if (ws === true) out.skip = "a WebSocket route, which answers only a WebSocket handshake";
  else if (ws === "other") out.unread = "websocket the file does not spell out";
  const defaults = starts.find((s) => /^defaults\s*=(?!=)/.test(code.slice(s)));
  if (defaults !== undefined) {
    const value = defaults + /^defaults\s*=\s*/.exec(code.slice(defaults))![0].length;
    out.defaults = pythonArg(text, code, value) === "None" ? undefined : dictKeys(text, code, value);
  }
  // A `*` or `**` argument may give any option, the rule's methods and host among them.
  if (spread !== undefined) out.unread = `options the file does not spell out (${pythonArg(text, code, spread)})`;
  return out;
}

/** What a converter is to Werkzeug: its regex (as Werkzeug compiles it), weight, and whether it takes one segment only. */
interface Converter {
  regex: string;
  weight?: number;
  /** Whether it takes text of one segment only (`part_isolating`); null where that is not read. */
  isolating: boolean | null;
  /** The regexp atlas tests a parameter's text with: none for any text of the segment; undefined where it is not read. */
  pattern?: string | null;
  /** Why a route with it is not read. */
  why?: string;
}

/** Python's `re.escape` (3.7 and later): the characters it escapes. */
const pyEscape = (s: string): string => s.replace(/[()[\]{}?*+\-|^$\\.&~# \t\n\r\v\f]/g, "\\$&");
const jsEscape = (s: string): string => s.replace(/[.*+?^${}()|[\]\\/-]/g, "\\$&");

/** A value of a converter's argument as Werkzeug reads it (`_pythonize`): a constant, an integer, a float or a string. */
type Py = null | boolean | number | string | { float: number };

/** A converter's arguments as Werkzeug parses them (`parse_converter_args`); undefined where it raises. */
function converterArgs(argstr: string): { args: Py[]; kwargs: Map<string, Py> } | undefined {
  const item = /\s*((\w+)\s*=\s*)?(True|False|\d+.\d+|\d+.|\d+|[\w\d_.]+|[urUR]?("[^"]*?"|'[^']*'))\s*,/y;
  const text = `${argstr},`;
  const args: Py[] = [];
  const kwargs = new Map<string, Py>();
  let at = 0;
  while (at < text.length) {
    item.lastIndex = at;
    const m = item.exec(text);
    // What is left after the last argument Werkzeug finds is not read, unless it starts where an argument should.
    if (!m) return /^[\s,]*$/.test(text.slice(at)) ? { args, kwargs } : undefined;
    const raw = m[4] ?? m[3]!;
    let value: Py;
    if (raw === "None" || raw === "True" || raw === "False") value = raw === "None" ? null : raw === "True";
    else if (/^[-+]?\d+$/.test(raw.replace(/_/g, "")) && !/^_|_$|__/.test(raw)) value = Number(raw.replace(/_/g, ""));
    else if (!Number.isNaN(Number(raw)) && /^[\d.eE+-]+$/.test(raw)) value = { float: Number(raw) };
    else value = /^(["']).*\1$/s.test(raw) ? raw.slice(1, -1) : raw;
    if (m[2]) kwargs.set(m[2], value);
    else args.push(value);
    at = item.lastIndex;
  }
  return { args, kwargs };
}

/** The values a converter's `__init__` takes, by name, from its arguments; undefined where Python would raise. */
function bind(parsed: { args: Py[]; kwargs: Map<string, Py> }, names: string[]): Map<string, Py> | undefined {
  if (parsed.args.length > names.length) return undefined;
  const out = new Map<string, Py>();
  parsed.args.forEach((v, i) => out.set(names[i]!, v));
  for (const [k, v] of parsed.kwargs) {
    if (!names.includes(k) || out.has(k)) return undefined;
    out.set(k, v);
  }
  return out;
}

const truthy = (v: Py | undefined): boolean => v !== undefined && v !== null && v !== false && v !== 0 && v !== "" && !(typeof v === "object" && v.float === 0);
const integer = (v: Py | undefined): number | undefined => (typeof v === "number" ? v : typeof v === "string" && /^\s*[-+]?\d+\s*$/.test(v) ? Number(v) : undefined);

/** A Werkzeug built-in converter (routing/converters.py), with the arguments a rule gives it. */
function builtin(name: string, argstr: string | undefined): Converter | undefined {
  const parsed = converterArgs(argstr ?? "");
  const refused: Converter = { regex: "", isolating: true, why: `its converter ${name}(${argstr ?? ""}) takes arguments Werkzeug refuses` };
  switch (name) {
    case "default":
    case "string": {
      const values = parsed && bind(parsed, ["minlength", "maxlength", "length"]);
      if (!values) return refused;
      const [min, max, length] = ["minlength", "maxlength", "length"].map((k) => values.get(k));
      const n = (v: Py | undefined, fallback: string) => (v === undefined || v === null ? fallback : integer(v));
      const regex = length !== undefined && length !== null ? `[^/]{${n(length, "")}}` : `[^/]{${n(min, "1")},${n(max, "")}}`;
      if (regex.includes("undefined")) return refused;
      return { regex, weight: 100, isolating: true, pattern: regex === "[^/]{1,}" ? null : regex };
    }
    case "any": {
      if (!parsed || parsed.kwargs.size || !parsed.args.every((a): a is string => typeof a === "string")) return refused;
      const items = parsed.args;
      return { regex: `(?:${items.map(pyEscape).join("|")})`, weight: 100, isolating: true, pattern: `(?:${items.map(jsEscape).join("|")})` };
    }
    case "path":
      // BaseConverter's `__init__` takes any arguments and keeps none.
      return { regex: "[^/].*?", weight: 200, isolating: false, pattern: null };
    case "uuid": {
      const regex = "[A-Fa-f0-9]{8}-[A-Fa-f0-9]{4}-[A-Fa-f0-9]{4}-[A-Fa-f0-9]{4}-[A-Fa-f0-9]{12}";
      return { regex, weight: 100, isolating: true, pattern: regex };
    }
    case "int":
    case "float": {
      const names = name === "int" ? ["fixed_digits", "min", "max", "signed"] : ["min", "max", "signed"];
      const values = parsed && bind(parsed, names);
      if (!values) return refused;
      const signed = truthy(values.get("signed"));
      const digits = name === "int" ? `\\d+` : `\\d+\\.\\d+`;
      const ascii = name === "int" ? "[0-9]+" : "[0-9]+\\.[0-9]+";
      const regex = signed ? `-?${digits}` : digits;
      // `to_python` refuses a value outside `min` and `max`, or of another number of digits than `fixed_digits`, after
      // the regex took it: a check atlas does not make, but for unsigned fixed digits, which a regex states.
      const fixed = values.get("fixed_digits");
      const range = [values.get("min"), values.get("max")].some((v) => v !== undefined && v !== null);
      if (range || (truthy(fixed) && (signed || integer(fixed) === undefined))) {
        return { regex, weight: 50, isolating: true, why: `its converter ${name}(${argstr}) checks the value it takes, which atlas does not read` };
      }
      // Python's `\d` takes any script's decimal digits; atlas tests ASCII ones, as code writes them.
      const pattern = truthy(fixed) ? `[0-9]{${integer(fixed)}}` : signed ? `-?${ascii}` : ascii;
      return { regex, weight: 50, isolating: true, pattern };
    }
  }
  return undefined;
}

/** A rule's text read as Werkzeug parses it, in atlas's form. */
export interface ParsedRule {
  /** The path, without its trailing `/`. */
  path: string;
  trailing: boolean;
  patterns: Map<string, string>;
  parts: NonNullable<Dispatch["parts"]>;
  variables: string[];
}

/**
 * A rule's text as Werkzeug parses it (`Rule._parse_rule`, with `merge_slashes`): each segment's static text and
 * variables `<converter(arguments):name>`, in atlas's form: a variable alone in its segment is `{name}`, a `path` one at
 * the end the rest of the path (`{name}/**`), a converter registered by the code `{name:converter}`, whose values atlas
 * does not read; the regexp of each other converter is the parameter's pattern. Why not, where Werkzeug refuses the rule
 * or atlas's form cannot say it: a `path` variable before the end or with text beside it, text that atlas would read as
 * a parameter, a converter whose segments or values are not read.
 */
export function parseRule(rule: string, converter: (name: string, args: string | undefined) => Converter | undefined): ParsedRule | { why: string } {
  if (!rule.startsWith("/")) return { why: `the rule ${JSON.stringify(rule)} does not start with a /, which Werkzeug refuses` };
  const merged = rule.replace(/\/{2,}/g, "/");
  const token = /(\/)|([^</]+)|<(?:([a-zA-Z_][a-zA-Z0-9_]*)(?:\((.*?)\))?:)?([a-zA-Z_][a-zA-Z0-9_]*)>/y;
  const parts: NonNullable<Dispatch["parts"]> = [];
  const segments: string[] = [];
  const patterns = new Map<string, string>();
  const variables: string[] = [];
  let content = "";
  let isStatic = true;
  let statics: Array<[number, number]> = [];
  let weights: Array<number | undefined> = [];
  let final = false;
  let n = 0;
  let segment = "";
  const flush = () => {
    if (!isStatic) content += "\\Z";
    const weight = weights.every((w): w is number => w !== undefined) ? [0 - statics.length || 0, ...statics.flat().map((x) => x || 0), 0 - weights.length || 0, ...weights] : undefined;
    parts.push(isStatic ? content : { regex: content, ...(weight ? { weight } : {}) });
    segments.push(segment);
    content = "";
    isStatic = true;
    statics = [];
    weights = [];
    n = 0;
    segment = "";
  };
  let at = 0;
  while (at < merged.length) {
    token.lastIndex = at;
    const m = token.exec(merged);
    if (!m) return { why: `the rule ${JSON.stringify(rule)} is not one Werkzeug parses` };
    at = token.lastIndex;
    if (final) return { why: `${rule} has text after a variable that takes slashes; the route is not read` };
    if (m[2] !== undefined) {
      const s = m[2];
      if (/[{}*?]/.test(s) || (!segment && s.startsWith(":"))) return { why: `${rule} has text atlas's path form would read as a parameter (${s}); the route is not read` };
      statics.push([statics.length, -s.length]);
      content += isStatic ? s : pyEscape(s);
      segment += s;
    } else if (m[5] !== undefined) {
      const name = m[5];
      const conv = m[3] ?? "default";
      const c = converter(conv, m[4]);
      const written = `<${m[3] ? `${m[3]}${m[4] !== undefined ? `(${m[4]})` : ""}:` : ""}${name}>`;
      if (!c) return { why: `${rule} names the converter ${conv}, which is neither Werkzeug's nor one the files read register; the route is not read` };
      if (c.why) return { why: `${rule} has ${written}: ${c.why}; the route is not read` };
      if (c.isolating === null) return { why: `${rule} has ${written}, a converter whose regex atlas does not read, so not which segments it takes; the route is not read` };
      if (variables.includes(name)) return { why: `${rule} names the variable ${name} twice; the route is not read` };
      variables.push(name);
      if (isStatic) content = pyEscape(content);
      isStatic = false;
      content += `(?P<__werkzeug_${n}>${c.regex})`;
      n++;
      weights.push(c.weight);
      if (!c.isolating) {
        if (c.pattern === undefined) return { why: `${rule} has ${written}, a converter the code registers that takes slashes; the route is not read` };
        if (segment) return { why: `${rule} has text before ${written}, a variable that takes slashes; the route is not read` };
        final = true;
        segment = `{${name}}/**`;
        continue;
      }
      if (c.pattern === undefined) {
        // atlas's form reads `{name:int}` and the like as Starlette's convertors.
        if (STARLETTE_NAMES.has(conv)) return { why: `${rule} has ${written}, a converter the code registers under a name atlas reads as a built-in converter's; the route is not read` };
        segment += `{${name}:${conv}}`;
      } else {
        if (c.pattern !== null) patterns.set(name, c.pattern);
        segment += `{${name}}`;
      }
    } else {
      if (final) return { why: `${rule} has text after a variable that takes slashes; the route is not read` };
      flush();
    }
  }
  flush();
  // A converter the code registers is read only as a segment whole (`{name:converter}`).
  const registered = segments.find((seg) => /\{\w+:\w+\}/.test(seg) && !/^\{\w+:\w+\}$/.test(seg));
  if (registered) return { why: `${rule} has a converter the code registers beside other text in a segment (${registered}), whose values atlas reads only where it is a segment whole; the route is not read` };
  // The first part is the empty text before the rule's leading `/`; a last empty one is its trailing `/`.
  parts.shift();
  segments.shift();
  const trailing = segments.length > 1 && segments[segments.length - 1] === "";
  if (trailing || (segments.length === 1 && segments[0] === "")) {
    parts.pop();
    segments.pop();
  }
  return { path: `/${segments.join("/")}`, trailing, patterns, parts, variables };
}

/**
 * The routes Flask and Quart serve from the Python files read, `texts` by file; `declared` is the path a blueprint's
 * file is served under where the code does not say it (`mounts`), in place of its registrations and its own
 * `url_prefix`.
 */
export function flaskRoutes(texts: Map<string, string>, component: string, declared: Record<string, string> = {}): { routes: FlaskRoute[]; limits: string[]; spans: Array<{ file: string; start: number; end: number }> } {
  const facts = new Map([...texts].filter(([file]) => file.endsWith(".py")).map(([file, text]) => [file, factsOf(text)]));
  const imports = new Map([...facts].map(([file, f]) => [file, f.imports]));
  const bindings = pythonBindings(imports, (file, name) => !!facts.get(file)?.bindings.has(name));
  const classes = pythonBindings(imports, (file, name) => !!facts.get(file)?.classes.has(name));
  const functions = pythonBindings(imports, (file, name) => !!facts.get(file)?.functions.has(name));
  const routes: FlaskRoute[] = [];
  const limits = new Set<string>();
  const spans: Array<{ file: string; start: number; end: number }> = [];
  const line = (file: string, at: number) => `${file}:${lineOf(texts.get(file)!, at)}`;
  const name = (key: string) => key.slice(key.lastIndexOf("#") + 1);
  const fileOf = (key: string) => key.slice(0, key.lastIndexOf("#"));
  const bindingOf = (key: string) => facts.get(fileOf(key))?.bindings.get(name(key));
  const said = (key: string) => `${name(key)} in ${fileOf(key)}`;

  /** What a receiver refers to at offset `at`: an application or blueprint, none where a function there binds its name. */
  const receiver = (file: string, expr: string, at: number): string | undefined => {
    const m = /^([A-Za-z_]\w*)(?:\.([A-Za-z_]\w*))?$/.exec(expr);
    if (!m || shadowed(facts.get(file)?.scopes ?? [], m[1]!, at)) return undefined;
    return bindings.reference(file, expr);
  };

  /** The application a `url_map` setting at offset `at` is made on, or "?" where atlas does not trace it to one. */
  const appOf = (file: string, expr: string, at: number): string => {
    const key = receiver(file, expr, at);
    return key && bindingOf(key)?.kind === "app" ? key : "?";
  };
  // The converters each application's `url_map` registers, by name: the class, or null where two registrations differ.
  // A registration on an application atlas does not trace, or whose name is not spelled out, may stand for any
  // converter of any application.
  const registered = new Map<string, Map<string, string | null>>();
  const unreadRegistrations: string[] = [];
  const untracedNames = new Set<string>();
  for (const [file, f] of facts) {
    for (const c of f.converters) {
      if (c.name === undefined || !c.cls) {
        unreadRegistrations.push(line(file, c.at));
        continue;
      }
      const app = appOf(file, c.receiver, c.at);
      if (app === "?") {
        untracedNames.add(c.name);
        continue;
      }
      const key = classes.reference(file, c.cls) ?? `?${c.cls}`;
      const map = registered.get(app) ?? registered.set(app, new Map()).get(app)!;
      map.set(c.name, map.has(c.name) && map.get(c.name) !== key ? null : key);
    }
  }
  if (unreadRegistrations.length) {
    limits.add(`routes ${component}: ${unreadRegistrations.join(", ")} register${unreadRegistrations.length === 1 ? "s" : ""} URL converters the file does not spell out; a rule's converter is read as Werkzeug's own or one the files register by name`);
  }

  /** A converter class the code defines: its weight, and whether it takes one segment, where its body spells them out. */
  const converterClass = (key: string | null): Converter => {
    const unknown: Converter = { regex: `<${key}>`, isolating: null };
    if (!key || key.startsWith("?")) return unknown;
    const cls = facts.get(fileOf(key))?.classes.get(name(key));
    const f = facts.get(fileOf(key))!;
    if (!cls || cls.bases.length !== 1 || !BASE_CONVERTER.has(qualified(f, cls.bases[0]!) ?? "")) return unknown;
    const regex = cls.members.get("regex");
    const isolatingText = cls.members.get("part_isolating");
    const weightText = cls.members.get("weight");
    const regexValue = regex !== undefined && pythonStrings(regex)?.length === regex.length ? pythonStrings(regex)!.value : undefined;
    // BaseConverter: `[^/]+`, weight 100, `part_isolating`; a class that sets its own regex takes slashes where the regex
    // holds a `/`, unless it sets `part_isolating` too (`BaseConverter.__init_subclass__`).
    const isolating = isolatingText === "True" ? true : isolatingText === "False" ? false : isolatingText !== undefined ? null : regex === undefined ? true : regexValue !== undefined ? !regexValue.includes("/") : null;
    const weight = weightText === undefined ? 100 : /^\d+$/.test(weightText) ? Number(weightText) : undefined;
    return { regex: `<${key}>`, isolating, ...(weight !== undefined ? { weight } : {}) };
  };
  /**
   * The converters of the rules an application serves (`app`), or of an application atlas does not know (undefined, a
   * blueprint `mounts` places): its `url_map`'s own, else Werkzeug's. A name registered on an application atlas does
   * not trace, or differently by the applications a rule may be served by, is not read.
   */
  const converterFor = (app: string | undefined) => (conv: string, args: string | undefined): Converter | undefined => {
    if (untracedNames.has(conv)) return { regex: "", isolating: true, why: `its converter ${conv} is registered on a url_map atlas does not trace to an application` };
    const classes = app === undefined ? new Set([...registered.values()].filter((m) => m.has(conv)).map((m) => m.get(conv))) : new Set(registered.get(app)?.has(conv) ? [registered.get(app)!.get(conv)] : []);
    if (classes.size > 1) return { regex: "", isolating: true, why: `its converter ${conv} is registered differently by the applications it may be served by` };
    const [cls] = [...classes];
    if (cls !== undefined) return { ...converterClass(cls), regex: `<${cls}(${args ?? ""})>`, pattern: undefined };
    return builtin(conv, args);
  };

  // `url_map.strict_slashes` and `merge_slashes` of each application, a setting on one atlas does not trace counting
  // for every one; for an application atlas does not know, every setting counts.
  const settings = (pick: (f: Facts) => Facts["strictSlashes"]) => [...facts].flatMap(([file, f]) => pick(f).map((s) => ({ ...s, file, app: appOf(file, s.receiver, s.at) })));
  const strictSettings = settings((f) => f.strictSlashes);
  const mergeSettings = settings((f) => f.mergeSlashes);
  const on = <T extends { app: string }>(all: T[], app: string | undefined) => all.filter((s) => app === undefined || s.app === app || s.app === "?");
  /** `url_map.strict_slashes`: true unless the code sets it; not read where it sets it otherwise than to True or False, or to both. */
  const mapStrict = (app: string | undefined): boolean | undefined => {
    const set = on(strictSettings, app);
    const values = new Set(set.map((s) => s.value));
    const strict = !set.length ? true : values.size === 1 && (values.has("True") || values.has("False")) ? values.has("True") : undefined;
    if (strict === undefined) {
      limits.add(`routes ${component}: url_map.strict_slashes is set to ${[...values].join(" and ")} (${set.map((s) => line(s.file, s.at)).join(", ")}); whether a route takes a request whose trailing / differs is not read`);
    }
    return strict;
  };
  /** `url_map.merge_slashes`: true unless the code sets it otherwise than to True. */
  const mapMerge = (app: string | undefined) => on(mergeSettings, app).every((s) => s.value === "True");
  // `PROVIDE_AUTOMATIC_OPTIONS` (Flask 3.1) turns off the OPTIONS each rule answers by itself.
  const optionsSetting = [...texts].find(([, text]) => text.includes("PROVIDE_AUTOMATIC_OPTIONS"));
  if (optionsSetting) limits.add(`routes ${component}: ${optionsSetting[0]} names PROVIDE_AUTOMATIC_OPTIONS; the OPTIONS Flask answers by itself beside each rule is not read`);

  // Each registration of a blueprint, keyed by the blueprint.
  const registers = new Map<string, Array<Register & { file: string; parent: string | undefined }>>();
  for (const [file, f] of facts) {
    for (const r of f.registers) {
      const child = receiver(file, r.target, r.at);
      if (!child || bindingOf(child)?.kind !== "blueprint") {
        limits.add(`routes ${component}: ${line(file, r.at)} registers ${r.target}, which atlas does not trace to a Blueprint of the route files; its routes are not read`);
        continue;
      }
      spans.push({ file, start: r.at, end: closingParen(f.code, f.code.indexOf("(", r.at) + 1) });
      (registers.get(child) ?? registers.set(child, []).get(child)!).push({ ...r, file, parent: receiver(file, r.receiver, r.at) });
    }
  }

  /**
   * The `url_prefix` of each registration of a blueprint or application, none for an application's own (null), as
   * `Blueprint.register` sets it: a registration's own, else the blueprint's, joined after its parent's. Why not, where
   * one is not spelled out, or the blueprint is registered nowhere, into itself, or with a subdomain.
   */
  const LIMIT = 64;
  type Unread = { why: string; about?: string };
  type Served = { prefix: string | null; app?: string };
  const served = new Map<string, Served[] | Unread>();
  const walking = new Set<string>();
  // Each blueprint's once: one registered on several parents, each registered on several, is read once per name.
  const prefixesOf = (key: string): Served[] | Unread => {
    const known = served.get(key);
    if (known) return known;
    if (walking.has(key)) return { why: `${said(key)} is registered into itself`, about: key };
    walking.add(key);
    const out = prefixes(key);
    walking.delete(key);
    served.set(key, out);
    return out;
  };
  const prefixes = (key: string): Served[] | Unread => {
    const b = bindingOf(key);
    if (!b) return { why: `${fileOf(key)} binds ${name(key)} to more than one application or blueprint`, about: key };
    if (b.kind === "app") return b.hosts ? { why: `${said(key)} matches rules by host (${b.hosts}), which atlas does not read`, about: key } : [{ prefix: null, app: key }];
    if (Object.hasOwn(declared, fileOf(key))) return [{ prefix: declared[fileOf(key)]! }];
    if (typeof b.prefix === "object" && b.prefix !== null) return { why: `${said(key)} has a url_prefix the file does not spell out (${b.prefix.unread})`, about: key };
    if (b.subdomain !== null) return { why: `${said(key)} has a subdomain (${typeof b.subdomain === "string" ? JSON.stringify(b.subdomain) : b.subdomain.unread}), which atlas does not read`, about: key };
    const all = registers.get(key);
    if (!all?.length) return { why: `${said(key)} is registered nowhere in the route files`, about: key };
    const out = new Map<string, Served>();
    for (const r of all) {
      const where = line(r.file, r.at);
      if (r.prefix.given === "spread" || (r.prefix.given && typeof r.prefix.value === "object" && r.prefix.value.unread !== "None")) {
        return { why: `${where} registers ${r.target} with a url_prefix the file does not spell out (${shown(r.prefix)})` };
      }
      if (r.subdomain.given && constant(r.subdomain) !== null) return { why: `${where} registers ${r.target} with a subdomain (${shown(r.subdomain)}), which atlas does not read` };
      if (!r.parent) return { why: `${where} registers ${r.target} on ${r.receiver}, which atlas does not trace to an application or Blueprint` };
      const given = r.prefix.given && typeof r.prefix.value === "string" ? r.prefix.value : null;
      const own = given ?? (b.prefix);
      const above = prefixesOf(r.parent);
      if ("why" in above) return above;
      for (const { prefix: p, app } of above) {
        const prefix = p !== null && own !== null ? `${p.replace(/\/+$/, "")}/${own.replace(/^\/+/, "")}` : (own ?? p);
        out.set(JSON.stringify([prefix, app]), { prefix, ...(app !== undefined ? { app } : {}) });
        if (out.size > LIMIT) return { why: `${said(key)} is served under more than ${LIMIT} prefixes`, about: key };
      }
    }
    return [...out.values()];
  };

  /** A rule under a prefix, joined as `BlueprintSetupState.add_url_rule` joins it. */
  const join = (prefix: string | null, rule: string) => (prefix === null ? rule : rule ? `${prefix.replace(/\/+$/, "")}/${rule.replace(/^\/+/, "")}` : prefix);

  /** The methods and `provide_automatic_options` of a view class, as `View` and `MethodView.__init_subclass__` set them. */
  type ViewInfo = { methods: Set<string> | null; automatic: boolean | null; defined: Set<string>; method: boolean } | { why: string };
  const viewOf = (key: string, seen: Set<string>): ViewInfo => {
    const f = facts.get(fileOf(key));
    const cls = f?.classes.get(name(key));
    if (!f || !cls || seen.has(key)) return { why: `${name(key)} is a class atlas does not read` };
    const bases: ViewInfo[] = cls.bases.map((b) => {
      const q = qualified(f, b);
      if (q && VIEW.has(q)) return { methods: null, automatic: null, defined: new Set(), method: false };
      if (q && METHOD_VIEW.has(q)) return { methods: null, automatic: null, defined: new Set(), method: true };
      const local = classes.reference(fileOf(key), b);
      return local ? viewOf(local, new Set([...seen, key])) : { why: `${name(key)} derives from ${b}, which atlas does not read` };
    });
    const unread = bases.find((b): b is { why: string } => "why" in b);
    if (unread) return unread;
    const read = bases as Array<Exclude<ViewInfo, { why: string }>>;
    if (!read.length) return { why: `${name(key)} is not a View` };
    const defined = new Set([...cls.members.keys(), ...read.flatMap((b) => [...b.defined])]);
    const method = read.some((b) => b.method);
    const automaticText = cls.members.get("provide_automatic_options");
    const automatic = cls.members.has("provide_automatic_options") ? (automaticText === "True" ? true : automaticText === "False" ? false : automaticText === "None" ? null : undefined) : (read.find((b) => b.automatic !== null)?.automatic ?? null);
    if (automatic === undefined) return { why: `${name(key)} sets provide_automatic_options to ${automaticText}` };
    let methods: Set<string> | null;
    if (cls.members.has("methods")) {
      const text = cls.members.get("methods")!;
      if (text === "None") methods = null;
      else {
        const code = pythonCode(text);
        const list = methodList(text, code, 0);
        if ("why" in list) return { why: `${name(key)} has ${list.why}` };
        methods = new Set(list);
      }
    } else if (method) {
      const all = new Set([...read.flatMap((b) => [...(b.methods ?? [])]), ...HTTP_METHOD_FUNCS.filter((m) => defined.has(m)).map((m) => m.toUpperCase())]);
      methods = all.size ? all : (read.find((b) => b.methods)?.methods ?? null);
    } else methods = read.find((b) => b.methods)?.methods ?? null;
    return { methods, automatic, defined, method };
  };

  /** The methods and `provide_automatic_options` of the view `add_url_rule` is given, as written. */
  const viewFunc = (file: string, view: string | undefined): { methods: Set<string> | null; automatic: boolean | null } | { why: string } => {
    if (view === undefined) return { methods: null, automatic: null };
    const as = /^([A-Za-z_][\w.]*?)\s*\.\s*as_view\s*\(/.exec(view);
    if (as) {
      const key = classes.reference(file, as[1]!);
      if (!key) return { why: `a view of ${as[1]}, a class atlas does not trace to the files read` };
      const v = viewOf(key, new Set());
      return "why" in v ? { why: `a view whose methods are not read (${v.why})` } : v;
    }
    const key = functions.reference(file, view);
    if (key && !facts.get(fileOf(key))!.attributed.has(name(key))) return { methods: null, automatic: null };
    return { why: `the view ${view}, whose methods atlas does not read` };
  };

  // Why the routes of an application or blueprint are not read, by cause: the one the cause is about, if any, and those
  // it leaves unread.
  const causes = new Map<string, { about?: string; keys: Set<string> }>();
  // The rules of each endpoint of an application or blueprint, for `redirect_defaults`.
  const endpoints = new Map<string, Array<{ file: string; r: Registration; rule: string }>>();
  for (const [file, f] of facts) {
    const at = (offset: number) => lineOf(texts.get(file)!, offset);
    const emit = (key: string, rule: string, offset: number, methods: string[], automatic: boolean, strict: boolean | undefined | null, extra: { convention?: string; implicit?: true; merge?: boolean | null } = {}) => {
      const p = prefixesOf(key);
      if ("why" in p) {
        const cause = causes.get(p.why) ?? causes.set(p.why, { about: p.about, keys: new Set() }).get(p.why)!;
        cause.keys.add(key);
        return;
      }
      for (const { prefix, app } of p) {
        const full = join(prefix, rule);
        // Werkzeug merges `//` in a rule into `/` (`Rule.compile`) unless `merge_slashes` is off for it or its map.
        if (full.includes("//") && (extra.merge === false || extra.merge === null || (extra.merge === undefined && !mapMerge(app)))) {
          limits.add(`routes ${component}: ${line(file, offset)} registers ${full}, whose // Werkzeug may keep (merge_slashes), which atlas's path form does not hold; the route is not read`);
          continue;
        }
        const parsed = parseRule(full, converterFor(app));
        if ("why" in parsed) {
          limits.add(`routes ${component}: ${line(file, offset)} registers ${parsed.why}`);
          continue;
        }
        const slashes = strict === null ? undefined : (strict ?? mapStrict(app));
        const dispatch: Dispatch = {
          picks: "werkzeug",
          parts: parsed.parts,
          ...(slashes === undefined ? {} : { slashes: "appended" as const }),
          ...(slashes === false ? { trailing: "both" as const } : parsed.trailing ? { trailing: "slash" as const } : {}),
        };
        const patterns = parsed.patterns.size ? Object.fromEntries(parsed.patterns) : undefined;
        const add = (method: string, implicit: boolean) =>
          routes.push({ method, path: parsed.path, ...(patterns ? { patterns } : {}), file, line: at(offset), ...(implicit || extra.implicit ? { implicit: true as const } : {}), ...(extra.convention ? { convention: extra.convention } : {}), dispatch });
        for (const m of methods) add(m, false);
        // Werkzeug adds HEAD beside GET (`Rule`); Flask OPTIONS where the rule's methods or view do not set it.
        if (methods.includes("GET") && !methods.includes("HEAD")) add("HEAD", true);
        if (automatic && !methods.includes("OPTIONS") && !optionsSetting) add("OPTIONS", true);
      }
      if (strict === null) limits.add(`routes ${component}: ${line(file, offset)} sets strict_slashes to a value the file does not spell out; whether its route takes a request whose trailing / differs is not read`);
    };
    // The static files route each application or blueprint adds as it is made (an application) or registered.
    for (const [bound, b] of f.bindings) {
      if (!b) continue;
      const rule = b.static.rule;
      if (rule === null) continue;
      if (typeof rule === "object") {
        limits.add(`routes ${component}: ${line(file, b.at)} makes ${bound} with ${rule.why}; the static files route ${b.framework === "quart" ? "Quart" : "Flask"} serves for it is not read`);
        continue;
      }
      emit(`${file}#${bound}`, rule, b.at, ["GET"], true, undefined, { implicit: true, convention: `${b.framework} static` });
    }
    const untraced = new Set<string>();
    for (const r of f.registrations) {
      const key = receiver(file, r.receiver, r.at);
      if (!key) {
        if (!r.called && /^(?:route|get|post|put|delete|patch|add_url_rule)$/.test(r.verb)) untraced.add(r.receiver);
        continue;
      }
      spans.push({ file, start: r.args[0], end: r.args[1] });
      const where = line(file, r.at);
      if (r.skip) {
        const rule = r.rule.given === true && typeof r.rule.value === "string" ? `${r.rule.value}, ` : "";
        if (!r.skip.startsWith("a rule only built")) limits.add(`routes ${component}: ${where} registers ${rule}${r.skip}; it is not read`);
        continue;
      }
      if (r.rule.given !== true || typeof r.rule.value !== "string") {
        limits.add(`routes ${component}: ${where} registers a rule the file does not spell out (${r.rule.given ? shown(r.rule) : "none"}); its routes are not read`);
        continue;
      }
      if (r.unread) {
        limits.add(`routes ${component}: ${where} registers ${r.rule.value} with ${r.unread}; its routes are not read`);
        continue;
      }
      if (r.methods && "why" in r.methods) {
        limits.add(`routes ${component}: ${where} registers ${r.rule.value} with ${r.methods.why}; its routes are not read`);
        continue;
      }
      // `App.add_url_rule`: the methods given, else the view's, else GET; OPTIONS where neither the call nor the view
      // says whether it is provided (`provide_automatic_options`), and the methods leave it out.
      const view = r.verb === "add_url_rule" ? viewFunc(file, r.view) : { methods: null, automatic: null };
      if ("why" in view && (!r.methods || r.automatic === undefined)) {
        limits.add(`routes ${component}: ${where} registers ${r.rule.value} with ${view.why}; its routes are not read`);
        continue;
      }
      const read = "why" in view ? { methods: null, automatic: null } : view;
      const methods = r.methods ?? (read.methods ? [...read.methods] : ["GET"]);
      if (r.automatic === null) limits.add(`routes ${component}: ${where} sets provide_automatic_options to a value the file does not spell out; the OPTIONS of its route is not read`);
      const automatic = r.automatic === null ? false : (r.automatic ?? read.automatic) === null;
      emit(key, r.rule.value, r.at, methods, automatic, r.strict, { merge: r.merge });
    }
    for (const name of untraced) {
      limits.add(`routes ${component}: ${file} registers routes on ${name}, which atlas does not trace to a Flask or Quart application or Blueprint of the route files; they are not read`);
    }
    for (const r of f.registrations) {
      const key = receiver(file, r.receiver, r.at);
      if (key && r.endpoint !== null && !r.skip && !r.unread && r.rule.given === true && typeof r.rule.value === "string") {
        const group = `${key}|${r.endpoint}`;
        (endpoints.get(group) ?? endpoints.set(group, []).get(group)!).push({ file, r, rule: r.rule.value });
      }
    }
  }
  // Werkzeug redirects a request a rule takes, whose values equal the `defaults` of another rule of the same endpoint
  // with the same arguments (variables and defaults), to that rule (`redirect_defaults`, `MapAdapter.get_default_redirect`,
  // `Rule.provides_defaults_for`): one tried before it among the endpoint's rules, which `Map.update` sorts by
  // `build_compare_key`, more defaults first, whatever order they were registered in.
  const variablesOf = (rule: string) => [...rule.matchAll(/<(?:[a-zA-Z_][a-zA-Z0-9_]*(?:\(.*?\))?:)?([a-zA-Z_][a-zA-Z0-9_]*)>/g)].map((m) => m[1]!);
  for (const rules of endpoints.values()) {
    for (const given of rules) {
      if (given.r.defaults === undefined) continue;
      const keys = given.r.defaults === null ? null : new Set([...variablesOf(given.rule), ...given.r.defaults]);
      for (const other of rules) {
        if (other === given || other.rule === given.rule || other.r.defaults !== undefined) continue;
        if (keys && !(keys.size === new Set(variablesOf(other.rule)).size && variablesOf(other.rule).every((v) => keys.has(v)))) continue;
        const defaults = given.r.defaults === null ? "defaults the file does not spell out" : `defaults for ${given.r.defaults.join(", ")}`;
        limits.add(
          `routes ${component}: ${line(other.file, other.r.at)} registers ${other.rule}, and ${line(given.file, given.r.at)} ${given.rule} with ${defaults}, for the endpoint ${given.r.endpoint ?? ""}; Werkzeug redirects a request to ${other.rule} whose values equal those defaults, by a method ${given.rule} takes, to ${given.rule} (redirect_defaults), which atlas does not tell apart`,
        );
      }
    }
  }
  for (const [why, { about, keys }] of causes) {
    const others = [...keys].filter((k) => k !== about).map((k) => `${fileOf(k)} (${name(k)})`);
    const whose = !others.length ? "its routes are" : `${about && keys.has(about) ? "its routes and those of" : "the routes of"} ${others.join(", ")} are`;
    const hint = [...keys].some((k) => bindingOf(k)?.kind === "blueprint") ? " (declare where it is served in mounts)" : "";
    limits.add(`routes ${component}: ${why}; ${whose} not read${hint}`);
  }
  return { routes, limits: [...limits], spans };
}
