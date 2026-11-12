import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { posix } from "node:path";
import { parse } from "yaml";
import type { RuleId } from "./model.js";
import type { Base, Join } from "./paths.js";

export interface RouteSource {
  component: string;
  /** Code files that register the component's routes; also searched for the handlers of documented operations. */
  files: string[];
  /**
   * An OpenAPI 2.0 or 3.x document of the component, as its framework generates it: a path in the repository, or an
   * absolute path to a file generated outside it. Its operations are surfaces; code routes add their locations.
   */
  openapi?: string;
  /**
   * nest: @Controller/@Get decorators. express: receiver.get("/x"). fastapi: @router.get("/x") in Python. spring:
   * @RequestMapping/@GetMapping annotations in Java or Kotlin. next: Next.js route handlers, `app/**\/route.ts` exporting
   * GET, POST and the like, and API routes under `pages/api`. flask: Flask's and Quart's `@app.route("/x")`,
   * `add_url_rule` and blueprints in Python. aspnetcore: ASP.NET Core minimal APIs (`app.MapGet("/x")`, `MapGroup`) and
   * controllers' attribute and conventional routes in C#. django: Django's URLconfs from `ROOT_URLCONF` (`path`,
   * `re_path`, `include`) and Django REST framework's routers, in Python. go: Gin's, chi's and net/http's ServeMux
   * registrations in Go, each router told by the package it comes from.
   */
  styles?: Array<"nest" | "express" | "fastapi" | "spring" | "next" | "flask" | "aspnetcore" | "django" | "go">;
  receivers?: string[];
  /**
   * Where the routers a file declares serve their routes, when the code does not say it with literal paths: an Express
   * router mounted as `app.use(\`${PREFIX}/collect\`, router)` does, `{ "src/routes/collect.js": "/collect" }`, or a
   * FastAPI router included as `app.include_router(api_router, prefix=settings.API_V1_STR)` does,
   * `{ "app/api/main.py": "/api/v1" }`. It takes the place of every mount or include of those routers.
   */
  mounts?: Record<string, string>;
  /**
   * The path the application serves every route of the entry under, where the code sets it in a way atlas does not
   * read. For `nest`, the global prefix: it takes the place of the one `setGlobalPrefix` sets, whose `exclude` and the
   * version still apply. For the other styles, a path put before every route the code registers.
   */
  prefix?: string;
  /**
   * For `nest`: the file whose `setGlobalPrefix` and `enableVersioning` calls set up the application, when it is not
   * the one atlas finds in the component.
   */
  bootstrap?: string;
  /**
   * Registration helpers, in TypeScript or Python: the argument that holds the path, and either the argument that holds
   * the method or the one `method` the helper always registers (`*` for every method).
   */
  calls?: Array<{ name: string; pathArg: number } & ({ methodArg: number; method?: never } | { method: string; methodArg?: never })>;
  /** A regular expression over constant names whose string value is a GET route, such as `Path$`. */
  constants?: string;
  /**
   * How operations without an explicit `operationId` are named. `nest-swagger`: `ClassName_methodName`, the default
   * operationIdFactory of @nestjs/swagger. Explicit ids in route options or `@ApiOperation` are always read.
   */
  operationIds?: "nest-swagger";
}

export interface CallSource {
  from: string;
  to: string;
  files: string[];
  /**
   * `data-*` attributes in templates whose value is a URL the project's scripts request, as `data-api-url`; HTML gives
   * a `data-*` value no meaning, so only the ones named here are read.
   */
  dataUrls?: string[];
  /**
   * The path of the base URL the client joins the paths it is given to, where the code sets it in a way atlas does not
   * read (`/api/v1/`, a trailing `/` kept as written), with `join`. A client whose base the code spells out
   * (`axios.create({ baseURL: "/api" })`) is read with its own.
   */
  base?: string;
  /**
   * How the client joins a path to `base`: `resolve` as a URL reference (RFC 3986: a path that starts with `/` replaces
   * the base's path, any other what follows its last `/`), as .NET's HttpClient, Retrofit, Ktor and `urljoin` do;
   * `append` after the base's path with one `/` between, as axios, Ky's `prefix` and RTK Query do.
   */
  join?: Join;
  /** The same as `base` with `join: append`, the form earlier configurations wrote. */
  prefix?: string;
  /**
   * In code read as text, the names the clients that join their paths to the base are called on (`client` in
   * `client.get("users")`): a path without a leading `/` is read only as the URL their calls take.
   */
  receivers?: string[];
  /**
   * The project's own wrappers around fetch, by the name they are called with (`authFetch`, `api.authFetch`), in
   * TypeScript and JavaScript: the URL first and a fetch init second. A call whose init states no method sends
   * `defaultMethod`, as fetch sends GET.
   */
  wrappers?: Array<{ name: string; defaultMethod: string }>;
}

export interface ActiveList {
  file: string;
  /** Applied to each string element; the first group is the key. */
  pattern?: string;
  /** For arrays of objects: the field that holds the key. */
  field?: string;
}

export interface RegistrySource {
  name: string;
  active: ActiveList | { files: string; pattern?: string; field?: string };
  producers: string[];
  consumers: string[];
}

export interface Config {
  components: Array<{ name: string; path: string }>;
  /** Component manifests: JSON files with `name`, and the interfaces it `provides` and `consumes`. */
  manifest?: { kind: "component-json"; glob: string };
  routes: RouteSource[];
  calls: CallSource[];
  registries: RegistrySource[];
  publicSurfaces: string[];
  exclude: string[];
  /** Globs of flow descriptions, relative to the repository root. */
  flows: string[];
  /** A component's OpenAPI description as a URI, when atlas should not use the one it finds; for `atlas export arazzo`. */
  openapi: Record<string, string>;
  /** The base URL a component is served at in the environment an export is for; joined with the document path it serves. */
  origins: Record<string, string>;
  rules: Partial<Record<RuleId, { enabled?: boolean; cycles?: boolean }>>;
  /** The configuration file and the SHA-256 of its bytes, recorded in each document's provenance. */
  file?: { path: string; sha256: string };
}

export const DEFAULT_EXCLUDE = [
  "**/node_modules/**",
  "**/dist/**",
  "**/build/**",
  "**/*.min.js",
  "**/generated/**",
  "**/*.test.*",
  "**/*.spec.*",
  "**/test/**",
  "**/tests/**",
  "**/__tests__/**",
];

export function loadConfig(path: string): Config {
  const bytes = readFileSync(path);
  const raw = (parse(bytes.toString("utf8")) as Record<string, unknown> | null) ?? {};
  return { ...normalizeConfig(raw), file: { path, sha256: createHash("sha256").update(bytes).digest("hex") } };
}

export function normalizeConfig(raw: Record<string, unknown>): Config {
  if (raw.versions !== undefined) throw new Error("versions: contract-version checks (FA006) were removed; delete the versions section");
  const list = <T>(value: unknown): T[] => (Array.isArray(value) ? (value as T[]) : []);
  return {
    components: list<Config["components"][number]>(raw.components).map((c) => (typeof c?.path === "string" ? { ...c, path: componentPath(c.path) } : c)),
    manifest: raw.manifest as Config["manifest"],
    routes: list<RouteSource>(raw.routes).map(checkRoute),
    calls: list<CallSource>(raw.calls).map(checkCalls),
    registries: list(raw.registries),
    publicSurfaces: list(raw.publicSurfaces),
    exclude: [...DEFAULT_EXCLUDE, ...list<string>(raw.exclude)],
    flows: raw.flows === undefined ? ["flows/**/*.flow.yaml"] : list(raw.flows),
    openapi: (raw.openapi as Record<string, string> | undefined) ?? {},
    origins: (raw.origins as Record<string, string> | undefined) ?? {},
    rules: (raw.rules as Config["rules"]) ?? {},
  };
}

/**
 * A component's directory as the repository's file paths start with it: `""` for the root, however it is written
 * (`.`, `./`), and otherwise without a leading `./` or trailing `/` (`./apps/web/` is `apps/web`).
 */
export function componentPath(path: string): string {
  const out = posix.normalize(path).replace(/^(?:\.\/)+/, "").replace(/\/+$/, "");
  return out === "." ? "" : out;
}

function checkRoute(route: RouteSource): RouteSource {
  const where = `routes of ${route.component}`;
  const path = (v: unknown) => typeof v === "string" && v.startsWith("/");
  if (route.mounts !== undefined) {
    const entries = route.mounts && typeof route.mounts === "object" && !Array.isArray(route.mounts) ? Object.entries(route.mounts) : undefined;
    if (!entries?.every(([file, at]) => file.trim().length > 0 && path(at))) {
      throw new Error(`${where}: mounts maps a file to the path it is served under, starting with / (${JSON.stringify(route.mounts)})`);
    }
  }
  if (route.prefix !== undefined && !path(route.prefix)) throw new Error(`${where}: prefix is a path starting with / (${JSON.stringify(route.prefix)})`);
  if (route.bootstrap !== undefined) {
    if (typeof route.bootstrap !== "string" || !route.bootstrap.trim()) throw new Error(`${where}: bootstrap names one file (${JSON.stringify(route.bootstrap)})`);
    if (!(route.styles ?? []).includes("nest")) throw new Error(`${where}: bootstrap is read for the nest style only`);
  }
  for (const c of route.calls ?? []) {
    // Exactly one of method and methodArg; an argument position is a whole number from 0.
    const fixed = c.method !== undefined;
    const indexed = c.methodArg !== undefined;
    const position = (v: unknown) => Number.isSafeInteger(v) && (v as number) >= 0;
    const named = (v: unknown) => typeof v === "string" && v.trim().length > 0;
    if (!named(c.name) || !position(c.pathArg) || fixed === indexed || (fixed && !named(c.method)) || (indexed && !position(c.methodArg))) {
      throw new Error(`routes of ${route.component}: a registration helper needs name, a pathArg position and either a methodArg position or method (${JSON.stringify(c)})`);
    }
  }
  // A source read only from its OpenAPI document may leave `files` out, as `files: []`.
  return route.files === undefined ? { ...route, files: [] } : route;
}

const HTTP_METHODS = new Set(["GET", "POST", "PUT", "PATCH", "DELETE", "HEAD", "OPTIONS"]);

const JOINS = new Set<unknown>(["resolve", "append"]);

/** The base a call source's configuration gives its client: `base` with `join`, or `prefix` appended to. */
export function baseOf(spec: Pick<CallSource, "base" | "join" | "prefix">): Base | undefined {
  if (spec.base !== undefined) return { path: spec.base, join: spec.join ?? "append" };
  return spec.prefix ? { path: spec.prefix, join: "append" } : undefined;
}

function checkCalls(spec: CallSource): CallSource {
  const edge = `calls ${spec.from}->${spec.to}`;
  if (spec.base !== undefined) {
    if (typeof spec.base !== "string" || !spec.base.startsWith("/")) throw new Error(`${edge}: base is the path of the client's base URL, starting with / (${JSON.stringify(spec.base)})`);
    if (spec.prefix !== undefined) throw new Error(`${edge}: base and prefix both give the client's base; keep one`);
    if (!JOINS.has(spec.join)) throw new Error(`${edge}: base needs join, how the client joins a path to it: resolve or append (${JSON.stringify(spec.join)})`);
  } else if (spec.join !== undefined) throw new Error(`${edge}: join says how a path joins base, which is not given`);
  if (spec.receivers !== undefined && !(Array.isArray(spec.receivers) && spec.receivers.every((r) => typeof r === "string" && /^[A-Za-z_$][\w$]*$/.test(r)))) {
    throw new Error(`${edge}: receivers lists the names clients are called on (${JSON.stringify(spec.receivers)})`);
  }
  if (spec.wrappers === undefined) return spec;
  // A list of wrappers, each with a name and one of the methods fetch sends.
  for (const w of Array.isArray(spec.wrappers) ? spec.wrappers : [spec.wrappers]) {
    const { name, defaultMethod } = (w ?? {}) as Record<string, unknown>;
    const named = typeof name === "string" && name.trim().length > 0;
    const method = typeof defaultMethod === "string" && HTTP_METHODS.has(defaultMethod.toUpperCase());
    if (!Array.isArray(spec.wrappers) || !named || !method) {
      throw new Error(`calls ${spec.from}->${spec.to}: a client wrapper needs name and a defaultMethod among ${[...HTTP_METHODS].join(", ")} (${JSON.stringify(w)})`);
    }
  }
  return { ...spec, wrappers: spec.wrappers.map((w) => ({ name: w.name, defaultMethod: w.defaultMethod.toUpperCase() })) };
}

export function ruleEnabled(config: Config, rule: RuleId): boolean {
  return config.rules[rule]?.enabled !== false;
}
