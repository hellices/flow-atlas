import { dirname } from "node:path";
import { isAlias, isMap, isScalar, isSeq, parseAllDocuments } from "yaml";
import type { ApiDocument } from "../model.js";
import { joinRoute } from "../paths.js";
import { GitRefSource, lineOf, matcher, type Source } from "../source.js";
import { withoutComments } from "./calls.js";
import { groupedOpenApis, type GroupedOpenApiBuild } from "./spring.js";

/** The build files that make a directory a Maven or Gradle project: one application or library, with its own classpath. */
export const BUILD_FILE = /(^|\/)(pom\.xml|build\.gradle(\.kts)?)$/;

/** A springdoc-openapi artifact: Maven coordinates (`springdoc-openapi-starter-webmvc-ui`) or a Gradle catalog accessor (`libs.springdoc.openapi...`). */
const SPRINGDOC = /springdoc[-.]openapi/g;

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
/**
 * A switch springdoc reads in a SpEL condition or compares with `"true"`/`"false"` (`enable-default-api-docs`,
 * `use-management-port`): only true or false, in any case, mean that there; with any other value the application
 * fails to start or moves the documents off the main port. Undefined when unset, null for any other value.
 */
const flag = (s: { value: string } | undefined): boolean | null | undefined => (s === undefined ? undefined : /^true$/i.test(s.value) ? true : /^false$/i.test(s.value) ? false : null);
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
    const stack = new Set<unknown>();
    // `at` is the alias a value was reached through: the place that sets it here.
    const walk = (node: unknown, key: string, at?: number): void => {
      if (stack.has(node)) return;
      stack.add(node);
      const line = (n: { range?: [number, number, number] | null }) => lineOf(text, at ?? n.range?.[0] ?? 0);
      if (isAlias(node)) walk(node.resolve(doc), key, at ?? node.range?.[0]);
      else if (isMap(node)) {
        // Merge keys (`<<: *base`) first, the earlier of several winning, so the map's own keys override them.
        const merges = node.items.filter((p) => isScalar(p.key) && p.key.value === "<<");
        for (const p of merges) {
          const from = (p.value as { range?: [number, number, number] | null } | null)?.range?.[0];
          for (const source of (isSeq(p.value) ? [...p.value.items] : [p.value]).reverse()) walk(source, key, at ?? from);
        }
        for (const p of node.items) if (!merges.includes(p)) walk(p.value, `${key ? `${key}.` : ""}${isScalar(p.key) ? String(p.key.value) : ""}`, at);
      }
      // An empty list is a value of its own, "" (Spring's YamlProcessor), so it replaces a list set with less precedence.
      else if (isSeq(node) && node.items.length === 0) settings.push({ key, value: "", file, line: line(node) });
      else if (isSeq(node)) node.items.forEach((item, i) => walk(item, `${key}[${i}]`, at));
      else if (isScalar(node)) {
        const v = node.value;
        const value = typeof v === "string" || typeof v === "number" || typeof v === "boolean" || typeof v === "bigint" ? String(v) : "";
        settings.push({ key, value, file, line: line(node) });
      }
      stack.delete(node);
    };
    walk(doc.contents, "");
    return [part(settings)];
  });
}

/** `.properties` escapes decoded as `java.util.Properties.load` does: `\uXXXX`, `\t`, `\n`, `\r`, `\f`, any other character as itself. */
const ESCAPES: Record<string, string> = { t: "\t", n: "\n", r: "\r", f: "\f" };
const unescape = (s: string): string =>
  s.replace(/\\(u[0-9a-fA-F]{4}|[\s\S])/g, (_, e: string) => (e.length === 5 ? String.fromCharCode(parseInt(e.slice(1), 16)) : (ESCAPES[e] ?? e)));

/**
 * The settings of a `.properties` file, a part per `#---` document: `key=value`, `key: value` or `key value`, lines
 * continued with `\`. A `\u` without four hex digits makes the file one Spring Boot cannot load ("Malformed \uxxxx
 * encoding"): `malformed` is then its line, and nothing of the file is read.
 */
function propertiesParts(file: string, text: string): Part[] | { malformed: number } {
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
    if (/(?<!\\)(?:\\\\)*\\u(?![0-9a-fA-F]{4})/.test(line)) return { malformed: start + 1 };
    const m = /^((?:\\.|[^\s:=\\])+)\s*[:=]?\s*(.*)$/.exec(line);
    if (!m) continue;
    parts.at(-1)!.push({ key: unescape(m[1]!), value: unescape(m[2]!).trimEnd(), file, line: start + 1 });
  }
  return parts.map(part);
}

/**
 * A document of settings, a name set twice keeping its last value as Spring Boot's loaders do; and the profile or cloud
 * platform it activates under (`spring.config.activate.*`, or `spring.profiles` before Spring Boot 2.4).
 */
function part(written: Setting[]): Part {
  const last = new Map<string, Setting>();
  for (const s of written) {
    last.delete(relaxed(s.key));
    last.set(relaxed(s.key), s);
  }
  const settings = [...last.values()];
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

/** Maven scopes that put a dependency on the application's runtime classpath (Maven, "Dependency Scope"). */
const MAVEN_RUNTIME = new Set(["", "compile", "runtime"]);

/**
 * Where a `pom.xml` declares a springdoc-openapi artifact as one of the project's own dependencies (`project/dependencies`),
 * in a scope the application runs with: not in `dependencyManagement` (versions only), a plugin's dependencies, or the
 * `test` and `provided` scopes. `profile` is one declared in a `<profile>`, which is activated at build time.
 */
function mavenSpringdoc(text: string): { at?: number; artifact?: string; profile?: number } {
  const xml = withoutXmlComments(text);
  const out: { at?: number; artifact?: string; profile?: number } = {};
  const stack: string[] = [];
  let content = 0;
  let dependency: { artifact?: string; at?: number; scope?: string } | undefined;
  for (const m of xml.matchAll(/<(\/?)([A-Za-z_][\w.:-]*)[^>]*?(\/?)>/g)) {
    const [whole, close, name, empty] = m;
    const at = m.index ?? 0;
    if (empty) continue;
    if (!close) {
      stack.push(name!);
      content = at + whole.length;
      if (name === "dependency") dependency = {};
      continue;
    }
    const inDependency = dependency && stack.at(-2) === "dependency";
    if (inDependency && name === "artifactId") Object.assign(dependency!, { artifact: xml.slice(content, at).trim(), at: content });
    if (inDependency && name === "scope") dependency!.scope = xml.slice(content, at).trim();
    if (name === "dependency" && dependency) {
      const path = stack.join("/");
      const springdoc = /^springdoc-openapi-/.test(dependency.artifact ?? "") && !/-(bom|maven-plugin)$/.test(dependency.artifact!);
      if (springdoc && MAVEN_RUNTIME.has(dependency.scope ?? "")) {
        if (path === "project/dependencies/dependency" && out.at === undefined) Object.assign(out, { at: dependency.at, artifact: dependency.artifact });
        else if (path === "project/profiles/profile/dependencies/dependency") out.profile ??= dependency.at;
      }
      dependency = undefined;
    }
    stack.pop();
  }
  return out;
}

/** Gradle configurations on the main runtime classpath (Gradle, "The Java Plugin" and "The Java Library Plugin"). */
const GRADLE_RUNTIME = new Set(["implementation", "api", "runtimeOnly", "compile", "runtime"]);

/** The unclosed `(`, `[` and `{` around `at`, innermost first. */
function openersAround(code: string, at: number): number[] {
  const out: number[] = [];
  let depth = 0;
  for (let i = at - 1; i >= 0; i--) {
    const c = code[i]!;
    if (c === ")" || c === "]" || c === "}") depth++;
    else if (c === "(" || c === "[" || c === "{") {
      if (depth === 0) out.push(i);
      else depth--;
    }
  }
  return out;
}

/**
 * Where a Gradle build file declares a springdoc-openapi artifact in a configuration the application runs with
 * (`implementation`, `api`, `runtimeOnly`), directly in its own `dependencies` block: not `testImplementation`,
 * `compileOnly` or Spring Boot's `developmentOnly`, a `platform(...)` BOM, a plugin id, or a `buildscript` or
 * `subprojects` block, which do not put it on this project's runtime classpath.
 */
function gradleSpringdoc(file: string, text: string): { at?: number; artifact?: string } {
  const code = withoutComments(file, text);
  for (const m of code.matchAll(SPRINGDOC)) {
    const at = m.index ?? 0;
    const openers = openersAround(code, at);
    const call = openers[0] !== undefined && code[openers[0]] === "(" ? openers[0] : undefined;
    // `implementation("...")`, or Groovy's `implementation '...'` and `api group: ..., name: '...'`.
    const configuration =
      call !== undefined
        ? /([A-Za-z_]\w*)\s*$/.exec(code.slice(0, call))?.[1]
        : /^\s*([A-Za-z_]\w*)\s/.exec(code.slice(code.lastIndexOf("\n", at) + 1, at))?.[1];
    const blocks = openers.filter((o) => code[o] === "{").map((o) => /([A-Za-z_]\w*)\s*(?:\([^()]*\))?\s*$/.exec(code.slice(0, o))?.[1]);
    if (GRADLE_RUNTIME.has(configuration ?? "") && blocks[0] === "dependencies" && !blocks.some((b) => b === "buildscript" || b === "subprojects"))
      return { at, artifact: /^[\w.:-]+/.exec(code.slice(at))![0] };
  }
  return {};
}

/**
 * The web stack a springdoc artifact is for: its WebMvc starters (and 1.x `springdoc-openapi-ui`, `-webmvc-core`) run in
 * a Servlet application, its WebFlux ones in a reactive one. The base path in front of every route is that stack's own
 * setting: `server.servlet.context-path` for Servlet, `spring.webflux.base-path` for WebFlux (Spring Boot, "Common
 * Application Properties"); the other one does nothing there.
 */
function webStack(artifact: string | undefined): "servlet" | "reactive" | undefined {
  if (!artifact) return undefined;
  if (/webflux/.test(artifact)) return "reactive";
  return /webmvc|^springdoc[-.]openapi[-.]ui(?![\w-])/.test(artifact) ? "servlet" : undefined;
}

/** The package a Java or Kotlin file declares; "" for the default package. */
const packageOf = (code: string): string => /^\s*package\s+([\w.]+)/m.exec(code)?.[1] ?? "";

/**
 * The OpenAPI documents springdoc-openapi serves for the Maven or Gradle project at `module` ("" for the repository
 * root), as paths on the server, and what could not be read (`limits`, to be prefixed with the components served).
 *
 * springdoc counts as present when the project's own build file puts a springdoc-openapi artifact on the application's
 * runtime classpath (adding it serves the document "with no additional configuration": springdoc.org, "Getting
 * Started"), or its main code builds a `GroupedOpenApi`, which compiles only with springdoc on the classpath. Then,
 * after springdoc.org:
 *
 * - "Getting Started" and "springdoc-openapi core properties": the document at `/v3/api-docs`, or at
 *   `springdoc.api-docs.path`; none when `springdoc.api-docs.enabled` is false; not the default one when
 *   `springdoc.enable-default-api-docs` is false. All of them behind `server.servlet.context-path` (FAQ "What is the URL
 *   of the swagger-ui, when I set a different context-path?") in a Servlet application, `spring.webflux.base-path` in
 *   a WebFlux one, the stack read from the springdoc starter (`webStack`).
 * - FAQ "How can I define multiple OpenAPI definitions in one Spring Boot project?": a document per `GroupedOpenApi`
 *   bean's group at `<api-docs path>/<group>`. A builder counts as a bean when a `@Bean` method of a component class
 *   (`@Configuration`, `@SpringBootApplication` or another stereotype) builds it, in the package of a
 *   `@SpringBootApplication` or below, which Spring Boot scans by default; any other builder, or a project that sets its
 *   own scan packages, is reported; FAQ "How can I define groups using application.yml?": the same for each
 *   `springdoc.group-configs[n].group`.
 *
 * Settings are read from `application.properties` and `application.yml` (`.yaml`) under `src/main/resources` and its
 * `config/`, with Spring Boot's precedence: `.properties` over YAML, `config/` over both, a later YAML document over an
 * earlier one, a list replaced whole (an empty one too), a name set twice keeping its last value; YAML aliases and
 * merge keys resolved, `.properties` escapes decoded. A profile's file (`application-dev.yml`) or document applies only when the profile
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
  let stack: ReturnType<typeof webStack>;
  const profiled: Array<{ file: string; line: number }> = [];
  for (const file of builds) {
    const text = source.read(file) ?? "";
    const found: { at?: number; artifact?: string; profile?: number } = file.endsWith(".xml") ? mavenSpringdoc(text) : gradleSpringdoc(file, text);
    if (found.at !== undefined && !dependency) {
      dependency = { file, line: lineOf(text, found.at) };
      stack = webStack(found.artifact);
    }
    if (found.profile !== undefined) profiled.push({ file, line: lineOf(text, found.profile) });
  }
  // Applications and where Spring Boot scans for components from them; any other scan setting leaves registration open.
  const built: Array<GroupedOpenApiBuild & { file: string; package: string }> = [];
  const applications: string[] = [];
  let scanSet: { file: string; line: number } | undefined;
  for (const file of code) {
    const text = source.read(file) ?? "";
    if (!/GroupedOpenApi|SpringBootApplication|ComponentScan/.test(text)) continue;
    const plain = withoutComments(file, text);
    const pkg = packageOf(plain);
    for (const m of plain.matchAll(/@(?:[\w.]*\.)?(SpringBootApplication|ComponentScan)\b(\s*\([^)]*\))?/g)) {
      if (m[1] === "SpringBootApplication") applications.push(pkg);
      if (m[1] === "ComponentScan" || /scanBasePackage/.test(m[2] ?? "")) scanSet ??= { file, line: lineOf(text, m.index ?? 0) };
    }
    if (text.includes("GroupedOpenApi")) built.push(...groupedOpenApis(file, text).map((g) => ({ ...g, file, package: pkg })));
  }
  if (!dependency) for (const p of profiled) limits.push(`${p.file}:${p.line} names springdoc in a Maven profile, which is activated at build time; it is not read`);
  if (!dependency && built.length === 0) return { documents: [], limits };

  const settings = new Map<string, Setting>();
  let groups: Setting[] = [];
  const conditional: Array<Setting & { when: string }> = [];
  let broken: string | undefined;
  // Lowest precedence first: YAML, then properties, at the classpath root and then in config/.
  const rank = (f: string) => (f.slice(resources.length).startsWith("config/") ? 2 : 0) + (f.endsWith(".properties") ? 1 : 0);
  for (const file of [...configs].sort((a, b) => rank(a) - rank(b) || (a < b ? -1 : 1))) {
    const text = source.read(file) ?? "";
    const profile = /application-([^/]+)\.\w+$/.exec(file)?.[1];
    const parts = file.endsWith(".properties") ? propertiesParts(file, text) : yamlParts(file, text);
    if (!Array.isArray(parts)) {
      if (profile !== undefined) limits.push(`${file}:${parts.malformed} has a malformed \\uxxxx escape, so Spring Boot cannot load the file under the profile ${profile}; it is not read`);
      else broken ??= `${file}:${parts.malformed} has a malformed \\uxxxx escape, so Spring Boot cannot load the file and the application does not start; the documents springdoc serves are not read`;
      continue;
    }
    for (const p of parts) {
      const when = profile !== undefined ? `the profile ${profile}` : p.when;
      const read = p.settings.filter((s) => readName(s.key));
      if (when !== undefined) {
        conditional.push(...read.map((s) => ({ ...s, when })));
        continue;
      }
      for (const s of read) if (!GROUP.test(relaxed(s.key))) settings.set(readName(s.key)!, s);
      // A list set here replaces the whole list set with less precedence, even when it is empty.
      const list = p.settings.filter((s) => /^springdoc\.groupconfigs(\[|$)/.test(relaxed(s.key)));
      if (list.length) groups = list.filter((s) => GROUP.test(relaxed(s.key))).sort((a, b) => Number(GROUP.exec(relaxed(a.key))![1]) - Number(GROUP.exec(relaxed(b.key))![1]));
    }
  }
  // In file order, whatever the precedence the files were read in.
  conditional.sort((a, b) => (a.file < b.file ? -1 : a.file > b.file ? 1 : a.line - b.line));
  for (const s of conditional) limits.push(`${s.file}:${s.line} sets ${readName(s.key)} for ${s.when}, which is chosen at launch; it is not read`);
  if (broken) {
    limits.push(broken);
    return { documents: [], limits };
  }
  // Only the base path of the stack springdoc runs on applies; without the stack, either one leaves the paths unknown.
  const ownPrefix = stack === "servlet" ? CONTEXT_PATH : stack === "reactive" ? BASE_PATH : undefined;
  const stackless = stack ? [] : [CONTEXT_PATH, BASE_PATH].map((k) => settings.get(k)).filter((x): x is Setting => !!x);
  if (stackless.length) {
    for (const x of stackless)
      limits.push(
        `${x.file}:${x.line} sets ${readName(x.key)}, which applies only to ${readName(x.key) === CONTEXT_PATH ? "a Servlet" : "a WebFlux"} application, and the build does not settle the web stack; the documents springdoc serves are not read`,
      );
    return { documents: [], limits };
  }

  const unresolved = (s: Setting) => s.value.includes("${");
  const stopping = [MANAGEMENT, ENABLED, DEFAULT_DOCS, ...(ownPrefix ? [ownPrefix] : []), PATH].map((k) => settings.get(k)).filter((s): s is Setting => !!s && unresolved(s));
  if (stopping.length) {
    for (const s of stopping)
      limits.push(`${s.file}:${s.line} sets ${readName(s.key)} to ${s.value}, resolved at run time; the documents springdoc serves are not read`);
    return { documents: [], limits };
  }
  const switches = [MANAGEMENT, DEFAULT_DOCS].map((k) => settings.get(k)).filter((s): s is Setting => flag(s) === null);
  if (switches.length) {
    for (const s of switches)
      limits.push(`${s.file}:${s.line} sets ${readName(s.key)} to ${s.value}, which springdoc reads only as true or false; the documents springdoc serves are not read`);
    return { documents: [], limits };
  }
  const management = settings.get(MANAGEMENT);
  if (flag(management)) {
    limits.push(`${management!.file}:${management!.line} serves springdoc's documents on the management port (${MANAGEMENT}); they are not read`);
    return { documents: [], limits };
  }
  // @ConditionalOnProperty without havingValue: on unless the value is "false", in any case (so `off` keeps them on).
  if (flag(settings.get(ENABLED)) === false) return { documents: [], limits };

  const path = settings.get(PATH);
  const base = joinRoute((ownPrefix && settings.get(ownPrefix)?.value) || "", path?.value ?? "/v3/api-docs");
  const documents: Array<Omit<ApiDocument, "component">> = [];
  const add = (location: string, convention: string, at: { file: string; line: number }, evidence: ApiDocument["evidence"]) => {
    if (!documents.some((d) => d.location === location)) documents.push({ kind: "served", location, convention, at, evidence });
  };
  if (flag(settings.get(DEFAULT_DOCS)) !== false) {
    if (path) add(base, "springdoc api-docs.path", { file: path.file, line: path.line }, "static");
    else if (dependency) add(base, "springdoc default", dependency, "text");
    else add(base, "springdoc default", { file: built[0]!.file, line: built[0]!.line }, "static");
  }
  for (const g of groups) {
    if (unresolved(g)) limits.push(`${g.file}:${g.line} sets ${readName(g.key)} to ${g.value}, resolved at run time; that group's document is not read`);
    else if (g.value) add(`${base}/${g.value}`, "springdoc group-configs", { file: g.file, line: g.line }, "static");
  }
  // springdoc serves a group per GroupedOpenApi bean (FAQ 13.1); a builder no registered bean returns serves nothing.
  const scanned = (pkg: string) => applications.some((app) => app === "" || pkg === app || pkg.startsWith(`${app}.`));
  for (const g of built) {
    const at = `${g.file}:${g.line} builds a GroupedOpenApi`;
    const unsettled = "whether it is registered is not settled, so its group's document is not read";
    if (!g.bean) limits.push(`${at} outside a @Bean method; whether a bean registers it is not settled, so its group's document is not read`);
    else if (!g.bean.component) limits.push(`${at} in a @Bean method of ${g.bean.type}, which is not a @Configuration or other component; ${unsettled}`);
    else if (scanSet) limits.push(`${at} in a @Bean method of ${g.bean.type}, in package ${g.package}, while the project sets which packages are scanned (${scanSet.file}:${scanSet.line}); ${unsettled}`);
    else if (!scanned(g.package))
      limits.push(`${at} in a @Bean method of ${g.bean.type}, in package ${g.package || "(default)"}, which no @SpringBootApplication of the project scans by default; ${unsettled}`);
    else if (g.group) add(`${base}/${g.group}`, "springdoc group", { file: g.file, line: g.line }, "static");
    else limits.push(`${at} whose group the file does not spell out (${g.expression || "not set in the builder's chain"}); that group's document is not read`);
  }
  return { documents: documents.sort((a, b) => a.location.localeCompare(b.location)), limits };
}
