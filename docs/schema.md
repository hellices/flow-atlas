# Flow Atlas schemas

This document fixes the format of the documents flow-atlas reads and writes. The format comes first for one reason:
tools added later, such as Mermaid, an HTML viewer or an end-to-end test runner, must read only this format and produce
the same result. If the format wavered, an LLM would end up filling the gaps, and the same input would give different
pictures.

The schemas are JSON Schema (2020-12) under `schema/`. The TypeScript types (`src/model.ts`, `src/flows.ts`) follow
them, and the tests check that the fixtures and every command's output conform.

## Three specifications underneath

Instead of inventing a frame, flow-atlas borrows three widely used ones.

The Kubernetes Resource Model (KRM), set out by Brian Grant at Google, gives every object `apiVersion`, `kind`,
`metadata`, `spec` and `status`. `spec` holds the state a person wants; `status` holds the state a controller observes.
State is written as a list of `conditions`, each with `type`, `status` (True, False, Unknown), `reason` and `message`.
The model's aim is that a CLI, a UI and deployment tools adapt once to every API that uses the frame. Backstage takes
the same frame for a repository's `catalog-info.yaml`; describing software configuration in YAML inside the repository,
it is the closest precedent.

SLSA provenance, started at Google and maintained by the OpenSSF, records where an artifact came from: which tool
(`builder`), how (`buildType`), with what inputs (`externalParameters`), reading what (`resolvedDependencies`, each with
a digest). Timestamps are optional.

Arazzo 1.0 describes sequences of API calls as workflows and steps. The step structure inside a flow comes from it.

## Two layers

Documents are split by who writes them.

| Layer | Written by | Format | kind |
|---|---|---|---|
| flow descriptions (spec) | people and agents | YAML, `flows/*.flow.yaml` | `Flow` |
| flow model and observations (status) | atlas | JSON, YAML on request | `Graph`, `Trace`, `Query`, `FlowReport`, `Findings`, `Diff`, `Inventory` |

KRM keeps spec and status in one object. flow-atlas does not write status back into the YAML people wrote; it goes to a
separate `FlowReport`. Backstage likewise keeps only the spec in repository files and lets the catalog attach relations
and state. A tool that edits files people wrote tangles reviews and conflicts, and invites agents to edit tool output
by hand.

## Flow

```yaml
apiVersion: flow-atlas.dev/v1alpha1
kind: Flow
metadata:
  name: view-order
  title: The web order screen shows one order
  labels:
    domain: orders
  sources:
    - id: screens
      resource: docs/orders.md#screens
      title: Order screen decision
  generated: { by: claude-code/opus-4, at: 2026-10-01T09:00:00Z }
  verified: { by: human:shop-lead, at: 2026-10-02T09:00:00Z }
  stale_after: 2027-04-01T00:00:00Z
spec:
  lifecycle: active
  owner: shop-team
  entry:
    component: web
    description: Order screen
  steps:
    - stepId: screen
      surface: "bff|GET /screens/order/{orderId}"
      role: Builds the order screen from the orders service
    - stepId: read
      surface: "orders|GET /orders/{id}"
      role: Owns the order record
  produces: ["document:receipt"]
```

A file may hold several flows separated by `---`, as KRM manifests do.

`metadata` identifies and classifies. `name` is unique in the repository and corresponds to Arazzo's `workflowId`.
`labels` are short values to select flows by: grouped by `domain: orders`, a viewer can show only the order flows.
`annotations` hold values tools and people attach that are not used for selection; atlas adds
`flow-atlas.dev/location` (file and line) in its reports.

The remaining four fields take their names and meanings from Google's Open Knowledge Format (OKF) 0.2, a format that
attaches provenance, trust and a review date to knowledge people and agents write and revise. A flow's title and roles
are such knowledge, so they use the same fields.

| Field | OKF section | Meaning |
|---|---|---|
| `sources` | §5.1 | the decisions, design documents and issues behind the flow; `resource` is required, and `id`, `title`, `author` and `last_modified` are optional |
| `generated` | §5.2 | who wrote the intent (`by`) and when it last changed in substance (`at`); an agent is `<tool>/<model>`, a person `human:<id>` |
| `verified` | §5.2 | who confirmed it, one mapping or a list; agents never write a `human:` entry |
| `stale_after` | §5.5 | from this time on, the roles need review |

atlas derives the trust tier from `verified` (§5.3): none is unverified, confirmations without `human:` are
machine-confirmed, and one with `human:` is human-reviewed. The tier is a signal and does not enter `Ready`.
`stale_after` becomes the `Fresh` condition, compared with the time of the commit read (the present only for the
working tree), so reading the same commit again gives the same result.

Some of OKF is not taken. Its `status` (draft, stable, deprecated) is a document's maturity, while `spec.lifecycle`
here means a step with no code yet (`planned`), so they differ; the trust tier covers review. The file format
(Markdown with frontmatter) is not taken either: the step structure is easier in YAML, and Markdown for reading can be
exported later. Documents the tool generates use the timestamp-free `provenance` instead of OKF's `generated.at`.

`spec` is the shape the flow must keep.

| Field | Meaning | From |
|---|---|---|
| `lifecycle` | `active`: the code must follow the flow. `planned`: steps may not exist yet. `deprecated`: not checked | Backstage `spec.lifecycle` |
| `owner` | the person or team who answers for the flow | Backstage `spec.owner` |
| `entry` | the starting point outside the graph (a screen and the like); this component must call the first step | added |
| `steps` | the hops the flow must pass | Arazzo `steps` |
| `produces` | registry entries the flow issues (`registry:key`) | added |

A step follows Arazzo's Step: it has a `stepId` and points at its target with one of `surface`, `call` or `flow`, where
Arazzo has `operationId`, `operationPath` or `workflowId`. `role` is what the component does in that step; keeping
modules' responsibilities from mixing needs this written down. Not every hop between steps has to be listed: atlas
finds the shortest path along the graph's edges to the next step.

Arazzo's `dependsOn` is not included. In Arazzo it means run order; this tool does not run flows, and reusing another
flow is covered by a `flow` step.

Arazzo's run semantics are not taken: `parameters`, `requestBody`, `successCriteria`, `onSuccess`, `onFailure`,
`outputs` and runtime expressions are for tools that call the API. flow-atlas reads code to check flows and calls
nothing. `atlas export arazzo` writes Flows as an Arazzo 1.0 document. Where the component's chosen description is a
file atlas can read, each operation is resolved against it: that document's operationId, else an `operationPath` with
the path key the document writes (which may name parameters differently from the code, such as `{orderId}`); an
operation the document does not declare is left out with a note. Otherwise a route's operationId is used, else an
`operationPath` (`{$sourceDescriptions.bff.url}#/paths/~1orders~1{id}/get`). The flows a selected flow runs are
exported with it, and an export with no workflow stops.

atlas finds each component's OpenAPI description itself, and chooses among several only when the code decides: the
author's `openapi` entry first, then the document the configuration reads routes from (`routes[].openapi`,
`ReadForRoutes`), then the one committed file that declares every route the code serves, then the one document the code
serves. Paths that show the same document are one: a swagger-ui page whose `uiConfig.url` shows `/openapi.json` is an
alias of it. A committed file that lacks routes is taken as a stale copy, and the difference is reported. When nothing
decides, the description is `ambiguous` and `export arazzo` stops.

When the chosen document is served, the server address in front of its path differs per environment and goes into the
configuration's `origins`. Parameters, request bodies and success criteria do not come from the code; whoever runs the
Arazzo document fills them in.

## The head of model documents

Every document atlas writes starts with the same head.

```yaml
apiVersion: flow-atlas.dev/v1alpha1
kind: FlowReport
provenance:
  builder: { id: flow-atlas, version: 0.1.0 }
  buildType: flow-atlas/FlowReport@v1alpha1
  externalParameters:
    ref: origin/main
  resolvedDependencies:
    - { name: code,   uri: ".",                    digest: { gitCommit: fd8775b457... } }
    - { name: config, uri: atlas.config.yaml,      digest: { sha256: 8619fff1... } }
    - { name: flows,  uri: flows/home.flow.yaml,   digest: { sha256: f2fcd80e... } }
```

`provenance` is a flow-atlas structure that takes the names and meanings of four SLSA provenance v1 fields and lays
them out flat. In SLSA, `buildType`, `externalParameters` and `resolvedDependencies` sit under
`predicate.buildDefinition` and `builder` under `predicate.runDetails`, wrapped in an in-toto statement (`_type`,
`subject`, `predicateType`); flow-atlas does neither, so this is not a statement to hand to a SLSA consumer as is. Each
entry of `resolvedDependencies` has exactly the shape of an in-toto ResourceDescriptor. `externalParameters` keeps the
values the caller gave, and `resolvedDependencies` the commits and files actually read, with digests: a moving name
such as `origin/main` stays in the former, the commit it pointed at in the latter, so which inputs produced a verdict
can be checked later.

Some things are left out: the time of creation, the machine that ran, absolute paths. The same commit, configuration
and flow files must give a byte-identical document so it can be compared and cached. Reading an uncommitted working
tree, `code` has no digest.

| kind | Command | Holds |
|---|---|---|
| `Graph` | `scan` | components, routes, calls, edges, registry entries, contract versions, what each configured source read |
| `Trace` | `trace` | the subgraph upstream and downstream of a starting route |
| `Query` | `query` | the routes and calls that match, with their neighbours one edge away |
| `FlowReport` | `flows` | each flow's metadata and status |
| `Findings` | `check` | findings and their state (new, baseline, excepted, expired-exception) |
| `Diff` | `diff` | routes, component links and findings that changed between two revisions |
| `Inventory` | `inventory` | candidates to look at when writing the configuration |

`Trace` and `Query` share `Graph`'s node and edge shape (`subgraph.schema.json`), so a renderer needs to know one shape.

## Nodes and edges

| Element | id | Tool metadata |
|---|---|---|
| route (surface) | `component\|METHOD /path` | `at` (file and line), `evidence`, `operationId`, `described` (where an OpenAPI document declares the operation), `describedPath` (the path key it uses), `reaches` (the methods the handler calls) |
| call | `from->to\|METHOD /path@file#scope` | `at`, `evidence`, `scope` (the function that holds the call), `based` |
| edge | `kind`, `from`, `to` | `evidence`, `via` |
| registry entry | `registry:key` | `at`, `producers`, `consumers` |
| OpenAPI document | component and location | `kind` (file, served), `convention` (how it was found), `aliasOf` (the path it shows), `agreement` (how much of the code's routes a committed file declares), `at` |
| description choice | component | `status` (chosen, ambiguous, none), `location`, `kind`, `reason`, `candidates` |
| contract version | `family-vN` | `active`, `references` |

Route paths are OpenAPI path templates: Nest's or Express's `:id` becomes `{id}`, Spring's `{id:\d+}` becomes `{id}`.
The same route has the same id whichever framework registered it, and matches an OpenAPI `paths` key as is. A
catch-all at the end of a Spring path (`{*rest}`, `**`) keeps its form and matches the rest of a request's path. An
`operationId` is read where the code states it (route options, `@ApiOperation`); with `operationIds: nest-swagger` in
the configuration, @nestjs/swagger's default rule (`Class_method`) is applied.

Spring MVC routes are read from annotations with `styles: [spring]`: a type's `@RequestMapping` joined to each
`@GetMapping`, `@PostMapping`, `@PutMapping`, `@DeleteMapping`, `@PatchMapping` and `@RequestMapping` in the type's
body, methods united as Spring combines them, and the POST endpoints Spring Security's `formLogin` and `logout` serve.

For a framework atlas does not read (Django, Flask and others), the OpenAPI 2.0 or 3.x document the framework generates
is given in `routes[].openapi`, and each operation becomes a route. The path takes Swagger 2.0's `basePath` or the path
of the first OpenAPI 3 server URL in front, without the host or a trailing `/`. The handler is placed by the rule the
framework derives operationIds by (FastAPI `function_path_method`, Nest `Class_method`, springdoc's method name) when
it finds one definition (`evidence: name`), else where code declares the operationId as a quoted value, once (`text`),
else at the document (`declared`). A route that any entry of the same component also reads from code (same method and
path, parameter names aside) keeps its code location and gains the document's operationId, `described` and
`describedPath`.

Call ids use the enclosing function's name rather than a line number, because an id that changed whenever code above
it changed would break flow descriptions. Only a call outside any function uses its line, and a repeated id gets a
suffix such as `~2`.

Edges are of two kinds. `match` joins a call to a route of its target whose method and path agree (call → route). For
a Spring component, whose router picks the most specific route, a request whose path is fully known matches only that
route; elsewhere it matches every route it fits, since registration order is not read. `reach` joins a route to an
outbound call its handler leads to (route → call): the handler's code makes the request (`evidence: static`), the
request sits in a method whose name the handler calls (`evidence: name`, `via` the method), or, for a Spring page, the
request is in the template the handler's view name renders (`evidence: name`, `via view <name>`).

`evidence` records how a fact was obtained: `declared`, written in a manifest or a document; `static`, parsed syntax;
`text`, matched as text; `name`, joined because a name agrees. A renderer can vary line styles by it, and an agent
checks `name` and `text` grounds against the code once more.

## FlowReport and conditions

Each item of a `FlowReport` is a Flow's `metadata` and the `status` atlas observed. `status.observedRef` is the commit
it was held against, KRM's `observedGeneration`. `conditions` always has the same seven entries in the same order.

| type | True | False | Unknown |
|---|---|---|---|
| `Ready` | no condition failed (`NoConditionFailed`) | any is False (`ConditionsFailed`) | planned steps are not built yet (`PlannedStepsPending`), deprecated (`Deprecated`) |
| `Resolved` | every step is in the code (`AllStepsResolved`; `PlannedStepsPending` when only planned steps are missing) | a step is missing (`StepNotFound`) | |
| `Connected` | every pair of neighbouring steps connects (`AllStepsConnected`) | a pair of active steps has no path (`NoPathBetweenSteps`) | not checked because a step is unresolved (`StepsUnresolved`); the link to a planned step is not built yet (`PlannedStepsPending`) |
| `EntryCalled` | the entry component calls the first step (`EntryCallsFirstStep`) | it does not (`EntryDoesNotCall`) | no `entry` (`NoEntry`), first step unresolved (`FirstStepUnresolved`) |
| `ProducesListed` | every listed registry entry exists (`AllListed`) | some does not (`NotInRegistry`) | none listed (`NotDeclared`) |
| `Documented` | a title and each step's role are written (`TitleAndRolesWritten`) | no title (`TitleMissing`), a step without a role (`RoleMissing`) | |
| `Fresh` | before `stale_after` (`BeforeStaleAfter`) | past it (`PastStaleAfter`) | no `stale_after` (`NoStaleAfter`) |

`Documented` and `Fresh` look at the author's part, not the code; the others check that the flow holds in the code.
The status also carries the OKF trust tier (`trust`). Who writes what is set out in
[responsibilities.md](responsibilities.md).

`reason` is a stable CamelCase code tools can branch on; `message` is for people. A viewer colours a flow by `Ready`
and shows where the problem is from the other conditions. KRM's `lastTransitionTime` is left out, since a timestamp
would make the same input give a different document; when a condition changed is seen by comparing two revisions'
reports with `diff`.

FA007 in `check` comes from these conditions and the step details: what is False in an `active` flow becomes a
finding. A `planned` flow treats all its steps as planned; its conditions are computed but produce no findings.

## SARIF export of findings

`atlas check --format sarif` writes findings as SARIF 2.1.0. The finding key becomes
`partialFingerprints.flowAtlasKey/v1`, the baseline `baselineState` (new, unchanged), and an exception `suppressions`
(external, accepted, the reason in `justification`). Rules go into `tool.driver.rules` with their name and default
level (error for FA002, note for FA006, warning for the rest), artifact locations are relative URI references with
each path segment percent-encoded, and the document's provenance goes into the run's `properties`. GitHub code
scanning and the VS Code SARIF Viewer read it as is.

## Version policy

`apiVersion` is `flow-atlas.dev/v1alpha1`. As KRM's convention goes, fields may change while it is alpha. After `v1`,
the version changes only when a field is removed or changes meaning; additions stay within the version. The schemas
set `additionalProperties: false`, so an added field is added to the schema too. Id formats (`component|METHOD /path`
and the others) and conditions' `reason` codes are part of the schema.

## Validation

`atlas flows` checks flow files against `flow.schema.json` as it reads them; a document that does not conform is not
resolved, and the error is reported. Another tool receiving a model document checks it against the schema for its
`kind`. The schemas' `$id` is `urn:flow-atlas:schema:v1alpha1:<name>`.
