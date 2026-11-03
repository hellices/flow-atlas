# Alignment with standards

For each field of flow-atlas's documents, we looked at who writes it and which standard it lines up with, and decided
what to keep and what to leave out. Two tests apply: the field has to serve the problem this tool solves, and where a
widely used standard exists, the field takes its shape so other tools need no adapter.

## The problem the tool solves

When people develop without understanding flows that cross components, one module's work ends up spread over several.
flow-atlas extracts the flows from the code, checks the flows people write against the code, and points out where they
diverge while the work is being done. Its output must be readable by people, joinable to end-to-end test tools later,
and usable by agents.

## Who reads the output

| Reader | Needs |
|---|---|
| agents | route and call lookups, flow traces, stable finding keys, reason codes for flow states |
| reviewers | a change summary and a picture to put in a PR description |
| renderers (Mermaid, HTML) | nodes and edges, per-flow state |
| IDEs and code review tools | findings attached to files and lines |
| end-to-end test tools | the API operations a flow's steps point at |
| runtime observation (traces) | route names to set against the static graph |

## Standards by concern

| Concern | Standard | Choice | Why |
|---|---|---|---|
| the shape of the flow files people write | Kubernetes Resource Model, the Backstage descriptor format | followed | the `apiVersion`, `kind`, `metadata`, `spec` frame with labels and annotations, the most widespread frame for describing software configuration in YAML inside a repository |
| steps within a flow | Arazzo 1.0 | followed, with an export | step structure and names match, and `atlas export arazzo` produces Arazzo documents that pass the official schema |
| where authored knowledge comes from, how far it is trusted, how long it holds | Google Open Knowledge Format (OKF) 0.2 | followed | `sources`, `generated`, `verified` and `stale_after` in a flow's `metadata` keep OKF's names and meanings; the trust tier is derived from `verified` only, as in OKF §5.3. OKF's file format and `status` are not taken |
| observed state | Kubernetes status conditions | followed | `type`, `status` (True, False, Unknown), `reason`, `message`; only the timestamp fields are left out |
| where a generated document came from | SLSA provenance v1 (in-toto ResourceDescriptor) | shape followed | the commits and files read are recorded with digests. SLSA is a specification for build outputs, so no SLSA conformance is claimed |
| static analysis results | SARIF 2.1.0 (OASIS) | export | GitHub code scanning, the VS Code SARIF Viewer and review bots read it as is; the output passes the official schema |
| route names | OpenAPI path templates | followed | path parameters are written `{name}` in ids, so a route has the same id whatever framework registers it |
| where OpenAPI documents are | conventional file names and frameworks' default paths | followed | `openapi.yaml`, `swagger.json`, Nest's `jsonDocumentUrl` and `<path>-json`, `@fastify/swagger-ui`'s `<prefix>/json` and `/openapi.json` routes are found in the code; only server addresses come from environment settings |
| operation names | OpenAPI operationId | followed | the operationId the code states is read; when configured, @nestjs/swagger's default rule (`Class_method`) is applied |
| joining runtime observation | OpenTelemetry HTTP semantic conventions | mapping only | `component` maps to `service.name`, `method` to `http.request.method`, and a normalized `http.route` to the route path |
| graph exchange format | JSON Graph Format, SARIF graphs | not followed | no graph exchange standard is widely used; nodes and edges are kept plain so renderers can use them directly |
| component catalogs | Backstage Component and API relations | not followed | using Backstage entity names as component names joins the two; no separate field is needed for now |

## Field by field

| Field | Used for | Decision |
|---|---|---|
| `metadata.name` | flow id, Arazzo `workflowId`, finding keys | kept |
| `metadata.labels` | grouping flows in a renderer | kept |
| `metadata.annotations` | location information the tool attaches | kept |
| `metadata.links` | the decision documents behind a flow | replaced by OKF `sources` |
| `metadata.generated`, `verified` | whether an agent wrote the roles, whether a person reviewed them | added (OKF); this was the gap in the three-part split |
| `metadata.stale_after` | when the intent should be reviewed again | added (OKF); agreement with the code is checked every run, but whether the intent still holds is not something a machine knows |
| `spec.lifecycle` | building the backend first (planned), retiring (deprecated) | kept; a distinction repositories that build the backend first actually needed |
| `spec.owner` | who answers for the flow | kept |
| `spec.entry` | checking that the app calls the first step | kept; it catches, flow by flow, APIs the app does not call |
| `spec.produces` | checking that the artifacts a flow issues are listed | kept; it ties artifacts without a producer to flows |
| `spec.dependsOn` | in Arazzo, run order | dropped; a `flow` step, which uses another flow as one step, is enough for reuse, and run order is outside this tool |
| `steps[].role` | what each component takes on | kept; the core of keeping responsibilities from mixing. The tool cannot check it; people and agents read it |
| `steps[].surface`, `call`, `flow` | what a step points at | kept |
| route `operationId` | Arazzo export, joining OpenAPI documents | added |
| route paths written `{name}` | stable ids, joining OpenAPI and traces | changed; earlier ids kept framework notation such as `:id` |
| condition `DependenciesDescribed` | checking `dependsOn` | dropped |
| the other five conditions | renderer colours, agent branching | kept |
| condition `Documented` | whether the author's fields (title, step roles) are written | added; the tool does not guess them, it only sees whether they are empty. See [responsibilities.md](responsibilities.md) |
| `provenance` | caching, comparison, reproduction | kept |
| call `based`, route `reaches` | the grounds for matching and for `reach` edges | kept; renderers can ignore them, agents use them to check the grounds |

## Verification

Exported documents are checked against the official schemas: `test/standards/` holds the official SARIF 2.1.0 and
Arazzo 1.0 schemas, and the tests validate the fixture's SARIF and Arazzo output against them. Nest's default
operationId rule was confirmed in @nestjs/swagger's `swagger-explorer.js` as `${controllerKey}_${methodKey}`.

## Open questions

`role` is prose, so the tool cannot check it. A machine-readable way to state what a component must not take on (for
example, components a step must not pass through) will be added if real use shows the need.

End-to-end tests are joined through `atlas export arazzo`. A tool that runs Arazzo needs parameters, request bodies
and success criteria; these do not come from the code, so an agent or a person fills them in.

Checking static edges against runtime traces is settled only as far as the OpenTelemetry mapping. Once end-to-end
tests leave traces, `service.name`, `http.request.method` and a normalized `http.route` can be set against the graph's
routes.
