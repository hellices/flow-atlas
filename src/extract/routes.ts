import ts from "typescript";
import type { Config, RouteSource } from "../config.js";
import type { Coverage, Surface } from "../model.js";
import { surfaceId } from "../model.js";
import { joinRoute, routeTemplate } from "../paths.js";
import { readFileSync } from "node:fs";
import { isAbsolute } from "node:path";
import { lineOf, matcher, select, type Source } from "../source.js";
import { operationShape } from "./apidocs.js";
import { routesFromSpring, type Views } from "./spring.js";
import { definitionLines, describedOperations, escapeRegExp, handlerNames } from "./openapi.js";
import { addCoverage } from "./coverage.js";
import { expressMounts, type Mounts } from "./mounts.js";
import type { Spans } from "./spans.js";
import type { Reach } from "./reach.js";
import { declarationOf } from "./binding.js";

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
};
const HTTP_VERBS = new Set(["get", "post", "put", "patch", "delete", "head", "options", "all"]);

/** A property's name as written, quoted or not: `path` and `"path"` are the same key. */
function propertyName(p: ts.ObjectLiteralElementLike): string | undefined {
  const n = p.name;
  return n && (ts.isIdentifier(n) || ts.isStringLiteral(n) || ts.isNoSubstitutionTemplateLiteral(n) || ts.isNumericLiteral(n)) ? n.text : undefined;
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
 * The path Next.js serves a static file at, without a handler: a file under `public/` at the component's root, from the
 * base URL (Next.js, public Folder); and the metadata files written as files in `app/` (Next.js, Metadata Files):
 * `favicon.ico`, `robots.txt`, `manifest.json` and `manifest.webmanifest` at its root, `sitemap.xml` in any segment.
 * Undefined for any other file.
 */
export function nextStaticFile(file: string, root: string): string | undefined {
  const inside = root === "" ? file : file.startsWith(`${root}/`) ? file.slice(root.length + 1) : undefined;
  if (inside === undefined) return undefined;
  if (inside.startsWith("public/")) return `/${inside.slice("public/".length)}`;
  const meta = /^(?:src\/)?app\/((?:[^]*\/)?)(favicon\.ico|robots\.txt|manifest\.json|manifest\.webmanifest|sitemap\.xml)$/.exec(inside);
  if (!meta) return undefined;
  if (meta[2] !== "sitemap.xml") return meta[1] ? undefined : `/${meta[2]}`;
  const segments = nextSegments(meta[1]!, true);
  return segments && joinRoute(...segments, "sitemap.xml");
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
    /** Per surface id, the `file@offset` of each address a page renders in a link or a form (see `Reach.from`). */
    offered?: Map<string, Set<string>>;
  } = {},
): Surface[] {
  const { reach, executed, mounts, limits, spans, root, offered } = context;
  const span = (node: ts.Node | undefined) => {
    if (node) spans?.add(file, node.getStart(sf), node.getEnd());
  };
  const sf = reach?.parse(file)?.sf ?? ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true, file.endsWith("x") ? ts.ScriptKind.TSX : ts.ScriptKind.TS);
  const styles = new Set(spec.styles ?? []);
  const receivers = new Set(spec.receivers ?? ["app", "router", "server", "fastify"]);
  const unmounted = new Set<string>();
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
  const add = (
    method: string,
    path: string,
    node: ts.Node,
    handler?: ts.Node,
    operationId?: string,
    more: { implicit?: boolean; handlerFile?: string; render?: boolean; offers?: boolean; wrappers?: Array<{ file: string; node: ts.Node }> } = {},
  ) => {
    const id = surfaceId({ component: spec.component, method: method.toUpperCase(), path: routeTemplate(joinRoute(path)) });
    const lines = executed ? (executed.get(id) ?? executed.set(id, new Set()).get(id)!) : undefined;
    const offers = more.offers && offered ? (offered.get(id) ?? offered.set(id, new Set()).get(id)!) : undefined;
    const starts = handler ? [{ file: more.handlerFile ?? file, node: handler }, ...(more.wrappers ?? [])] : [];
    out.push({
      id,
      component: spec.component,
      method: method.toUpperCase(),
      path: routeTemplate(joinRoute(path)),
      at: at(node),
      evidence: "static",
      ...(operationId ? { operationId } : {}),
      ...(reach && handler ? { reaches: [...new Set(starts.flatMap((st) => reach.from(st.file, st.node, lines, more.render, offers)))].sort() } : {}),
      ...(more.implicit ? { implicit: true } : {}),
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
    // that handler and OPTIONS by itself. `generateSitemaps` splits a sitemap into `sitemap/[id].xml`. Crawlers fetch
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
      add("GET", path, statement, handler, undefined, { implicit: true, handlerFile: found?.file });
      add("HEAD", path, statement, handler, undefined, { implicit: true, handlerFile: found?.file });
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
    add("GET", next.path, page ?? sf, component, undefined, { render: true, handlerFile, offers: true, wrappers });
    add("HEAD", next.path, page ?? sf, component, undefined, { implicit: true, render: true, handlerFile, wrappers });
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

  const visit = (node: ts.Node): void => {
    if (styles.has("nest") && ts.isClassDeclaration(node)) {
      let bases: string[] | undefined;
      for (const d of decorators(node)) {
        const call = decoratorCall(d);
        if (call?.name === "Controller") {
          bases = decoratorPaths(call.args);
          if (!bases) unread(call.args[0]!);
          for (const a of call.args) span(a);
        }
      }
      if (bases !== undefined) {
        const className = node.name?.text;
        for (const member of node.members) {
          const explicit = decorators(member)
            .map(decoratorCall)
            .find((c) => c?.name === "ApiOperation");
          const methodName = ts.isMethodDeclaration(member) && ts.isIdentifier(member.name) ? member.name.text : undefined;
          const operationId =
            operationIdIn(explicit?.args ?? []) ??
            (spec.operationIds === "nest-swagger" && className && methodName ? `${className}_${methodName}` : undefined);
          for (const d of decorators(member)) {
            const call = decoratorCall(d);
            const method = call ? NEST_METHODS[call.name] : undefined;
            const paths = call && method ? decoratorPaths(call.args) : undefined;
            if (call && method && !paths) unread(call.args[0]!, method, bases);
            if (!paths) continue;
            for (const a of call!.args) span(a);
            for (const base of bases) for (const path of paths) add(method!, joinRoute(base, path), member, member, operationId);
          }
        }
      }
    }
    if (ts.isCallExpression(node)) {
      const name = calleeName(node.expression);
      if (styles.has("express") && ts.isPropertyAccessExpression(node.expression) && name && HTTP_VERBS.has(name)) {
        const receiver = node.expression.expression;
        const arg = node.arguments[0];
        const path = stringValue(arg);
        const router = ts.isIdentifier(receiver) ? mounts?.routerOf(file, receiver) : undefined;
        // With one argument, `app.get(name)` reads a setting; a route takes a path and a handler.
        if (ts.isIdentifier(receiver) && (router || receivers.has(receiver.text)) && arg && node.arguments.length > 1 && path === undefined) {
          unread(arg, name, router ? mounts!.prefixes(router) : [""]);
        }
        if (ts.isIdentifier(receiver) && path?.startsWith("/") && (router || receivers.has(receiver.text))) {
          span(node.arguments[0]);
          const method = name === "all" ? "*" : name;
          if (router) {
            const prefixes = mounts!.prefixes(router);
            if (prefixes) for (const p of prefixes) add(method, joinRoute(p, path), node, node);
            else unmounted.add(receiver.text);
          } else if (receivers.has(receiver.text)) add(method, path, node, node);
        }
      }
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
  for (const name of unmounted) {
    limits?.push(`routes ${spec.component}: router ${name} in ${file} is mounted where the code gives no literal path; its routes are not read (declare it in mounts)`);
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
function closingParen(code: string, from: number): number {
  let depth = 1;
  for (let i = from; i < code.length; i++) {
    if ("([{".includes(code[i]!)) depth++;
    else if (")]}".includes(code[i]!) && --depth === 0) return i;
  }
  return code.length;
}

/**
 * The methods a FastAPI `api_route` serves: GET when `methods` is not given, the listed ones when it is a literal list,
 * tuple or set of strings; undefined when the list is built at run time, so no route is guessed.
 */
function apiRouteMethods(text: string, code: string, argsStart: number): string[] | undefined {
  const end = closingParen(code, argsStart);
  const m = /\bmethods\s*=\s*/.exec(code.slice(argsStart, end));
  if (!m) return ["GET"];
  const valueStart = argsStart + m.index + m[0].length;
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
function pythonStrings(text: string): { value: string; length: number } | undefined {
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
function pythonArgStarts(code: string, from: number): number[] {
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
function pythonArg(text: string, code: string, at: number): string {
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

export function routesFromPython(file: string, text: string, spec: RouteSource, limits?: string[], spans?: Spans): Surface[] {
  const out: Surface[] = [];
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
    const path = starlettePath(raw);
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
  // Styles left out, as a direct call does, read FastAPI; the scan always passes the configured ones.
  const fastapi = !spec.styles || spec.styles.includes("fastapi");
  for (const m of fastapi ? code.matchAll(FASTAPI) : []) {
    if (!receivers.has(m[1]!)) continue;
    const argsStart = (m.index ?? 0) + m[0].length;
    // The path is the first argument, or the one named `path` (`@app.get(path="/items")`).
    const first = /^[A-Za-z_]\w*\s*=(?!=)/.test(code.slice(argsStart)) ? undefined : argsStart;
    const named = pythonArgStarts(code, argsStart)
      .map((at) => ({ at, m: /^path\s*=\s*/.exec(code.slice(at)) }))
      .find((a) => a.m);
    const pathAt = named ? named.at + named.m![0].length : first;
    if (pathAt !== undefined) unread(pathAt);
    const path = pathAt === undefined ? undefined : pythonLiteral(text.slice(pathAt));
    if (!path) continue;
    spans?.add(file, argsStart, closingParen(code, argsStart));
    const methods = m[2] === "api_route" ? apiRouteMethods(text, code, argsStart) : [m[2]!.toUpperCase()];
    for (const method of methods ?? []) add(method, path, m.index ?? 0);
  }
  // Starlette's mount hands everything under its path to the mounted application, compiled as the path with
  // `/{path:path}` joined. StaticFiles answers GET and HEAD; what another application serves is not read here.
  for (const m of fastapi ? code.matchAll(/\b(\w+)\.mount\(\s*/g) : []) {
    if (!receivers.has(m[1]!)) continue;
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
      add("GET", joinRoute(path, "{path:path}"), m.index ?? 0);
      add("HEAD", joinRoute(path, "{path:path}"), m.index ?? 0, true);
    } else {
      limits?.push(`routes ${spec.component}: ${file}:${lineOf(text, m.index ?? 0)} mounts an application at ${path} whose routes are not read`);
    }
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
): { at: Found; evidence: Surface["evidence"] } | undefined {
  const hits: Found[] = [];
  for (const name of handlerNames(operationId, method, key)) {
    for (const [f, t] of texts) for (const line of definitionLines(f, t, name)) hits.push({ file: f, line, offset: definitionOffset(t, line, name) });
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
  for (const op of api.operations) {
    const id = surfaceId({ component: spec.component, method: op.method, path: op.path });
    const known = byShape.get(operationShape(op.method, op.path));
    if (known) {
      if (op.operationId && !known.operationId) known.operationId = op.operationId;
      if (!known.described) Object.assign(known, { described: op.at, describedPath: op.key });
      continue;
    }
    const place = op.operationId ? handlerPlace(texts, op.operationId, op.method, op.key) : undefined;
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
      ...(handler ? { reaches: reach!.from(place!.at.file, handler, executed && (executed.get(id) ?? executed.set(id, new Set()).get(id)!)) } : {}),
    };
    byShape.set(operationShape(op.method, op.path), surface);
    out.push(surface);
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

/** Surfaces with one per component, method and path, the first kept. */
function unique(surfaces: Surface[]): Surface[] {
  const seen = new Set<string>();
  return surfaces.filter((s) => {
    const k = `${s.component}|${s.method}|${s.path}`;
    if (seen.has(k)) return false;
    seen.add(k);
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
  offered?: Map<string, Set<string>>,
): Surface[] {
  const out: Surface[] = [];
  const roots = new Map(config.components.map((c) => [c.name, c.path]));
  // View names Spring handlers render; their templates' requests are what the route leads to.
  const views: Views = new Map();
  const codeFiles = new Map<string, Set<string>>();
  // Code first, so a document merges with the routes every entry of its component registers.
  for (const spec of config.routes) {
    const files = select(source, spec.files ?? [], config.exclude);
    const known = codeFiles.get(spec.component) ?? codeFiles.set(spec.component, new Set()).get(spec.component)!;
    const before = out.length;
    const scripts = new Map(files.filter((f) => /\.(c|m)?[jt]sx?$/.test(f)).map((f) => [f, source.read(f) ?? ""]));
    const mounts = (spec.styles ?? []).includes("express") ? expressMounts(scripts, spec.mounts) : undefined;
    for (const file of files) {
      known.add(file);
      const text = source.read(file);
      if (text === undefined) continue;
      if (/\.(c|m)?tsx?$/.test(file) || /\.(c|m)?jsx?$/.test(file)) out.push(...routesFromTypeScript(file, text, spec, { reach, executed, mounts, limits, spans, root: roots.get(spec.component), offered }));
      else if (file.endsWith(".py") && ((spec.styles ?? []).includes("fastapi") || spec.calls?.length)) out.push(...routesFromPython(file, text, { ...spec, styles: spec.styles ?? [] }, limits, spans));
      else if (/\.(java|kt|kts)$/.test(file) && (spec.styles ?? []).includes("spring")) out.push(...routesFromSpring(file, text, spec, views, spans, limits));
    }
    addCoverage(coverage, `routes ${spec.component}`, files.length, out.length - before);
  }
  // What Next.js serves from files with no handler: public/ and the metadata files written as files. After the code, so
  // a route a file also names keeps the handler's place.
  const skip = matcher(config.exclude);
  for (const component of new Set(config.routes.filter((r) => (r.styles ?? []).includes("next")).map((r) => r.component))) {
    const root = roots.get(component);
    if (root === undefined) continue;
    for (const file of source.list()) {
      const path = skip(file) ? undefined : nextStaticFile(file, root);
      if (path === undefined) continue;
      for (const method of ["GET", "HEAD"]) {
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
  return unique(out);
}
