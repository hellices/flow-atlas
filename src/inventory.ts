import { dirname } from "node:path";
import ts from "typescript";
import { parse } from "yaml";
import { DOCUMENT_FILE, documentStart, servedDocuments, spectacularDocuments } from "./extract/apidocs.js";
import { withoutComments } from "./extract/calls.js";
import { BUILD_FILE, springdocDocuments } from "./extract/springdoc.js";
import type { ApiDocument } from "./model.js";
import { lineOf, matcher, select, type Source } from "./source.js";

/**
 * Raw material for writing a configuration: where components, routes and client calls appear to be.
 * It decides nothing; whoever writes the configuration chooses what to keep.
 */
export interface Inventory {
  /** `note` says why a component is named by its path rather than by its manifest or directory. */
  components: Array<{ name: string; path: string; manifest: string; note?: string }>;
  routes: Array<{ component: string; file: string; style: string; count: number; example: string }>;
  calls: Array<{ component: string; file: string; count: number; example: string }>;
  /** OpenAPI descriptions committed or served by code, by owning component. */
  apiDocuments: ApiDocument[];
}

const CODE = "**/*.{ts,tsx,js,jsx,mjs,cjs,kt,kts,java,swift,py,go,dart,html,htm}";
const MANIFESTS = /(^|\/)(component\.json|package\.json|project\.json|pyproject\.toml|build\.gradle(\.kts)?|pom\.xml|go\.mod|pubspec\.yaml)$/;

/** Of manifests in one directory, the one that names the component: component.json, then Nx's project.json. */
const rank = (manifest: string): number => (/(^|\/)component\.json$/.test(manifest) ? 2 : /(^|\/)project\.json$/.test(manifest) ? 1 : 0);

const SCRIPT = /\.(c|m)?[jt]sx?$/;

const NEXT_METHOD = /^(?:GET|HEAD|POST|PUT|PATCH|DELETE|OPTIONS)$/;

/**
 * The values an `export { a, b as c }` list exports: `a` and `c`, never the local name before an `as`; a type-only one
 * (`type H as GET`) exports no value, and is left out.
 */
const exportedNames = (list: string): string[] =>
  list
    .split(",")
    .map((spec) => spec.trim())
    .filter((spec) => spec && !/^type\s/.test(spec))
    .map((spec) => spec.split(/\s+as\s+/).pop()!.trim());

/** Whether a Python file imports one of `packages`: `from flask import ...`, `import os, flask.views as v`. */
function importsPackage(code: string, packages: string[]): boolean {
  const named = (module: string) => packages.includes(module.split(".")[0]!);
  for (const m of code.matchAll(/^[ \t]*from[ \t]+([\w.]+)[ \t]+import\b/gm)) if (named(m[1]!)) return true;
  for (const m of code.matchAll(/^[ \t]*import[ \t]+([^\n#;]+)/gm)) {
    if (m[1]!.split(",").some((item) => named(item.trim().split(/\s+/)[0] ?? ""))) return true;
  }
  return false;
}

/** The names a Python file binds to one of `classes` called (`app = Flask(__name__)`, `router = fastapi.APIRouter()`). */
const boundTo = (code: string, classes: string): Set<string> =>
  new Set([...code.matchAll(new RegExp(`^[ \\t]*([A-Za-z_]\\w*)[ \\t]*(?::[^=\\n]+)?=[ \\t]*(?:[A-Za-z_][\\w.]*\\.)?(?:${classes})[ \\t]*\\(`, "gm"))].map((m) => m[1]!));

/** Each style only in the files its extractor reads, so a Python decorator is not offered as an Express route. */
const ROUTE_STYLES: Array<{ style: string; re: RegExp; files: RegExp; accept?: (m: RegExpMatchArray) => boolean }> = [
  { style: "nest", re: /@(Get|Post|Put|Patch|Delete|Sse)\(\s*(["'`][^"'`]*["'`])?\s*\)/g, files: SCRIPT },
  { style: "express", re: /\b(?:app|router|server|fastify)\.(?:get|post|put|patch|delete|all)\(\s*["'`](\/[^"'`]*)/g, files: SCRIPT },
  { style: "fastapi", re: /@(?<fastapi>\w+)\.(?:get|post|put|patch|delete|api_route)\(\s*["'](\/[^"']*)/g, files: /\.py$/ },
  // Flask's and Quart's decorators, method shortcuts and `add_url_rule`, in a file that imports either.
  { style: "flask", re: /@(?<decorated>[A-Za-z_][\w.]*)\.(?:route|get|post|put|patch|delete)\(\s*["'](\/[^"']*)|(?<![\w.])(?<called>[A-Za-z_][\w.]*)\.add_url_rule\(\s*["'](\/[^"']*)/g, files: /\.py$/ },
  { style: "spring", re: /@(?:org\.springframework\.web\.bind\.annotation\.)?(?:Get|Post|Put|Delete|Patch|Request)Mapping\b/g, files: /\.(java|kt|kts)$/ },
  // App Router handlers, declared, re-exported by name or re-exported wholesale; Pages Router API routes' default export.
  {
    style: "next",
    re: /^[\t ]*export\s+(?:async\s+)?(?:function|const|let|var)\s+(GET|HEAD|POST|PUT|PATCH|DELETE|OPTIONS)\b|^[\t ]*export\s*\{([^}]*)\}|^[\t ]*export\s*\*\s*from\b/gm,
    files: /(?:^|\/)app\/(?:.*\/)?route\.(c|m)?[jt]sx?$/,
    accept: (m) => m[2] === undefined || exportedNames(m[2]).some((n) => NEXT_METHOD.test(n)),
  },
  // Pages: an App Router page, a Pages Router page or API route; each serves its default export.
  {
    style: "next",
    re: /^[\t ]*export\s+default\b|^[\t ]*export\s*\{([^}]*)\}/gm,
    files: /(?:^|\/)(?:app\/(?:.*\/)?page|pages\/(?!_app\.|_document\.|_error\.)[^]*)\.(c|m)?[jt]sx?$/,
    accept: (m) => m[1] === undefined || exportedNames(m[1]).includes("default"),
  },
  { style: "registration", re: /\b([A-Za-z_]\w*)\(\s*(?:[A-Za-z_][\w.]*\s*,\s*)?["'](?:GET|POST|PUT|PATCH|DELETE)["']\s*,\s*["'`](\/[^"'`]*)/g, files: /./ },
];

/**
 * A request given as an object: a generated client's `client.get({ url: "/x" })`, axios's request config. A member of a
 * type (`url: "/x"`) names a value instead (`typeMembers`).
 */
const URL_PROPERTY = /\burl\s*:\s*(["'`])\/[A-Za-z][^"'`]*\1/g;

/**
 * Where the members of a script's types (in a type literal or an interface) start: their meaning is a type, whatever
 * separates them.
 */
function typeMembers(file: string, text: string): Set<number> {
  const sf = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true, /x$/.test(file) ? ts.ScriptKind.TSX : ts.ScriptKind.TS);
  const starts = new Set<number>();
  const visit = (n: ts.Node): void => {
    if (ts.isPropertySignature(n)) starts.add(n.name.getStart(sf));
    ts.forEachChild(n, visit);
  };
  visit(sf);
  return starts;
}

const CALL_SHAPES = [
  /["'`](?:\$\{[^}]+\}|\$[A-Za-z_]\w*)\/[A-Za-z][^"'`]*["'`]/g,
  // fetch and the wrappers named after it: authFetch, fetchJson, useFetch.
  /\b(?:fetch\w*|\w*Fetch\w*)\(\s*["'`]\/[A-Za-z][^"'`]*/g,
  /\bpath:\s*["'`]\/[A-Za-z][^"'`]*/g,
  URL_PROPERTY,
  /\(\s*["'`]\/[A-Za-z][^"'`]*["'`]\s*,\s*["'](?:GET|POST|PUT|PATCH|DELETE)["']/g,
  /@\{\s*~?\/[A-Za-z][^}]*\}/g,
  // A Python f-string that joins a value to a path: f"{base}/orders".
  /\b(?:[fF][rR]?|[rR][fF])(?:"\{[^}"]+\}\/[A-Za-z][^"]*"|'\{[^}']+\}\/[A-Za-z][^']*')/g,
  /\b(?:action|formaction|data-[\w-]+-url)\s*=\s*["']?\/[A-Za-z]/gi,
];

/**
 * A verb call whose first argument is a path, type arguments allowed: Dio's `dio.get<T>("/x")`, `http.post("/x")`.
 * Not in JavaScript or TypeScript, where `app.get("/x")` registers a route, nor in a decorator such as FastAPI's.
 */
// A receiver that is a router registers a route (`router.get("/x", handler)` in Dart's shelf_router): not a request.
// A Dart cascade (`router..get(...)`, `Router()..get(...)`) registers on the receiver before the `..`.
const VERB_CALL = /(?<!@[\w.]*)(?:\b([A-Za-z_]\w*)\s*(?:\(\s*\))?\s*\.?)?\.(?:get|post|put|patch|delete)\s*(?:<[^()]*>\s*)?\(\s*["'`]\/[A-Za-z][^"'`]*/g;

/**
 * The names a script binds to an HTTP client, by the module it comes from: Angular's `HttpClient` from
 * `@angular/common/http` (`http: HttpClient`, `inject(HttpClient)`), and axios with the instances `create` makes. A
 * verb call on one of them is a request; on any other receiver in a script it may register a route.
 */
function httpClients(text: string): string[] {
  const names: string[] = [];
  if (/\bimport\s*(?:type\s+)?\{[^}]*\bHttpClient\b[^}]*\}\s*from\s*["']@angular\/common\/http["']/.test(text)) {
    for (const m of text.matchAll(/([A-Za-z_$][\w$]*)\s*[!?]?\s*:\s*HttpClient\b/g)) names.push(m[1]!);
    for (const m of text.matchAll(/([A-Za-z_$][\w$]*)\s*=\s*inject\(\s*HttpClient\s*\)/g)) names.push(m[1]!);
  }
  const axios = [
    ...[...text.matchAll(/\bimport\s+([A-Za-z_$][\w$]*)\s*(?:,\s*\{[^}]*\}\s*)?from\s*["']axios["']/g)].map((m) => m[1]!),
    ...[...text.matchAll(/([A-Za-z_$][\w$]*)\s*=\s*require\(\s*["']axios["']\s*\)/g)].map((m) => m[1]!),
  ];
  for (const a of axios) {
    names.push(a);
    for (const m of text.matchAll(new RegExp(`([A-Za-z_$][\\w$]*)\\s*=\\s*${a.replace(/\$/g, "\\$")}\\.create\\(`, "g"))) names.push(m[1]!);
  }
  return [...new Set(names)];
}

/** A verb call, type arguments allowed, on one of `names` (or `this.<name>`), whose first argument is a path. */
const clientCall = (names: string[]): RegExp =>
  new RegExp(
    `(?<![\\w$.])(?:this\\.)?(?:${names.map((n) => n.replace(/\$/g, "\\$")).join("|")})\\s*\\.\\s*(?:get|post|put|patch|delete|head|options|request)\\s*(?:<[^()]*>\\s*)?\\(\\s*["'\`]\\/[A-Za-z]`,
    "g",
  );

function ownerOf(file: string, roots: Array<{ name: string; path: string }>): string {
  let best: { name: string; path: string } | undefined;
  for (const r of roots) {
    if ((r.path === "" || file.startsWith(`${r.path}/`)) && (!best || r.path.length > best.path.length)) best = r;
  }
  return best?.name ?? "(none)";
}

function nameFrom(manifest: string, text: string | undefined, dir: string): string {
  if (manifest.endsWith(".json") && text) {
    try {
      const n = (JSON.parse(text) as { name?: unknown }).name;
      if (typeof n === "string" && n) return n.replace(/^@[^/]+\//, "");
    } catch {
      // not JSON; fall back to the directory name
    }
  }
  return dir.split("/").pop() || "root";
}

const dependsOn = (text: string | undefined, name: string): boolean => {
  try {
    const m = JSON.parse(text ?? "{}") as Record<string, unknown>;
    return ["dependencies", "devDependencies", "peerDependencies", "optionalDependencies"].some((k) => {
      const deps = m[k];
      return !!deps && typeof deps === "object" && Object.hasOwn(deps, name);
    });
  } catch {
    return false;
  }
};

/** A pubspec whose dependencies take `flutter` from the SDK: `dependencies: { flutter: { sdk: flutter } }`. */
const onFlutter = (text: string | undefined): boolean => {
  try {
    const pubspec = parse(text ?? "") as { dependencies?: { flutter?: { sdk?: unknown } } } | null;
    return pubspec?.dependencies?.flutter?.sdk === "flutter";
  } catch {
    return false;
  }
};

/**
 * The platform folders a cross-platform framework keeps beside an app and builds as part of it, each with a trailing
 * `/`: the host projects of a Flutter app or plugin (a pubspec.yaml on the Flutter SDK), the native projects of a React
 * Native app or library (a package.json depending on react-native) and of an Expo module (expo-module.config.json).
 * A manifest inside one belongs to that app's build, so it is not a component of its own.
 */
function platformFolders(source: Source, all: string[]): string[] {
  const out: string[] = [];
  for (const file of all) {
    const dir = dirname(file) === "." ? "" : `${dirname(file)}/`;
    const name = file.slice(dir.length);
    const folders =
      name === "pubspec.yaml" && onFlutter(source.read(file))
        ? ["android", "ios", "macos", "linux", "windows", "web"]
        : (name === "package.json" && dependsOn(source.read(file), "react-native")) || name === "expo-module.config.json"
          ? ["android", "ios"]
          : [];
    out.push(...folders.map((f) => `${dir}${f}/`));
  }
  return out;
}

/**
 * Components that would share a name, taken from the directory or the manifest, are named by as much of their path
 * above it as tells them apart from each other and from every other component (`mobile-app`, `catalog-app`), and say
 * so.
 */
function uniqueNames(components: Inventory["components"]): void {
  const groups = new Map<string, Inventory["components"]>();
  for (const c of components) (groups.get(c.name) ?? groups.set(c.name, []).get(c.name)!).push(c);
  for (const [name, group] of groups) {
    if (group.length < 2) continue;
    const others = new Set(components.filter((c) => c.name !== name).map((c) => c.name));
    const above = group.map((c) => {
      const segments = c.path.split("/").filter(Boolean);
      return segments[segments.length - 1] === name ? segments.slice(0, -1) : segments;
    });
    const longest = Math.max(...above.map((a) => a.length));
    const distinct = (names: string[]) => new Set(names).size === names.length && !names.some((n) => others.has(n));
    let names: string[] = [];
    for (let k = 1; k <= Math.max(longest, 1); k++) {
      names = above.map((a) => [...a.slice(Math.max(0, a.length - k)), name].join("-"));
      if (distinct(names)) break;
    }
    // Where the paths run out first (a root package named as a directory below it), a number tells them apart.
    const numbered = !distinct(names);
    if (numbered) {
      const used = new Set(others);
      names = names.map((n) => {
        let candidate = n;
        for (let i = 2; used.has(candidate); i++) candidate = `${n}-${i}`;
        used.add(candidate);
        return candidate;
      });
    }
    group.forEach((c, i) => {
      c.name = names[i]!;
      c.note = `named by its path: ${group.length} components would be named ${name}${numbered ? ", and their paths do not tell them apart, so they are numbered" : ""}`;
    });
  }
}

/**
 * A root manifest that only lists workspaces is the monorepo's tooling, not a component; so is the root package.json of
 * an Nx workspace whose projects are elsewhere, each with its project.json.
 */
function workspaceRoot(source: Source, manifest: string, all: string[]): boolean {
  if (manifest !== "package.json") return false;
  if (all.includes("pnpm-workspace.yaml")) return true;
  if (all.includes("nx.json") && !all.includes("project.json") && all.some((f) => f.endsWith("/project.json"))) return true;
  try {
    return (JSON.parse(source.read(manifest) ?? "{}") as { workspaces?: unknown }).workspaces !== undefined;
  } catch {
    return false;
  }
}

export function inventory(source: Source, exclude: string[]): Inventory {
  const skip = matcher(exclude);
  const all = source.list().filter((f) => !skip(f));

  // project.json is a manifest where nx.json says the repository is an Nx workspace.
  const nx = all.includes("nx.json");
  const manifestFiles = all.filter((f) => MANIFESTS.test(f) && (nx || !/(^|\/)project\.json$/.test(f)));
  if (manifestFiles.length) select(source, manifestFiles, []);
  const platforms = platformFolders(source, all);
  const byDir = new Map<string, Inventory["components"][number]>();
  for (const m of manifestFiles) {
    if (!m.includes("/") && workspaceRoot(source, m, all)) continue;
    if (platforms.some((p) => m.startsWith(p))) continue;
    // A manifest at the root makes the repository itself a component, at path "".
    const dir = dirname(m) === "." ? "" : dirname(m);
    const there = byDir.get(dir);
    if (there && rank(there.manifest) >= rank(m)) continue;
    byDir.set(dir, { name: nameFrom(m, source.read(m), dir), path: dir, manifest: m });
  }
  const components = [...byDir.values()].sort((a, b) => a.path.localeCompare(b.path));
  uniqueNames(components);

  // A file's package may use Next.js when the nearest package.json above it depends on next, or none says.
  const packages = new Set(all.filter((f) => f === "package.json" || f.endsWith("/package.json")));
  const mayUseNext = (file: string): boolean => {
    for (let dir = dirname(file); ; dir = dirname(dir)) {
      const manifest = dir === "." ? "package.json" : `${dir}/package.json`;
      if (packages.has(manifest)) return dependsOn(source.read(manifest), "next");
      if (dir === ".") return true;
    }
  };

  const code = select(source, [CODE], exclude);
  const routes: Inventory["routes"] = [];
  const calls: Inventory["calls"] = [];
  const apiDocuments: ApiDocument[] = [];
  for (const file of all.filter((f) => DOCUMENT_FILE.test(f))) {
    const text = source.read(file) ?? "";
    const start = documentStart(text);
    if (start !== undefined)
      apiDocuments.push({ component: ownerOf(file, components), kind: "file", location: file, convention: "committed", at: { file, line: lineOf(text, start) }, evidence: "text" });
  }
  for (const file of code) {
    const text = source.read(file);
    if (!text) continue;
    const component = ownerOf(file, components);
    if (/\.(c|m)?tsx?$/.test(file) && /SwaggerModule|swagger|openapi|api-docs/i.test(text)) apiDocuments.push(...servedDocuments(file, text, component));
    if (file.endsWith(".py") && text.includes("Spectacular")) apiDocuments.push(...spectacularDocuments(file, text, component));
    // An annotation a Java or Kotlin comment mentions (`each @RequestMapping method` in a Javadoc) maps nothing.
    const code = /\.(java|kt|kts)$/.test(file) ? withoutComments(file, text) : text;
    for (const { style, re, files, accept } of ROUTE_STYLES) {
      if (!files.test(file) || (style === "next" && !mayUseNext(file))) continue;
      // A Python file that imports Flask or Quart registers their routes; their shortcuts look like FastAPI's.
      // A Python file registers Flask's or Quart's routes where it imports either, FastAPI's where it imports FastAPI or
      // neither; in a file that imports both, a decorator on a name bound to the other framework's application or router
      // is that framework's.
      const flask = style === "flask" || style === "fastapi" ? importsPackage(code, ["flask", "quart"]) : false;
      if (style === "flask" && !flask) continue;
      if (style === "fastapi" && flask && !importsPackage(code, ["fastapi"])) continue;
      const other = style === "flask" ? boundTo(code, "FastAPI|APIRouter") : style === "fastapi" && flask ? boundTo(code, "Flask|Quart|Blueprint") : undefined;
      const receiverOf = (m: RegExpMatchArray) => m.groups?.decorated ?? m.groups?.called ?? m.groups?.fastapi ?? "";
      const hits = [...code.matchAll(re)].filter((m) => (!accept || accept(m)) && !other?.has(receiverOf(m)));
      if (!hits.length) continue;
      const first = hits[0]!;
      const label = style === "registration" ? `registration ${first[1]}` : style;
      routes.push({ component, file, style: label, count: hits.length, example: `${file}:${lineOf(text, first.index ?? 0)}` });
    }
    let count = 0;
    let firstAt: number | undefined;
    // The names the file binds to a `Router()`, besides the usual `app` and `router`.
    const routers = new Set(["app", "router", "_router", ...[...text.matchAll(/\b([A-Za-z_]\w*)\s*=\s*(?:new\s+)?(?:[A-Za-z_]\w*\.)*Router\s*\(/g)].map((m) => m[1]!)]);
    const clients = SCRIPT.test(file) ? httpClients(text) : [];
    const shapes = SCRIPT.test(file) ? [...CALL_SHAPES, ...(clients.length ? [clientCall(clients)] : [])] : [...CALL_SHAPES, VERB_CALL];
    let types: Set<number> | undefined;
    for (const re of shapes) {
      for (const m of text.matchAll(re)) {
        if (re === VERB_CALL && m[1] !== undefined && (routers.has(m[1]) || m[1] === "Router")) continue;
        if (re === URL_PROPERTY && SCRIPT.test(file) && (types ??= typeMembers(file, text)).has(m.index ?? 0)) continue;
        // Outside a script, as in a Vue or Svelte file's script block, a member ended by `;` is taken for a type's.
        if (re === URL_PROPERTY && !SCRIPT.test(file) && /^\s*;/.test(text.slice((m.index ?? 0) + m[0].length))) continue;
        count++;
        firstAt = Math.min(firstAt ?? Infinity, m.index ?? 0);
      }
    }
    if (count) calls.push({ component, file, count, example: `${file}:${lineOf(text, firstAt ?? 0)}` });
  }
  // What springdoc serves for each Maven or Gradle project, under the component its build file gives.
  const projects = new Set(manifestFiles.filter((f) => BUILD_FILE.test(f)).map((f) => (dirname(f) === "." ? "" : dirname(f))));
  for (const project of [...projects].sort()) {
    const component = ownerOf(project ? `${project}/` : "", components);
    apiDocuments.push(...springdocDocuments(source, project, exclude).documents.map((d) => ({ component, ...d })));
  }

  return { components, routes, calls, apiDocuments };
}

export function inventoryText(inv: Inventory): string {
  const lines: string[] = [];
  lines.push(`components (${inv.components.length}, from package manifests and Nx projects; list the ones to keep under components:)`);
  for (const c of inv.components) lines.push(`  ${c.name}  ${c.path}  ${c.manifest.split("/").pop()}${c.note ? `  (${c.note})` : ""}`);
  lines.push("", "route candidates (file, style, count, first)");
  for (const r of inv.routes) lines.push(`  ${r.component}  ${r.style}  ${r.count}  ${r.example}`);
  const byComponent = new Map<string, Inventory["calls"]>();
  for (const c of inv.calls) (byComponent.get(c.component) ?? byComponent.set(c.component, []).get(c.component)!).push(c);
  lines.push("", "client call candidates (paths joined to a base, fetch paths, path: and url: properties, a path then a method, verb calls on Angular's HttpClient and axios)");
  for (const [component, files] of byComponent) {
    const total = files.reduce((n, f) => n + f.count, 0);
    lines.push(`  ${component}: ${total} in ${files.length} files`);
    for (const f of [...files].sort((a, b) => b.count - a.count).slice(0, 8)) lines.push(`    ${f.count}  ${f.example}`);
  }
  lines.push("", "OpenAPI descriptions (component, kind, location, how found)");
  for (const d of inv.apiDocuments) lines.push(`  ${d.component}  ${d.kind}  ${d.location}  ${d.convention}  ${d.at.file}:${d.at.line}`);
  return `${lines.join("\n")}\n`;
}
