import ts from "typescript";
import { joinRoute } from "../paths.js";
import { declarationOf, unwrap } from "./binding.js";

/** `VERSION_NEUTRAL`: a route served with no version in its path. */
export const NEUTRAL = "";

/**
 * What a Nest application's bootstrap sets for every controller route: the global prefix, the paths its `exclude` keeps
 * out of it, and URI versioning (docs.nestjs.com/faq/global-prefix, /techniques/versioning).
 */
export interface NestApp {
  /** The global prefix ("" when none is set); undefined when it is set to a value the files do not spell out. */
  prefix: string | undefined;
  exclude: Array<{ path: RegExp; method?: string }>;
  /**
   * Versioning when enabled: of the URI type, the text put before a version in the path and the default version(s)
   * (undefined when none is set, "unread" when not spelled out); "other" for a type that leaves the path alone.
   */
  versioning?: { uri: true; prefix: string; defaults: string[] | undefined | "unread" } | { uri: false } | "unread";
  /** Why no route of the application can be placed: settings that disagree. */
  unknown?: string;
}

const short = (node: ts.Node, sf: ts.SourceFile): string => {
  const text = node.getText(sf).replace(/\s+/g, " ");
  return text.length > 80 ? `${text.slice(0, 77)}...` : text;
};

/** A string the file spells out: a literal, or a `const` of the file initialized with one (`const globalPrefix = "api"`). */
function literalOf(e: ts.Expression | undefined): string | undefined {
  const u = e && unwrap(e);
  if (!u) return undefined;
  if (ts.isStringLiteral(u) || ts.isNoSubstitutionTemplateLiteral(u)) return u.text;
  if (!ts.isIdentifier(u)) return undefined;
  const decl = declarationOf(u);
  return decl && ts.isVariableDeclaration(decl) && ts.isIdentifier(decl.name) && decl.parent.flags & ts.NodeFlags.Const ? literalOf(decl.initializer) : undefined;
}

/** A version or list of versions as Nest takes them: strings, `VERSION_NEUTRAL`, or an array of those; undefined otherwise. */
export function versionsOf(e: ts.Expression): string[] | undefined {
  const u = unwrap(e);
  if ((ts.isIdentifier(u) && u.text === "VERSION_NEUTRAL") || (ts.isPropertyAccessExpression(u) && u.name.text === "VERSION_NEUTRAL")) return [NEUTRAL];
  if (ts.isArrayLiteralExpression(u)) {
    const all = u.elements.map((x) => (ts.isSpreadElement(x) ? undefined : versionsOf(x)));
    return all.every(Boolean) ? (all as string[][]).flat() : undefined;
  }
  const v = literalOf(u);
  return v === undefined ? undefined : [v];
}

/** A property of an object literal: undefined when it is not there, null when the literal does not spell it out. */
const property = (o: ts.ObjectLiteralExpression, name: string): ts.Expression | undefined | null => {
  // A spread may set any property.
  if (o.properties.some(ts.isSpreadAssignment)) return null;
  for (const p of o.properties) {
    const key = p.name && (ts.isIdentifier(p.name) || ts.isStringLiteral(p.name)) ? p.name.text : undefined;
    if (key !== name) continue;
    if (ts.isPropertyAssignment(p)) return p.initializer;
    if (ts.isShorthandPropertyAssignment(p)) return p.name;
    return null;
  }
  return undefined;
};

/**
 * An `exclude` path as Nest compiles it, with path-to-regexp 8 and its defaults (no case, a trailing `/` allowed):
 * `:name` takes one segment, `*name` one or more, `{...}` is optional; anything else in its syntax is not read.
 */
export function excludePattern(path: string): RegExp | undefined {
  const lead = path.startsWith("/") || path.startsWith("{/") ? path : `/${path}`;
  let source = "";
  let depth = 0;
  for (let i = 0; i < lead.length; ) {
    const c = lead[i]!;
    if (c === "{") {
      source += "(?:";
      depth++;
      i++;
    } else if (c === "}") {
      if (!depth--) return undefined;
      source += ")?";
      i++;
    } else if (c === ":" || c === "*") {
      const name = /^[A-Za-z_$][\w$]*/.exec(lead.slice(i + 1));
      if (!name) return undefined;
      source += c === ":" ? "[^/]+" : "[^]+";
      i += 1 + name[0].length;
    } else if ("()[]?+!\\\"".includes(c)) return undefined;
    else {
      source += c.replace(/[.^$|]/g, "\\$&");
      i++;
    }
  }
  return depth ? undefined : new RegExp(`^${source}/?$`, "i");
}

const REQUEST_METHODS = new Set(["GET", "POST", "PUT", "DELETE", "PATCH", "OPTIONS", "HEAD", "SEARCH", "ALL"]);

/**
 * Reads the global prefix and versioning that `setGlobalPrefix` and `enableVersioning` calls in `texts` set, with
 * `declared` taking the place of the prefix. Every such call is taken as the application's; calls that disagree leave
 * it unknown. `limits` gets what is not read.
 */
export function nestApp(texts: Map<string, string>, component: string, limits: string[], declared?: string): NestApp {
  const prefixes: Array<{ where: string; args: string; value: string | undefined; exclude: NestApp["exclude"]; limits: string[] }> = [];
  const versionings: Array<{ where: string; args: string; value: NonNullable<NestApp["versioning"]>; limits: string[] }> = [];
  for (const [file, text] of texts) {
    if (!/\b(?:setGlobalPrefix|enableVersioning)\s*\(/.test(text)) continue;
    const sf = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true, /x$/.test(file) ? ts.ScriptKind.TSX : ts.ScriptKind.TS);
    const where = (n: ts.Node) => `${file}:${sf.getLineAndCharacterOfPosition(n.getStart(sf)).line + 1}`;
    const visit = (node: ts.Node): void => {
      const name = ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression) ? node.expression.name.text : undefined;
      const call = node as ts.CallExpression;
      const args = name ? call.arguments.map((a) => a.getText(sf).replace(/\s+/g, " ")).join(", ") : "";
      if (name === "setGlobalPrefix") {
        const value = literalOf(call.arguments[0]);
        const own: string[] = [];
        if (value === undefined && declared === undefined) {
          own.push(`routes ${component}: ${where(call)} sets a global prefix the file does not spell out (${short(call.arguments[0] ?? call, sf)}); the routes under it are not read (declare it in prefix)`);
        }
        const exclude: NestApp["exclude"] = [];
        const options = call.arguments[1] && unwrap(call.arguments[1]);
        const list = options && ts.isObjectLiteralExpression(options) ? property(options, "exclude") : undefined;
        const entries: ts.Expression[] = list && ts.isArrayLiteralExpression(unwrap(list)) ? [...(unwrap(list) as ts.ArrayLiteralExpression).elements] : list ? [list] : list === null ? [options!] : [];
        if (options && !ts.isObjectLiteralExpression(options)) entries.push(options);
        for (const entry of entries) {
          const u = ts.isSpreadElement(entry) ? undefined : unwrap(entry);
          const object = u && ts.isObjectLiteralExpression(u) ? u : undefined;
          const path = object ? literalOf(property(object, "path") ?? undefined) : u && literalOf(u);
          const method = object ? property(object, "method") : undefined;
          const verb = method && ts.isPropertyAccessExpression(unwrap(method)) ? (unwrap(method) as ts.PropertyAccessExpression).name.text : undefined;
          const pattern = path === undefined ? undefined : excludePattern(path);
          // A RouteInfo names its method (`RequestMethod.GET`, `ALL` for every one); one with a version is not read.
          const known = pattern && (!object || (verb && REQUEST_METHODS.has(verb) && property(object, "version") === undefined));
          if (known) exclude.push({ path: pattern, ...(verb && verb !== "ALL" ? { method: verb } : {}) });
          else {
            own.push(
              `routes ${component}: ${where(entry)} excludes from the global prefix ${path === undefined ? "a path the file does not spell out" : !pattern ? "a pattern atlas does not read" : "an entry atlas does not read"} (${short(entry, sf)}); a route it excludes is read under the prefix`,
            );
          }
        }
        prefixes.push({ where: where(call), args, value, exclude, limits: own });
      }
      if (name === "enableVersioning") {
        const options = call.arguments[0] && unwrap(call.arguments[0]);
        const own: string[] = [];
        let value: NonNullable<NestApp["versioning"]> = "unread";
        if (!options) value = { uri: true, prefix: "v", defaults: undefined };
        else if (ts.isObjectLiteralExpression(options)) {
          const type = property(options, "type");
          const kind = type && ts.isPropertyAccessExpression(unwrap(type)) ? (unwrap(type) as ts.PropertyAccessExpression).name.text : undefined;
          const prefix = property(options, "prefix");
          const before = prefix === undefined ? "v" : prefix && unwrap(prefix).kind === ts.SyntaxKind.FalseKeyword ? "" : literalOf(prefix ?? undefined);
          const defaults = property(options, "defaultVersion");
          const versions = defaults === undefined ? undefined : ((defaults && versionsOf(defaults)) ?? null);
          if (kind && ["HEADER", "MEDIA_TYPE", "CUSTOM"].includes(kind)) value = { uri: false };
          else if (kind === "URI" && before !== undefined) value = { uri: true, prefix: before, defaults: versions === null ? "unread" : versions };
          if (value !== "unread" && value.uri && value.defaults === "unread") {
            own.push(`routes ${component}: ${where(defaults!)} sets a default version the file does not spell out (${short(defaults!, sf)}); the routes that take it are not read`);
          }
        }
        if (value === "unread") own.push(`routes ${component}: ${where(call)} enables versioning the file does not spell out (${short(call.arguments[0]!, sf)}); the routes are not read`);
        versionings.push({ where: where(call), args, value, limits: own });
      }
      ts.forEachChild(node, visit);
    };
    visit(sf);
  }
  const app: NestApp = { prefix: declared ?? "", exclude: [] };
  const differ = <T extends { where: string; args: string }>(calls: T[]) => new Set(calls.map((c) => c.args)).size > 1;
  if (differ(prefixes) || differ(versionings)) {
    const calls = differ(prefixes) ? prefixes : versionings;
    app.unknown = `${calls.map((c) => c.where).join(", ")} set ${calls === prefixes ? "the global prefix" : "versioning"} differently, and which application serves a controller is not read, so no route of the controllers is (name the application's bootstrap file in bootstrap)`;
    limits.push(`routes ${component}: ${app.unknown}`);
    return app;
  }
  if (prefixes[0]) {
    limits.push(...prefixes[0].limits);
    app.prefix = declared ?? prefixes[0].value;
    app.exclude = prefixes[0].exclude;
  }
  if (versionings[0]) {
    limits.push(...versionings[0].limits);
    app.versioning = versionings[0].value;
  }
  return app;
}

/**
 * The paths Nest serves a route at: `inner` (the controller's path joined to the method's), `method` and the versions
 * the route takes (the method's, else the controller's, else the default). Undefined when the application's settings
 * leave it unknown.
 */
export function nestPaths(app: NestApp, method: string, inner: string, versions: string[] | undefined): string[] | undefined {
  if (app.unknown || app.versioning === "unread") return undefined;
  const uri = app.versioning?.uri ? app.versioning : undefined;
  const taken = versions ?? (uri?.defaults === "unread" ? null : uri?.defaults);
  if (taken === null) return undefined;
  const segments = uri && taken ? taken.map((v) => (v === NEUTRAL ? "" : `${uri.prefix}${v}`)) : [""];
  // Exclusions are matched against the path without the version, and an excluded route keeps its version.
  const excluded = app.exclude.some((e) => (!e.method || e.method === method) && e.path.test(inner));
  if (!excluded && app.prefix === undefined) return undefined;
  return [...new Set(segments.map((v) => (excluded ? joinRoute(v, inner) : joinRoute(app.prefix!, v, inner))))];
}
