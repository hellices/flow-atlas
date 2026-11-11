import { dirname } from "node:path";
import type { Dispatch, Place, Surface } from "../model.js";
import { surfaceId } from "../model.js";
import { joinRoute } from "../paths.js";
import { lineOf, matcher, type Source } from "../source.js";
import { withoutComments } from "./calls.js";
import { BUILD_FILE, GRADLE_RUNTIME, MAVEN_RUNTIME, openersAround, propertiesParts, relaxed, withoutXmlComments, yamlParts, type Setting } from "./springdoc.js";

/** A dependency a build file declares for the application's runtime, by its coordinates, and where. */
interface Dependency {
  group: string;
  artifact: string;
  line: number;
}

/** The groups read: Spring Boot's own, and WebJars' (`org.webjars`, `org.webjars.npm`, `org.webjars.bower`). */
const READ_GROUP = /^(?:org\.springframework\.boot|org\.webjars(?:\.[\w-]+)*)$/;

/**
 * The Spring Boot and WebJars artifacts a `pom.xml` declares as the project's own dependencies (`project/dependencies`),
 * in a scope the application runs with: not in `dependencyManagement`, a profile or a plugin, nor in the `test` or
 * `provided` scopes.
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
      if (stack.join("/") === "project/dependencies/dependency" && READ_GROUP.test(dependency.group ?? "") && dependency.artifact && MAVEN_RUNTIME.has(dependency.scope ?? "")) {
        out.push({ group: dependency.group!, artifact: dependency.artifact, line: lineOf(text, dependency.at!) });
      }
      dependency = undefined;
    }
    stack.pop();
  }
  return out;
}

/**
 * The Spring Boot and WebJars artifacts a Gradle build file declares in a configuration the application runs with,
 * directly in its own `dependencies` block, by their coordinates (`org.springframework.boot:spring-boot-starter-web`).
 */
function gradleBoot(file: string, text: string): Dependency[] {
  const code = withoutComments(file, text);
  const out: Dependency[] = [];
  for (const m of text.matchAll(/["'](org\.springframework\.boot|org\.webjars(?:\.[\w-]+)*):([\w.-]+)(?::[^"']*)?["']/g)) {
    const at = m.index ?? 0;
    // A string the comments blanked is not there.
    if (code.slice(at, at + m[0].length) !== m[0]) continue;
    const openers = openersAround(code, at);
    const call = openers[0] !== undefined && code[openers[0]] === "(" ? openers[0] : undefined;
    const configuration = call !== undefined ? /([A-Za-z_]\w*)\s*$/.exec(code.slice(0, call))?.[1] : /^\s*([A-Za-z_]\w*)\s/.exec(code.slice(code.lastIndexOf("\n", at) + 1, at))?.[1];
    const blocks = openers.filter((o) => code[o] === "{").map((o) => /([A-Za-z_]\w*)\s*(?:\([^()]*\))?\s*$/.exec(code.slice(0, o))?.[1]);
    if (GRADLE_RUNTIME.has(configuration ?? "") && blocks[0] === "dependencies" && !blocks.some((b) => b === "buildscript" || b === "subprojects" || b === "allprojects")) {
      out.push({ group: m[1]!, artifact: m[2]!, line: lineOf(text, at) });
    }
  }
  return out;
}

/**
 * The version of Spring Boot a build file names, as its major times 100 and its minor (`304` for 3.4.1): Maven's `spring-boot-starter-parent` parent,
 * `spring-boot-dependencies` BOM or `spring-boot-maven-plugin` (a property of the same file standing for its value);
 * Gradle's `org.springframework.boot` plugin or its coordinates. Null for one it names in a way not read (another
 * placeholder, a version catalog), undefined where it names none.
 */
function bootVersion(file: string, text: string): number | null | undefined {
  const majors: Array<number | null> = [];
  const major = (v: string): number | null => {
    const m = v.includes("$") ? null : /^(\d+)\.(\d+)/.exec(v.trim());
    return m ? Number(m[1]) * 100 + Number(m[2]) : null;
  };
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
  "spring.web.resources.static-locations",
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
  "management.endpoints.access.max-permitted",
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

/** Where Spring Boot looks for static resources by default (`WebProperties.Resources.CLASSPATH_RESOURCE_LOCATIONS`), in its order. */
const STATIC_LOCATIONS = ["classpath:/META-INF/resources/", "classpath:/resources/", "classpath:/static/", "classpath:/public/"];

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
  const has = (...artifacts: string[]) => deps.find((d) => d.group === "org.springframework.boot" && artifacts.includes(d.artifact));
  const mvc = has("spring-boot-starter-web", "spring-boot-starter-webmvc");
  const flux = has("spring-boot-starter-webflux");
  if (!mvc && !flux) return [];
  // The version from the nearest build file at or above the module that names one.
  let version: number | null | undefined;
  for (let dir: string | undefined = module; version === undefined && dir !== undefined; dir = dir === "" ? undefined : dirname(dir) === "." ? "" : dirname(dir)) {
    for (const b of ["pom.xml", "build.gradle", "build.gradle.kts"].map((x) => (dir ? `${dir}/${x}` : x)).filter((x) => listed.has(x))) {
      const found = bootVersion(b, source.read(b) ?? "");
      if (found !== undefined) version = version === undefined || version === found ? found : null;
    }
  }
  const major = typeof version === "number" ? Math.floor(version / 100) : version;
  const where = (mvc ?? flux)!;
  if (major === undefined || major === null || major < 3 || major > 4 || typeof version !== "number") {
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
  const unspelled = property && placeholder("spring.autoconfigure.exclude") ? property : undefined;
  const excluded = (property && making.test(property.value) ? property : undefined) ?? named ?? annotated ?? unspelled;
  if (excluded) {
    said(`${excluded.file}:${excluded.line} excludes auto-configuration that ${excluded === annotated || excluded === unspelled ? "it does not spell out" : "makes them"}; the routes Spring Boot serves by itself are not read`);
    return [];
  }
  const type = value("spring.main.web-application-type");
  const stack = type ? (/^none$/i.test(type.value) ? "none" : /^servlet$/i.test(type.value) ? "servlet" : /^reactive$/i.test(type.value) ? "reactive" : undefined) : mvc ? "servlet" : "reactive";
  if (stack === undefined) {
    said(`${type!.file}:${type!.line} sets spring.main.web-application-type to ${type!.value}, which is not read; the routes Spring Boot serves by itself are not read`);
    return [];
  }
  if (stack === "none") return [];
  // A stack forced against the starters has no web server of that kind to start.
  if ((stack === "servlet" && !mvc) || (stack === "reactive" && !flux)) {
    said(`${type!.file}:${type!.line} sets spring.main.web-application-type to ${type!.value}, whose starter the build does not bring in; the routes Spring Boot serves by itself are not read`);
    return [];
  }
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
  const web = (stack === "servlet" ? mvc : flux)!;

  if (stack === "servlet") {
    const names = [major >= 4 ? "spring.web.error.path" : "server.error.path", "error.path"];
    const given = names.map(value).find((s) => s !== undefined);
    const own = text(/\b(?:implements|extends)\b[^{;]*?\b(?:Abstract|Basic)?ErrorController\b|\bclass\s+\w+[^{]*?:[^{]*?\b(?:Abstract|Basic)?ErrorController\b/);
    if (own) said(`${own.file}:${own.line} names an ErrorController of the code's, which takes the place of the one Spring Boot maps its error page with; that page is not read`);
    else if (given && (placeholder(readName(given.key)!) || !given.value.startsWith("/"))) said(`${given.file}:${given.line} sets ${readName(given.key)} to ${given.value}, which is not read as a path; the error page Spring Boot serves is not read`);
    else add("*", given?.value ?? "/error", "spring-boot error", declared(given, web), mapped);
  }

  const mappings = flag(value("spring.web.resources.add-mappings"));
  const takenOver = text(stack === "servlet" ? /@EnableWebMvc\b|\b(?:WebMvcConfigurationSupport|DelegatingWebMvcConfiguration)\b/ : /@EnableWebFlux\b|\b(?:WebFluxConfigurationSupport|DelegatingWebFluxConfiguration)\b/);
  const prefix = stack === "servlet" ? "spring.mvc" : "spring.webflux";
  if (mappings === null) said(`${value("spring.web.resources.add-mappings")!.file}:${value("spring.web.resources.add-mappings")!.line} sets spring.web.resources.add-mappings to a value that is neither true nor false; the static resources and WebJars Spring Boot serves are not read`);
  else if (mappings !== false && !takenOver) {
    // The WebJars, where the build brings one in: the handler takes every path under its pattern, each a WebJar's file.
    const webjar = deps.find((d) => d.group.startsWith("org.webjars"));
    const jars = value(`${prefix}.webjars-path-pattern`);
    if (webjar && !placeholder(`${prefix}.webjars-path-pattern`)) {
      const pattern = jars?.value ?? "/webjars/**";
      if (!resourcePattern(pattern)) said(`${jars!.file}:${jars!.line} sets ${prefix}.webjars-path-pattern to ${pattern}, a pattern atlas does not read; the WebJars Spring Boot serves there are not read`);
      else for (const method of ["GET", "HEAD"]) add(method, pattern, "spring-boot webjars", declared(jars, webjar), strict);
    }
    // The static resources: each file of a static location of the module, at its path under the pattern. A request
    // for any other path finds no resource and is answered 404.
    const pattern = value(`${prefix}.static-path-pattern`);
    const locations = value("spring.web.resources.static-locations");
    if (!placeholder(`${prefix}.static-path-pattern`) && !placeholder("spring.web.resources.static-locations")) {
      if (pattern && !resourcePattern(pattern.value)) said(`${pattern.file}:${pattern.line} sets ${prefix}.static-path-pattern to ${pattern.value}, a pattern atlas does not read; the static resources Spring Boot serves there are not read`);
      else {
        const base = (pattern?.value ?? "/**").slice(0, -"/**".length);
        const resources = `${module ? `${module}/` : ""}src/main/resources/`;
        const listedLocations = locations ? locations.value.split(",").map((l) => l.trim()).filter(Boolean) : STATIC_LOCATIONS;
        for (const location of listedLocations) {
          const classpath = /^classpath:\/?([^*]*)$/.exec(location);
          if (!classpath) {
            said(`${locations!.file}:${locations!.line} sets spring.web.resources.static-locations to ${location} among others, a location whose files atlas does not list; the static resources there are not read`);
            continue;
          }
          const dir = `${resources}${classpath[1]!.replace(/^\/+|\/+$/g, "")}`.replace(/\/*$/, "/");
          for (const file of source.list()) {
            if (!file.startsWith(dir) || skip(file) || nested.some((d) => file.startsWith(`${d}/`))) continue;
            const path = joinRoute(base, `/${file.slice(dir.length).replace(/[\0- "#%<>?^`{}\x7F-\u{10FFFF}]/gu, encodeURIComponent)}`);
            for (const method of ["GET", "HEAD"]) out.push({ id: surfaceId({ component, method, path }), component, method, path, at: { file, line: 1 }, evidence: "static", implicit: true, convention: "spring-boot static resources", dispatch: strict });
          }
        }
        // A Servlet application also serves the servlet context's root, which a war packs from src/main/webapp.
        const webapp = `${module ? `${module}/` : ""}src/main/webapp/`;
        if (stack === "servlet" && source.list().some((f) => f.startsWith(webapp) && !f.startsWith(`${webapp}WEB-INF/`))) {
          said(`${webapp} holds files a Servlet application serves from its servlet context where it is packed as a war; they are not read`);
        }
      }
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
  // Where the endpoints are and which are exposed; a discovery switch not read leaves only the discovery page out.
  if (["management.endpoints.web.base-path", "management.endpoints.web.exposure.include", "management.endpoints.web.exposure.exclude"].some(placeholder)) return out;
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
  if (placeholder("management.endpoints.web.discovery.enabled")) {
    // Named among the settings resolved at run time above.
  } else if (discovery === null) said(`${value("management.endpoints.web.discovery.enabled")!.file} sets management.endpoints.web.discovery.enabled to a value that is neither true nor false; the actuator's discovery page is not read`);
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
  // Spring Boot 3.4 brought `access` beside the `enabled` switches, which it still reads; before, `access` is no
  // setting of it (PropertiesEndpointAccessResolver). The endpoint's own setting wins over the default for all, and
  // `max-permitted` caps both.
  const keys = version >= 304 ? ["management.endpoint.health.access", "management.endpoint.health.enabled", "management.endpoints.access.default", "management.endpoints.enabled-by-default"] : ["management.endpoint.health.enabled", "management.endpoints.enabled-by-default"];
  const access = keys.map(value).filter((s): s is Setting => !!s);
  const cap = version >= 304 ? value("management.endpoints.access.max-permitted") : undefined;
  const on = (s: Setting) => (/^(read-only|unrestricted|true)$/i.test(s.value.trim()) ? true : /^(none|false)$/i.test(s.value.trim()) ? false : null);
  const decided = cap && on(cap) !== true ? on(cap) : access[0] ? on(access[0]) : true;
  if (decided === null) {
    const s = cap && on(cap) !== true ? cap : access[0]!;
    said(`${s.file}:${s.line} sets ${readName(s.key)} to ${s.value}, which is not read; the health endpoint is not read`);
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
