/**
 * The Flow Atlas model: what atlas extracts from code and writes as JSON. Every document carries `apiVersion`, `kind`
 * and `provenance`, after the Kubernetes Resource Model and SLSA provenance; the JSON Schemas under `schema/` are the
 * contract, these types follow them.
 */

/** Changes only when a field is removed or changes meaning; added fields keep it. */
export const API_VERSION = "flow-atlas.dev/v1alpha1";

/**
 * How a fact was obtained. `declared`: a manifest states it. `static`: parsed syntax. `text`: matched as text in a
 * language atlas does not parse. `name`: two facts joined because a method name agrees.
 */
export type Evidence = "declared" | "static" | "text" | "name";

export interface Place {
  file: string;
  line: number;
}

/** An input that went into a document, after the in-toto ResourceDescriptor. */
export interface ResourceDescriptor {
  /** What the input is to this document, such as `code`, `config`, `base` or `head`. */
  name: string;
  /** Repository-relative location; `.` for the repository itself. */
  uri: string;
  /** `gitCommit` for code read from a commit, `sha256` for files. Absent for an uncommitted working tree. */
  digest?: Record<string, string>;
}

/**
 * How a document was produced, after SLSA provenance: the tool, what it was asked, and every input it read with a
 * digest. No timestamps or machine paths: the same inputs give the same document.
 */
export interface Provenance {
  builder: { id: "flow-atlas"; version: string };
  /** `flow-atlas/<Kind>@v1alpha1`. */
  buildType: string;
  /** The arguments as given, such as `ref: HEAD`. */
  externalParameters: Record<string, string>;
  resolvedDependencies: ResourceDescriptor[];
}

export interface Component {
  name: string;
  path: string;
  provides: string[];
  consumes: string[];
}

export interface Surface {
  /** `component|METHOD /path`. */
  id: string;
  component: string;
  method: string;
  path: string;
  at: Place;
  evidence: Evidence;
  /** The OpenAPI operationId, when the code states it, the configured convention gives it, or a document declares it. */
  operationId?: string;
  /** Where the component's OpenAPI document declares this operation. */
  described?: Place;
  /** The path key that document writes the operation under, which may differ from `path` by a base path, a trailing slash or parameter names. */
  describedPath?: string;
  /** That document's version: `2.0` for Swagger, otherwise its `openapi` value. */
  describedVersion?: string;
  /** Member methods the handler calls, following local and relatively imported functions. */
  reaches?: string[];
  /**
   * Served by the framework with no handler written for it, as Next.js answers HEAD with GET's handler and OPTIONS
   * with an Allow header and serves the files of `public/`, FastAPI its OpenAPI document and Spring Boot its error page;
   * requested by convention from outside the code, as crawlers fetch Next.js's robots.txt and sitemaps; or by the
   * framework's own client, as a Next.js Server Action posts to its page. A request can reach it; no rule expects a
   * caller for it.
   */
  implicit?: boolean;
  /**
   * The rule of the framework that serves the route where no code of the application handles it, with `at` the place
   * that brings it in: `fastapi docs_url`, `spring-boot error`, `next public`, `@fastify/static`.
   */
  convention?: string;
  /**
   * The regular expression the text of each parameter named here must match, as its router tests it: Fastify's
   * `:file(^\d+)` and Hono's `:date{[0-9]+}`, and where a parameter shares its segment, Fastify's `(.*?)` and Spring's
   * `(.*)`. A parameter not named takes some text of its segment, or the whole segment.
   */
  patterns?: Record<string, string>;
  /** How the router that serves the route dispatches a request, where atlas reads it (see `Dispatch`). */
  dispatch?: Dispatch;
}

/**
 * How a route's router picks it among the routes a request fits, and how it treats a trailing `/`, as its framework
 * documents it. A field left out is a rule atlas does not read for the route; matching then keeps every route a request
 * fits, with or without a trailing `/`.
 */
export interface Dispatch {
  /**
   * `registration`: the first route registered that a request fits answers it (Express, @koa/router, Hono, Nest on
   * Express, Starlette), by `order`. `find-my-way`: Fastify's router tries static text before a parameter, a parameter
   * with a regexp before one without, and a parameter before a wildcard, whatever the order. `specificity`: Nest's
   * `routeResolutionStrategy: 'specificity'` registers the more specific routes first, by `rank`, and routes of one rank
   * in `order`. `werkzeug`: Werkzeug's matcher (Flask, Quart) tries a segment's static text before its variables, and
   * variables by their weight, whatever the order, by `parts`. `precedence`: ASP.NET Core's endpoint routing takes, of
   * the routes whose template and constraints a request meets, the one first by `rank` (lower first: `Order`, then
   * precedence), and of those a route that names the request's method before one that takes any (`EndpointComparer`,
   * `HttpMethodMatcherPolicy`); routes left tied are ambiguous.
   */
  picks?: "registration" | "find-my-way" | "specificity" | "werkzeug" | "precedence";
  /**
   * For `specificity`, the kind of each segment of the route's path as Nest's specificity sort ranks it
   * (`RouteSpecificitySorter`): a literal 0, text with a parameter 2, a parameter 3, a wildcard 4. For `precedence`, the
   * route's `Order` and then the digit of each segment of its template (`RoutePrecedence.ComputeInbound`): a literal 1,
   * a constrained parameter or a segment of several parts 2, a parameter 3, a constrained catch-all 4, a catch-all 5.
   */
  rank?: number[];
  /**
   * The parts of the route's rule as Werkzeug's `StateMachineMatcher` holds them, one a segment from the first (a
   * variable that takes slashes, `path`, makes one part of the rest), a `/` at the end left out (`trailing` says it): a
   * static part's text, or a part with variables: its regular expression as Werkzeug compiles it (the same for two parts
   * Werkzeug keeps in one state; a converter whose regex is not read stands as its class) and its weight (`Weighting`,
   * flattened: more pieces of static text first, the longer first, then more converters, then each converter's weight,
   * lower first). No weight where a converter's is not read.
   */
  parts?: Array<string | { regex: string; weight?: number[] }>;
  /**
   * Where the route is registered, from the router a request enters down to the one that holds the route: each step a
   * sequence of registrations whose order is known (`router`, one router in one function body of one file) and the
   * place in it (`at`). Of two routes, the one before is the one whose steps first differ in `at` within the same
   * `router`; routes whose steps first differ in `router` are in no order atlas knows.
   */
  order?: Array<{ router: string; at: number }>;
  /** The handler takes the `next` it may pass the request on with, so a route registered after it may answer too. */
  passes?: true;
  /**
   * How the router treats a `/` at the end of a request's path: `ignored` (Express, @koa/router), `strict` (a path with
   * it is another path: Fastify, Hono, Spring 6 and later), `redirected` (Starlette redirects a request no route takes
   * to the path with the `/` added or removed where a route takes that), `removed` and `added` (Next.js redirects every
   * request to the path without it, or with it, by `trailingSlash`), `appended` (Werkzeug serves the path as the route
   * writes it, and redirects a request without the `/` to the path with it where a route written with one takes that,
   * unless its matcher reaches a route that takes the request as written first: `strict_slashes`).
   */
  slashes?: "ignored" | "strict" | "redirected" | "removed" | "added" | "appended";
  /**
   * The route's path as served ends with a `/` (`slash`), or is served with and without one (`both`). On a route that
   * ends in a wildcard, `slash` says the path before the wildcard is served only with the `/` (find-my-way's `/x/*`,
   * Nest's `x/*`); that holds whatever `slashes` is.
   */
  trailing?: "slash" | "both";
  /**
   * The router takes a request to the route only where its headers meet a constraint (Fastify's `constraints`), or may,
   * where the route's options are not spelled out.
   */
  constrained?: true;
  /** The router matches the literal text of the path whatever its case (ASP.NET Core). */
  caseless?: true;
  /**
   * Parameters whose constraint atlas does not read as a regular expression (ASP.NET Core's `min(2000)`, `guid`, one
   * the application registers): the router may refuse a value the path takes there, so the route takes a request from
   * no other route for certain.
   */
  unchecked?: string[];
}

export interface Call {
  /** `from->to|METHOD /path@file#scope`, or `@file:line` without a scope; `~n` tells repeats apart. */
  id: string;
  from: string;
  to: string;
  method: string;
  path: string;
  /** Whether the call site joins a base address to the path, as `${baseUrl}/orders` does. */
  based: boolean;
  /** The call site writes a `/` at the end of the path, which `path` leaves out. */
  slash?: true;
  at: Place;
  evidence: Evidence;
  /** The function or method that holds the call site. */
  scope?: string;
  /**
   * For a URL relative to the page that holds it (a page-relative link, a form with no action): the path of the routes
   * whose page it was resolved against. The template is read once for each such path, and only those routes reach it.
   */
  page?: string;
}

/**
 * `match`: a call reaches a surface of its target by method and path (call id to surface id).
 * `reach`: a surface's handler calls the method `via`, which holds an outbound call (surface id to call id).
 */
export interface Edge {
  kind: "match" | "reach";
  from: string;
  to: string;
  evidence: Evidence;
  via?: string;
}

export interface DeclaredEdge {
  from: string;
  to: string;
  via: string;
}

export interface RegistryEntry {
  /** `registry:key`. */
  id: string;
  registry: string;
  key: string;
  at: Place;
  producers: Place[];
  consumers: Place[];
}


/**
 * An OpenAPI description of a component. `file`: committed in the repository, `location` is the file. `served`: the
 * component serves it, `location` is the path on the server; the server's origin depends on the environment.
 */
export interface ApiDocument {
  component: string;
  kind: "file" | "served";
  location: string;
  /**
   * How it was found: committed, route, nest-swagger jsonDocumentUrl, nest-swagger default, fastify-swagger-ui,
   * springdoc default, springdoc api-docs.path, springdoc group, springdoc group-configs, drf-spectacular urlconf.
   */
  convention: string;
  /** A served path that shows another served document, as a swagger UI's `uiConfig.url` does. */
  aliasOf?: string;
  /** For a committed file: how many of the component's routes it declares, which it lacks, and how many it adds. */
  agreement?: { surfaces: number; covered: number; missing: string[]; extra: number };
  at: Place;
  evidence: Evidence;
}

/** Which description is a component's, when the code decides it; otherwise why not, and the candidates. */
export interface ApiDescription {
  component: string;
  status: "chosen" | "ambiguous" | "none";
  location?: string;
  kind?: "file" | "served" | "author";
  /** AuthorOverride, ReadForRoutes, FileMatchesCode, ServedByCode, AliasesOfOne, OnlyPartialFile, OnlyFileUnconfirmed, SeveralCompleteFiles, SeveralServedDocuments, SeveralPartialFiles, SeveralReadForRoutes, NoneFound. */
  reason: string;
  message?: string;
  candidates: string[];
}

export interface Coverage {
  /** `routes <component>`, `calls <from>-><to>` or `registries <name>`. */
  source: string;
  files: number;
  items: number;
  /** Calls that reach a surface of their target. */
  matched?: number;
  /** Calls a surface of the same component leads to, so a trace can continue through them. */
  linked?: number;
}

export interface Document<K extends string> {
  apiVersion: typeof API_VERSION;
  kind: K;
  provenance: Provenance;
}

export interface Graph extends Document<"Graph"> {
  components: Component[];
  surfaces: Surface[];
  calls: Call[];
  edges: Edge[];
  declared: DeclaredEdge[];
  registries: RegistryEntry[];
  /** Every OpenAPI description found per component. */
  apiDocuments: ApiDocument[];
  /** Per component, which of them is its description, or why that is not decided. */
  apiDescriptions: ApiDescription[];
  coverage: Coverage[];
  limits: string[];
}

/** Part of a graph: the result of `trace` (around `seeds`) or `query` (matching `filter`). */
export interface Subgraph extends Document<"Trace" | "Query"> {
  seeds?: string[];
  filter?: Record<string, string>;
  surfaces: Surface[];
  calls: Call[];
  edges: Edge[];
}

export type RuleId = "FA001" | "FA002" | "FA003" | "FA004" | "FA007";

export interface Finding {
  rule: RuleId;
  /** Stable identity: the same situation keeps the same key when code moves. */
  key: string;
  title: string;
  message: string;
  at: Place[];
}

export type FindingStatus = "new" | "baseline" | "excepted" | "expired-exception";

export interface Findings extends Document<"Findings"> {
  since?: string;
  items: Array<{ finding: Finding; status: FindingStatus; note?: string }>;
}

export interface GraphDiff extends Document<"Diff"> {
  surfaces: { added: Surface[]; removed: Surface[] };
  componentEdges: { added: ComponentEdge[]; removed: ComponentEdge[] };
  findings: { new: Finding[]; resolved: Finding[] };
  /** Chains that appear, disappear, or reach different surfaces: what a change does to the requests the code makes. */
  chains: { added: string[]; removed: string[]; changed: Array<{ id: string; added: string[]; removed: string[] }> };
}

export interface ComponentEdge {
  from: string;
  to: string;
  /** `call` when a call matched a surface; otherwise the manifest field that declares it. */
  via: string;
}

/**
 * A reach edge from a route to the request its reply redirects to: the client that made the request follows it, so the
 * request is the client's, not a call the server makes. It is read as text; a call in a method named `redirect` is
 * reached with other evidence.
 */
export const isRedirect = (e: Edge): boolean => e.kind === "reach" && e.via === "redirect" && e.evidence === "text";

export const surfaceId = (s: { component: string; method: string; path: string }): string =>
  `${s.component}|${s.method} ${s.path}`;

export type Draft<T extends { id: string }> = Omit<T, "id">;
