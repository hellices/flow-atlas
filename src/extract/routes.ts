import ts from "typescript";
import type { Config, RouteSource } from "../config.js";
import type { Coverage, Place, Surface } from "../model.js";
import { surfaceId } from "../model.js";
import { joinRoute, routeTemplate } from "../paths.js";
import { readFileSync } from "node:fs";
import { isAbsolute } from "node:path";
import { lineOf, matcher, select, type Source } from "../source.js";
import { operationShape } from "./apidocs.js";
import { httpExchanges, pathPrefixes, routesFromSpring, type Views } from "./spring.js";
import { definitions, describedOperations, escapeRegExp, handlerNames, type Definition } from "./openapi.js";
import { addCoverage } from "./coverage.js";
import { expressMounts, verbsOf, type Mounts } from "./mounts.js";
import type { Spans } from "./spans.js";
import type { Reach } from "./reach.js";
import { declarationOf, unwrap } from "./binding.js";
import { fastapiRouters, type Routers } from "./fastapi.js";
import { nestApp, nestModules, nestPaths, property, versionsOf, type NestApp } from "./nest.js";
import { nestSyntax, packageRanges, readRoutePath, syntaxOf, type RoutePath, type Syntax } from "./syntax.js";

const NEST_METHODS: Record<string, string> = {
  Get: "GET",
  Post: "POST",
  Put: "PUT",
  Patch: "PATCH",
  Delete: "DELETE",
  Head: "HEAD",
  Options: "OPTIONS",
  Sse: "GET",
  All: "*",
  // @nestjs/common's decorator of the QUERY method; `Query` is the parameter decorator of the query string.
  QueryMethod: "QUERY",
};
const HTTP_VERBS = new Set(["get", "post", "put", "patch", "delete", "head", "options", "all"]);
/** The names of the calls that may register a route on a router the express style reads. */
const REGISTERING = new Set([...["express", "@koa/router", "fastify", "hono"].flatMap((p) => [...verbsOf(p)]), "route", "on", "redirect"]);
/** The names whose calls the express style reads as routes when no router is traced, unless the entry names others. */
const EXPRESS_RECEIVERS = ["app", "router", "server", "fastify"];

/** A property's name as written, quoted or not: `path` and `"path"` are the same key. */
function propertyName(p: ts.ObjectLiteralElementLike): string | undefined {
  const n = p.name;
  return n && (ts.isIdentifier(n) || ts.isStringLiteral(n) || ts.isNoSubstitutionTemplateLiteral(n) || ts.isNumericLiteral(n)) ? n.text : undefined;
}

/** The text of a string literal, through parentheses and assertions; undefined for anything else, a spread included. */
const literalText = (e: ts.Expression): string | undefined => {
  const u = unwrap(e);
  return ts.isStringLiteralLike(u) ? u.text : undefined;
};

/** A property's name as the object holds it, a computed one included where it is a literal (`["url"]`). */
function literalKey(n: ts.PropertyName): string | undefined {
  if (ts.isComputedPropertyName(n)) {
    const e = n.expression;
    return ts.isStringLiteralLike(e) || ts.isNumericLiteral(e) ? e.text : undefined;
  }
  return ts.isIdentifier(n) || ts.isStringLiteral(n) || ts.isNoSubstitutionTemplateLiteral(n) || ts.isNumericLiteral(n) || ts.isPrivateIdentifier(n) ? n.text : undefined;
}

function stringValue(node: ts.Node | undefined): string | undefined {
  if (!node) return undefined;
  if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) return node.text;
  if (ts.isObjectLiteralExpression(node)) {
    for (const p of node.properties) {
      if (ts.isPropertyAssignment(p) && propertyName(p) === "path") return stringValue(p.initializer);
    }
  }
  return undefined;
}

/**
 * The paths a Nest decorator gives: none written means the root; a string, a list of strings or `{ path }` are read.
 * A path the file does not spell out (a constant, an expression) is unknown, so the caller registers nothing for it.
 */
function decoratorPaths(args: readonly ts.Expression[]): string[] | undefined {
  const arg = args[0];
  if (!arg) return [""];
  if (ts.isObjectLiteralExpression(arg)) {
    const path = arg.properties.find((p) => ts.isPropertyAssignment(p) && propertyName(p) === "path") as ts.PropertyAssignment | undefined;
    if (!path) return [""];
    return decoratorPaths([path.initializer]);
  }
  if (ts.isArrayLiteralExpression(arg)) {
    const paths = arg.elements.map((e) => stringValue(e));
    return paths.length && paths.every((p) => p !== undefined) ? paths : undefined;
  }
  const path = stringValue(arg);
  return path === undefined ? undefined : [path];
}

function decorators(node: ts.Node): ts.Decorator[] {
  return ts.canHaveDecorators(node) ? [...(ts.getDecorators(node) ?? [])] : [];
}

function decoratorCall(d: ts.Decorator): { name: string; args: readonly ts.Expression[] } | undefined {
  if (!ts.isCallExpression(d.expression)) return undefined;
  const callee = d.expression.expression;
  const name = ts.isIdentifier(callee) ? callee.text : ts.isPropertyAccessExpression(callee) ? callee.name.text : undefined;
  return name ? { name, args: d.expression.arguments } : undefined;
}

function calleeName(expr: ts.Expression): string | undefined {
  if (ts.isIdentifier(expr)) return expr.text;
  if (ts.isPropertyAccessExpression(expr)) return expr.name.text;
  return undefined;
}

/** An `operationId` property in an object literal among the arguments: route options, `@ApiOperation({ operationId })`. */
function operationIdIn(args: readonly ts.Expression[]): string | undefined {
  for (const arg of args) {
    if (!ts.isObjectLiteralExpression(arg)) continue;
    for (const p of arg.properties) {
      if (ts.isPropertyAssignment(p) && p.name.getText().replace(/["']/g, "") === "operationId") {
        const v = stringValue(p.initializer);
        if (v) return v;
      }
    }
  }
  return undefined;
}

const NEXT_METHODS = new Set(["GET", "HEAD", "POST", "PUT", "DELETE", "PATCH", "OPTIONS"]);

/** The image metadata files, with the numbered variants Next.js accepts (`icon1`). */
const METADATA_IMAGES = "(?:icon|apple-icon|opengraph-image|twitter-image)\\d?";

/**
 * The path Next.js serves a file at, and what the file is there: a route handler `app/**\/route.ts`, a page
 * `app/**\/page.tsx`, a metadata route, or under `pages/`, an API route (`pages/api/**`) or a page; `app/` and `pages/`
 * at the component's root or under its `src/`. `[x]` is a parameter, `[...x]` the rest of the path with at least one
 * segment (`{x}/**`) and `[[...x]]` with none or more (`{*x}`). In the App Router only, route groups `(x)` and slots
 * `@x` add no segment, and a private folder (`_x`) or an intercepting route `(.)x` is not served (undefined); under
 * `pages/` those are plain segments, and `_app`, `_document`, `_error`, `404` and `500` are not routes.
 *
 * Metadata routes are special route handlers whose default export makes the file (Next.js, Metadata Files): at the root
 * of `app/`, `robots.ts` serves `/robots.txt` (where RFC 9309 puts it) and `manifest.ts` `/manifest.webmanifest`; in
 * any segment, `sitemap.ts` serves `sitemap.xml` there. An image one (`icon`, `apple-icon`, `opengraph-image`,
 * `twitter-image`) is served at a path Next.js generates, which the file does not settle (`image`). `app` is the
 * directory of an App Router file's `app/`.
 */
export function nextRoute(file: string, root?: string): { path: string; kind: "handler" | "api" | "page" | "metadata" | "image"; app?: string } | undefined {
  // Inside the component, `app/` and `pages/` sit at its root or under `src/`; without a root, the first one found.
  const inside = root === undefined ? file : root === "" ? file : file.startsWith(`${root}/`) ? file.slice(root.length + 1) : undefined;
  if (inside === undefined) return undefined;
  const lead = root === undefined ? "(?:^|\\/)" : "^(?:src\\/)?";
  const app =
    new RegExp(`${lead}app\\/((?:[^]*\\/)?)(route|page)\\.(?:c|m)?[jt]sx?$`).exec(inside) ??
    new RegExp(`${lead}app\\/((?:[^]*\\/)?)(robots|manifest|sitemap|${METADATA_IMAGES})\\.[jt]sx?$`).exec(inside);
  const pages = app ? undefined : new RegExp(`${lead}pages\\/([^]+)\\.(?:c|m)?[jt]sx?$`).exec(inside);
  if (pages && /^(?:_app|_document|_error|404|500)$/.test(pages[1]!)) return undefined;
  const rest = app?.[1] ?? pages?.[1];
  if (rest === undefined) return undefined;
  const segments = nextSegments(rest, !!app);
  if (!segments) return undefined;
  if (pages && segments[segments.length - 1] === "index") segments.pop();
  const name = app?.[2];
  const appDir = app ? file.slice(0, file.length - inside.length + app.index + app[0].indexOf("app/") + "app".length) : undefined;
  if (name === "route" || name === "page") return { path: joinRoute(...segments), kind: name === "route" ? "handler" : "page", app: appDir };
  // Next.js reads robots and manifest only at the root of app/.
  if (name === "robots" || name === "manifest") return rest ? undefined : { path: name === "robots" ? "/robots.txt" : "/manifest.webmanifest", kind: "metadata" };
  if (name === "sitemap") return { path: joinRoute(...segments, "sitemap.xml"), kind: "metadata" };
  if (name) return { path: joinRoute(...segments, name), kind: "image" };
  return { path: joinRoute(...segments), kind: rest.startsWith("api/") ? "api" : "page" };
}

/** The segments of the folders a Next.js file sits in, as `nextRoute` reads them; undefined where the App Router serves nothing. */
function nextSegments(rest: string, app: boolean): string[] | undefined {
  const segments: string[] = [];
  for (const seg of rest.split("/").filter(Boolean)) {
    if (app) {
      if (seg.startsWith("_") || /^\(\.{1,3}\)/.test(seg)) return undefined;
      if (seg.startsWith("@") || /^\(.*\)$/.test(seg)) continue;
    }
    // A dynamic segment's name is any text but `]` (`[product-id]`).
    const optional = /^\[\[\.\.\.([^\]]+)\]\]$/.exec(seg);
    const required = /^\[\.\.\.([^\]]+)\]$/.exec(seg);
    const one = /^\[([^\].][^\]]*)\]$/.exec(seg);
    if (optional) segments.push(`{*${optional[1]}}`);
    else if (required) segments.push(`{${required[1]}}`, "**");
    else segments.push(one ? `{${one[1]}}` : seg);
  }
  return segments;
}

/**
 * The path Next.js serves a static file at, without a handler of the app's: a file under `public/` at the component's
 * root, from the base URL (Next.js, public Folder); and the metadata files written as files in `app/` (Next.js,
 * Metadata Files): `favicon.ico`, `robots.txt`, `manifest.json` and `manifest.webmanifest` at its root, `sitemap.xml` in
 * any segment. Undefined for any other file. A public file's name is written as a request holds it: the characters the
 * URL Standard's path percent-encode set holds, and `%`, percent-encoded; Next.js matches a request to the file both
 * encoded and decoded (filesystem.ts, `encodeURIPath`).
 */
export function nextStaticFile(file: string, root: string): { path: string; kind: "public" | "metadata" } | undefined {
  const inside = root === "" ? file : file.startsWith(`${root}/`) ? file.slice(root.length + 1) : undefined;
  if (inside === undefined) return undefined;
  if (inside.startsWith("public/")) return { path: `/${inside.slice("public/".length).replace(/[\0- "#%<>?^`{}\x7F-\u{10FFFF}]/gu, encodeURIComponent)}`, kind: "public" };
  const meta = /^(?:src\/)?app\/((?:[^]*\/)?)(favicon\.ico|robots\.txt|manifest\.json|manifest\.webmanifest|sitemap\.xml)$/.exec(inside);
  if (!meta) return undefined;
  if (meta[2] !== "sitemap.xml") return meta[1] ? undefined : { path: `/${meta[2]}`, kind: "metadata" };
  const segments = nextSegments(meta[1]!, true);
  return segments && { path: joinRoute(...segments, "sitemap.xml"), kind: "metadata" };
}

/**
 * The layouts and templates that wrap an App Router page, by their default exports: in the page's folder and each one
 * above it up to `app/`. They render in the same request, around the page (Next.js, layout.js and template.js). A file
 * under `pages/` has none.
 */
function nextWrappers(file: string, appDir: string, reach: Reach): Array<{ file: string; node: ts.Node }> {
  const folders = file.slice(appDir.length + 1).split("/").slice(0, -1);
  const out: Array<{ file: string; node: ts.Node }> = [];
  for (let n = 0; n <= folders.length; n++) {
    const dir = [appDir, ...folders.slice(0, n)].join("/");
    for (const name of ["layout", "template"]) {
      for (const ext of ["tsx", "ts", "jsx", "js"]) {
        const found = reach.exported(`${dir}/${name}.${ext}`, "default");
        if (found) out.push(found);
      }
    }
  }
  return out;
}

/** A member's name as written in any static form: `render`, `"render"`, `["render"]`. */
function memberName(name: ts.PropertyName): string | undefined {
  if (ts.isIdentifier(name) || ts.isStringLiteral(name) || ts.isNoSubstitutionTemplateLiteral(name)) return name.text;
  if (ts.isComputedPropertyName(name)) {
    const e = name.expression;
    return ts.isStringLiteral(e) || ts.isNoSubstitutionTemplateLiteral(e) ? e.text : undefined;
  }
  return undefined;
}

/**
 * A class component's `render`, its own or the one it inherits: React calls it on the instance, so a class without its
 * own takes its base class's, declared in the file or imported from a relative module. A base outside (React's
 * Component) renders nothing read here.
 */
function classRender(cls: ts.ClassDeclaration, file: string, sf: ts.SourceFile, reach: Reach | undefined, depth = 0): { node: ts.Node; file: string } | undefined {
  const own = ownRender(cls);
  if (own) return { node: own, file };
  const base = cls.heritageClauses?.find((h) => h.token === ts.SyntaxKind.ExtendsKeyword)?.types[0]?.expression;
  if (!base || !ts.isIdentifier(base) || depth > 8) return undefined;
  const local = sf.statements.find((st): st is ts.ClassDeclaration => ts.isClassDeclaration(st) && st.name?.text === base.text);
  if (local) return classRender(local, file, sf, reach, depth + 1);
  const imported = reach?.parse(file)?.imports.get(base.text);
  const target = imported && reach?.parse(imported.file);
  if (!imported || !target) return undefined;
  const declared = target.sf.statements.find(
    (st): st is ts.ClassDeclaration =>
      ts.isClassDeclaration(st) &&
      exported(st) &&
      (imported.name === "default" ? !!ts.getModifiers(st)?.some((m) => m.kind === ts.SyntaxKind.DefaultKeyword) : st.name?.text === imported.name),
  );
  return declared ? classRender(declared, imported.file, target.sf, reach, depth + 1) : undefined;
}

/** A class component's own `render`: a method, or a field holding a function (`render = () => ...`). */
function ownRender(cls: ts.ClassDeclaration): ts.Node | undefined {
  for (const m of cls.members) {
    // React calls the instance's render: not a static one, nor an overload's signature without a body.
    if (!m.name || memberName(m.name) !== "render" || (ts.canHaveModifiers(m) && ts.getModifiers(m)?.some((x) => x.kind === ts.SyntaxKind.StaticKeyword))) continue;
    if (ts.isMethodDeclaration(m) && m.body) return m;
    if (ts.isPropertyDeclaration(m) && m.initializer && (ts.isArrowFunction(m.initializer) || ts.isFunctionExpression(m.initializer))) return m.initializer;
  }
  return undefined;
}

/** Whether a module exports a value under a name: a function, a variable or an `export { }` entry that is not a type. */
function exportsValue(sf: ts.SourceFile, name: string): boolean {
  return sf.statements.some(
    (st) =>
      (ts.isFunctionDeclaration(st) && exported(st) && st.name?.text === name) ||
      (ts.isVariableStatement(st) && exported(st) && st.declarationList.declarations.some((d) => ts.isIdentifier(d.name) && d.name.text === name)) ||
      (ts.isExportDeclaration(st) && !st.isTypeOnly && !!st.exportClause && ts.isNamedExports(st.exportClause) && st.exportClause.elements.some((e) => e.name.text === name && !e.isTypeOnly)),
  );
}

const exported = (node: ts.Node): boolean => ts.canHaveModifiers(node) && !!ts.getModifiers(node)?.some((m) => m.kind === ts.SyntaxKind.ExportKeyword);

/** `executed` collects, per surface id, the `file@offset` of each expression its handler hands to a call it runs (see `Reach.from`). */
export function routesFromTypeScript(
  file: string,
  text: string,
  spec: RouteSource,
  context: {
    reach?: Reach;
    executed?: Map<string, Set<string>>;
    mounts?: Mounts;
    limits?: string[];
    /** Where registrations write their paths, collected for the call extractors. */
    spans?: Spans;
    /** The component's directory, which the Next.js paths are read from. */
    root?: string;
    /** The global prefix and versioning of the Nest application the controllers belong to. */
    nest?: NestApp;
    /** Per surface id, the `file@offset` of each address a page renders in a link or a form (see `Reach.from`). */
    offered?: Map<string, Set<string>>;
    /** The version range of a package the nearest package.json above a file names (see `packageRanges`). */
    ranges?: (file: string, pkg: string) => string | undefined;
  } = {},
): Surface[] {
  const { reach, executed, mounts, limits, spans, root, offered, ranges } = context;
  const nest = context.nest ?? { prefix: spec.prefix ?? "", exclude: [] };
  // A version changes the path only under URI versioning.
  const versioned = nest.versioning === "unread" || !!nest.versioning?.uri;
  const span = (node: ts.Node | undefined) => {
    if (node) spans?.add(file, node.getStart(sf), node.getEnd());
  };
  const sf = reach?.parse(file)?.sf ?? ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true, file.endsWith("x") ? ts.ScriptKind.TSX : ts.ScriptKind.TS);
  const styles = new Set(spec.styles ?? []);
  const receivers = new Set(spec.receivers ?? EXPRESS_RECEIVERS);
  /** Routers whose routes are not read, by name, with why. */
  const unmounted = new Map<string, string>();
  const constPattern = spec.constants ? new RegExp(spec.constants) : undefined;
  const out: Surface[] = [];
  const at = (node: ts.Node) => ({ file, line: sf.getLineAndCharacterOfPosition(node.getStart(sf)).line + 1 });
  /**
   * The declarations `constants` turned into GET routes, with their paths, and the registrations whose path is not a
   * literal: the method each registers and the prefixes its path is served under, where they are known.
   */
  const readConstants = new Map<ts.Node, string>();
  const unreadPaths: Array<{ arg: ts.Expression; method?: string; prefixes?: string[] }> = [];
  const unread = (arg: ts.Expression, method?: string, prefixes?: string[]) => unreadPaths.push({ arg, method, prefixes });
  const unreadVersion = (arg: ts.Node) =>
    limits?.push(`routes ${spec.component}: ${file}:${at(arg).line} gives a version the file does not spell out (${arg.getText(sf).replace(/\s+/g, " ")}); its routes are not read`);
  const add = (
    method: string,
    path: string,
    node: ts.Node,
    handler?: ts.Node,
    operationId?: string,
    more: {
      implicit?: boolean;
      handlerFile?: string;
      render?: boolean;
      served?: boolean;
      offers?: boolean;
      alongside?: Array<{ file: string; node: ts.Node }>;
      /** The syntax of the router the path is registered on, which reads it; without one, `:name` is the only syntax. */
      syntax?: Syntax;
    } = {},
  ) => {
    // A Nest route's path is already the one it is served at; any other is served under the configured prefix.
    const full = more.served ? joinRoute(path) : joinRoute(spec.prefix ?? "", path);
    const read = more.syntax ? readRoutePath(full, more.syntax) : { paths: [{ path: routeTemplate(full) }] };
    if ("why" in read) {
      limits?.push(`routes ${spec.component}: ${file}:${at(node).line} registers ${full}, a path not read: ${read.why}`);
      return;
    }
    for (const served of read.paths) push(method, served, node, handler, operationId, more);
  };
  const push = (method: string, served: RoutePath, node: ts.Node, handler: ts.Node | undefined, operationId: string | undefined, more: Parameters<typeof add>[5] = {}) => {
    const template = served.path;
    const id = surfaceId({ component: spec.component, method: method.toUpperCase(), path: template });
    const lines = executed ? (executed.get(id) ?? executed.set(id, new Set()).get(id)!) : undefined;
    const offers = more.offers && offered ? (offered.get(id) ?? offered.set(id, new Set()).get(id)!) : undefined;
    // `alongside`: what runs in the same request beside the handler (a page's layouts, a split sitemap's `generateSitemaps`).
    const starts = handler ? [{ file: more.handlerFile ?? file, node: handler }, ...(more.alongside ?? [])] : [];
    out.push({
      id,
      component: spec.component,
      method: method.toUpperCase(),
      path: template,
      at: at(node),
      evidence: "static",
      ...(operationId ? { operationId } : {}),
      ...(reach && handler ? { reaches: [...new Set(starts.flatMap((st) => reach.from(st.file, st.node, lines, more.render, offers)))].sort() } : {}),
      ...(more.implicit ? { implicit: true } : {}),
      ...(served.patterns ? { patterns: served.patterns } : {}),
    });
  };

  const next = styles.has("next") ? nextRoute(file, root) : undefined;
  /** The handler an export names, in the module it is re-exported from when there is one. */
  const reexported = (st: ts.ExportDeclaration, e: ts.ExportSpecifier): { handler?: ts.Node; file?: string } => {
    const from = st.moduleSpecifier && ts.isStringLiteral(st.moduleSpecifier) ? st.moduleSpecifier.text : undefined;
    if (!from) return { handler: e };
    const target = reach?.resolve(file, from);
    const found = target ? reach!.exported(target, (e.propertyName ?? e.name).text) : undefined;
    return found ? { handler: found.node, file: found.file } : {};
  };
  const isDefault = (st: ts.Statement) =>
    (ts.isExportAssignment(st) && !st.isExportEquals) ||
    ((ts.isFunctionDeclaration(st) || ts.isClassDeclaration(st)) && exported(st) && !!ts.getModifiers(st)?.some((m) => m.kind === ts.SyntaxKind.DefaultKeyword));
  if (next?.kind === "image") {
    limits?.push(`routes ${spec.component}: ${file} is a metadata image route, served at a path Next.js generates; it is not read`);
  } else if (next?.kind === "metadata") {
    // The default export makes the file, and Next.js serves it to GET; as for any route handler, it answers HEAD with
    // that handler and OPTIONS by itself. `generateSitemaps` splits a sitemap into `sitemap/[id].xml`, and the handler
    // Next.js generates calls it on each request to find the id asked for (next-metadata-route-loader). Crawlers fetch
    // robots.txt where RFC 9309 puts it and the sitemaps it names, and browsers the manifest the page's head links to:
    // none is requested by the app's own code, so each is implicit, as a file in public/ is.
    const statement =
      sf.statements.find(isDefault) ??
      sf.statements.find((st) => ts.isExportDeclaration(st) && !st.isTypeOnly && !!st.exportClause && ts.isNamedExports(st.exportClause) && st.exportClause.elements.some((e) => e.name.text === "default" && !e.isTypeOnly));
    if (statement) {
      const found = reach?.exported(file, "default");
      const handler = found?.node ?? (ts.isExportAssignment(statement) ? statement.expression : statement);
      const split = next.path.endsWith("/sitemap.xml") && exportsValue(sf, "generateSitemaps");
      const path = split ? next.path.replace(/\.xml$/, "/{id}.xml") : next.path;
      const ids = split ? reach?.exported(file, "generateSitemaps") : undefined;
      const alongside = ids ? [ids] : [];
      add("GET", path, statement, handler, undefined, { implicit: true, handlerFile: found?.file, alongside });
      add("HEAD", path, statement, handler, undefined, { implicit: true, handlerFile: found?.file, alongside });
      add("OPTIONS", path, statement, undefined, undefined, { implicit: true });
    }
  } else if (next?.kind === "page") {
    // A page answers GET (and HEAD) by rendering its default export. What the server runs while rendering is part of
    // the request; a link, or a handler the browser runs later, starts another one.
    let page: ts.Statement | undefined = sf.statements.find(isDefault);
    // A class component renders through its `render` method; `this.x()` called there is followed from it.
    let component: ts.Node | undefined =
      page && ts.isExportAssignment(page)
        ? page.expression
        : page && ts.isClassDeclaration(page)
          ? undefined
          : page;
    let handlerFile: string | undefined;
    if (page && ts.isClassDeclaration(page)) {
      const found = classRender(page, file, sf, reach);
      component = found?.node;
      handlerFile = found?.file;
    }
    if (!page) {
      // `export { Page as default }`, or `export { default } from "./Page"`: the function it names renders.
      page = sf.statements.find((st) => ts.isExportDeclaration(st) && !!st.exportClause && ts.isNamedExports(st.exportClause) && st.exportClause.elements.some((e) => e.name.text === "default"));
      const found = page ? reach?.exported(file, "default") : undefined;
      component = found?.node;
      handlerFile = found?.file;
    }
    // An App Router page renders inside the layouts and templates of its folders; the GET response holds the links and
    // forms they render, which the page offers to follow. HEAD answers with no body.
    const wrappers = reach && next.app !== undefined ? nextWrappers(file, next.app, reach) : [];
    add("GET", next.path, page ?? sf, component, undefined, { render: true, handlerFile, offers: true, alongside: wrappers });
    add("HEAD", next.path, page ?? sf, component, undefined, { implicit: true, render: true, handlerFile, alongside: wrappers });
  } else if (next) {
    const handlers = new Map<string, { node: ts.Node; handler?: ts.Node; file?: string }>();
    for (const st of sf.statements) {
      // A type-only export (`export type * from`, `export type { GET } from`) exports no value Next.js could call.
      if (ts.isExportDeclaration(st) && st.isTypeOnly) continue;
      if (next.kind === "api") {
        // An API route's default export answers every method.
        if (ts.isExportAssignment(st) && !st.isExportEquals) add("*", next.path, st, st.expression);
        if (ts.isFunctionDeclaration(st) && exported(st) && ts.getModifiers(st)!.some((m) => m.kind === ts.SyntaxKind.DefaultKeyword)) add("*", next.path, st, st);
        // `export { default } from "../server/handler"`, `export { handler as default }`.
        if (ts.isExportDeclaration(st) && st.exportClause && ts.isNamedExports(st.exportClause)) {
          for (const e of st.exportClause.elements) {
            if (e.name.text !== "default" || e.isTypeOnly) continue;
            const r = reexported(st, e);
            add("*", next.path, e, r.handler, undefined, { handlerFile: r.file });
          }
        }
        continue;
      }
      if (ts.isFunctionDeclaration(st) && exported(st) && st.name && NEXT_METHODS.has(st.name.text)) handlers.set(st.name.text, { node: st, handler: st });
      if (ts.isVariableStatement(st) && exported(st)) {
        for (const d of st.declarationList.declarations) {
          if (ts.isIdentifier(d.name) && NEXT_METHODS.has(d.name.text)) handlers.set(d.name.text, { node: d, handler: d.initializer ?? d });
        }
      }
      if (ts.isExportDeclaration(st) && st.exportClause && ts.isNamedExports(st.exportClause)) {
        for (const e of st.exportClause.elements) {
          // `export { GET } from "./handlers"` serves the other module's function; without it the route still stands.
          if (NEXT_METHODS.has(e.name.text) && !e.isTypeOnly) handlers.set(e.name.text, { node: e, ...reexported(st, e) });
        }
      }
      // `export * from "./handlers"` serves every method that module exports, followed as far as re-exports go.
      if (ts.isExportDeclaration(st) && !st.exportClause && st.moduleSpecifier && ts.isStringLiteral(st.moduleSpecifier) && reach) {
        const target = reach.resolve(file, st.moduleSpecifier.text);
        for (const method of NEXT_METHODS) {
          const found = target && !handlers.has(method) ? reach.exported(target, method) : undefined;
          if (found) handlers.set(method, { node: st, handler: found.node, file: found.file });
        }
      }
    }
    for (const [method, h] of handlers) add(method, next.path, h.node, h.handler, undefined, { handlerFile: h.file });
    // Next.js answers HEAD with the GET handler when the file exports GET and no HEAD, and OPTIONS with an Allow header
    // when it exports no OPTIONS.
    const get = handlers.get("GET");
    if (get && !handlers.has("HEAD")) add("HEAD", next.path, get.node, get.handler, undefined, { implicit: true, handlerFile: get.file });
    if (handlers.size && !handlers.has("OPTIONS")) add("OPTIONS", next.path, sf.statements[0] ?? sf, undefined, undefined, { implicit: true });
  }

  /** The router a receiver is: traced, with the package it is created from, or a name among the receivers read at the root. */
  type Instance = { router?: string; pkg?: string; name: string };
  const rootName = (e: ts.Expression): string => {
    let x = unwrap(e);
    while ((ts.isCallExpression(x) || ts.isPropertyAccessExpression(x) || ts.isElementAccessExpression(x)) && !ts.isNewExpression(x)) x = unwrap(x.expression);
    return ts.isIdentifier(x) ? x.text : x.getText(sf).replace(/\s+/g, " ");
  };
  const instanceAt = (e: ts.Expression): Instance | undefined => {
    const router = mounts?.routerOf(file, e);
    if (router) return { router, pkg: mounts!.packageOf(router), name: rootName(e) };
    const x = unwrap(e);
    return ts.isIdentifier(x) && receivers.has(x.text) ? { name: x.text } : undefined;
  };
  /**
   * The name among the receivers a chain of route methods starts from, where no router is traced: what such a chain is
   * on, and so where its routes are served, depends on the framework (Elysia's group callbacks, Hono's kept path).
   */
  const untracedChain = (e: ts.Expression): string | undefined => {
    let x = unwrap(e);
    if (!ts.isCallExpression(x)) return undefined;
    while (ts.isCallExpression(x) && ts.isPropertyAccessExpression(x.expression)) {
      const n = x.expression.name.text;
      if (n !== "use" && !HTTP_VERBS.has(n)) return undefined;
      x = unwrap(x.expression.expression);
    }
    return ts.isIdentifier(x) && receivers.has(x.text) && !mounts?.routerOf(file, x) ? x.text : undefined;
  };
  /**
   * The syntax of a router's paths: its package, at the version the package.json above where it is created gives it.
   * Ranges that differ (a plugin under two instances) admit no one major version.
   */
  const syntaxFor = (inst: Instance): Syntax => {
    const origins = inst.router ? mounts!.originsOf(inst.router) : [];
    const given = inst.pkg === undefined ? [] : (origins.length ? origins : [file]).flatMap((f) => ranges?.(f, inst.pkg!) ?? []);
    return syntaxOf(inst.pkg, given.length ? [...new Set(given)].join(" || ") : undefined);
  };
  const at0 = (node: ts.Node) => at(node).line;
  const hono = (inst: Instance) => inst.pkg === "hono" || !!inst.pkg?.startsWith("hono/");
  const koa = (inst: Instance) => inst.pkg === "@koa/router" || inst.pkg === "koa-router";
  /** The prefixes a path not read would have been served under, for `unread`. */
  const prefixesOf = (inst: Instance): string[] | undefined => (inst.router ? mounts!.prefixes(inst.router) : [""]);
  /** The prefixes a router's routes are served under: none known for a router mounted where the code does not say. */
  const servedUnder = (inst: Instance): string[] | undefined => {
    if (!inst.router) return [""];
    const prefixes = mounts!.prefixes(inst.router);
    if (!prefixes) unmounted.set(inst.name, mounts!.why(inst.router) ?? "is mounted where the code gives no literal path");
    return prefixes;
  };
  /**
   * A route a registration on `inst` makes. A path must start with `/`, except on Hono, which joins one that does not
   * (`*`, `users`) to the base path as if it did (`mergePath`); an empty one it joins with a trailing `/`, not read.
   */
  const register = (inst: Instance, method: string, path: string, node: ts.CallExpression) => {
    // A route is placed where its method is named, which in a chain is not where the chain starts.
    const place = ts.isPropertyAccessExpression(node.expression) ? node.expression.name : node;
    if (!path.startsWith("/") && (!hono(inst) || path === "")) {
      limits?.push(`routes ${spec.component}: ${file}:${at0(place)} registers ${JSON.stringify(path)} on ${inst.name}, a path that does not start with \`/\`; its routes are not read`);
      return;
    }
    const verb = method === "all" ? "*" : method === "del" ? "delete" : method;
    const syntax = syntaxFor(inst);
    for (const p of servedUnder(inst) ?? []) add(verb, joinRoute(p, path.startsWith("/") ? path : `/${path}`), place, node, undefined, { syntax });
  };
  /**
   * The literal paths an argument gives: a string, or an array of strings on the routers that take one (Express's
   * `Layer` and @koa/router's `register`); undefined where it gives none the file spells out, said in `limits`.
   */
  const pathsAt = (arg: ts.Expression, inst: Instance, method: string): string[] | undefined => {
    const u = unwrap(arg);
    const one = stringValue(u);
    if (one !== undefined) {
      span(arg);
      return [one];
    }
    if (ts.isArrayLiteralExpression(u)) {
      const all = u.elements.map(literalText);
      if (inst.pkg !== "express" && !koa(inst)) {
        limits?.push(
          `routes ${spec.component}: ${file}:${at0(arg)} registers an array of paths (${arg.getText(sf).replace(/\s+/g, " ")}) on ${inst.name}, which atlas reads only on a router traced to Express or @koa/router; its routes are not read`,
        );
        return undefined;
      }
      if (all.length && all.every((p) => p !== undefined)) {
        span(arg);
        return all;
      }
    }
    unread(arg, method === "all" ? "*" : method, prefixesOf(inst));
    return undefined;
  };
  /** Whether an argument is a function: written in place, or a name the file binds to one. */
  const handlerAt = (e: ts.Expression): boolean => {
    const u = unwrap(e);
    if (ts.isArrowFunction(u) || ts.isFunctionExpression(u)) return true;
    const decl = ts.isIdentifier(u) ? declarationOf(u) : undefined;
    if (decl && ts.isFunctionDeclaration(decl)) return true;
    const init = decl && ts.isVariableDeclaration(decl) && decl.parent.flags & ts.NodeFlags.Const && decl.initializer ? unwrap(decl.initializer) : undefined;
    return !!init && (ts.isArrowFunction(init) || ts.isFunctionExpression(init));
  };
  /** Hono's path a registration with none of its own takes: the one the last call on the instance set (`#path`). */
  const honoPath = (e: ts.Expression): string | undefined => {
    let x = unwrap(e);
    for (;;) {
      // A new instance, or the copy `basePath` makes, starts at `/`.
      if (ts.isNewExpression(x)) return "/";
      if (!ts.isCallExpression(x) || !ts.isPropertyAccessExpression(x.expression)) return undefined;
      const n = x.expression.name.text;
      const first = x.arguments[0] && unwrap(x.arguments[0]);
      if (n === "basePath") return "/";
      if (verbsOf("hono").has(n)) {
        if (first && ts.isStringLiteralLike(first)) return first.text;
        if (!first || !handlerAt(first)) return undefined;
      } else if (n === "on") {
        const p = x.arguments[1] && unwrap(x.arguments[1]);
        const last = p && ts.isArrayLiteralExpression(p) ? p.elements[p.elements.length - 1] : p;
        return last && ts.isStringLiteralLike(last) ? last.text : undefined;
      } else if (n === "use") {
        if (first && ts.isStringLiteralLike(first)) return first.text;
        return first && handlerAt(first) ? "*" : undefined;
      } else if (!["route", "onError", "notFound", "mount"].includes(n)) return undefined;
      x = unwrap(x.expression.expression);
    }
  };
  /** The `route(path)` call an Express route's chain starts from: `app.route("/book").get(h).post(h)`. */
  const expressRoute = (e: ts.Expression): ts.CallExpression | undefined => {
    let x = unwrap(e);
    while (ts.isCallExpression(x) && ts.isPropertyAccessExpression(x.expression)) {
      const n = x.expression.name.text;
      if (n === "route" && x.arguments.length === 1 && !ts.isObjectLiteralExpression(unwrap(x.arguments[0]!))) return x;
      if (!verbsOf("express").has(n)) return undefined;
      x = unwrap(x.expression.expression);
    }
    return undefined;
  };
  /** A string a method argument names, literal, or each of an array of them; undefined where one is not spelled out. */
  const methodsAt = (arg: ts.Expression | undefined): string[] | undefined => {
    const u = arg && unwrap(arg);
    if (!u) return undefined;
    if (ts.isStringLiteralLike(u)) return [u.text];
    if (!ts.isArrayLiteralExpression(u) || !u.elements.length) return undefined;
    const all = u.elements.map(literalText);
    return all.every((m) => m !== undefined) ? all : undefined;
  };
  const express = (inst: Instance) => inst.pkg === undefined || inst.pkg === "express";

  /** The routes a call of the express style registers: a method's, `route(path)`'s, Fastify's `route`, Hono's `on`, @koa/router's `redirect`. */
  const expressRoutes = (node: ts.CallExpression): void => {
    const callee = node.expression;
    if (!ts.isPropertyAccessExpression(callee)) return;
    const name = callee.name.text;
    if (!REGISTERING.has(name)) return;
    const args = node.arguments;
    const said = (what: string) => limits?.push(`routes ${spec.component}: ${file}:${at0(callee.name)} ${what}`);
    // Express's `route(path)` returns a route whose methods take only handlers (router 2 `Route`).
    const route = expressRoute(callee.expression);
    if (route) {
      const inst = instanceAt((route.expression as ts.PropertyAccessExpression).expression);
      if (!inst || !express(inst) || !verbsOf("express").has(name) || !args.length) return;
      for (const path of pathsAt(route.arguments[0]!, inst, name) ?? []) register(inst, name, path, node);
      return;
    }
    const inst = instanceAt(callee.expression);
    if (!inst) {
      const chained = HTTP_VERBS.has(name) && args.length > 1 ? untracedChain(callee.expression) : undefined;
      if (chained) said(`registers a route chained on ${chained}, which atlas does not trace to Express, @koa/router, Fastify or Hono; its route is not read`);
      return;
    }
    const verbs = inst.pkg === undefined ? HTTP_VERBS : verbsOf(inst.pkg);
    if (verbs.has(name)) {
      if (hono(inst)) {
        // Hono's method takes a path, which it keeps for the next registration, or a handler for the path kept.
        const first = args[0] && unwrap(args[0]);
        if (!first) return;
        if (ts.isStringLiteralLike(first)) {
          span(first);
          if (args.length > 1) register(inst, name, first.text, node);
        } else if (handlerAt(first)) {
          const path = honoPath(callee.expression);
          if (path !== undefined) register(inst, name, path, node);
          else said(`registers ${name.toUpperCase()} on ${inst.name} with no path, at the one the last registration on it set; its route is not read`);
        } else if (args.length > 1 || !ts.isIdentifier(first)) unread(first, name === "all" ? "*" : name, prefixesOf(inst));
        else said(`registers ${name.toUpperCase()} on ${inst.name} with ${first.text}, a path or a handler the file does not settle; its route is not read`);
        return;
      }
      // A route takes a path and a handler; with one argument Express's `get(name)` reads a setting.
      if (args.length < 2) return;
      // @koa/router takes a name before the path where the second argument is a string or a RegExp (`_registerMethod`).
      const second = unwrap(args[1]!);
      const named = koa(inst) && (ts.isStringLiteralLike(second) || ts.isTemplateExpression(second) || ts.isRegularExpressionLiteral(second));
      if (named && args.length < 3) return;
      for (const path of pathsAt(args[named ? 1 : 0]!, inst, name) ?? []) register(inst, name, path, node);
      return;
    }
    // Fastify's full declaration, `route({ method, url, handler })`: `url`, else `path` (lib/route.js), each method of a list.
    if (name === "route" && args.length === 1 && ts.isObjectLiteralExpression(unwrap(args[0]!)) && (inst.pkg === undefined || inst.pkg === "fastify")) {
      const options = unwrap(args[0]!) as ts.ObjectLiteralExpression;
      const given = new Map<string, ts.Expression>();
      for (const p of options.properties) {
        const key = ts.isSpreadAssignment(p) ? undefined : literalKey(p.name);
        if (key === undefined) {
          said(`declares a route with options the file does not spell out (${p.getText(sf).replace(/\s+/g, " ")}); its routes are not read`);
          return;
        }
        if (ts.isPropertyAssignment(p)) given.set(key, p.initializer);
        else if (ts.isShorthandPropertyAssignment(p)) given.set(key, p.name);
        else given.set(key, p as unknown as ts.Expression);
      }
      const methods = methodsAt(given.get("method"));
      const url = given.get("url") && stringValue(unwrap(given.get("url")!));
      const path = given.get("path") && stringValue(unwrap(given.get("path")!));
      const unknown = (given.has("url") && url === undefined) || (!url && given.has("path") && path === undefined);
      if (!methods) said(`declares a route with a method the file does not spell out (${given.get("method")?.getText(sf).replace(/\s+/g, " ") ?? "none"}); its routes are not read`);
      if (unknown) unread(given.get(url === undefined && given.has("url") ? "url" : "path")!, methods?.length === 1 ? methods[0] : undefined, prefixesOf(inst));
      if (!methods || unknown) return;
      const written = url || path || "";
      for (const k of ["url", "path"]) if (given.has(k)) span(given.get(k));
      for (const m of methods) register(inst, m.toLowerCase(), written, node);
      return;
    }
    // Hono's `on(method or [methods], path or [paths], ...handlers)`: each method at each path (hono-base.js).
    if (name === "on" && hono(inst)) {
      if (args.length < 3) return;
      const methods = methodsAt(args[0]);
      const p = unwrap(args[1]!);
      const paths = ts.isArrayLiteralExpression(p) ? p.elements.map(literalText) : [literalText(p)];
      if (!methods) said(`registers a method the file does not spell out (${args[0]!.getText(sf).replace(/\s+/g, " ")}) on ${inst.name}; its routes are not read`);
      if (paths.some((x) => x === undefined) || !paths.length) unread(args[1]!, methods?.length === 1 ? methods[0] : undefined, prefixesOf(inst));
      if (!methods || paths.some((x) => x === undefined) || !paths.length) return;
      span(args[1]);
      for (const path of paths as string[]) for (const m of methods) register(inst, m.toUpperCase() === "ALL" ? "all" : m.toLowerCase(), path, node);
      return;
    }
    // @koa/router's `redirect(source, destination)` registers `all` at the source; a source that is no path names a route.
    if (name === "redirect" && koa(inst) && args.length >= 2) {
      const source = unwrap(args[0]!);
      if (ts.isStringLiteralLike(source) && source.text.startsWith("/")) {
        span(source);
        register(inst, "all", source.text, node);
      } else if (ts.isStringLiteralLike(source)) said(`redirects from the route named ${JSON.stringify(source.text)} on ${inst.name}, at the path @koa/router builds from it; its route is not read`);
      else unread(source, "*", prefixesOf(inst));
    }
  };

  const visit = (node: ts.Node): void => {
    if (styles.has("nest") && ts.isClassDeclaration(node)) {
      let bases: string[] | undefined;
      /** The controller's version: none given, the versions it states, or null where it is not spelled out. */
      let version: string[] | undefined | null;
      for (const d of decorators(node)) {
        const call = decoratorCall(d);
        if (call?.name === "Controller") {
          bases = decoratorPaths(call.args);
          if (!bases) unread(call.args[0]!);
          for (const a of call.args) span(a);
          const options = call.args[0] && ts.isObjectLiteralExpression(call.args[0]) ? call.args[0] : undefined;
          // `version: '2'` or `{ version }`; a spread or an accessor may give one the file does not spell out.
          const given = options ? property(options, "version") : undefined;
          version = given === undefined || !versioned ? undefined : given ? (versionsOf(given) ?? null) : null;
          if (version === null) unreadVersion(given ?? options!);
        }
      }
      // The paths RouterModule puts before the controller's, from the module that holds it; none read, no route is.
      const routed = node.name ? nest.modules?.get(`${file}#${node.name.text}`) : undefined;
      if (bases !== undefined && routed !== null) {
        const className = node.name?.text;
        for (const member of node.members) {
          const explicit = decorators(member)
            .map(decoratorCall)
            .find((c) => c?.name === "ApiOperation");
          const methodName = ts.isMethodDeclaration(member) && ts.isIdentifier(member.name) ? member.name.text : undefined;
          const operationId =
            operationIdIn(explicit?.args ?? []) ??
            (spec.operationIds === "nest-swagger" && className && methodName ? `${className}_${methodName}` : undefined);
          // `@Version()` on the method takes the place of the controller's.
          const own = decorators(member)
            .map(decoratorCall)
            .find((c) => c?.name === "Version");
          const versions = !versioned ? undefined : own?.args[0] ? (versionsOf(own.args[0]) ?? null) : own ? null : version;
          if (own && versions === null) unreadVersion(own.args[0] ?? member);
          for (const d of decorators(member)) {
            const call = decoratorCall(d);
            const method = call ? NEST_METHODS[call.name] : undefined;
            const paths = call && method ? decoratorPaths(call.args) : undefined;
            if (call && method && !paths) unread(call.args[0]!, method, bases);
            if (!paths) continue;
            for (const a of call!.args) span(a);
            if (versions === null) continue;
            for (const module of routed ?? [""]) {
              for (const base of bases) {
                for (const path of paths) {
                  for (const served of nestPaths(nest, method!, joinRoute(module, base, path), versions) ?? []) add(method!, served, member, member, operationId, { served: true, syntax: nestSyntax((pkg) => ranges?.(spec.bootstrap ?? file, pkg)) });
                }
              }
            }
          }
        }
      }
    }
    if (ts.isCallExpression(node)) {
      const name = calleeName(node.expression);
      if (styles.has("express")) expressRoutes(node);
      for (const c of spec.calls ?? []) {
        if (name !== c.name) continue;
        const method = c.method ?? stringValue(node.arguments[c.methodArg]);
        const arg = node.arguments[c.pathArg];
        const path = stringValue(arg);
        if (arg && path === undefined) unread(arg, method, [""]);
        if (method && path?.startsWith("/")) {
          span(node.arguments[c.pathArg]);
          add(method, path, node, node, operationIdIn(node.arguments));
        }
      }
    }
    if (constPattern && ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && constPattern.test(node.name.text)) {
      const path = stringValue(node.initializer);
      if (path?.startsWith("/")) {
        span(node.initializer);
        add("GET", path, node);
        readConstants.set(node, path);
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  // A GET registration at the very path of a constant read as a route above is that route; any other, another method
  // or a prefix included, is said in `limits`.
  for (const { arg, method, prefixes } of unreadPaths) {
    const inner = ts.isTemplateExpression(arg) && !arg.head.text && arg.templateSpans.length === 1 && !arg.templateSpans[0]!.literal.text ? arg.templateSpans[0]!.expression : arg;
    const declaration = ts.isIdentifier(inner) ? declarationOf(inner) : undefined;
    const value = declaration && readConstants.get(declaration);
    const route = (p: string) => routeTemplate(joinRoute(p));
    if (value && method?.toUpperCase() === "GET" && prefixes?.length && prefixes.every((p) => route(joinRoute(p, value)) === route(value))) continue;
    limits?.push(`routes ${spec.component}: ${file}:${at(arg).line} registers a path the file does not spell out (${arg.getText(sf).replace(/\s+/g, " ")}); its routes are not read`);
  }
  for (const [name, why] of unmounted) {
    limits?.push(`routes ${spec.component}: router ${name} in ${file} ${why}; its routes are not read (declare it in mounts)`);
  }
  // express.static answers with the files of a directory, and passes on what it does not hold: what it serves is the
  // directory's content, not the code's.
  for (const { line, paths } of mounts?.statics(file) ?? []) {
    limits?.push(`routes ${spec.component}: ${file}:${line} serves the files of a directory at ${paths?.join(", ") ?? "a path the code does not spell out"} (express.static); their paths are not read`);
  }
  return out;
}

const FASTAPI = /^[ \t]*@(\w+)\.(get|post|put|patch|delete|head|options|api_route)\(\s*/gm;
const PY_STRING = /^(?:[rRbBuUfF]{0,2})("""|'''|"|')/;

/**
 * Python source with every comment and the contents of every string literal blanked (newlines kept), so text that
 * only looks like code there is not read as code. Offsets are unchanged.
 */
export function pythonCode(text: string): string {
  const out = text.split("");
  let i = 0;
  while (i < text.length) {
    const c = text[i]!;
    if (c === "#") {
      while (i < text.length && text[i] !== "\n") out[i++] = " ";
      continue;
    }
    const m = /[A-Za-z_]/.test(text[i - 1] ?? "") ? null : PY_STRING.exec(text.slice(i, i + 5));
    if (m) {
      const quote = m[1]!;
      let j = i + m[0].length;
      while (j < text.length && !text.startsWith(quote, j)) {
        if (text[j] === "\\") j++;
        else if (quote.length === 1 && text[j] === "\n") break;
        j++;
      }
      for (let k = i + m[0].length; k < Math.min(j, text.length); k++) if (out[k] !== "\n") out[k] = " ";
      i = j + quote.length;
      continue;
    }
    i++;
  }
  return out.join("");
}

/** The index of the `)` that closes the `(` before `from`, in code whose strings and comments are blanked. */
export function closingParen(code: string, from: number): number {
  let depth = 1;
  for (let i = from; i < code.length; i++) {
    if ("([{".includes(code[i]!)) depth++;
    else if (")]}".includes(code[i]!) && --depth === 0) return i;
  }
  return code.length;
}

/**
 * The methods a FastAPI `api_route` or `add_api_route` serves: GET when `methods` is not given or None (`APIRoute`), the
 * listed ones when it is a literal list, tuple or set of strings; undefined when the list is built at run time, so no
 * route is guessed.
 */
function apiRouteMethods(text: string, code: string, argsStart: number): string[] | undefined {
  const end = closingParen(code, argsStart);
  const m = /\bmethods\s*=\s*/.exec(code.slice(argsStart, end));
  if (!m) return ["GET"];
  const valueStart = argsStart + m.index + m[0].length;
  if (/^None\b/.test(code.slice(valueStart))) return ["GET"];
  const open = code[valueStart];
  if (!open || !"[({".includes(open)) return undefined;
  const close = closingParen(code, valueStart + 1);
  const items = text.slice(valueStart + 1, close).split(",").map((x) => x.trim()).filter(Boolean);
  const methods = items.map((x) => /^[rRuU]?(["'])([A-Za-z]+)\1$/.exec(x)?.[2]?.toUpperCase());
  return methods.length && methods.every(Boolean) ? [...new Set(methods as string[])] : undefined;
}

/** A plain, raw or unicode literal at the start of `text`; an f-string or a name is a path the file does not spell out. */
const PY_ESCAPES: Record<string, string> = { n: "\n", t: "\t", r: "\r", "\\": "\\", "'": "'", '"': '"', a: "\x07", b: "\b", f: "\f", v: "\v", "0": "\0" };

/**
 * A plain, raw or unicode Python string literal at the start of `text`: its value, escapes decoded as Python does
 * (a raw literal keeps its backslashes), and its length in the text. An f-string or a name is a path the file does not
 * spell out: undefined.
 */
function pythonString(text: string): { value: string; length: number } | undefined {
  const m = /^([rRuU]?)("""|'''|"|')/.exec(text);
  if (!m) return undefined;
  const raw = /[rR]/.test(m[1]!);
  const quote = m[2]!;
  let value = "";
  for (let i = m[0].length; i < text.length; ) {
    if (text.startsWith(quote, i)) return { value, length: i + quote.length };
    const c = text[i]!;
    if (quote.length === 1 && c === "\n") return undefined;
    if (c !== "\\" || i + 1 >= text.length) {
      value += c;
      i++;
      continue;
    }
    const next = text[i + 1]!;
    // A backslash keeps a quote from ending the literal, in a raw one too, where both characters stay.
    if (raw) value += c + next;
    // A backslash before a line break joins the lines: `\` with LF, CRLF or CR adds nothing.
    else if (next === "\n") value += "";
    else if (next === "\r") {
      if (text[i + 2] === "\n") i++;
    }
    // `\N{name}` names a character by its Unicode name, which this reading has no table of: the value is unknown.
    else if (next === "N" && text[i + 2] === "{") return undefined;
    else if (next === "x" && /^[0-9a-fA-F]{2}$/.test(text.slice(i + 2, i + 4))) {
      value += String.fromCharCode(parseInt(text.slice(i + 2, i + 4), 16));
      i += 2;
    } else if (next === "u" && /^[0-9a-fA-F]{4}$/.test(text.slice(i + 2, i + 6))) {
      value += String.fromCharCode(parseInt(text.slice(i + 2, i + 6), 16));
      i += 4;
    } else if (next === "U" && /^[0-9a-fA-F]{8}$/.test(text.slice(i + 2, i + 10)) && parseInt(text.slice(i + 2, i + 10), 16) <= 0x10ffff) {
      value += String.fromCodePoint(parseInt(text.slice(i + 2, i + 10), 16));
      i += 8;
    } else if (/[0-7]/.test(next)) {
      // Up to three octal digits: `\057` is `/`, `\0` NUL.
      const digits = /^[0-7]{1,3}/.exec(text.slice(i + 1))![0];
      value += String.fromCharCode(parseInt(digits, 8));
      i += digits.length - 1;
    } else value += PY_ESCAPES[next] ?? c + next;
    i += 2;
  }
  return undefined;
}

/**
 * A string literal and those written next to it, which Python joins into one (`"/api" "/users"`), across lines inside the
 * brackets of a call; undefined when one of them is not a plain literal (an f-string, a name).
 */
export function pythonStrings(text: string): { value: string; length: number } | undefined {
  const first = pythonString(text);
  if (!first) return undefined;
  let { value, length } = first;
  for (;;) {
    // Spaces, line breaks and comments may stand between them inside the call's brackets.
    const gap = /^(?:\s|#[^\n]*)*/.exec(text.slice(length))![0];
    const rest = text.slice(length + gap.length);
    if (!/^[rRuUfFbB]{0,2}["']/.test(rest)) return { value, length };
    const next = pythonString(rest);
    if (!next) return undefined;
    value += next.value;
    length += gap.length + next.length;
  }
}

const pythonLiteral = (text: string): string | undefined => pythonStrings(text)?.value || undefined;
const pythonLiteralLength = (text: string): number | undefined => pythonStrings(text)?.length;

/**
 * A Starlette path in atlas's form: a converter is kept as written, since `{name:path}` takes the rest of the path after
 * the `/` before it, which neither Spring's `{*name}` nor `**` requires, and `int`, `float` and `uuid` take only the
 * segments their regex does. `{name:str}` is `{name}`, the convertor Starlette applies when none is named.
 */
const starlettePath = (path: string): string => joinRoute(path.replace(/\{(\w+):str\}/g, "{$1}"));

/** The start of each top-level argument of the call whose arguments begin at `from`, in blanked code. */
export function pythonArgStarts(code: string, from: number): number[] {
  const end = closingParen(code, from);
  const starts = [from];
  let depth = 0;
  for (let i = from; i < end; i++) {
    const c = code[i]!;
    if ("([{".includes(c)) depth++;
    else if (")]}".includes(c)) depth--;
    else if (c === "," && depth === 0) starts.push(i + 1);
  }
  return starts.map((s) => s + (/^\s*/.exec(code.slice(s))?.[0].length ?? 0));
}

/** Whether the name at `at` follows `def`, across any spaces and line continuations: a function's definition. */
function definesName(code: string, at: number): boolean {
  let i = at;
  while (i > 0 && /[\s\\]/.test(code[i - 1]!)) i--;
  return i < at && i >= 3 && code.slice(i - 3, i) === "def" && !/\w/.test(code[i - 4] ?? "");
}

/** The text of the argument starting at `at`, up to the comma or bracket that ends it, in blanked code. */
export function pythonArg(text: string, code: string, at: number): string {
  let depth = 0;
  let end = at;
  for (; end < code.length; end++) {
    const c = code[end]!;
    if ("([{".includes(c)) depth++;
    else if (")]}".includes(c) && depth-- === 0) break;
    else if (c === "," && depth === 0) break;
  }
  return text.slice(at, end).trim();
}

/**
 * `routers` tells where the FastAPI routers of the route files are served; without it, only this file's are known, and
 * why one is not read is said in `limits` here rather than once for every file.
 */
export function routesFromPython(file: string, text: string, spec: RouteSource, limits?: string[], spans?: Spans, routers?: Routers): Surface[] {
  // Styles left out, as a direct call does, read FastAPI; the scan always passes the configured ones.
  const fastapi = !spec.styles || spec.styles.includes("fastapi");
  const own = routers || !fastapi ? undefined : fastapiRouters(new Map([[file, text]]), spec.mounts);
  const out: Surface[] = [];
  /** Receivers whose decorators register routes but which no binding of the files read makes an application or router. */
  const untraced = new Set<string>();
  const receivers = new Set(spec.receivers ?? ["app", "router"]);
  const code = pythonCode(text);
  /** A registration whose path argument is a name, an f-string or an expression: said in `limits`. */
  const unread = (at: number) => {
    const arg = pythonArg(text, code, at);
    if (arg && pythonStrings(text.slice(at)) === undefined) {
      limits?.push(`routes ${spec.component}: ${file}:${lineOf(text, at)} registers a path the file does not spell out (${arg.replace(/\s+/g, " ")}); its routes are not read`);
    }
  };
  const add = (verb: string, raw: string, at: number, implicit = false) => {
    // A `path` converter takes the rest of the path only at its end; one before a suffix is a match atlas does not do.
    if (/\{\w+:path\}./.test(raw)) {
      limits?.push(`routes ${spec.component}: ${file}:${lineOf(text, at)} has a path converter before the end of ${raw}; the route is not read`);
      return;
    }
    const method = verb.toUpperCase();
    const path = starlettePath(spec.prefix ? joinRoute(spec.prefix, raw) : raw);
    out.push({
      id: surfaceId({ component: spec.component, method, path }),
      component: spec.component,
      method,
      path,
      at: { file, line: lineOf(text, at) },
      evidence: "text",
      ...(implicit ? { implicit: true } : {}),
    });
  };
  // A name traced to an application or router of the files read registers routes whatever it is called (`subapi`).
  const traced = (name: string, at: number) => (routers ?? own!).receiver(file, name, at);
  // The decorators, and `add_api_route(path, endpoint, methods=...)`, which they call (fastapi/routing.py `APIRouter`).
  const registrations = fastapi ? [...code.matchAll(FASTAPI), ...code.matchAll(/\b(\w+)\.(add_api_route)\(\s*/g)].sort((a, b) => (a.index ?? 0) - (b.index ?? 0)) : [];
  for (const m of registrations) {
    if (!receivers.has(m[1]!) && !traced(m[1]!, m.index ?? 0)) continue;
    const argsStart = (m.index ?? 0) + m[0].length;
    // The path is the first argument, or the one named `path` (`@app.get(path="/items")`).
    const first = /^[A-Za-z_]\w*\s*=(?!=)/.test(code.slice(argsStart)) ? undefined : argsStart;
    const named = pythonArgStarts(code, argsStart)
      .map((at) => ({ at, m: /^path\s*=\s*/.exec(code.slice(at)) }))
      .find((a) => a.m);
    const pathAt = named ? named.at + named.m![0].length : first;
    if (pathAt !== undefined) unread(pathAt);
    const path = pathAt === undefined ? undefined : pythonStrings(text.slice(pathAt))?.value;
    if (path === undefined) continue;
    // An application serves at the root; a router under every prefix it is served at, or not at all where one is unknown.
    const key = (routers ?? own!).receiver(file, m[1]!, m.index ?? 0);
    const prefixes = key ? (routers ?? own!).served(key) : [""];
    // An empty path is the router's prefix itself; with no prefix FastAPI refuses it.
    if (!prefixes || (!path && prefixes.every((p) => joinRoute(p) === "/"))) continue;
    spans?.add(file, argsStart, closingParen(code, argsStart));
    const methods = m[2] === "api_route" || m[2] === "add_api_route" ? apiRouteMethods(text, code, argsStart) : [m[2]!.toUpperCase()];
    if (!methods) limits?.push(`routes ${spec.component}: ${file}:${lineOf(text, m.index ?? 0)} registers ${path} with methods the file does not spell out; its routes are not read`);
    const before = out.length;
    for (const prefix of prefixes) for (const method of methods ?? []) add(method, joinRoute(prefix, path), m.index ?? 0);
    if (!key && out.length > before) untraced.add(m[1]!);
  }
  // Starlette's mount hands everything under its path to the mounted application, compiled as the path with
  // `/{path:path}` joined. StaticFiles answers GET and HEAD, under every prefix the receiver is served at; what another
  // application serves is not read here.
  for (const m of fastapi ? code.matchAll(/\b(\w+)\.mount\(\s*/g) : []) {
    if (!receivers.has(m[1]!) && !traced(m[1]!, m.index ?? 0)) continue;
    const argsStart = (m.index ?? 0) + m[0].length;
    // `mount("/x", app)` or by name, `mount(path="/x", app=...)`.
    const all = pythonArgStarts(code, argsStart);
    const keyword = (name: string) => all.map((at) => ({ at, m: new RegExp(`^${name}\\s*=\\s*`).exec(code.slice(at)) })).find((a) => a.m);
    const positional = all.filter((a) => !/^\w+\s*=(?!=)/.test(code.slice(a)));
    const named = keyword("path");
    const pathAt = named ? named.at + named.m![0].length : positional[0];
    if (pathAt === undefined) continue;
    const path = pythonLiteral(text.slice(pathAt));
    if (!path?.startsWith("/")) continue;
    spans?.add(file, pathAt, pathAt + (pythonLiteralLength(text.slice(pathAt)) ?? 0));
    const app = keyword("app");
    const mounted = app ? app.at : positional.find((a) => a !== pathAt);
    if (mounted !== undefined && /^(?:app\s*=\s*)?(?:[\w.]+\.)?StaticFiles\s*\(/.test(code.slice(mounted))) {
      const key = (routers ?? own!).receiver(file, m[1]!, m.index ?? 0);
      if (!key) untraced.add(m[1]!);
      for (const prefix of (key ? (routers ?? own!).served(key) : [""]) ?? []) {
        add("GET", joinRoute(prefix, path, "{path:path}"), m.index ?? 0);
        add("HEAD", joinRoute(prefix, path, "{path:path}"), m.index ?? 0, true);
      }
    } else if (mounted === undefined || !(routers ?? own!).traced(file, pythonArg(text, code, mounted).replace(/^app\s*=\s*/, ""), m.index ?? 0)) {
      // An application or router of the route files that it mounts is served under the mount with the routes read there.
      limits?.push(`routes ${spec.component}: ${file}:${lineOf(text, m.index ?? 0)} mounts an application at ${path} whose routes are not read`);
    }
  }
  // `frontend` serves the files built into a directory where no route matches, and a fallback page for GET and HEAD
  // (fastapi.tiangolo.com/tutorial/frontend): which paths answer depends on the build, not on the code.
  for (const m of fastapi ? code.matchAll(/\b(\w+)\.frontend\(\s*/g) : []) {
    if (!receivers.has(m[1]!)) continue;
    const argsStart = (m.index ?? 0) + m[0].length;
    const all = pythonArgStarts(code, argsStart);
    const named = all.map((at) => ({ at, m: /^path\s*=\s*/.exec(code.slice(at)) })).find((a) => a.m);
    const pathAt = named ? named.at + named.m![0].length : all.find((a) => !/^\w+\s*=(?!=)/.test(code.slice(a)));
    const path = pathAt === undefined ? undefined : pythonLiteral(text.slice(pathAt));
    limits?.push(
      `routes ${spec.component}: ${file}:${lineOf(text, m.index ?? 0)} serves a frontend's files at ${path ?? "a path the file does not spell out"} (${m[1]}.frontend), with a fallback page for GET and HEAD where no route matches; their paths are not read`,
    );
  }
  for (const name of untraced) {
    limits?.push(`routes ${spec.component}: ${file} registers routes on ${name}, which atlas does not trace to a FastAPI application or APIRouter of the route files; they are read at the paths written`);
  }
  for (const c of spec.calls ?? []) {
    for (const m of code.matchAll(new RegExp(`(?<![\\w.])(?:\\w+\\.)?${escapeRegExp(c.name)}\\(`, "g"))) {
      // The helper's own definition takes its path as a parameter; it registers nothing.
      if (definesName(code, m.index ?? 0)) continue;
      const args = pythonArgStarts(code, (m.index ?? 0) + m[0].length);
      if (args[c.pathArg] !== undefined) unread(args[c.pathArg]!);
      const path = args[c.pathArg] === undefined ? undefined : pythonLiteral(text.slice(args[c.pathArg]));
      const method = c.method ?? (args[c.methodArg] === undefined ? undefined : pythonLiteral(text.slice(args[c.methodArg]))?.toUpperCase());
      if (path?.startsWith("/") && method) {
        spans?.add(file, args[c.pathArg]!, args[c.pathArg]! + (pythonLiteralLength(text.slice(args[c.pathArg])) ?? 0));
        add(method, path, m.index ?? 0);
      }
    }
  }
  if (own) limits?.push(...own.limits(spec.component));
  return out;
}

/** The text before a quoted value that declares it an operationId: `operationId: `, `operation_id=`, `"operationId": `. */
const DECLARES_ID = /["']?\b(?:operationId|operation_id)["']?\s*[:=]\s*$/;

/**
 * Where code declares an operationId as a quoted value: a route option, a decorator argument or an annotation
 * attribute (`operation_id="x"`, `{ operationId: "x" }`, `@Operation(operationId = "x")`). The same text elsewhere, in a
 * log line or a lookup, declares nothing.
 */
function literalLines(texts: Map<string, string>, id: string): Found[] {
  const quoted = new RegExp(`(["'\`])${escapeRegExp(id)}\\1`, "g");
  const out: Found[] = [];
  for (const [file, text] of texts) {
    for (const m of text.matchAll(quoted)) {
      const at = m.index ?? 0;
      if (DECLARES_ID.test(text.slice(text.lastIndexOf("\n", at - 1) + 1, at))) out.push({ file, line: lineOf(text, at), offset: at });
    }
  }
  return out;
}

/** A place in a file, with the character offset of what was found there. */
type Found = Surface["at"] & { offset: number };

/** The offset of a definition of `name` on a line: where the name stands before its parameters. */
function definitionOffset(text: string, line: number, name: string): number {
  let start = 0;
  for (let i = 1; i < line; i++) start = text.indexOf("\n", start) + 1;
  const end = text.indexOf("\n", start);
  const at = text.slice(start, end === -1 ? undefined : end).search(new RegExp(`(?<![\\w$])${escapeRegExp(name)}\\s*[(<]`));
  return start + Math.max(at, 0);
}

/**
 * The TypeScript or JavaScript handler an offset points at. Walking out from it: a function whose header (decorators and
 * signature, before the body) holds it is the handler; a call whose arguments hold it, such as
 * `app.get(path, { operationId }, handler)`, gives its last function argument. Reaching a function's body first means
 * the text sits inside code, which names no handler, even on the header's line.
 */
function handlerNode(reach: Reach, at: Found): ts.Node | undefined {
  if (!/\.(c|m)?[jt]sx?$/.test(at.file)) return undefined;
  const sf = reach.parse(at.file)?.sf;
  if (!sf) return undefined;
  const chain: ts.Node[] = [];
  const descend = (n: ts.Node): void => {
    chain.push(n);
    const child = n.getChildren(sf).find((c) => c.getStart(sf) <= at.offset && at.offset < c.getEnd());
    if (child) descend(child);
  };
  descend(sf);
  for (const n of chain.reverse()) {
    if (ts.isFunctionLike(n) && "body" in n && n.body) {
      if (at.offset < (n.body as ts.Node).getStart(sf)) return n;
      return undefined;
    }
    if (ts.isCallExpression(n) && n.arguments.some((a) => a.getStart(sf) <= at.offset && at.offset < a.getEnd())) {
      const handler = [...n.arguments].reverse().find((a) => ts.isFunctionLike(a));
      if (handler) return handler;
    }
  }
  return undefined;
}

/** Where the code defines an operation's handler: one definition by a derived name, else one quoted explicit id. */
function handlerPlace(
  texts: Map<string, string>,
  operationId: string,
  method: string,
  key: string,
  parsed: Map<string, Map<string, Definition[]>>,
): { at: Found; evidence: Surface["evidence"] } | undefined {
  const hits: Found[] = [];
  for (const name of handlerNames(operationId, method, key)) {
    for (const [f, t] of texts)
      for (const { line, offset } of definitions(f, t, name, parsed)) hits.push({ file: f, line, offset: offset ?? definitionOffset(t, line, name) });
    if (hits.length) break;
  }
  if (hits.length === 1) return { at: hits[0]!, evidence: "name" };
  const quoted = literalLines(texts, operationId);
  return quoted.length === 1 ? { at: quoted[0]!, evidence: "text" } : undefined;
}

/**
 * Surfaces from a component's OpenAPI document. An operation the code also registers keeps the code's location and
 * gains the document's operationId and place; the others are new surfaces, placed on their handler when the code gives
 * it away. `code` holds every route read so far, of every component.
 */
function documentedSurfaces(
  source: Source,
  spec: RouteSource,
  texts: Map<string, string>,
  code: Surface[],
  limits: string[],
  reach?: Reach,
  executed?: Map<string, Set<string>>,
): Surface[] {
  const file = spec.openapi!;
  let text: string | undefined;
  if (isAbsolute(file)) {
    try {
      text = readFileSync(file, "utf8");
    } catch (e) {
      const code = (e as NodeJS.ErrnoException).code;
      if (code !== "ENOENT") {
        limits.push(`routes ${spec.component}: the OpenAPI document ${file} could not be read (${code ?? (e as Error).message})`);
        return [];
      }
    }
  } else text = source.read(file);
  if (text === undefined) {
    limits.push(`routes ${spec.component}: the OpenAPI document ${file} is not there${isAbsolute(file) ? "" : " at this revision"}`);
    return [];
  }
  if (isAbsolute(file) && source.ref !== "WORKTREE")
    limits.push(`routes ${spec.component}: ${file} is outside the repository and is read as it is now, not at ${source.ref.slice(0, 12)}`);
  const api = describedOperations(file, text);
  if (!api) {
    limits.push(`routes ${spec.component}: ${file} is not a Swagger 2.0 or OpenAPI 3 document`);
    return [];
  }
  // Matched by method and path with parameters unnamed: the document may name them differently from the code.
  const byShape = new Map(code.filter((s) => s.component === spec.component).map((s) => [operationShape(s.method, s.path), s]));
  const out: Surface[] = [];
  const parsed = new Map<string, Map<string, Definition[]>>();
  // Operations whose handler was looked for in the route files by operationId and not found, and operations with no
  // operationId to look for one by, which stay where the document writes them.
  const unplaced: string[] = [];
  const unnamed: string[] = [];
  for (const op of api.operations) {
    const id = surfaceId({ component: spec.component, method: op.method, path: op.path });
    const known = byShape.get(operationShape(op.method, op.path));
    if (known) {
      if (op.operationId && !known.operationId) known.operationId = op.operationId;
      if (!known.described) Object.assign(known, { described: op.at, describedPath: op.key, describedVersion: api.version });
      continue;
    }
    const place = op.operationId ? handlerPlace(texts, op.operationId, op.method, op.key, parsed) : undefined;
    if (!place && texts.size) (op.operationId ? unplaced : unnamed).push(op.operationId ?? `${op.method} ${op.key}`);
    const handler = place && reach ? handlerNode(reach, place.at) : undefined;
    const surface: Surface = {
      id,
      component: spec.component,
      method: op.method,
      path: op.path,
      at: place ? { file: place.at.file, line: place.at.line } : op.at,
      evidence: place?.evidence ?? "declared",
      ...(op.operationId ? { operationId: op.operationId } : {}),
      described: op.at,
      describedPath: op.key,
      describedVersion: api.version,
      ...(handler ? { reaches: reach!.from(place!.at.file, handler, executed && (executed.get(id) ?? executed.set(id, new Set()).get(id)!)) } : {}),
    };
    byShape.set(operationShape(op.method, op.path), surface);
    out.push(surface);
  }
  const named = (ops: string[]) => (ops.length > 5 ? `${ops.slice(0, 5).join(", ")} and ${ops.length - 5} more` : ops.join(", "));
  const stay = (ops: string[]) => (ops.length === 1 ? "it stays at its" : "they stay at their");
  if (unplaced.length) {
    limits.push(
      `routes ${spec.component}: no handler was found in the configured route files for ${unplaced.length} operation${unplaced.length === 1 ? "" : "s"} of ${file} (${named(unplaced)}); ${stay(unplaced)} line in the document`,
    );
  }
  if (unnamed.length) {
    limits.push(
      `routes ${spec.component}: ${unnamed.length === 1 ? "1 operation" : `${unnamed.length} operations`} of ${file} ${unnamed.length === 1 ? "has" : "have"} no operationId to find a handler by (${named(unnamed)}); ${stay(unnamed)} line in the document`,
    );
  }
  return out;
}

/** The directory of the nearest build file (Maven or Gradle) above a file: "" at the root, undefined when there is none. */
function buildRoot(file: string, files: Set<string>): string | undefined {
  const parts = file.split("/").slice(0, -1);
  for (let n = parts.length; n >= 0; n--) {
    const dir = parts.slice(0, n).join("/");
    const prefix = dir ? `${dir}/` : "";
    if (["pom.xml", "build.gradle", "build.gradle.kts"].some((b) => files.has(`${prefix}${b}`))) return dir;
  }
  return undefined;
}

/**
 * The global prefix and versioning of a Nest component, from its `bootstrap` file when the entry names one, else from
 * the calls that set them in the route files and in the component's code (tests and the other excluded files left out).
 */
function nestBootstrap(source: Source, config: Config, spec: RouteSource, files: string[], root: string | undefined, limits: string[]): NestApp {
  const script = (f: string) => /\.(c|m)?[jt]sx?$/.test(f);
  const dir = root?.replace(/\/+$/, "");
  const component = dir === undefined ? [] : select(source, [dir ? `${dir}/**` : "**"], config.exclude);
  const candidates = [...new Set([...files, ...component])].filter(script);
  const texts = new Map(candidates.map((f) => [f, source.read(f) ?? ""]));
  let app: NestApp;
  if (spec.bootstrap !== undefined) {
    const text = source.read(spec.bootstrap);
    if (text === undefined) limits.push(`routes ${spec.component}: the bootstrap file ${spec.bootstrap} is not there${source.ref === "WORKTREE" ? "" : " at this revision"}`);
    app = nestApp(new Map(text === undefined ? [] : [[spec.bootstrap, text]]), spec.component, limits, spec.prefix);
  } else app = nestApp(texts, spec.component, limits, spec.prefix);
  // The modules RouterModule routes are those of the application's code, wherever its bootstrap is.
  const { modules, unknown } = nestModules(texts, spec.component, limits);
  return { ...app, modules, ...(unknown && !app.unknown ? { unknown } : {}) };
}

/**
 * The Java and Kotlin files a Spring entry's configurers and annotation types are read from: its route files and the
 * component's code (the excluded files left out), since a `WebMvcConfigurer` need not be among the controller globs.
 */
function springSources(source: Source, config: Config, files: string[], root: string | undefined): Map<string, string> {
  const dir = root?.replace(/\/+$/, "");
  const component = dir === undefined ? [] : select(source, [dir ? `${dir}/**` : "**"], config.exclude);
  const all = [...new Set([...files, ...component])].filter((f) => /\.(java|kt|kts)$/.test(f));
  return new Map(all.map((f) => [f, source.read(f) ?? ""]));
}

/**
 * Surfaces with one per component, method and path, the first kept. Where the routes of one path take their parameters
 * by different regexps (or one by none), the surface takes what any of them does: it keeps no pattern.
 */
function unique(surfaces: Surface[]): Surface[] {
  const seen = new Map<string, Surface>();
  return surfaces.filter((s) => {
    const k = `${s.component}|${s.method}|${s.path}`;
    const kept = seen.get(k);
    if (kept) {
      if (kept.patterns && JSON.stringify(kept.patterns) !== JSON.stringify(s.patterns)) delete kept.patterns;
      return false;
    }
    seen.set(k, s);
    return true;
  });
}

export function extractRoutes(
  source: Source,
  config: Config,
  reach?: Reach,
  coverage: Coverage[] = [],
  limits: string[] = [],
  executed?: Map<string, Set<string>>,
  spans?: Spans,
  redirects?: Redirects,
  offered?: Map<string, Set<string>>,
): Surface[] {
  const out: Surface[] = [];
  const roots = new Map(config.components.map((c) => [c.name, c.path]));
  // View names Spring handlers render; their templates' requests are what the route leads to.
  const views: Views = new Map();
  const codeFiles = new Map<string, Set<string>>();
  const ranges = packageRanges(source);
  // Code first, so a document merges with the routes every entry of its component registers.
  for (const spec of config.routes) {
    const files = select(source, spec.files ?? [], config.exclude);
    const known = codeFiles.get(spec.component) ?? codeFiles.set(spec.component, new Set()).get(spec.component)!;
    const before = out.length;
    const scripts = new Map(files.filter((f) => /\.(c|m)?[jt]sx?$/.test(f)).map((f) => [f, source.read(f) ?? ""]));
    const mounts = (spec.styles ?? []).includes("express") ? expressMounts(scripts, spec.mounts, spec.receivers ?? EXPRESS_RECEIVERS) : undefined;
    const nest = (spec.styles ?? []).includes("nest") ? nestBootstrap(source, config, spec, files, roots.get(spec.component), limits) : undefined;
    const java = (spec.styles ?? []).includes("spring") ? springSources(source, config, files, roots.get(spec.component)) : undefined;
    const prefixes = java ? pathPrefixes(java) : undefined;
    const exchanges = java ? httpExchanges(java) : undefined;
    const routers = (spec.styles ?? []).includes("fastapi")
      ? fastapiRouters(new Map(files.filter((f) => f.endsWith(".py")).map((f) => [f, source.read(f) ?? ""])), spec.mounts)
      : undefined;
    for (const file of files) {
      known.add(file);
      const text = source.read(file);
      if (text === undefined) continue;
      if (/\.(c|m)?tsx?$/.test(file) || /\.(c|m)?jsx?$/.test(file)) out.push(...routesFromTypeScript(file, text, spec, { reach, executed, mounts, limits, spans, root: roots.get(spec.component), nest, offered, ranges }));
      else if (file.endsWith(".py") && ((spec.styles ?? []).includes("fastapi") || spec.calls?.length)) out.push(...routesFromPython(file, text, { ...spec, styles: spec.styles ?? [] }, limits, spans, routers));
      else if (/\.(java|kt|kts)$/.test(file) && (spec.styles ?? []).includes("spring")) out.push(...routesFromSpring(file, text, spec, views, spans, limits, prefixes, exchanges));
    }
    if (routers) limits.push(...routers.limits(spec.component));
    if (prefixes) limits.push(...prefixes.limits(spec.component));
    addCoverage(coverage, `routes ${spec.component}`, files.length, out.length - before);
  }
  // What Next.js serves from files with no handler of the app's: public/ as files, to GET and HEAD, and the metadata
  // files written as files through a route handler it generates, which answers OPTIONS too (next-metadata-route-loader,
  // auto-implement-methods). After the code, so a route a file also names keeps the handler's place.
  const skip = matcher(config.exclude);
  for (const component of new Set(config.routes.filter((r) => (r.styles ?? []).includes("next")).map((r) => r.component))) {
    const root = roots.get(component);
    if (root === undefined) continue;
    for (const file of source.list()) {
      const served = skip(file) ? undefined : nextStaticFile(file, root);
      if (served === undefined) continue;
      const { path } = served;
      for (const method of served.kind === "metadata" ? ["GET", "HEAD", "OPTIONS"] : ["GET", "HEAD"]) {
        out.push({ id: surfaceId({ component, method, path }), component, method, path, at: { file, line: 1 }, evidence: "static", implicit: true });
      }
    }
  }
  // A route two entries both register is one surface, so the document enriches the copy that is kept.
  const code = unique(out);
  out.length = 0;
  out.push(...code);
  // The document the configuration chooses for a component goes first, so its operationIds and places win.
  const documents = config.routes
    .filter((r) => r.openapi)
    .sort((a, b) => Number(config.openapi[b.component] === b.openapi) - Number(config.openapi[a.component] === a.openapi));
  for (const spec of documents) {
    const texts = new Map([...codeFiles.get(spec.component)!].map((f) => [f, source.read(f) ?? ""]));
    const added = documentedSurfaces(source, spec, texts, out, limits, reach, executed);
    out.push(...added);
    addCoverage(coverage, `routes ${spec.component}`, 1, added.length);
  }
  if (executed && views.size) {
    const templates = source.list().filter((f) => /(^|\/)templates\/.+\.html$/.test(f));
    const files = new Set(templates);
    const all = new Set(source.list());
    for (const [id, { file, names }] of views) {
      const runs = executed.get(id) ?? executed.set(id, new Set()).get(id)!;
      // Spring Boot's Thymeleaf resolver: classpath:/templates/<name>.html of the application the handler belongs to.
      const module = /^(?:(.*)\/)?src\/main\/(?:java|kotlin)\//.exec(file);
      for (const name of names) {
        if (module) {
          const t = `${module[1] ? `${module[1]}/` : ""}src/main/resources/templates/${name}.html`;
          if (files.has(t)) runs.add(`${t}:*${name}`);
          continue;
        }
        // Outside the standard layout, the application is the nearest directory above the handler with a build file.
        const root = buildRoot(file, all);
        if (root === undefined) {
          limits.push(`routes ${id}: no build file above ${file} tells which application view ${name} belongs to; none is linked`);
          continue;
        }
        // A template under a nested build file belongs to that module, not to the handler's application.
        const found = templates.filter((t) => t.endsWith(`templates/${name}.html`) && buildRoot(t, all) === root);
        if (found.length === 1) runs.add(`${found[0]}:*${name}`);
        else if (found.length > 1) limits.push(`routes ${id}: view ${name} names ${found.length} templates (${found.join(", ")}); none is linked`);
      }
    }
  }
  for (const [id, { file, redirects: to }] of views) if (to.length) redirects?.set(id, to.map((r) => ({ path: r.path, at: { file, line: r.line } })));
  return unique(out);
}

/** The paths a route's replies redirect to (see `routesFromSpring`), by route, each where it is written. */
export type Redirects = Map<string, Array<{ path: string; at: Place }>>;
