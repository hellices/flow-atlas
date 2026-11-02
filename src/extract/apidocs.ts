import ts from "typescript";
import { isMap, isScalar, parse, parseDocument } from "yaml";
import type { Config } from "../config.js";
import type { ApiDescription, ApiDocument, Component, Surface } from "../model.js";
import { joinRoute, routeTemplate } from "../paths.js";
import { lineOf, select, type Source } from "../source.js";
import { describedOperations } from "./openapi.js";

/** Paths API documents are commonly served at. */
export const DOCUMENT_PATH = /\/(openapi|swagger)(\.json|\.ya?ml)?$|\/api-docs(\.json)?$|\/v3\/api-docs$/;

/** File names API descriptions are commonly committed under. */
export const DOCUMENT_FILE = /(^|\/)(openapi|swagger)\.(json|ya?ml)$|\.openapi\.(json|ya?ml)$/;


function str(node: ts.Node | undefined): string | undefined {
  return node && (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) ? node.text : undefined;
}

/** The plugin a `register` call names: an identifier or a property access, never an inline function. */
function pluginName(arg: ts.Expression | undefined): string | undefined {
  if (!arg) return undefined;
  if (ts.isIdentifier(arg)) return arg.text;
  if (ts.isPropertyAccessExpression(arg)) return arg.name.text;
  return undefined;
}

function prop(obj: ts.Node | undefined, name: string): ts.Expression | undefined {
  if (!obj || !ts.isObjectLiteralExpression(obj)) return undefined;
  for (const p of obj.properties) if (ts.isPropertyAssignment(p) && p.name.getText().replace(/["']/g, "") === name) return p.initializer;
  return undefined;
}

/**
 * Where a TypeScript file serves an OpenAPI document: `SwaggerModule.setup(path, app, doc, { jsonDocumentUrl })` (Nest;
 * `<path>-json` by default), `register(swaggerUi, { routePrefix })` (@fastify/swagger-ui; `<prefix>/json`), or a route
 * registered as `x.get("/openapi.json", ...)` at a well-known document path. A swagger-ui whose `uiConfig.url` names
 * another path shows that document, so it is recorded as an alias of it.
 */
export function servedDocuments(file: string, text: string, component: string): ApiDocument[] {
  const sf = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true, file.endsWith("x") ? ts.ScriptKind.TSX : ts.ScriptKind.TS);
  const out: ApiDocument[] = [];
  const at = (n: ts.Node) => ({ file, line: sf.getLineAndCharacterOfPosition(n.getStart(sf)).line + 1 });
  const add = (location: string, convention: string, n: ts.Node, aliasOf?: string) =>
    out.push({
      component,
      kind: "served",
      location: joinRoute(location),
      convention,
      ...(aliasOf ? { aliasOf: joinRoute(aliasOf) } : {}),
      at: at(n),
      evidence: "static",
    });
  const visit = (n: ts.Node): void => {
    if (ts.isCallExpression(n) && ts.isPropertyAccessExpression(n.expression)) {
      const target = n.expression.expression.getText(sf);
      const name = n.expression.name.text;
      if (target === "SwaggerModule" && name === "setup") {
        const base = str(n.arguments[0]);
        const json = str(prop(n.arguments[3], "jsonDocumentUrl"));
        if (json) add(json, "nest-swagger jsonDocumentUrl", n);
        else if (base !== undefined) add(`${joinRoute(base)}-json`, "nest-swagger default", n);
      } else if (name === "register" && /^(swaggerUi|fastifySwaggerUi)$/i.test(pluginName(n.arguments[0]) ?? "")) {
        const prefix = str(prop(n.arguments[1], "routePrefix")) ?? "/documentation";
        const shown = str(prop(prop(n.arguments[1], "uiConfig"), "url"));
        add(`${joinRoute(prefix)}/json`, "fastify-swagger-ui", n, shown?.startsWith("/") ? shown : undefined);
      } else if (name === "get") {
        const path = str(n.arguments[0]);
        if (path && path.startsWith("/") && DOCUMENT_PATH.test(path)) add(path, "route", n);
      }
    }
    ts.forEachChild(n, visit);
  };
  visit(sf);
  return out;
}

/**
 * Where an OpenAPI or Swagger document declares its version, or undefined when the text is not such a document. The
 * parsed top-level `openapi` or `swagger` field decides, so compact JSON counts as much as pretty YAML.
 */
export function documentStart(text: string): number | undefined {
  let doc: unknown;
  try {
    doc = parse(text);
  } catch {
    return undefined;
  }
  if (!doc || typeof doc !== "object" || Array.isArray(doc)) return undefined;
  const top = doc as Record<string, unknown>;
  if (top.openapi === undefined && top.swagger === undefined) return undefined;
  return versionKeyOffset(text);
}

/** Where the top-level `openapi` or `swagger` key stands; a key of the same name nested deeper is not it. */
function versionKeyOffset(text: string): number {
  const root = parseDocument(text).contents;
  if (!isMap(root)) return 0;
  const pair = root.items.find((p) => isScalar(p.key) && (p.key.value === "openapi" || p.key.value === "swagger"));
  return (isScalar(pair?.key) && pair.key.range?.[0]) || 0;
}

const shape = (path: string): string => routeTemplate(path).replace(/\{[^}]*\}/g, "{}");

/**
 * The path key a description writes each operation under, by `METHOD /path` (the base path joined, parameters written
 * `{}`): the same operation may name its parameters differently from the code (`{orderId}` for `{id}`).
 */
export function documentPathKeys(text: string): Map<string, string> | undefined {
  const api = describedOperations("", text);
  if (!api) return undefined;
  return new Map(api.operations.map((o) => [`${o.method} ${shape(o.path)}`, o.key]));
}

/** The operationId a description gives each operation that has one, by `METHOD /path` as in `documentPathKeys`. */
export function documentOperationIds(text: string): Map<string, string> | undefined {
  let doc: unknown;
  try {
    doc = parse(text);
  } catch {
    return undefined;
  }
  const paths = (doc as { paths?: Record<string, Record<string, unknown>> } | null)?.paths;
  if (!paths || typeof paths !== "object") return undefined;
  const out = new Map<string, string>();
  for (const [path, item] of Object.entries(paths)) {
    for (const method of HTTP_METHODS) {
      const op = item && typeof item === "object" ? (item[method] as { operationId?: unknown } | undefined) : undefined;
      if (op && typeof op.operationId === "string") out.set(`${method.toUpperCase()} ${shape(path)}`, op.operationId);
    }
  }
  return out;
}

/** The operations a committed description declares, as `METHOD /path` with parameters written `{}`. */
export function documentOperations(text: string): string[] | undefined {
  const keys = documentPathKeys(text);
  return keys ? [...keys.keys()].sort() : undefined;
}

/** A surface's `METHOD /path` with parameters written `{}`, to look up in `documentPathKeys`. */
export const operationShape = (method: string, path: string): string => `${method} ${shape(path)}`;

/** How well a committed description agrees with the routes the code serves for the same component. */
function agreement(operations: string[], surfaces: Surface[]): NonNullable<ApiDocument["agreement"]> {
  const declared = new Set(operations);
  const served = surfaces.map((s) => ({ id: s.id, key: `${s.method} ${shape(s.path)}`, any: s.method === "*", path: shape(s.path) }));
  const covered = (s: (typeof served)[number]) => (s.any ? operations.some((o) => o.endsWith(` ${s.path}`)) : declared.has(s.key));
  const missing = served.filter((s) => !covered(s)).map((s) => s.id).sort();
  const keys = new Set(served.map((s) => s.key));
  const paths = new Set(served.filter((s) => s.any).map((s) => s.path));
  const extra = operations.filter((o) => !keys.has(o) && !paths.has(o.slice(o.indexOf(" ") + 1))).length;
  return { surfaces: served.length, covered: served.length - missing.length, missing, extra };
}

/**
 * Every OpenAPI description a component has: committed files under it, with how far they agree with the code's routes,
 * and the documents its route files serve.
 */
export function extractApiDocuments(source: Source, config: Config, components: Component[], surfaces: Surface[]): ApiDocument[] {
  const out: ApiDocument[] = [];
  const owner = (file: string): string | undefined => {
    let best: Component | undefined;
    for (const c of components) if (c.path && file.startsWith(`${c.path}/`) && (!best || c.path.length > best.path.length)) best = c;
    return best?.name;
  };
  for (const file of source.list().filter((f) => DOCUMENT_FILE.test(f))) {
    const component = owner(file);
    if (!component || select(source, [file], config.exclude).length === 0) continue;
    const text = source.read(file) ?? "";
    const start = documentStart(text);
    if (start === undefined) continue;
    const operations = documentOperations(text);
    out.push({
      component,
      kind: "file",
      location: file,
      convention: "committed",
      ...(operations ? { agreement: agreement(operations, surfaces.filter((s) => s.component === component)) } : {}),
      at: { file, line: lineOf(text, start) },
      evidence: "text",
    });
  }
  for (const spec of config.routes) {
    for (const file of select(source, spec.files, config.exclude)) {
      if (!/\.(c|m)?tsx?$/.test(file)) continue;
      const text = source.read(file);
      if (text && /SwaggerModule|swagger|openapi|api-docs/i.test(text)) out.push(...servedDocuments(file, text, spec.component));
    }
  }
  const seen = new Set<string>();
  return out
    .sort((a, b) => a.component.localeCompare(b.component) || a.kind.localeCompare(b.kind) || a.location.localeCompare(b.location))
    .filter((d) => {
      const k = `${d.component}|${d.kind}|${d.location}`;
      if (seen.has(k)) return false;
      seen.add(k);
      return true;
    });
}

/**
 * Which description is a component's, decided only where the code decides it; otherwise the candidates and the reason.
 *
 * 1. The author's `openapi` entry.
 * 2. Served paths that show another served document (`aliasOf`) are that document.
 * 3. A committed file that declares every route the code serves agrees with the code. If exactly one does, it is the one.
 * 4. Otherwise a single served document: the code generates it, and partial committed files are stale.
 * 5. A single committed file that the code cannot confirm (the component has no routes read) or that is partial.
 * Anything else is ambiguous: several complete files, several served documents, several partial files.
 */
export function resolveApiDescriptions(documents: ApiDocument[], surfaces: Surface[], config: Config): ApiDescription[] {
  const read = new Map<string, string[]>();
  for (const r of config.routes) if (r.openapi) read.set(r.component, [...new Set([...(read.get(r.component) ?? []), r.openapi])]);
  // A component that serves routes but has no description is reported as NoneFound, not left out.
  const components = [
    ...new Set([...documents.map((d) => d.component), ...Object.keys(config.openapi), ...read.keys(), ...surfaces.map((s) => s.component)]),
  ].sort();
  return components.map((component): ApiDescription => {
    const docs = documents.filter((d) => d.component === component);
    const candidates = docs.map((d) => d.location);
    const override = config.openapi[component];
    if (override) return { component, status: "chosen", location: override, kind: "author", reason: "AuthorOverride", candidates };
    const forRoutes = read.get(component) ?? [];
    if (forRoutes.length === 1) return { component, status: "chosen", location: forRoutes[0]!, kind: "author", reason: "ReadForRoutes", candidates };
    if (forRoutes.length > 1)
      return {
        component,
        status: "ambiguous",
        reason: "SeveralReadForRoutes",
        message: `candidates: ${forRoutes.join(", ")}`,
        candidates: [...new Set([...forRoutes, ...candidates])],
      };

    const servedPaths = new Set(docs.filter((d) => d.kind === "served").map((d) => d.location));
    // A page that shows its own path is that document, not an alias of another.
    const served = docs.filter((d) => d.kind === "served" && !(d.aliasOf && d.aliasOf !== d.location && servedPaths.has(d.aliasOf)));
    const files = docs.filter((d) => d.kind === "file");
    const routes = surfaces.filter((s) => s.component === component).length;
    const complete = files.filter((d) => routes > 0 && d.agreement && d.agreement.missing.length === 0);
    const partial = files.filter((d) => !complete.includes(d));
    const drift = partial
      .filter((d) => d.agreement && routes > 0)
      .map((d) => `${d.location} lacks ${d.agreement!.missing.length} of ${d.agreement!.surfaces} routes`)
      .join("; ");
    const chosen = (d: ApiDocument, reason: string, message?: string): ApiDescription => ({
      component,
      status: "chosen",
      location: d.location,
      kind: d.kind,
      reason,
      ...(message ? { message } : {}),
      candidates,
    });
    const ambiguous = (reason: string, list: ApiDocument[]): ApiDescription => ({
      component,
      status: "ambiguous",
      reason,
      message: `candidates: ${list.map((d) => d.location).join(", ")}`,
      candidates,
    });

    if (docs.length === 0) return { component, status: "none", reason: "NoneFound", candidates };
    if (complete.length === 1) return chosen(complete[0]!, "FileMatchesCode", drift || undefined);
    if (complete.length > 1) return ambiguous("SeveralCompleteFiles", complete);
    if (served.length === 1)
      return chosen(served[0]!, served.length === docs.filter((d) => d.kind === "served").length ? "ServedByCode" : "AliasesOfOne", drift || undefined);
    if (served.length > 1) return ambiguous("SeveralServedDocuments", served);
    if (files.length === 1)
      return chosen(files[0]!, routes === 0 ? "OnlyFileUnconfirmed" : "OnlyPartialFile", routes === 0 ? "no routes of this component were read to compare" : drift);
    return ambiguous("SeveralPartialFiles", files);
  });
}
