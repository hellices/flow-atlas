import { dirname } from "node:path";
import type { Dispatch, Place, Surface } from "../model.js";
import { surfaceId } from "../model.js";
import { joinRoute } from "../paths.js";
import { lineOf, matcher, type Source } from "../source.js";
import { withoutComments } from "./calls.js";
import { BUILD_FILE, GRADLE_RUNTIME, MAVEN_RUNTIME, openersAround, propertiesParts, relaxed, withoutXmlComments, yamlParts, type Setting } from "./springdoc.js";

/** A dependency a build file declares for the application's runtime, by its artifact, and where. */
interface Dependency {
  artifact: string;
  line: number;
}

/**
 * The Spring Boot artifacts a `pom.xml` declares as the project's own dependencies (`project/dependencies`), in a scope
 * the application runs with: not in `dependencyManagement`, a profile or a plugin, nor in the `test` or `provided`
 * scopes.
 */
function mavenBoot(text: string): Dependency[] {
  const xml = withoutXmlComments(text);
  const out: Dependency[] = [];
  const stack: string[] = [];
  let content = 0;
  let dependency: { artifact?: string; group?: string; at?: number; scope?: string } | undefined;
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
    if (dependency && stack.at(-2) === "dependency") {
      const value = xml.slice(content, at).trim();
      if (name === "artifactId") Object.assign(dependency, { artifact: value, at: content });
      if (name === "groupId") dependency.group = value;
      if (name === "scope") dependency.scope = value;
    }
    if (name === "dependency" && dependency) {
      if (stack.join("/") === "project/dependencies/dependency" && dependency.group === "org.springframework.boot" && dependency.artifact && MAVEN_RUNTIME.has(dependency.scope ?? "")) {
        out.push({ artifact: dependency.artifact, line: lineOf(text, dependency.at!) });
      }
      dependency = undefined;
    }
    stack.pop();
  }
  return out;
}

/**
 * The Spring Boot artifacts a Gradle build file declares in a configuration the application runs with, directly in its
 * own `dependencies` block, by their coordinates (`org.springframework.boot:spring-boot-starter-web`).
 */
function gradleBoot(file: string, text: string): Dependency[] {
  const code = withoutComments(file, text);
  const out: Dependency[] = [];
  for (const m of text.matchAll(/["']org\.springframework\.boot:(spring-boot-[\w-]+)(?::[^"']*)?["']/g)) {
    const at = m.index ?? 0;
    // A string the comments blanked is not there.
    if (code.slice(at, at + m[0].length) !== m[0]) continue;
    const openers = openersAround(code, at);
    const call = openers[0] !== undefined && code[openers[0]] === "(" ? openers[0] : undefined;
    const configuration = call !== undefined ? /([A-Za-z_]\w*)\s*$/.exec(code.slice(0, call))?.[1] : /^\s*([A-Za-z_]\w*)\s/.exec(code.slice(code.lastIndexOf("\n", at) + 1, at))?.[1];
    const blocks = openers.filter((o) => code[o] === "{").map((o) => /([A-Za-z_]\w*)\s*(?:\([^()]*\))?\s*$/.exec(code.slice(0, o))?.[1]);
    if (GRADLE_RUNTIME.has(configuration ?? "") && blocks[0] === "dependencies" && !blocks.some((b) => b === "buildscript" || b === "subprojects" || b === "allprojects")) {
      out.push({ artifact: m[1]!, line: lineOf(text, at) });
    }
  }
  return out;
}

/**
 * The major version of Spring Boot a build file names: Maven's `spring-boot-starter-parent` parent,
 * `spring-boot-dependencies` BOM or `spring-boot-maven-plugin` (a property of the same file standing for its value);
 * Gradle's `org.springframework.boot` plugin or its coordinates. Null for one it names in a way not read (another
 * placeholder, a version catalog), undefined where it names none.
 */
function bootMajor(file: string, text: string): number | null | undefined {
  const majors: Array<number | null> = [];
  const major = (v: string): number | null => (v.includes("$") ? null : /^(\d+)\./.test(v.trim()) ? Number(/^(\d+)\./.exec(v.trim())![1]) : null);
  if (file.endsWith("pom.xml")) {
    const xml = withoutXmlComments(text);
    const properties = new Map<string, string>();
    for (const block of xml.matchAll(/<properties>([^]*?)<\/properties>/g)) for (const p of block[1]!.matchAll(/<([\w.-]+)>([^<]*)<\/\1>/g)) properties.set(p[1]!, p[2]!.trim());
    for (const block of xml.matchAll(/<(parent|dependency|plugin)>([^]*?)<\/\1>/g)) {
      const artifact = /<artifactId>\s*([^<\s]+)\s*<\/artifactId>/.exec(block[2]!)?.[1];
      const group = /<groupId>\s*([^<\s]+)\s*<\/groupId>/.exec(block[2]!)?.[1];
      const version = /<version>\s*([^<]*?)\s*<\/version>/.exec(block[2]!)?.[1];
      if (group !== "org.springframework.boot" || !["spring-boot-starter-parent", "spring-boot-dependencies", "spring-boot-maven-plugin"].includes(artifact ?? "") || version === undefined) continue;
      majors.push(major(version.replace(/^\$\{([\w.-]+)\}$/, (whole, name: string) => properties.get(name) ?? whole)));
    }
  } else {
    const code = withoutComments(file, text);
    for (const m of code.matchAll(/\bid\s*\(?\s*["']org\.springframework\.boot["']\s*\)?\s*version\s*\(?\s*["']([^"']*)["']/g)) majors.push(major(m[1]!));
    for (const m of code.matchAll(/["']org\.springframework\.boot:spring-boot-(?:gradle-plugin|dependencies):([^"']*)["']/g)) majors.push(major(m[1]!));
    // `alias(libs.plugins.spring.boot)` takes the version from a catalog, which is not read; a plugin applied without a
    // version takes the one a build file above declares.
    if (/\balias\s*\(\s*libs\.plugins\.[\w.]*spring[\w.]*boot/i.test(code)) majors.push(null);
  }
  if (!majors.length) return undefined;
  const known = [...new Set(majors.filter((m): m is number => m !== null))];
  return known.length === 1 ? known[0] : null;
}

/** The settings read here, by their canonical names. */
const READ = [
  "server.servlet.context-path",
  "spring.mvc.servlet.path",
  "spring.webflux.base-path",
  "spring.main.web-application-type",
  "spring.autoconfigure.exclude",
  "spring.mvc.static-path-pattern",
  "spring.mvc.webjars-path-pattern",
  "spring.webflux.static-path-pattern",
  "spring.webflux.webjars-path-pattern",
  "spring.web.resources.add-mappings",
  "spring.web.error.path",
  "server.error.path",
  "error.path",
  "management.server.port",
  "management.endpoints.web.base-path",
  "management.endpoints.web.exposure.include",
  "management.endpoints.web.exposure.exclude",
  "management.endpoints.web.discovery.enabled",
  "management.endpoints.web.path-mapping.health",
  "management.endpoint.health.access",
  "management.endpoint.health.enabled",
  "management.endpoints.access.default",
  "management.endpoints.enabled-by-default",
];
const canonical = new Map(READ.map((k) => [relaxed(k), k]));
/** A setting's canonical name; a list's elements (`include[0]`) go by the list's. */
const readName = (key: string): string | undefined => canonical.get(relaxed(key).replace(/\[\d+\]$/, ""));

/**
 * The settings of a module's `application.properties` and `application.yml` under `src/main/resources` and its
 * `config/`, with Spring Boot's precedence (see `springdocDocuments`): a list's elements are joined with commas, as
 * Spring Boot binds a comma-separated value. Settings a profile's file or document gives are named in `limits` and not
 * read; a file Spring Boot cannot load leaves nothing read.
 */
function bootSettings(source: Source, module: string, exclude: string[], limits: string[], component: string): Map<string, Setting> | undefined {
  const skip = matcher(exclude);
  const resources = `${module ? `${module}/` : ""}src/main/resources/`;
  const configs = source.list().filter((f) => f.startsWith(resources) && !skip(f) && /^(config\/)?application(-[^/]+)?\.(properties|ya?ml)$/.test(f.slice(resources.length)));
  const rank = (f: string) => (f.slice(resources.length).startsWith("config/") ? 2 : 0) + (f.endsWith(".properties") ? 1 : 0);
  const settings = new Map<string, Setting>();
  for (const file of [...configs].sort((a, b) => rank(a) - rank(b) || (a < b ? -1 : 1))) {
    const text = source.read(file) ?? "";
    const profile = /application-([^/]+)\.\w+$/.exec(file)?.[1];
    const parts = file.endsWith(".properties") ? propertiesParts(file, text) : yamlParts(file, text);
    if (!Array.isArray(parts)) {
      if (profile === undefined) {
        limits.push(`routes ${component}: ${file}:${parts.malformed} has a malformed \\uxxxx escape, so Spring Boot cannot load the file; the routes Spring Boot serves by itself are not read`);
        return undefined;
      }
      continue;
    }
    for (const p of parts) {
      const when = profile !== undefined ? `the profile ${profile}` : p.when;
      const read = p.settings.filter((s) => readName(s.key));
      if (when !== undefined) {
        for (const s of read) limits.push(`routes ${component}: ${s.file}:${s.line} sets ${readName(s.key)} for ${when}, which is chosen at launch; it is not read`);
        continue;
      }
      const lists = new Map<string, Setting[]>();
      for (const s of read) {
        const name = readName(s.key)!;
        if (/\[\d+\]$/.test(s.key)) (lists.get(name) ?? lists.set(name, []).get(name)!).push(s);
        else settings.set(name, s);
      }
      for (const [name, items] of lists) settings.set(name, { ...items[0]!, key: name, value: items.map((i) => i.value).join(",") });
    }
  }
  return settings;
}

/** A path pattern a setting gives that atlas reads: literal segments and a final `/**`. */
const resourcePattern = (pattern: string): boolean => /^(?:\/[\w.~-]+)*\/\*\*$/.test(pattern);

/**
 * The routes Spring Boot (3 and 4) serves by itself in the application of a Maven or Gradle module whose own build file
 * puts a web starter on its runtime classpath (`spring-boot-starter-web`, `-webmvc` or `-webflux`; with both, Spring
 * MVC), from the auto-configuration of that version (spring-boot, module/spring-boot-webmvc, -webflux, -actuator):
 *
 * - Spring MVC only: the error page `BasicErrorController` maps, for any method, at `spring.web.error.path` (Spring Boot
 *   4) or `server.error.path` (3), else `error.path`, else `/error`; none where the code has an `ErrorController` of
 *   its own.
 * - The static resources at `spring.mvc.static-path-pattern` (`spring.webflux.` for WebFlux), `/**` by default, and the
 *   WebJars at `spring.mvc.webjars-path-pattern`, `/webjars/**`, to GET and HEAD, unless
 *   `spring.web.resources.add-mappings` is false or the code takes the web configuration over (`@EnableWebMvc`,
 *   `WebMvcConfigurationSupport`, and WebFlux's).
 * - With `spring-boot-starter-actuator`: the discovery page at `management.endpoints.web.base-path` (`/actuator`), and
 *   the health endpoint at `<base>/health` and `<base>/health/**`, to GET, where the exposure takes it in (only it by
 *   default). Other endpoints depend on the classpath and are named in a limit.
 *
 * Each is `implicit`, with its `convention` and the setting or dependency that brings it in as `at`. A context path or
 * servlet path, a base path, auto-configuration excluded, or a setting not spelled out leaves them unread, with why.
 */
export function springBootRoutes(source: Source, entries: Map<string, { files: string[]; slashes: { mapped?: "strict" | "ignored" } | undefined }>, exclude: string[], limits: string[]): Surface[] {
  const listed = new Set(source.list());
  // The module of each route file: the directory of the nearest build file above it.
  const owners = new Map<string, Set<string>>();
  for (const [component, { files }] of entries) {
    for (const file of files) {
      const parts = file.split("/").slice(0, -1);
      for (let n = parts.length; n >= 0; n--) {
        const dir = parts.slice(0, n).join("/");
        if (["pom.xml", "build.gradle", "build.gradle.kts"].some((b) => listed.has(dir ? `${dir}/${b}` : b))) {
          (owners.get(dir) ?? owners.set(dir, new Set()).get(dir)!).add(component);
          break;
        }
      }
    }
  }
  const out: Surface[] = [];
  for (const [module, components] of [...owners].sort(([a], [b]) => (a < b ? -1 : 1))) {
    const component = [...components].sort()[0]!;
    const said: string[] = [];
    const routes = moduleRoutes(source, component, module, listed, exclude, said, entries.get(component)!.slashes);
    // One application serves them for all of its components, which the configuration splits it into.
    if (components.size > 1 && (routes.length || said.length)) {
      limits.push(`routes ${[...components].sort().join(", ")}: their route files are one application (${module || "the repository's root"}), whose routes Spring Boot serves by itself belong to none of them alone; they are not read`);
      continue;
    }
    limits.push(...said);
    out.push(...routes);
  }
  return out;
}

function moduleRoutes(source: Source, component: string, module: string, listed: Set<string>, exclude: string[], limits: string[], slashes: { mapped?: "strict" | "ignored" } | undefined): Surface[] {
  const said = (why: string) => limits.push(`routes ${component}: ${why}`);
  const builds = ["pom.xml", "build.gradle", "build.gradle.kts"].map((b) => (module ? `${module}/${b}` : b)).filter((b) => listed.has(b));
  const deps = builds.flatMap((b) => {
    const text = source.read(b) ?? "";
    return (b.endsWith(".xml") ? mavenBoot(text) : gradleBoot(b, text)).map((d) => ({ ...d, file: b }));
  });
  const has = (...artifacts: string[]) => deps.find((d) => artifacts.includes(d.artifact));
  const mvc = has("spring-boot-starter-web", "spring-boot-starter-webmvc");
  const flux = has("spring-boot-starter-webflux");
  if (!mvc && !flux) return [];
  // The version from the nearest build file at or above the module that names one.
  let major: number | null | undefined;
  for (let dir: string | undefined = module; major === undefined && dir !== undefined; dir = dir === "" ? undefined : dirname(dir) === "." ? "" : dirname(dir)) {
    for (const b of ["pom.xml", "build.gradle", "build.gradle.kts"].map((x) => (dir ? `${dir}/${x}` : x)).filter((x) => listed.has(x))) {
      const found = bootMajor(b, source.read(b) ?? "");
      if (found !== undefined) major = major === undefined || major === found ? found : null;
    }
  }
  const where = (mvc ?? flux)!;
  if (major === undefined || major === null || major < 3 || major > 4) {
    said(`${where.file}:${where.line} brings in Spring Boot's web stack, ${major === undefined || major === null ? "in a version the build files do not spell out" : `version ${major}, whose auto-configuration atlas does not read`}; the routes Spring Boot serves by itself (its error page, static resources, WebJars and actuator) are not read`);
    return [];
  }
  const settings = bootSettings(source, module, exclude, limits, component);
  if (!settings) return [];
  // The module's own main code: a file of a module nested in it belongs to that one.
  const skip = matcher(exclude);
  const nested = [...listed].filter((b) => BUILD_FILE.test(b)).map((b) => (dirname(b) === "." ? "" : dirname(b))).filter((d) => d.length > module.length && (module === "" || d.startsWith(`${module}/`)));
  const code = source.list().filter((f) => f.startsWith(module ? `${module}/src/main/` : "src/main/") && /\.(java|kt)$/.test(f) && !skip(f) && !nested.some((d) => f.startsWith(`${d}/`)));
  const text = (re: RegExp) => {
    for (const f of code) {
      const t = source.read(f) ?? "";
      const m = re.exec(withoutComments(f, t));
      if (m) return { file: f, line: lineOf(t, m.index) };
    }
    return undefined;
  };
  const value = (name: string) => settings.get(name);
  const unresolved = [...settings.values()].filter((s) => s.value.includes("${"));
  for (const s of unresolved) said(`${s.file}:${s.line} sets ${readName(s.key)} to ${s.value}, resolved at run time; the routes Spring Boot serves by itself that depend on it are not read`);
  const placeholder = (name: string) => unresolved.some((s) => readName(s.key) === name);

  // An auto-configuration excluded by name that makes these routes, or an exclusion not spelled out, leaves them unread.
  const making = /\b(?:ErrorMvc|WebMvc|WebFlux|DispatcherServlet|\w*Endpoint\w*|\w*Management\w*|Health\w*)AutoConfiguration\b/;
  const property = value("spring.autoconfigure.exclude");
  const annotated = text(/@(?:SpringBootApplication|EnableAutoConfiguration)\s*\([^)]*\bexclude(?:Name)?\s*=(?!\s*\{?\s*(?:\[\s*)?(?:[\w.]+(?:\.class|::class)|"[\w.]+")(?:\s*,\s*(?:[\w.]+(?:\.class|::class)|"[\w.]+"))*\s*\]?\s*\}?\s*[,)])/);
  const named = text(new RegExp(`@(?:SpringBootApplication|EnableAutoConfiguration)\\s*\\([^)]*\\bexclude(?:Name)?\\s*=[^)]*${making.source}`));
  const excluded = (property && making.test(property.value) ? property : undefined) ?? named ?? annotated;
  if (excluded) {
    said(`${excluded.file}:${excluded.line} excludes auto-configuration that ${excluded === annotated ? "it does not spell out" : "makes them"}; the routes Spring Boot serves by itself are not read`);
    return [];
  }
  const type = value("spring.main.web-application-type");
  const stack = type ? (/^none$/i.test(type.value) ? "none" : /^servlet$/i.test(type.value) ? "servlet" : /^reactive$/i.test(type.value) ? "reactive" : undefined) : mvc ? "servlet" : "reactive";
  if (stack === undefined) {
    said(`${type!.file}:${type!.line} sets spring.main.web-application-type to ${type!.value}, which is not read; the routes Spring Boot serves by itself are not read`);
    return [];
  }
  if (stack === "none") return [];
  const prefixes = (stack === "servlet" ? ["server.servlet.context-path", "spring.mvc.servlet.path"] : ["spring.webflux.base-path"]).map(value).filter((s): s is Setting => !!s && s.value !== "" && s.value !== "/");
  if (prefixes.length) {
    said(`${prefixes.map((s) => `${s.file}:${s.line} sets ${readName(s.key)}`).join(" and ")}, which atlas does not put before routes; the routes Spring Boot serves by itself are not read`);
    return [];
  }

  const out: Surface[] = [];
  const declared = (s: Setting | undefined, d: Dependency & { file: string }): Place => (s ? { file: s.file, line: s.line } : { file: d.file, line: d.line });
  const add = (method: string, path: string, convention: string, at: Place, dispatch?: Dispatch) =>
    out.push({ id: surfaceId({ component, method, path }), component, method, path, at, evidence: "declared", implicit: true, convention, ...(dispatch ? { dispatch } : {}) });
  // Spring 6, which Spring Boot 3 and 4 run on, matches a request to a pattern only with the trailing `/` it has; the
  // error controller is mapped as the code's controllers are.
  const strict: Dispatch = { slashes: "strict" };
  const mapped: Dispatch | undefined = slashes?.mapped ? { slashes: slashes.mapped } : undefined;
  const flag = (s: Setting | undefined) => (s === undefined ? undefined : /^true$/i.test(s.value) ? true : /^false$/i.test(s.value) ? false : null);
  const web = (stack === "servlet" ? mvc : flux) ?? where;

  if (stack === "servlet") {
    const names = [major >= 4 ? "spring.web.error.path" : "server.error.path", "error.path"];
    const given = names.map(value).find((s) => s !== undefined);
    const own = text(/\b(?:implements|extends)\b[^{;]*?\b(?:Abstract|Basic)?ErrorController\b|\bclass\s+\w+[^{]*?:[^{]*?\b(?:Abstract|Basic)?ErrorController\b/);
    if (own) said(`${own.file}:${own.line} names an ErrorController of the code's, which takes the place of the one Spring Boot maps its error page with; that page is not read`);
    else if (given && (names.some(placeholder) || !given.value.startsWith("/"))) said(`${given.file}:${given.line} sets ${readName(given.key)} to ${given.value}, which is not read as a path; the error page Spring Boot serves is not read`);
    else add("*", given?.value ?? "/error", "spring-boot error", declared(given, web), mapped);
  }

  const mappings = flag(value("spring.web.resources.add-mappings"));
  const takenOver = text(stack === "servlet" ? /@EnableWebMvc\b|\b(?:WebMvcConfigurationSupport|DelegatingWebMvcConfiguration)\b/ : /@EnableWebFlux\b|\b(?:WebFluxConfigurationSupport|DelegatingWebFluxConfiguration)\b/);
  const prefix = stack === "servlet" ? "spring.mvc" : "spring.webflux";
  if (mappings === null) said(`${value("spring.web.resources.add-mappings")!.file}:${value("spring.web.resources.add-mappings")!.line} sets spring.web.resources.add-mappings to a value that is neither true nor false; the static resources and WebJars Spring Boot serves are not read`);
  else if (mappings !== false && !takenOver) {
    for (const [name, fallback, convention] of [
      [`${prefix}.webjars-path-pattern`, "/webjars/**", "spring-boot webjars"],
      [`${prefix}.static-path-pattern`, "/**", "spring-boot static resources"],
    ] as const) {
      const s = value(name);
      const pattern = s?.value ?? fallback;
      if (placeholder(name)) continue;
      if (!resourcePattern(pattern)) {
        said(`${s!.file}:${s!.line} sets ${name} to ${pattern}, a pattern atlas does not read; the resources Spring Boot serves there are not read`);
        continue;
      }
      for (const method of ["GET", "HEAD"]) add(method, pattern, convention, declared(s, web), strict);
    }
  }

  const actuator = has("spring-boot-starter-actuator");
  if (!actuator) return out;
  const port = value("management.server.port");
  if (port) {
    if (port.value.trim() !== "-1") said(`${port.file}:${port.line} serves the actuator on its own port (management.server.port); its endpoints are not read`);
    return out;
  }
  const base = value("management.endpoints.web.base-path");
  const actuatorSettings = ["management.endpoints.web.base-path", "management.endpoints.web.exposure.include", "management.endpoints.web.exposure.exclude", "management.endpoints.web.discovery.enabled"];
  if (actuatorSettings.some(placeholder)) return out;
  if (base && base.value !== "" && !base.value.startsWith("/")) {
    said(`${base.file}:${base.line} sets management.endpoints.web.base-path to ${base.value}, which Spring Boot refuses; the actuator's endpoints are not read`);
    return out;
  }
  const basePath = (base?.value ?? "/actuator").replace(/\/+$/, "");
  const list = (s: Setting | undefined, fallback: string[]) => (s ? s.value.split(",").map((x) => x.trim().toLowerCase()).filter(Boolean) : fallback);
  const include = list(value("management.endpoints.web.exposure.include"), ["health"]);
  const excludeIds = list(value("management.endpoints.web.exposure.exclude"), []);
  const discovery = flag(value("management.endpoints.web.discovery.enabled"));
  const at = declared(base ?? value("management.endpoints.web.exposure.include"), actuator);
  if (discovery === null) said(`${value("management.endpoints.web.discovery.enabled")!.file} sets management.endpoints.web.discovery.enabled to a value that is neither true nor false; the actuator's discovery page is not read`);
  else if (discovery !== false && basePath !== "") add("GET", basePath, "spring-boot actuator", at, strict);
  const others = include.filter((id) => id !== "health" && !excludeIds.includes(id));
  if (others.length) {
    const s = value("management.endpoints.web.exposure.include")!;
    said(
      others.includes("*")
        ? `${s.file}:${s.line} exposes every actuator endpoint over HTTP (*); which endpoints there are depends on the classpath and the code, so of them only the discovery page and health are read`
        : `${s.file}:${s.line} exposes the actuator endpoints ${others.join(", ")} over HTTP, which exist where the classpath and the code give them; their routes are not read`,
    );
  }
  const exposed = (include.includes("health") || include.includes("*")) && !excludeIds.includes("health") && !excludeIds.includes("*");
  if (!exposed) return out;
  const access = ["management.endpoint.health.access", "management.endpoint.health.enabled", "management.endpoints.access.default", "management.endpoints.enabled-by-default"].map(value).filter((s): s is Setting => !!s);
  const on = (s: Setting) => (/^(read-only|unrestricted|true)$/i.test(s.value.trim()) ? true : /^(none|false)$/i.test(s.value.trim()) ? false : null);
  // The endpoint's own setting wins over the default for all.
  const decided = access[0] ? on(access[0]) : true;
  if (decided === null) {
    said(`${access[0]!.file}:${access[0]!.line} sets ${readName(access[0]!.key)} to ${access[0]!.value}, which is not read; the health endpoint is not read`);
    return out;
  }
  if (!decided) return out;
  const mappedPath = value("management.endpoints.web.path-mapping.health");
  if (mappedPath && (placeholder("management.endpoints.web.path-mapping.health") || !/^[\w.~-]+$/.test(mappedPath.value))) {
    said(`${mappedPath.file}:${mappedPath.line} maps the health endpoint to ${mappedPath.value}, which is not read as a path segment; it is not read`);
    return out;
  }
  const health = `${basePath}/${mappedPath?.value ?? "health"}`;
  add("GET", health, "spring-boot actuator health", at, strict);
  add("GET", joinRoute(health, "**"), "spring-boot actuator health", at, strict);
  return out;
}
