import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { parse } from "yaml";
import type { RuleId } from "./model.js";

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
   * GET, POST and the like, and API routes under `pages/api`.
   */
  styles?: Array<"nest" | "express" | "fastapi" | "spring" | "next">;
  receivers?: string[];
  /**
   * Where an Express router file is mounted, when the code does not say it with a literal path, as
   * `app.use(\`${PREFIX}/collect\`, router)` does: `{ "src/routes/collect.js": "/collect" }`.
   */
  mounts?: Record<string, string>;
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
   * The path the client puts before each root-relative path, when it is set where atlas does not read it: an HTTP
   * client's base URL such as `axios.create({ baseURL: "/api" })` or Dio's `baseUrl`.
   */
  prefix?: string;
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

export interface VersionSource {
  name: string;
  files: string;
  /** The first group is the family, the second the version number. */
  pattern: string;
  active?: ActiveList;
  /** A family matching this regex is a companion; its first group names the owning family, whose activity it shares. */
  companionOf?: string;
  references: string[];
}

export interface Config {
  components: Array<{ name: string; path: string }>;
  /** Component manifests: JSON files with `name`, and the interfaces it `provides` and `consumes`. */
  manifest?: { kind: "component-json"; glob: string };
  routes: RouteSource[];
  calls: CallSource[];
  registries: RegistrySource[];
  versions: VersionSource[];
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
  const list = <T>(value: unknown): T[] => (Array.isArray(value) ? (value as T[]) : []);
  return {
    components: list(raw.components),
    manifest: raw.manifest as Config["manifest"],
    routes: list<RouteSource>(raw.routes).map(checkRoute),
    calls: list(raw.calls),
    registries: list(raw.registries),
    versions: list(raw.versions),
    publicSurfaces: list(raw.publicSurfaces),
    exclude: [...DEFAULT_EXCLUDE, ...list<string>(raw.exclude)],
    flows: raw.flows === undefined ? ["flows/**/*.flow.yaml"] : list(raw.flows),
    openapi: (raw.openapi as Record<string, string> | undefined) ?? {},
    origins: (raw.origins as Record<string, string> | undefined) ?? {},
    rules: (raw.rules as Config["rules"]) ?? {},
  };
}

function checkRoute(route: RouteSource): RouteSource {
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
  return route;
}

export function ruleEnabled(config: Config, rule: RuleId): boolean {
  return config.rules[rule]?.enabled !== false;
}
