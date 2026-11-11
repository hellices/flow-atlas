import ts from "typescript";
import type { Place } from "../model.js";
import { joinRoute } from "../paths.js";
import { lineOf, type Source } from "../source.js";
import { declarationOf, unwrap } from "./binding.js";
import type { Constants } from "./constants.js";
import { property } from "./nest.js";
import type { Reach } from "./reach.js";

/**
 * The configuration a Next.js application at a root reads: the object its `next.config.*` exports, written in place or
 * held in a `const` of the file (none where there is no such file, and Next.js's defaults hold); why where it is not
 * read: two files, an export that is no object the file spells out (a function, a plugin's wrapper).
 */
export type NextConfig = { file?: string; object?: ts.ObjectLiteralExpression } | { why: string };

export function nextConfig(source: Pick<Source, "read">, root: string): NextConfig {
  const dir = root.replace(/\/+$/, "");
  const files = ["js", "mjs", "cjs", "ts", "mts", "cts"].map((ext) => `${dir ? `${dir}/` : ""}next.config.${ext}`).filter((f) => source.read(f) !== undefined);
  if (!files.length) return {};
  if (files.length > 1) return { why: `${files.join(" and ")} are both there, and which Next.js reads is not read` };
  const file = files[0]!;
  const sf = ts.createSourceFile(file, source.read(file)!, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  let exported: ts.Expression | undefined;
  for (const st of sf.statements) {
    if (ts.isExportAssignment(st) && !st.isExportEquals) exported = st.expression;
    if (ts.isExpressionStatement(st) && ts.isBinaryExpression(st.expression) && st.expression.operatorToken.kind === ts.SyntaxKind.EqualsToken && st.expression.left.getText(sf) === "module.exports") exported = st.expression.right;
  }
  if (!exported) return { why: `${file} exports no configuration atlas reads` };
  const config = held(exported);
  if (!ts.isObjectLiteralExpression(config)) return { why: `${file} exports ${config.getText(sf).replace(/\s+/g, " ").slice(0, 80)}, not an object it spells out` };
  return { file, object: config };
}

/** An expression through parentheses, assertions and the `const`s of its file that hold it; a cycle ends where it starts. */
function held(e: ts.Expression, seen = new Set<ts.Node>()): ts.Expression {
  const u = unwrap(e);
  if (!ts.isIdentifier(u)) return u;
  const decl = declarationOf(u);
  if (!decl || seen.has(decl) || !ts.isVariableDeclaration(decl) || !(decl.parent.flags & ts.NodeFlags.Const) || !decl.initializer) return u;
  seen.add(decl);
  return held(decl.initializer, seen);
}

/**
 * A setting of a configuration read by `nextConfig`, at a path of keys (`images`, `unoptimized`): its value where the
 * file spells it out as a literal, undefined where it is not set (Next.js's default then holds), null where it is set
 * to something the file does not spell out, or a spread or a computed name may set it.
 */
export function nextSetting(config: { object?: ts.ObjectLiteralExpression }, ...keys: string[]): string | number | boolean | undefined | null {
  let at: ts.Expression | undefined = config.object;
  if (!at) return undefined;
  for (const key of keys) {
    const o = held(at);
    if (!ts.isObjectLiteralExpression(o)) return null;
    const v = property(o, key);
    if (v === undefined || v === null) return v;
    at = v;
  }
  const v = held(at);
  if (ts.isStringLiteralLike(v)) return v.text;
  if (ts.isNumericLiteral(v)) return Number(v.text);
  if (v.kind === ts.SyntaxKind.TrueKeyword) return true;
  if (v.kind === ts.SyntaxKind.FalseKeyword) return false;
  if (ts.isIdentifier(v) && v.text === "undefined" && declarationOf(v) === undefined) return undefined;
  return null;
}

/** The place an application at a root brings Next.js in: the line of `next` among its package.json's dependencies. */
function nextDependency(source: Pick<Source, "read">, root: string): Place | undefined {
  const file = `${root ? `${root}/` : ""}package.json`;
  const text = source.read(file);
  if (text === undefined) return undefined;
  let pkg: { dependencies?: Record<string, unknown>; devDependencies?: Record<string, unknown> } | undefined;
  try {
    pkg = JSON.parse(text) as typeof pkg;
  } catch {
    return undefined;
  }
  if (!pkg || (pkg.dependencies?.next === undefined && pkg.devDependencies?.next === undefined)) return undefined;
  const at = /"next"\s*:/.exec(text);
  return { file, line: at ? lineOf(text, at.index) : 1 };
}

/** A route Next.js serves by itself, with no file of the application's: what it is (`convention`) and what brings it in. */
export interface BuiltinRoute {
  method: string;
  path: string;
  convention: string;
  at: Place;
}

/**
 * The routes `next start` serves by itself (server/lib/router-utils/filesystem.ts, next-server.ts), under the
 * configuration's `basePath`:
 *
 * - `/_next/static/**`: the files the build writes to `.next/static`, to GET and HEAD.
 * - `/_next/image`: the image optimizer `next/image` requests, to any method. Next.js answers it only with the default
 *   loader and without `images.unoptimized` (`handleNextImageRequest`); `images.loaderFile` needs another loader, and
 *   `output: "export"` serves no optimizer.
 *
 * `at` is the line of `next` in the application's package.json, else its configuration file; where a setting they
 * depend on is not read, they are left out and `limits` says why.
 */
export function nextBuiltins(source: Pick<Source, "read">, root: string, component: string, config: NextConfig, limits: string[]): BuiltinRoute[] {
  const at = nextDependency(source, root) ?? ("file" in config && config.file ? { file: config.file, line: 1 } : undefined);
  if (!at) return [];
  if ("why" in config) {
    limits.push(`routes ${component}: ${config.why}, so the basePath Next.js serves its build's files (/_next/static) and image optimizer (/_next/image) under is not read; they are not read`);
    return [];
  }
  const basePath = nextSetting(config, "basePath");
  if (basePath !== undefined && (typeof basePath !== "string" || (basePath !== "" && !basePath.startsWith("/")))) {
    limits.push(`routes ${component}: ${config.file} sets basePath to a value it does not spell out as a path, so where Next.js serves its build's files (/_next/static) and image optimizer (/_next/image) is not read; they are not read`);
    return [];
  }
  const base = basePath ?? "";
  const out: BuiltinRoute[] = [];
  for (const method of ["GET", "HEAD"]) out.push({ method, path: joinRoute(base, "/_next/static/{file}/**"), convention: "next build assets", at });
  const settings = { output: nextSetting(config, "output"), loader: nextSetting(config, "images", "loader"), loaderFile: nextSetting(config, "images", "loaderFile"), unoptimized: nextSetting(config, "images", "unoptimized") };
  const unread = Object.entries(settings).filter(([, v]) => v === null);
  if (unread.length) {
    limits.push(`routes ${component}: ${config.file} sets ${unread.map(([k]) => (k === "output" ? k : `images.${k}`)).join(" and ")} to a value it does not spell out, so whether Next.js serves its image optimizer (/_next/image) is not read; it is not read`);
    return out;
  }
  const optimizer = settings.output !== "export" && (settings.loader === undefined || settings.loader === "default") && settings.loaderFile === undefined && settings.unoptimized !== true;
  if (optimizer) out.push({ method: "*", path: joinRoute(base, "/_next/image"), convention: "next image optimizer", at });
  return out;
}

/** Next.js's `djb2Hash` (shared/lib/hash.ts), the 32-bit hash it suffixes metadata routes with. */
export function djb2(text: string): number {
  let hash = 5381;
  for (let i = 0; i < text.length; i++) hash = ((hash << 5) + hash + text.charCodeAt(i)) & 0xffffffff;
  return hash >>> 0;
}

/**
 * The suffix Next.js gives the name of a metadata file in a folder under a route group or a slot, so that two such
 * files do not take one path (`getMetadataRouteSuffix`, lib/metadata/get-metadata-route.ts): the first six base-36
 * digits of the hash of the folders from `app/` (`/(site)/blog`); none elsewhere.
 */
export function metadataSuffix(folders: string[]): string {
  if (!folders.some((f) => (f.startsWith("(") && f.endsWith(")")) || (f.startsWith("@") && f !== "@children"))) return "";
  return `-${djb2(`/${folders.join("/")}`).toString(36).slice(0, 6)}`;
}

/** A page: its file, the path it is served at, and the directory of its `app/`, or of its `pages/` for the Pages Router. */
export interface NextPage {
  file: string;
  path: string;
  app?: string;
  pages?: string;
}

/**
 * How Next.js answers the requests of each page: `*` where it renders the page on each request, which takes any
 * method; GET (and HEAD) where it prerenders it at build, and answers any other method with 405, POST too where a
 * Server Action may post to it (server/base-server.ts, `renderToResponseWithComponentsImpl`: a page is refused other
 * methods where its route is prerendered, or under the Pages Router where it is plain HTML or has `getStaticProps`; a
 * request that may be a Server Action passes).
 */
export interface PageMethods {
  methods: string[];
  /** Why: what the page does that Next.js reads it by. */
  why: string;
}

/** The value a module exports under a name as a literal; undefined where it exports none, null where it does not spell it out. */
function exportedLiteral(sf: ts.SourceFile, name: string): string | number | boolean | null | undefined {
  let found: string | number | boolean | null | undefined;
  for (const st of sf.statements) {
    if (ts.isVariableStatement(st) && ts.getModifiers(st)?.some((m) => m.kind === ts.SyntaxKind.ExportKeyword)) {
      for (const d of st.declarationList.declarations) {
        if (!ts.isIdentifier(d.name) || d.name.text !== name) continue;
        const v = d.initializer && st.declarationList.flags & ts.NodeFlags.Const ? held(d.initializer) : undefined;
        found =
          v && ts.isStringLiteralLike(v) ? v.text : v && ts.isNumericLiteral(v) ? Number(v.text) : v?.kind === ts.SyntaxKind.TrueKeyword ? true : v?.kind === ts.SyntaxKind.FalseKeyword ? false : null;
      }
    }
    // `export { dynamic } from "./config"`, `export { x as dynamic }`, or `export *`, which Next.js reads the value of.
    if (ts.isExportDeclaration(st) && !st.isTypeOnly) {
      if (!st.exportClause) {
        if (st.moduleSpecifier) found = found === undefined ? null : found;
      } else if (ts.isNamedExports(st.exportClause) && st.exportClause.elements.some((e) => e.name.text === name && !e.isTypeOnly)) found = null;
    }
  }
  return found;
}

/** Whether a module exports a value under a name, as `exportsValue` reads it, or may through `export *`. */
function exportsName(sf: ts.SourceFile, name: string): boolean | null {
  let star = false;
  for (const st of sf.statements) {
    const exported = ts.canHaveModifiers(st) && ts.getModifiers(st)?.some((m) => m.kind === ts.SyntaxKind.ExportKeyword);
    if (exported && ts.isFunctionDeclaration(st) && st.name?.text === name) return true;
    if (exported && ts.isVariableStatement(st) && st.declarationList.declarations.some((d) => ts.isIdentifier(d.name) && d.name.text === name)) return true;
    if (ts.isExportDeclaration(st) && !st.isTypeOnly) {
      if (!st.exportClause) star = true;
      else if (ts.isNamedExports(st.exportClause) && st.exportClause.elements.some((e) => e.name.text === name && !e.isTypeOnly)) return true;
    }
  }
  return star ? null : false;
}

/**
 * Whether a module's component has `getInitialProps`, as Next.js reads it from the default export: a static member of
 * its class, or a property set on it (`Page.getInitialProps = ...`). Null where its default export is not read.
 */
function initialProps(sf: ts.SourceFile): boolean | null {
  let name: string | undefined;
  let found = false;
  for (const st of sf.statements) {
    const isDefault = ts.canHaveModifiers(st) && ts.getModifiers(st)?.some((m) => m.kind === ts.SyntaxKind.DefaultKeyword);
    if ((ts.isClassDeclaration(st) || ts.isFunctionDeclaration(st)) && isDefault) {
      name = st.name?.text;
      if (ts.isClassDeclaration(st) && st.members.some((m) => m.name && ts.isIdentifier(m.name) && m.name.text === "getInitialProps" && ts.canHaveModifiers(m) && ts.getModifiers(m)?.some((x) => x.kind === ts.SyntaxKind.StaticKeyword))) found = true;
    }
    if (ts.isExportAssignment(st) && !st.isExportEquals) {
      const e = unwrap(st.expression);
      if (ts.isIdentifier(e)) name = e.text;
    }
  }
  for (const st of sf.statements) {
    if (!ts.isExpressionStatement(st) || !ts.isBinaryExpression(st.expression) || st.expression.operatorToken.kind !== ts.SyntaxKind.EqualsToken) continue;
    const left = st.expression.left;
    if (ts.isPropertyAccessExpression(left) && left.name.text === "getInitialProps" && ts.isIdentifier(left.expression) && (name === undefined || left.expression.text === name)) found = true;
  }
  return found ? true : false;
}

/** Whether a module's directive prologue holds a directive. */
function directive(statements: readonly ts.Statement[], text: string): boolean {
  for (const st of statements) {
    if (!ts.isExpressionStatement(st) || !ts.isStringLiteral(st.expression)) return false;
    if (st.expression.text === text) return true;
  }
  return false;
}

/** A Server Action a module holds: the whole module marked `"use server"`, or a function whose body starts with it. */
function serverAction(sf: ts.SourceFile): ts.Node | undefined {
  if (directive(sf.statements, "use server")) return sf.statements[0];
  let found: ts.Node | undefined;
  const visit = (n: ts.Node): void => {
    if (found) return;
    if (ts.isFunctionLike(n) && "body" in n && n.body && ts.isBlock(n.body) && directive((n.body).statements, "use server")) found = n;
    else ts.forEachChild(n, visit);
  };
  visit(sf);
  return found;
}

/** The most modules followed from one page in search of a Server Action. */
const MAX_MODULES = 2000;

/**
 * Reads how Next.js answers each page (see `PageMethods`), with `limits` for what it cannot tell. By the rules of
 * base-server.ts and app-render (Next.js 16), each read from the code:
 *
 * - Pages Router: `getServerSideProps`, or `getInitialProps` on the page or on a custom `_app` for a page without
 *   `getStaticProps`, renders on each request (`*`); any other page is prerendered (Automatic Static Optimization) or
 *   statically generated (GET).
 * - App Router: a route with a dynamic segment is never prerendered as a route, so it takes any method; so does one where
 *   the page or a layout above it exports `dynamic = "force-dynamic"`, or `revalidate = 0` with no `force-static` above
 *   it (create-component-tree.tsx), or where what renders it calls a request-time API (`requestTimeCall`) or reads its
 *   `searchParams`. `dynamic = "force-static"` or `"error"` keeps it prerendered whatever it calls, as `output: "export"`
 *   does. A page atlas sees none of these in is read as GET, and named in a limit: what it renders from code atlas does
 *   not follow (a package, a module imported by another path than a relative one) may still call one.
 * - A page whose module graph (the page, its layouts and templates, and what they import, followed through relative
 *   imports, tsconfig `paths` and the workspace's packages) holds a Server Action takes POST besides GET: the action
 *   posts to the page it is called from, and Next.js passes such a request on to the page (`getIsPossibleServerAction`).
 */
export function nextPageMethods(
  pages: NextPage[],
  ctx: { component: string; root: string; config: NextConfig; source: Pick<Source, "read" | "list">; reach?: Reach; constants: Constants; limits: string[]; major?: number },
): Map<string, PageMethods> {
  const { component, reach, constants, limits } = ctx;
  const out = new Map<string, PageMethods>();
  const parse = (f: string) => reach?.parse(f)?.sf;
  const byPath = new Map<string, NextPage[]>();
  for (const p of pages) (byPath.get(`${p.app === undefined ? "pages" : "app"} ${p.path}`) ?? byPath.set(`${p.app === undefined ? "pages" : "app"} ${p.path}`, []).get(`${p.app === undefined ? "pages" : "app"} ${p.path}`)!).push(p);
  const assumed: string[] = [];
  const set = (group: NextPage[], methods: string[], why: string) => {
    for (const p of group) out.set(p.file, { methods, why });
  };
  // A custom App's getInitialProps turns prerendering off for every page without getStaticProps.
  const pagesDir = pages.find((p) => p.pages !== undefined)?.pages;
  const customApp = pagesDir !== undefined ? ["tsx", "ts", "jsx", "js"].map((e) => `${pagesDir}/_app.${e}`).find((f) => ctx.source.read(f) !== undefined) : undefined;
  const appSf = customApp ? parse(customApp) : undefined;
  const appInitial = appSf ? initialProps(appSf) : false;
  const output = "why" in ctx.config ? null : nextSetting(ctx.config, "output");
  const cacheComponents = "why" in ctx.config ? null : nextSetting(ctx.config, "cacheComponents") ?? nextSetting(ctx.config, "experimental", "cacheComponents") ?? nextSetting(ctx.config, "experimental", "dynamicIO") ?? nextSetting(ctx.config, "experimental", "ppr");
  // Partial prerendering came with Next.js 14 (`experimental.ppr`), and as `cacheComponents` with 16.
  if (cacheComponents !== undefined && cacheComponents !== false && pages.some((p) => p.app !== undefined) && !(ctx.major !== undefined && ctx.major < 14)) {
    const why = "why" in ctx.config ? `${ctx.config.why}, so whether it turns on cacheComponents or partial prerendering is not read` : `${ctx.config.file} turns on cacheComponents or partial prerendering, or may`;
    limits.push(`routes ${component}: ${why}; under them Next.js prerenders a shell even of a page that reads the request, so which pages it refuses methods other than GET for is not read, and each page is read as if they were off`);
  }
  for (const group of byPath.values()) {
    const first = group[0]!;
    if (first.app === undefined) {
      const sf = parse(first.file);
      if (!sf) continue;
      const ssp = exportsName(sf, "getServerSideProps");
      const ssg = exportsName(sf, "getStaticProps");
      const initial = initialProps(sf);
      if (ssp === true) set(group, ["*"], "getServerSideProps");
      else if (initial) set(group, ["*"], "getInitialProps");
      else if (appInitial && ssg !== true) set(group, ["*"], `getInitialProps in ${customApp}`);
      else if (ssp === null || ssg === null) {
        limits.push(`routes ${component}: ${first.file} re-exports everything another module exports (export *), which may give getServerSideProps; whether Next.js renders the page on each request, answering any method, is not read, and it is read as GET`);
        set(group, ["GET"], "unread");
      } else set(group, ["GET"], ssg ? "getStaticProps" : "prerendered");
      continue;
    }
    if (output === "export") {
      set(group, ["GET"], 'output: "export"');
      continue;
    }
    if (/\{/.test(first.path)) {
      set(group, ["*"], "a dynamic segment");
      continue;
    }
    // Each page's segments from the root layout down to the page, as Next.js renders them.
    let dynamic: string | undefined;
    const unread = new Set<string>();
    let allStatic = true;
    const starts: Array<{ file: string; node: ts.Node }> = [];
    const searchParams: string[] = [];
    let unsure = false;
    for (const page of group) {
      // The layout of each folder from `app/` down, and the page; a template renders inside its folder's layout.
      const folders = page.file.slice(page.app!.length + 1).split("/").slice(0, -1);
      const find = (dir: string, name: string) => ["tsx", "ts", "jsx", "js"].map((e) => `${dir}/${name}.${e}`).find((f) => ctx.source.read(f) !== undefined);
      const chain: Array<{ file: string; template?: string }> = [];
      for (let n = 0; n <= folders.length; n++) {
        const dir = [page.app!, ...folders.slice(0, n)].join("/");
        const layout = find(dir, "layout");
        const template = find(dir, "template");
        if (layout) chain.push({ file: layout, template });
        else if (template) chain.push({ file: template });
      }
      chain.push({ file: page.file });
      let forceStatic = false;
      let shouldError = false;
      for (const { file, template } of chain) {
        const sf = parse(file);
        if (!sf) continue;
        const d = exportedLiteral(sf, "dynamic");
        const r = exportedLiteral(sf, "revalidate");
        if (d === null || (d !== undefined && !["auto", "force-dynamic", "error", "force-static"].includes(String(d)))) unread.add(`${file} exports dynamic as a value it does not spell out`);
        else if (d === "force-dynamic") dynamic ??= `dynamic = "force-dynamic" in ${file}`;
        else if (d === "error") shouldError = true;
        else if (d === "force-static") [forceStatic, shouldError] = [true, false];
        else if (d === "auto") [forceStatic, shouldError] = [false, false];
        if (r === null) unread.add(`${file} exports revalidate as a value it does not spell out`);
        else if (r === 0 && !forceStatic) dynamic ??= `revalidate = 0 in ${file}`;
        // What renders, and `generateMetadata`, which runs in the same request.
        if (!forceStatic && !shouldError) {
          for (const [f, name] of [[file, "default"], [file, "generateMetadata"], ...(template ? [[template, "default"]] : [])] as Array<[string, string]>) {
            const found = reach?.exported(f, name);
            if (found) starts.push(found);
          }
        }
      }
      if (!forceStatic && !shouldError) {
        allStatic = false;
        const read = pageSearchParams(page.file, reach);
        if (read === null) unsure = true;
        else if (read) searchParams.push(read);
      }
    }
    if (dynamic) {
      set(group, ["*"], dynamic);
      continue;
    }
    if (allStatic && !unread.size) {
      set(group, ["GET"], 'dynamic = "force-static" or "error"');
      continue;
    }
    const used = new Set<string>();
    for (const s of starts) reach?.from(s.file, s.node, undefined, true, undefined, used);
    if (searchParams.length || used.size) {
      set(group, ["*"], [...searchParams, ...[...used].sort()][0]!);
      continue;
    }
    for (const u of unread) limits.push(`routes ${component}: ${u}; whether Next.js renders the page on each request, answering any method, is not read, and it is read as GET`);
    if (!allStatic) assumed.push(...group.map((p) => p.file));
    set(group, ["GET"], unsure ? "unread searchParams" : "prerendered");
  }
  if (assumed.length) {
    limits.push(
      `routes ${component}: Next.js prerenders a page at build unless rendering it calls a request-time API (cookies(), headers(), connection(), searchParams, a fetch with no-store); atlas sees one only in the code it follows from the page and its layouts, not in packages or in modules imported by another path than a relative one, so these pages, where it sees none, are read as taking GET alone: ${assumed.sort().join(", ")}`,
    );
  }
  // A Server Action (App Router only) posts to the page it is called from.
  const graph = new Map<string, { action: boolean; imports: string[] }>();
  for (const group of byPath.values()) {
    const methods = out.get(group[0]!.file);
    if (!methods || methods.methods.includes("*") || group[0]!.app === undefined) continue;
    const found = actionIn(group.flatMap((p) => [p.file, ...segmentFiles(p, ctx.source)]), constants, ctx.source, graph);
    if (found) set(group, [...methods.methods, "POST"], `${methods.why}; a Server Action in ${found}`);
  }
  return out;
}

/** The layouts and templates around an App Router page, from its folder up to `app/`. */
function segmentFiles(page: NextPage, source: Pick<Source, "read">): string[] {
  const folders = page.file.slice(page.app!.length + 1).split("/").slice(0, -1);
  const out: string[] = [];
  for (let n = 0; n <= folders.length; n++) {
    const dir = [page.app!, ...folders.slice(0, n)].join("/");
    for (const name of ["layout", "template"]) {
      const f = ["tsx", "ts", "jsx", "js"].map((e) => `${dir}/${name}.${e}`).find((x) => source.read(x) !== undefined);
      if (f) out.push(f);
    }
  }
  return out;
}

/**
 * The first module of the graph from `starts` that holds a Server Action, followed through the imports `constants`
 * resolves; `graph` keeps what each module holds and imports, for the next page.
 */
function actionIn(starts: string[], constants: Constants, source: Pick<Source, "read">, graph: Map<string, { action: boolean; imports: string[] }>): string | undefined {
  const seen = new Set<string>(starts);
  const queue = [...starts];
  while (queue.length && seen.size <= MAX_MODULES) {
    const file = queue.shift()!;
    let known = graph.get(file);
    if (!known) {
      const text = source.read(file);
      const sf = text === undefined ? undefined : ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true, /x$/.test(file) ? ts.ScriptKind.TSX : ts.ScriptKind.TS);
      const imports: string[] = [];
      for (const st of sf?.statements ?? []) {
        const spec =
          ts.isImportDeclaration(st) && !st.importClause?.isTypeOnly && ts.isStringLiteral(st.moduleSpecifier)
            ? st.moduleSpecifier.text
            : ts.isExportDeclaration(st) && !st.isTypeOnly && st.moduleSpecifier && ts.isStringLiteral(st.moduleSpecifier)
              ? st.moduleSpecifier.text
              : undefined;
        const target = spec === undefined ? undefined : constants.module(file, spec);
        if (target) imports.push(target);
      }
      known = { action: !!sf && !!serverAction(sf), imports };
      graph.set(file, known);
    }
    if (known.action) return file;
    for (const target of known.imports) {
      if (seen.has(target)) continue;
      seen.add(target);
      queue.push(target);
    }
  }
  return undefined;
}

/**
 * Whether a page reads the `searchParams` Next.js hands its default export, which only a request gives: `searchParams`
 * awaited, read a property of, or handed to `use`, from its first parameter destructured or through `props.searchParams`.
 * The name of what it reads where it does; null where it hands the props or the `searchParams` on whole, which atlas does not
 * follow; false where it does neither.
 */
function pageSearchParams(file: string, reach: Reach | undefined): string | false | null {
  const found = reach?.exported(file, "default");
  const node = found?.node;
  const fn = node && (ts.isFunctionLike(node) ? node : ts.isBlock(node) && ts.isFunctionLike(node.parent) ? node.parent : undefined);
  if (!fn || !("body" in fn) || !fn.body) return false;
  const param = fn.parameters[0];
  if (!param) return false;
  const uses: ts.Identifier[] = [];
  const reads = "searchParams";
  let whole = false;
  if (ts.isObjectBindingPattern(param.name)) {
    for (const el of param.name.elements) {
      const key = el.propertyName && ts.isIdentifier(el.propertyName) ? el.propertyName.text : ts.isIdentifier(el.name) ? el.name.text : undefined;
      if (el.dotDotDotToken) whole = true;
      if (key === reads && ts.isIdentifier(el.name)) uses.push(el.name);
      else if (key === reads) return reads;
    }
  } else if (ts.isIdentifier(param.name)) {
    const props = param.name;
    let read: string | false | null = false;
    const visit = (n: ts.Node): void => {
      if (ts.isIdentifier(n) && n !== props && n.text === props.text && declarationOf(n) === param) {
        const p = n.parent;
        if (ts.isPropertyAccessExpression(p) && p.expression === n) {
          if (p.name.text === reads) read = reads;
        } else if (!(ts.isElementAccessExpression(p) && ts.isStringLiteralLike(p.argumentExpression) && p.argumentExpression.text !== reads)) read = read || null;
      }
      ts.forEachChild(n, visit);
    };
    visit(fn.body);
    return read;
  } else return null;
  let result: string | false | null = whole ? null : false;
  for (const id of uses) {
    const visit = (n: ts.Node): void => {
      if (result === reads) return;
      if (ts.isIdentifier(n) && n !== id && n.text === id.text && declarationOf(n) === id.parent) {
        const p = n.parent;
        if (ts.isAwaitExpression(p) || ts.isPropertyAccessExpression(p) || ts.isElementAccessExpression(p)) result = reads;
        else if (ts.isCallExpression(p) && ts.isIdentifier(p.expression) && p.expression.text === "use") result = reads;
        else result = result || null;
      }
      ts.forEachChild(n, visit);
    };
    visit(fn.body);
  }
  return result;
}
