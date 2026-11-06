import { dirname } from "node:path";
import { isMap, isScalar, isSeq, parseAllDocuments } from "yaml";
import type { ApiDocument } from "../model.js";
import { joinRoute } from "../paths.js";
import { GitRefSource, lineOf, matcher, type Source } from "../source.js";
import { withoutComments } from "./calls.js";
import { groupedOpenApis } from "./spring.js";

/** The build files that make a directory a Maven or Gradle project: one application or library, with its own classpath. */
export const BUILD_FILE = /(^|\/)(pom\.xml|build\.gradle(\.kts)?)$/;

/** A springdoc-openapi artifact: Maven coordinates (`springdoc-openapi-starter-webmvc-ui`) or a Gradle catalog accessor (`libs.springdoc.openapi...`). */
const SPRINGDOC = /springdoc[-.]openapi/;

/**
 * The settings read, by their canonical name. Spring Boot binds `apiDocs`, `api_docs` and `api-docs` alike (relaxed
 * binding), so names are compared lower-cased without `-` and `_`.
 */
const PATH = "springdoc.api-docs.path";
const ENABLED = "springdoc.api-docs.enabled";
const DEFAULT_DOCS = "springdoc.enable-default-api-docs";
const MANAGEMENT = "springdoc.use-management-port";
const CONTEXT_PATH = "server.servlet.context-path";
const BASE_PATH = "spring.webflux.base-path";
const GROUP = /^springdoc\.groupconfigs\[(\d+)\]\.group$/;
const READ = [PATH, ENABLED, DEFAULT_DOCS, MANAGEMENT, CONTEXT_PATH, BASE_PATH];
const relaxed = (key: string): string => key.toLowerCase().replace(/[-_]/g, "");
const canonical = new Map(READ.map((k) => [relaxed(k), k]));

interface Setting {
  key: string;
  value: string;
  file: string;
  line: number;
}

/** One document of a configuration file, and the profile or platform it applies under; none for always. */
interface Part {
  settings: Setting[];
  when?: string;
}

/** The read settings of a YAML file, a part per `---` document, keys flattened as Spring Boot does (`a.b[0].c`). */
function yamlParts(file: string, text: string): Part[] {
  return parseAllDocuments(text).flatMap((doc) => {
    if (!("contents" in doc) || doc.errors.length) return [];
    const settings: Setting[] = [];
    const walk = (node: unknown, key: string): void => {
      if (isMap(node)) for (const p of node.items) walk(p.value, `${key ? `${key}.` : ""}${isScalar(p.key) ? String(p.key.value) : ""}`);
      else if (isSeq(node)) node.items.forEach((item, i) => walk(item, `${key}[${i}]`));
      else if (isScalar(node)) {
        const v = node.value;
        const value = typeof v === "string" || typeof v === "number" || typeof v === "boolean" || typeof v === "bigint" ? String(v) : "";
        settings.push({ key, value, file, line: lineOf(text, node.range?.[0] ?? 0) });
      }
    };
    walk(doc.contents, "");
    return [part(settings)];
  });
}

/** The settings of a `.properties` file, a part per `#---` document: `key=value`, `key: value` or `key value`, lines continued with `\`. */
function propertiesParts(file: string, text: string): Part[] {
  const parts: Setting[][] = [[]];
  const lines = text.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const start = i;
    let line = lines[i]!.replace(/\r$/, "").trimStart();
    if (/^[#!]---\s*$/.test(line)) {
      parts.push([]);
      continue;
    }
    if (!line || line.startsWith("#") || line.startsWith("!")) continue;
    while (/(?<!\\)(?:\\\\)*\\$/.test(line) && i + 1 < lines.length) line = line.slice(0, -1) + lines[++i]!.replace(/\r$/, "").trimStart();
    const m = /^((?:\\.|[^\s:=\\])+)\s*[:=]?\s*(.*)$/.exec(line);
    if (!m) continue;
    const unescape = (s: string) => s.replace(/\\(.)/g, "$1");
    parts.at(-1)!.push({ key: unescape(m[1]!), value: unescape(m[2]!).trimEnd(), file, line: start + 1 });
  }
  return parts.map(part);
}

/** A document that activates only under a profile or a cloud platform (`spring.config.activate.*`, or `spring.profiles` before Spring Boot 2.4). */
function part(settings: Setting[]): Part {
  const on = (name: string) => settings.find((s) => relaxed(s.key) === relaxed(name))?.value;
  const profile = on("spring.config.activate.on-profile") ?? on("spring.profiles");
  const platform = on("spring.config.activate.on-cloud-platform");
  return { settings, ...(profile !== undefined ? { when: `the profile ${profile}` } : platform !== undefined ? { when: `the cloud platform ${platform}` } : {}) };
}

/** The name a setting read here goes by, or undefined for any other setting. */
function readName(key: string): string | undefined {
  const k = relaxed(key);
  const group = GROUP.exec(k);
  return group ? `springdoc.group-configs[${group[1]}].group` : canonical.get(k);
}

/** XML comments blanked, as `withoutComments` blanks Java's, so offsets and lines stay. */
const withoutXmlComments = (text: string): string => text.replace(/<!--[\s\S]*?-->/g, (c) => c.replace(/[^\n]/g, " "));

/**
 * The OpenAPI documents springdoc-openapi serves for the Maven or Gradle project at `module` ("" for the repository
 * root), as paths on the server, and what could not be read (`limits`, to be prefixed with the components served).
 *
 * springdoc counts as present when the project's own build file names a springdoc-openapi artifact (adding it serves
 * the document "with no additional configuration": springdoc.org, "Getting Started") or its main code builds a
 * `GroupedOpenApi`, which compiles only with springdoc on the classpath. Then, after springdoc.org:
 *
 * - "Getting Started" and "springdoc-openapi core properties": the document at `/v3/api-docs`, or at
 *   `springdoc.api-docs.path`; none when `springdoc.api-docs.enabled` is false; not the default one when
 *   `springdoc.enable-default-api-docs` is false. All of them behind `server.servlet.context-path` (FAQ "What is the URL
 *   of the swagger-ui, when I set a different context-path?"), or WebFlux's `spring.webflux.base-path`.
 * - FAQ "How can I define multiple OpenAPI definitions in one Spring Boot project?": a document per `GroupedOpenApi`
 *   group at `<api-docs path>/<group>`; FAQ "How can I define groups using application.yml?": the same for each
 *   `springdoc.group-configs[n].group`.
 *
 * Settings are read from `application.properties` and `application.yml` (`.yaml`) under `src/main/resources` and its
 * `config/`, with Spring Boot's precedence: `.properties` over YAML, `config/` over both, a later YAML document over an
 * earlier one, a list replaced whole. A profile's file (`application-dev.yml`) or document applies only when the profile
 * is active, which is decided at launch; one that sets these settings is reported, not read. A value with a placeholder
 * (`${...}`) is resolved at run time and is not read either. The `.yaml` twin of each document (`/v3/api-docs.yaml`) and
 * swagger-ui pages are the same documents and are not listed.
 */
export function springdocDocuments(source: Source, module: string, exclude: string[]): { documents: Array<Omit<ApiDocument, "component">>; limits: string[] } {
  const skip = matcher(exclude);
  const prefix = module ? `${module}/` : "";
  const all = source.list().filter((f) => f.startsWith(prefix) && !skip(f));
  const modules = new Set(all.filter((f) => BUILD_FILE.test(f)).map((f) => (dirname(f) === "." ? "" : dirname(f))));
  // A file of a project nested in this one belongs to that project.
  const own = (f: string) => ![...modules].some((m) => m.length > module.length && f.startsWith(`${m}/`));
  const limits: string[] = [];
  const builds = all.filter((f) => BUILD_FILE.test(f) && dirname(f) === (module || "."));
  const code = all.filter((f) => f.startsWith(`${prefix}src/main/`) && /\.(java|kt)$/.test(f) && own(f));
  const resources = `${prefix}src/main/resources/`;
  const configs = all.filter((f) => f.startsWith(resources) && /^(config\/)?application(-[^/]+)?\.(properties|ya?ml)$/.test(f.slice(resources.length)));
  if (source instanceof GitRefSource) source.preload([...builds, ...code, ...configs]);

  let dependency: { file: string; line: number } | undefined;
  for (const file of builds) {
    const text = source.read(file) ?? "";
    const at = (file.endsWith(".xml") ? withoutXmlComments(text) : withoutComments(file, text)).search(SPRINGDOC);
    if (at >= 0 && !dependency) dependency = { file, line: lineOf(text, at) };
  }
  const built: Array<{ group?: string; expression: string; file: string; line: number }> = [];
  for (const file of code) {
    const text = source.read(file);
    if (text?.includes("GroupedOpenApi")) built.push(...groupedOpenApis(file, text).map((g) => ({ ...g, file })));
  }
  if (!dependency && built.length === 0) return { documents: [], limits };

  const settings = new Map<string, Setting>();
  let groups: Setting[] = [];
  const conditional: Array<Setting & { when: string }> = [];
  // Lowest precedence first: YAML, then properties, at the classpath root and then in config/.
  const rank = (f: string) => (f.slice(resources.length).startsWith("config/") ? 2 : 0) + (f.endsWith(".properties") ? 1 : 0);
  for (const file of [...configs].sort((a, b) => rank(a) - rank(b) || (a < b ? -1 : 1))) {
    const text = source.read(file) ?? "";
    const profile = /application-([^/]+)\.\w+$/.exec(file)?.[1];
    for (const p of file.endsWith(".properties") ? propertiesParts(file, text) : yamlParts(file, text)) {
      const when = profile !== undefined ? `the profile ${profile}` : p.when;
      const read = p.settings.filter((s) => readName(s.key));
      if (when !== undefined) {
        conditional.push(...read.map((s) => ({ ...s, when })));
        continue;
      }
      for (const s of read) if (!GROUP.test(relaxed(s.key))) settings.set(readName(s.key)!, s);
      const listed = read.filter((s) => GROUP.test(relaxed(s.key)));
      if (listed.length) groups = listed;
    }
  }
  // In file order, whatever the precedence the files were read in.
  conditional.sort((a, b) => (a.file < b.file ? -1 : a.file > b.file ? 1 : a.line - b.line));
  for (const s of conditional) limits.push(`${s.file}:${s.line} sets ${readName(s.key)} for ${s.when}, which is chosen at launch; it is not read`);

  const unresolved = (s: Setting) => s.value.includes("${");
  const stopping = [MANAGEMENT, ENABLED, DEFAULT_DOCS, CONTEXT_PATH, BASE_PATH, PATH].map((k) => settings.get(k)).filter((s): s is Setting => !!s && unresolved(s));
  if (stopping.length) {
    for (const s of stopping)
      limits.push(`${s.file}:${s.line} sets ${readName(s.key)} to ${s.value}, resolved at run time; the documents springdoc serves are not read`);
    return { documents: [], limits };
  }
  const management = settings.get(MANAGEMENT);
  if (management?.value.toLowerCase() === "true") {
    limits.push(`${management.file}:${management.line} serves springdoc's documents on the management port (${MANAGEMENT}); they are not read`);
    return { documents: [], limits };
  }
  if (settings.get(ENABLED)?.value.toLowerCase() === "false") return { documents: [], limits };

  const path = settings.get(PATH);
  const base = joinRoute(settings.get(CONTEXT_PATH)?.value ?? settings.get(BASE_PATH)?.value ?? "", path?.value ?? "/v3/api-docs");
  const documents: Array<Omit<ApiDocument, "component">> = [];
  const add = (location: string, convention: string, at: { file: string; line: number }, evidence: ApiDocument["evidence"]) => {
    if (!documents.some((d) => d.location === location)) documents.push({ kind: "served", location, convention, at, evidence });
  };
  if (settings.get(DEFAULT_DOCS)?.value.toLowerCase() !== "false") {
    if (path) add(base, "springdoc api-docs.path", { file: path.file, line: path.line }, "static");
    else if (dependency) add(base, "springdoc default", dependency, "text");
    else add(base, "springdoc default", { file: built[0]!.file, line: built[0]!.line }, "static");
  }
  for (const g of groups) {
    if (unresolved(g)) limits.push(`${g.file}:${g.line} sets ${readName(g.key)} to ${g.value}, resolved at run time; that group's document is not read`);
    else if (g.value) add(`${base}/${g.value}`, "springdoc group-configs", { file: g.file, line: g.line }, "static");
  }
  for (const g of built) {
    if (g.group) add(`${base}/${g.group}`, "springdoc group", { file: g.file, line: g.line }, "static");
    else
      limits.push(
        `${g.file}:${g.line} builds a GroupedOpenApi whose group the file does not spell out (${g.expression || "not set in the builder's chain"}); that group's document is not read`,
      );
  }
  return { documents: documents.sort((a, b) => a.location.localeCompare(b.location)), limits };
}
