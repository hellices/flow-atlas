import { dirname } from "node:path";
import { DOCUMENT_FILE, documentStart, servedDocuments } from "./extract/apidocs.js";
import type { ApiDocument } from "./model.js";
import { lineOf, matcher, select, type Source } from "./source.js";

/**
 * Raw material for writing a configuration: where components, routes, client calls and versioned files appear to be.
 * It decides nothing; whoever writes the configuration chooses what to keep.
 */
export interface Inventory {
  components: Array<{ name: string; path: string; manifest: string }>;
  routes: Array<{ component: string; file: string; style: string; count: number; example: string }>;
  calls: Array<{ component: string; file: string; count: number; example: string }>;
  versions: Array<{ dir: string; pattern: string; families: number; files: number }>;
  activeLists: Array<{ file: string; names: number; dir: string }>;
  /** OpenAPI descriptions committed or served by code, by owning component. */
  apiDocuments: ApiDocument[];
}

const CODE = "**/*.{ts,tsx,js,mjs,cjs,kt,kts,java,swift,py,go,html,htm}";
const MANIFESTS = /(^|\/)(component\.json|package\.json|pyproject\.toml|build\.gradle\.kts|go\.mod)$/;

const ROUTE_STYLES: Array<{ style: string; re: RegExp }> = [
  { style: "nest", re: /@(Get|Post|Put|Patch|Delete|Sse)\(\s*(["'`][^"'`]*["'`])?\s*\)/g },
  { style: "express", re: /\b(?:app|router|server|fastify)\.(?:get|post|put|patch|delete|all)\(\s*["'`](\/[^"'`]*)/g },
  { style: "fastapi", re: /@\w+\.(?:get|post|put|patch|delete|api_route)\(\s*["'](\/[^"']*)/g },
  { style: "spring", re: /@(?:org\.springframework\.web\.bind\.annotation\.)?(?:Get|Post|Put|Delete|Patch|Request)Mapping\b/g },
  { style: "registration", re: /\b([A-Za-z_]\w*)\(\s*(?:[A-Za-z_][\w.]*\s*,\s*)?["'](?:GET|POST|PUT|PATCH|DELETE)["']\s*,\s*["'`](\/[^"'`]*)/g },
];

const CALL_SHAPES = [
  /["'`](?:\$\{[^}]+\}|\$[A-Za-z_]\w*)\/[A-Za-z][^"'`]*["'`]/g,
  /\bfetch\(\s*["'`]\/[A-Za-z][^"'`]*/g,
  /\bpath:\s*["'`]\/[A-Za-z][^"'`]*/g,
  /\(\s*["'`]\/[A-Za-z][^"'`]*["'`]\s*,\s*["'](?:GET|POST|PUT|PATCH|DELETE)["']/g,
  /@\{\s*~?\/[A-Za-z][^}]*\}/g,
  /\b(?:action|formaction|data-[\w-]+-url)\s*=\s*["']?\/[A-Za-z]/gi,
];

const VERSIONED = /^(.+)-v(\d+)(\.[\w.]+)$/;

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

/** A root manifest that only lists workspaces is the monorepo's tooling, not a component. */
function workspaceRoot(source: Source, manifest: string, all: string[]): boolean {
  if (manifest !== "package.json") return false;
  if (all.includes("pnpm-workspace.yaml")) return true;
  try {
    return (JSON.parse(source.read(manifest) ?? "{}") as { workspaces?: unknown }).workspaces !== undefined;
  } catch {
    return false;
  }
}

export function inventory(source: Source, exclude: string[]): Inventory {
  const skip = matcher(exclude);
  const all = source.list().filter((f) => !skip(f));

  const manifestFiles = all.filter((f) => MANIFESTS.test(f));
  if (manifestFiles.length) select(source, manifestFiles, []);
  const byDir = new Map<string, { name: string; path: string; manifest: string }>();
  for (const m of manifestFiles) {
    if (!m.includes("/") && workspaceRoot(source, m, all)) continue;
    // A manifest at the root makes the repository itself a component, at path "".
    const dir = dirname(m) === "." ? "" : dirname(m);
    const prefer = /component\.json/.test(m);
    if (byDir.has(dir) && !prefer) continue;
    byDir.set(dir, { name: nameFrom(m, source.read(m), dir), path: dir, manifest: m });
  }
  const components = [...byDir.values()].sort((a, b) => a.path.localeCompare(b.path));

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
    for (const { style, re } of ROUTE_STYLES) {
      const hits = [...text.matchAll(re)];
      if (!hits.length) continue;
      const first = hits[0]!;
      const label = style === "registration" ? `registration ${first[1]}` : style;
      routes.push({ component, file, style: label, count: hits.length, example: `${file}:${lineOf(text, first.index ?? 0)}` });
    }
    let count = 0;
    let firstAt: number | undefined;
    for (const re of CALL_SHAPES) {
      for (const m of text.matchAll(re)) {
        count++;
        firstAt = Math.min(firstAt ?? Infinity, m.index ?? 0);
      }
    }
    if (count) calls.push({ component, file, count, example: `${file}:${lineOf(text, firstAt ?? 0)}` });
  }

  const groups = new Map<string, { dir: string; pattern: string; families: Set<string>; files: string[] }>();
  for (const f of all) {
    const base = f.split("/").pop()!;
    const m = VERSIONED.exec(base);
    if (!m) continue;
    const dir = dirname(f);
    const key = `${dir}|${m[3]}`;
    const g = groups.get(key) ?? { dir, pattern: `(.+)-v(\\d+)${m[3]!.replace(/\./g, "\\.")}`, families: new Set(), files: [] };
    g.families.add(m[1]!);
    g.files.push(base);
    groups.set(key, g);
  }
  const versions = [...groups.values()]
    .filter((g) => g.files.length >= 2)
    .map((g) => ({ dir: g.dir, pattern: g.pattern, families: g.families.size, files: g.files.length }))
    .sort((a, b) => b.files - a.files);

  const jsonFiles = all.filter((f) => f.endsWith(".json") && !VERSIONED.test(f.split("/").pop()!));
  const activeLists: Inventory["activeLists"] = [];
  if (groups.size) {
    // A list may sit anywhere under the parent of the versioned directory; a top-level directory's parent is the root.
    const under = (f: string, dir: string) => dir === "." || dir === "" || f.startsWith(`${dir}/`);
    const candidates = jsonFiles.filter((f) => versions.some((v) => under(f, dirname(v.dir))));
    select(source, candidates, []);
    // Names are matched within one directory's group, so the same file name in two directories is not confused.
    const shared = (a: string, b: string) => {
      const x = a.split("/");
      const y = b.split("/");
      let n = 0;
      while (n < x.length && n < y.length && x[n] === y[n]) n++;
      return n;
    };
    for (const f of candidates) {
      const text = source.read(f) ?? "";
      let best: { dir: string; names: number; near: number } | undefined;
      for (const g of groups.values()) {
        const names = new Set(g.files.filter((n) => text.includes(`"${n}"`))).size;
        if (names < 2) continue;
        const near = shared(dirname(f), g.dir);
        if (!best || names > best.names || (names === best.names && near > best.near)) best = { dir: g.dir, names, near };
      }
      if (best) activeLists.push({ file: f, names: best.names, dir: best.dir });
    }
  }

  return { components, routes, calls, versions, activeLists, apiDocuments };
}

export function inventoryText(inv: Inventory): string {
  const lines: string[] = [];
  lines.push(`components (${inv.components.length}, from manifests)`);
  for (const c of inv.components) lines.push(`  ${c.name}  ${c.path}  ${c.manifest.split("/").pop()}`);
  lines.push("", "route candidates (file, style, count, first)");
  for (const r of inv.routes) lines.push(`  ${r.component}  ${r.style}  ${r.count}  ${r.example}`);
  const byComponent = new Map<string, Inventory["calls"]>();
  for (const c of inv.calls) (byComponent.get(c.component) ?? byComponent.set(c.component, []).get(c.component)!).push(c);
  lines.push("", "client call candidates (paths joined to a base, fetch paths, path: properties, a path then a method)");
  for (const [component, files] of byComponent) {
    const total = files.reduce((n, f) => n + f.count, 0);
    lines.push(`  ${component}: ${total} in ${files.length} files`);
    for (const f of [...files].sort((a, b) => b.count - a.count).slice(0, 8)) lines.push(`    ${f.count}  ${f.example}`);
  }
  lines.push("", "versioned files (directory, pattern, families, files)");
  for (const v of inv.versions) lines.push(`  ${v.dir}  ${v.pattern}  ${v.families}  ${v.files}`);
  lines.push("", "lists naming versioned files (active-list candidates)");
  for (const a of inv.activeLists) lines.push(`  ${a.file}  names ${a.names} from ${a.dir}`);
  lines.push("", "OpenAPI descriptions (component, kind, location, how found)");
  for (const d of inv.apiDocuments) lines.push(`  ${d.component}  ${d.kind}  ${d.location}  ${d.convention}  ${d.at.file}:${d.at.line}`);
  return `${lines.join("\n")}\n`;
}
