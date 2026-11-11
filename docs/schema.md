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

`sources` lists the decisions, design documents and issues behind the flow; `resource` is required, and `id`, `title`,
`author` and `last_modified` are optional. It keeps the shape of a source in Google's Open Knowledge Format (OKF) 0.2
(§5.1). Who wrote a flow's intent and who reviewed it are in the history of the pull requests that change the file.

`spec` is the shape the flow must keep.

| Field | Meaning | From |
|---|---|---|
| `lifecycle` | `active`: the code must follow the flow. `planned`: steps may not exist yet. `deprecated`: not checked | Backstage `spec.lifecycle` |
| `owner` | the person or team who answers for the flow | Backstage `spec.owner` |
| `entry` | the starting point outside the graph (a screen and the like); this component must call the first step. A flow whose first step is a chain, or a sub-flow that starts with one, takes it from the chain and needs none | added |
| `steps` | the hops the flow must pass | Arazzo `steps` |
| `produces` | registry entries the flow issues (`registry:key`) | added |

A step follows Arazzo's Step: it has a `stepId` and points at its target with one of `chain`, `surface`, `call` or
`flow`, where Arazzo has `operationId`, `operationPath` or `workflowId`. A `chain` step is one request and everything
it reaches (see Chains); it is the form to write, since its structure comes from the code. `surface` and `call` steps
are kept for plans that name a route not called yet and for flows written before chains. `role` is what the component does in that
step; keeping modules' responsibilities from mixing needs this written down. Not every hop between surface steps has to
be listed: atlas finds the shortest path along the graph's edges to the next step. Between two chain steps the link is
a request the first chain's result offers (`next`); with none, two chains one component starts are in the author's
order (`Connected: Unknown`), and any other pair is not connected.

Arazzo's `dependsOn` is not included. In Arazzo it means run order; this tool does not run flows, and reusing another
flow is covered by a `flow` step.

Arazzo's run semantics are not taken: `parameters`, `requestBody`, `successCriteria`, `onSuccess`, `onFailure`,
`outputs` and runtime expressions are for tools that call the API. flow-atlas reads code to check flows and calls
nothing. `atlas export arazzo` writes Flows as an Arazzo 1.0 document. Where the component's chosen description is a
file atlas can read, each operation is resolved against it: that document's operationId, else an `operationPath` with
the path key the document writes (which may name parameters differently from the code, such as `{orderId}`); an
operation the document does not declare is left out with a note. Otherwise a route's operationId is used, else an
`operationPath` (`{$sourceDescriptions.bff.url}#/paths/~1orders~1{id}/get`). The flows a selected flow runs are
exported with it.

A step that cannot be written (its component has no decided description, its route accepts any method, its document
does not declare it, the flow it runs is not exported) is left out with a `limit:` line saying why and what to set,
and the rest is written. A flow that loses some steps is still written, because its other steps are what the code
holds and a viewer or an agent can use them; but an Arazzo workflow is a sequence and the steps left are not the
flow, so the workflow says so in its `description` and lists the left-out steps, each with its reason, in
`x-flow-atlas.omitted`. Whoever runs it must add those steps back or not run it as the flow. A flow with no step left
is not written, and neither is a step that runs it. Left-out steps stop the export only when they leave no workflow
to write; an `ambiguous` description (below) stops it whatever else could be written.

atlas finds each component's OpenAPI description itself, and chooses among several only when the code decides: the
author's `openapi` entry first, then the document the configuration reads routes from (`routes[].openapi`,
`ReadForRoutes`), then the one committed file that declares every route the code serves, then the one document the code
serves (springdoc's groups are as many documents). Paths that show the same document are one: a swagger-ui page whose `uiConfig.url` shows `/openapi.json` is an
alias of it. A committed file that lacks routes is taken as a stale copy, and the difference is reported. When nothing
decides, the description is `ambiguous` and `export arazzo` stops: the choice is one line of configuration and the
repository's to make. A component with no description at all (one atlas reads from code only) does not stop it; its
steps are left out.

When the chosen document is served, the server address in front of its path differs per environment and goes into the
configuration's `origins`. A file in the repository, named by a relative or an absolute path (there at the revision
read, whether or not on this disk), is written relative to the repository root, and the document says it assumes it is
kept there (Arazzo resolves a relative URL against the document). The export prints to stdout and writes nothing to
`--out`; save it at the repository root. A file is placed where its links lead: a committed
link to a file outside the repository is outside it, since git keeps only the link. A file outside the repository is
not written as a path on the machine that ran atlas but by its file name, as a file next to the exported document,
with a `limit:` to commit the document or publish it and set `openapi.<component>` to its URL. Nothing in the code says
such a file is the document the component serves, so a served path and `origins` are not put in for it; when the code
serves one, the `limit:` names it, and setting `openapi.<component>` to that path says they are the same. Two
different documents written under one name are reported. Parameters, request bodies and success criteria do not come from the code; whoever
runs the Arazzo document fills them in.

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
| `Graph` | `scan` | components, routes, calls, edges, registry entries, what each configured source read |
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
| route (surface) | `component\|METHOD /path` | `at` (file and line), `evidence`, `operationId`, `described` (where an OpenAPI document declares the operation), `describedPath` (the path key it uses), `describedVersion` (that document's version), `reaches` (the methods the handler calls), `implicit` (served by the framework with no handler written for it, such as Next.js's HEAD and OPTIONS, the files of `public/` and the metadata files of `app/`, or requested by convention from outside the code, such as its robots.txt, sitemaps and manifest; no rule expects a caller), `patterns` (the regexp each parameter named there must match, as Fastify, Hono, Spring or AdonisJS's matchers test it), `dispatch` (how its router picks it and treats a trailing `/`: `picks`, `order`, `passes`, `slashes`, `trailing`, `constrained`; see below) |
| call | `from->to\|METHOD /path@file#scope` | `at`, `evidence`, `scope` (the function that holds the call), `based`, `page` (the path a URL relative to its page was resolved against), `slash` (the path is written with a trailing `/`) |
| edge | `kind`, `from`, `to` | `evidence`, `via` |
| registry entry | `registry:key` | `at`, `producers`, `consumers` |
| OpenAPI document | component and location | `kind` (file, served), `convention` (how it was found), `aliasOf` (the path it shows), `agreement` (how much of the code's routes a committed file declares), `at` |
| description choice | component | `status` (chosen, ambiguous, none), `location`, `kind`, `reason`, `candidates` |

Route paths are OpenAPI path templates: Nest's or Express's `:id` becomes `{id}`, Spring's `{id:\d+}` becomes `{id}`,
Starlette's `{id:str}` becomes `{id}`. The same route has the same id whichever framework registered it, and matches an
OpenAPI `paths` key as is. Parameters that share a segment with text are written there (`/flights/{from}-{to}`), each
taking some text of it, and a path one registration serves in several forms is a route per form (Express 5's
`/about{/:section}` is `/about` and `/about/{section}`). The regexp Fastify (`:code(^[a-z]+)`) or Hono
(`:code{[a-z]+}`) tests a parameter with is kept in the route's `patterns`, so the id stays the template; a request
reaches the route only where the text it gives the parameter matches. So is what a parameter sharing its segment takes
where that is not some text of it: Fastify's `(.*?)` and Spring's `(.*)`, none included (Spring's own regexp of such a
variable, written for Java, is not kept, so `.*` stands for it). Starlette's other converters (`{id:int}`,
`{id:float}`, `{id:uuid}`) are kept as written: each takes only the segments its regex does. Two forms
are kept as the router writes them, because OpenAPI has no template for them: a catch-all at the end of a path, which
matches the rest of a request's path, and a wildcard within a segment (`*.txt`, and Spring's `t?st.html`, `?` being one
character), which matches any text in that segment. Spring's `{*rest}` and `**` (and Next.js's `[[...rest]]`, written
`{*rest}`, Hono's final `/*`, written `**`, and path-to-regexp 8's `/x{/*rest}`, written `/x/{*rest}`) match the path
without them too. Fastify's and Express 4's final `/*` (written `**`) and path-to-regexp 8's `/x/{*rest}` (Nest's
`/x/*`) take `/x/`, with nothing after its `/`, but not `/x`: the route's `dispatch.trailing` is `slash`, and a request
for `/x` is not matched to it. `{rest}/**` (Next.js's `[...rest]`, path-to-regexp 8's `*rest`) takes one segment or
more; Starlette's `{rest:path}`, also how a mount is compiled (`/static/{path:path}`), is `.*` after the `/` before it,
so a request without that segment is answered with the redirect to the path with a `/` added, which Starlette's router
answers when no route, of any method, matches the path: it is matched to none, and a `limit:` names the redirect
(where the route's router is not read, it is matched to the route, through the redirect). A path that holds either is not an OpenAPI template. `export arazzo` names such a route as a
description that declares it does; without one, the operation path it writes keeps the router's form, which an Arazzo
tool cannot resolve. Paths that differ only in a trailing `/` are one route, whose `dispatch.trailing` says which
forms it is served at where its router tells them apart (`slash`, `both`; neither where only the form without is).
`dispatch` holds how the route's router dispatches, as far as atlas reads it: `picks` (`registration`, the first
route registered that a request fits, in the `order` of the route's steps from the router a request enters to the one
holding it, each a sequence of registrations and a place in it; `find-my-way`, Fastify's precedence; `specificity`,
Nest's sort by the `rank` of each segment, then `order`), `passes` (its
handler may pass the request on to a later route), `slashes` (`ignored`, `strict`, `redirected` for Starlette, `removed`
and `added` for Next.js's `trailingSlash`) and `constrained` (Fastify takes a request to it only with headers that meet
its constraints). Where an OpenAPI document writes the
`/` (a server path or `basePath` before the root key `/` puts one after it), a call that leaves it out is matched to
the route only by GET or HEAD. Whether another method reaches it depends on the framework (Starlette's redirect keeps
the method, Django's may lose a POST's body), so such a call is matched to none and a `limit:` names it. A route
whose document writes the path as the call does comes before one the call reaches only by that redirect
(`describedPath` and the call's `slash` keep what was written). An
`operationId` is read where the code states it (route options, `@ApiOperation`); with `operationIds: nest-swagger` in
the configuration, @nestjs/swagger's default rule (`Class_method`) is applied.

Spring MVC routes are read from annotations with `styles: [spring]`: a type's `@RequestMapping` joined to each
`@GetMapping`, `@PostMapping`, `@PutMapping`, `@DeleteMapping`, `@PatchMapping` and `@RequestMapping` in the type's
body, methods united as Spring combines them, and the POST endpoints Spring Security's `formLogin` and `logout` serve.

For a framework atlas does not read (Django, Flask and others), the OpenAPI 2.0 or 3.x document the framework generates
is given in `routes[].openapi`, and each operation becomes a route. The path takes Swagger 2.0's `basePath` or the path
of the first OpenAPI 3 server URL in front, without the host or a trailing `/`. The handler is placed by the rule the
framework derives operationIds by (FastAPI `function_path_method`, Nest `Class_method`, springdoc's method name; a
numbered id such as springdoc's `get_1` is not traced back to `get`) when
it finds one definition (`evidence: name`), else where code declares the operationId as a quoted value, once (`text`),
else at the document (`declared`), and a limit lists the operations left there. A route that any entry of the same component also reads from code (same method and
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
request is in the template the handler's view name renders (`evidence: name`, `via view <name>`), or its reply
redirects to the request (`evidence: text`, `via redirect`). A redirect's request is a call from the route's own
component to itself, a GET of the URL after `redirect:` (a HEAD from a HEAD route); it is the client's that made the
request, so it is no component calling another (no FA003). A URL relative to its page (a page-relative Thymeleaf link, a form with no
action) is read once for each path of the routes that render its template, and the call's `page` holds that path:
only those routes reach it.

`evidence` records how a fact was obtained: `declared`, written in a manifest or a document; `static`, parsed syntax;
`text`, matched as text; `name`, joined because a name agrees. A renderer can vary line styles by it, and an agent
checks `name` and `text` grounds against the code once more.

## Chains

`atlas chains` derives, on every run, the requests the code makes. A chain starts at a call no handler makes in the
same request (the client's call), or at a surface declared in `publicSurfaces` that no component calls (`outside`). It
takes in the surface the call reaches and every surface that surface's handler reaches, along reach and match edges,
fan-out included. Its id is `<entry>-><surface id>`, such as `mobile->bff|POST /orders`.

A reach edge to a call in the template a page renders (`via view <name>`), or in a link or form a Next.js page renders
(`via view <file>`), is not part of the page's request: the user makes that call later. Those calls start chains of
their own, and the page's chain lists them as `next`, which is where a journey's following step comes from.
A reach edge to a call in the template a page renders (`via view <name>`) is not part of the page's request: the user
makes that call later. Those calls start chains of their own, and the page's chain lists them as `next`, which is where
a journey's following step comes from. A redirect of the chain's root (`via redirect`) is followed by the entry that
made the request, so its `next` is a chain of that entry, made when no call of the entry starts it (with no callers).
A public surface reached only by redirects starts an `outside` chain unless a chain of a component's call redirects to
it, so public routes that only redirect to each other are chained.

| Field | Meaning |
|---|---|
| `entry` | the component that makes the request and its call sites, or `outside` |
| `root` | the surface the request reaches |
| `surfaces` | the root and every surface reached in the same request, nearest first |
| `edges` | the reach and match edges between them |
| `next` | requests the result offers: the chain, the surface that offers it, and how |
| `weak` | edges joined only because a name agrees; read those handlers before relying on them |
| `digest` | changes when the surfaces or the links between them change, not when code moves within a file |

`unchained` lists surfaces no chain reaches: no path of calls leads to them from a call that starts a request, and
they are not declared public. Two handlers that only call each other, with nothing calling either from outside, leave
both surfaces unchained. `atlas diff` reports
chains added, removed, and changed with the surfaces they now reach or no longer reach.

## FlowReport and conditions

Each item of a `FlowReport` is a Flow's `metadata` and the `status` atlas observed. `status.observedRef` is the commit
it was held against, KRM's `observedGeneration`. `conditions` always has the same five entries in the same order.

| type | True | False | Unknown |
|---|---|---|---|
| `Ready` | no condition failed (`NoConditionFailed`) | any is False (`ConditionsFailed`) | planned steps are not built yet (`PlannedStepsPending`), the flow orders chains the code does not link (`OrderNotInCode`), deprecated (`Deprecated`) |
| `Resolved` | every step is in the code (`AllStepsResolved`; `PlannedStepsPending` when only planned steps are missing) | a step is missing (`StepNotFound`) | |
| `Connected` | every pair of neighbouring steps connects (`AllStepsConnected`); between two chain steps (a sub-flow counts as the chains at its ends), the first chain's `next` offers the second | a pair of active surface or call steps has no path (`NoPathBetweenSteps`) | not checked because a step is unresolved (`StepsUnresolved`); the link to a planned step is not built yet (`PlannedStepsPending`); two chains with no link in the code from the first to the second, ordered by the author, whoever makes the requests (`OrderNotInCode`) |
| `ProducesListed` | every listed registry entry exists (`AllListed`) | some does not (`NotInRegistry`) | none listed (`NotDeclared`) |
| `Documented` | a title and each step's role are written (`TitleAndRolesWritten`) | no title (`TitleMissing`), a step without a role (`RoleMissing`) | |

`Documented` looks at the author's part, not the code; the others check that the flow holds in the code. Who writes
what is set out in
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
level (error for FA002, warning for the rest), artifact locations are relative URI references with
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
