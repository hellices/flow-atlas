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
  /** Member methods the handler calls, following local and relatively imported functions. */
  reaches?: string[];
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
  at: Place;
  evidence: Evidence;
  /** The function or method that holds the call site. */
  scope?: string;
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

export interface ContractVersion {
  /** `family-vN`. */
  id: string;
  family: string;
  version: number;
  active: boolean | undefined;
  at: Place;
  references: Place[];
}

/**
 * An OpenAPI description of a component. `file`: committed in the repository, `location` is the file. `served`: the
 * component serves it, `location` is the path on the server; the server's origin depends on the environment.
 */
export interface ApiDocument {
  component: string;
  kind: "file" | "served";
  location: string;
  /** How it was found: committed, route, nest-swagger jsonDocumentUrl, nest-swagger default, fastify-swagger-ui. */
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
  /** `routes <component>` or `calls <from>-><to>`. */
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
  versions: ContractVersion[];
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

export type RuleId = "FA001" | "FA002" | "FA003" | "FA004" | "FA006" | "FA007";

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

export const surfaceId = (s: { component: string; method: string; path: string }): string =>
  `${s.component}|${s.method} ${s.path}`;

export type Draft<T extends { id: string }> = Omit<T, "id">;
