---
name: flow-atlas
description: Use in a monorepo when a change crosses components — designing or adding an HTTP route, a client call, a registry entry (artifact, tool, event), checking whether something that does the job already exists, following or documenting a flow from the app through the BFF to the services, finding where a request breaks between components (a call nothing serves, a route nothing calls), walking a customer journey or scenario against the code to see which steps are built, and before finishing such work or opening a PR. The deterministic `atlas` CLI derives the structure — routes, calls, and each request with everything it reaches (chains) — and drafts flows from it; you write only the intent (titles, roles, which chains make a journey, decisions) and interpret component boundaries, and atlas checks what you wrote against the code.
license: MIT
compatibility: Requires Node.js 20+ and the atlas CLI from this repository (npx github:hellices/flow-atlas, or npm install -g github:hellices/flow-atlas). Reads git; writes only to --out.
metadata:
  version: "0.2.0"
  schema: flow-atlas.dev/v1alpha1
---

# flow-atlas

The repository's own AGENTS.md, design documents and governance tests take precedence over this skill.

## The rule: atlas owns the structure, you own the words

A flow has three layers, and only the last is yours:

1. **Chains (atlas).** A chain is one request and every surface it reaches in that request, fan-out included:
   `mobile->bff|POST /orders` and what its handler calls. `atlas chains` derives them on every run.
2. **What may follow (atlas).** A chain's `next` lists the requests its result offers, such as the links and forms of
   a page its handler renders.
3. **Intent (you).** A flow's title, labels and owner, each step's role, and, for a journey across requests, which
   chains in which order, picked from what atlas lists.

So:

- Never type a surface id, a chain id or a step order you worked out from reading code. Take chains from
  `atlas chains` or `atlas draft flows`; take a following step from a chain's `next`. If atlas does not list what you
  see in the code, the configuration or the extractor is behind: report that, do not write around it.
- The structural conditions (`Resolved`, `Connected`) fail only on facts from the code: a chain that is gone, a
  step the code does not reach. What you write fails other checks: `Documented` when a title or role is empty, and the
  schema check when a field is invalid. None of those says the code is wrong. What you write is a proposal until a
  person reviews the pull request that adds it.
- What atlas cannot settle stays visible: `Connected` and `Ready` are `Unknown (OrderNotInCode)` when you order two
  requests the code does not link, `unchained` surfaces, and chain edges joined `by name`. Leave them as they are; do not turn an
  Unknown into True by adding steps or edges by hand.

## Three parts

atlas generates what the code settles. You write what needs intent, and atlas checks it. Between the two, you interpret
which work belongs to which component, with the criteria in `references/boundaries.md`. Everything you decide goes
into a file atlas reads (flow files, the exceptions file, the configuration), so the next run and the next
agent see it.

### atlas generates: never write these by hand

| Fact | Command |
|---|---|
| surfaces, calls, edges, operationIds, registries | `scan` |
| surfaces and calls by path, method or component | `query` |
| a surface's callers upstream and the services it reaches downstream | `trace` |
| chains: each request, everything it reaches, who makes it, what may follow it, and whether any edge is joined only by name | `chains` |
| registry entries (tools, events, artifacts) with where each is listed, produced and consumed | `query --kind registries` |
| a Flow draft per chain no flow names, with its chain, entry and the requests that may follow | `draft flows` |
| whether a Flow holds in code, and whether its author fields are written | `flows` (conditions) |
| findings with locations and nearby paths | `check`, `explain` |
| what changed between revisions, including chains that appear, disappear or reach other surfaces, and the flows that reaches: a step built or lost, a condition that moved | `diff` |
| configuration candidates and how much the configuration covers | `inventory`, `scan` |
| each component's OpenAPI descriptions, how far committed ones agree with the code, and which one is the component's when the code decides it | `scan`, `inventory` |

Do not grep `graph.json`, guess callers from text search, or type surface ids from memory: copy them from atlas output.

### You write: atlas checks it

| What | Checked by |
|---|---|
| a Flow's `title` and each step's `role` | `Documented` (present, not true) |
| a journey: which chains, in which order, picked from atlas output | `Resolved`; `Connected` from `next`, else Unknown |
| a journey step that is no request (a tool an agent calls within one request, an event): a `registry` step, its id copied from `query --kind registries` | `Resolved` where a producer names the entry; its order is Unknown |
| `owner`, `labels`, `sources`, `lifecycle` (planned when a step is not built) | schema; `Resolved` counts planned steps apart |
| `produces` | `ProducesListed` |
| exceptions: reason, `decidedBy`, `reviewBy` | expiry brings the finding back |
| a misread file: an exception whose reason says which file and how | expiry brings the finding back |
| the configuration | `scan` coverage |
| the OpenAPI document the framework generates, for a component atlas cannot parse (`routes[].openapi`, `references/openapi.md`) | `scan` coverage and `limit:` lines |
| `origins`: the base URL each component runs at in an environment, from the deployment files | `export arazzo` notes a missing one; a `limit:` line names a host calls go to that no origin states |
| `openapi.<component>` when atlas reports its description `ambiguous` | `export arazzo` refuses until it is set |
| `openapi.<component>` or `routes[].openapi` for a component with no description, when a flow step uses it | `export arazzo` leaves its steps out, says so in the workflow (`x-flow-atlas.omitted`) and prints a `limit:` per step |
| a document outside the repository, committed or published (`openapi.<component>`: its URL, or the path the component serves it at) | `export arazzo` writes it by file name with a `limit:` until then |

Do not hand your part to the tool: no `publicSurfaces`, exception or baseline update without a reason a person would
accept.

### You interpret: boundaries

Whether a hop belongs to the component it sits in, whether a similar surface already does the job, whether a gap is a
defect, a plan or a false positive, how far to trust an edge, and where a flow starts and ends. Follow
`references/boundaries.md`; it orders the sources (repository rules, then flow roles, then code) and gives the
criteria.

## Setup

- Run `atlas --help`. If `atlas` is not installed, run it through npx (`npx github:hellices/flow-atlas --help`) or ask
  the user to install it; do not reimplement its readings by hand.
- The configuration is `<root>/atlas.config.yaml`, `<out>/atlas.config.yaml`, or `--config <file>`. If there is
  none, follow "Setting up" below.
- If the repository must not be written to, pass `--out <dir outside it>`. Every write goes there.

## Designing a change

1. `atlas query --path <path or fragment>` and `atlas chains --component <name>` to see what already exists: the
   routes, and the requests the code already makes with everything each reaches.
2. `atlas trace <closest surface>` to see one route in detail: client call, BFF route, the port methods its handler
   reaches, the service route each one matches.
3. Decide: reuse, extend, or add. Write down the surface keys you will add or change and which component owns each hop.
   If two components would end up doing the same step, settle that before writing code.
4. If the repository keeps flows (`flows/*.flow.yaml`), update the Flow, or, once the code exists, start one with
   `atlas draft flows` (see "Writing a flow"). For a route not built yet, a planned flow may name it as a surface step
   with `lifecycle: planned`.

## While implementing

After adding a route or a client call, run `atlas trace <surface>`. Upstream should show the caller you intended and
downstream the calls you intended. An empty side means either not wired yet, or wired in a way the tool cannot read
(a path built far from the call, a handler in another language, work the handler queues for a worker to run later,
an object injected from another package); open the code and say which. Past such a hand-off, say that atlas stops
there and what continues it, from the repository's design documents, its tests or runtime traces; do not write
steps or edges to carry the chain on.

When you add, remove or change a route of a component whose routes come from a generated OpenAPI document, regenerate
the document in the same change. A client call alone does not change it.

## Writing a flow

1. `atlas chains --unnamed` lists the requests no flow names yet; `atlas draft flows` prints a Flow for each (narrow it
   with `--component`). Save the output under `flows/<name>.flow.yaml`, or `<out>/flows/` for a repository you must not
   change.
2. Fill only the `agent:` lines: `title`, `labels`, each step's `role`, and `sources` when a decision or issue is behind the flow. Keep every line without a
   marker; the step, its chain and the entry come from the code.
3. For a journey across requests (open a page, then submit its form; attach, then send), write a flow whose steps are
   chains, in order. Take each following chain from the previous chain's `next` when atlas lists one; then `Connected`
   is True from the code. Two requests with nothing in the code linking them, whether one component makes both or
   one client hands off to another, give `Connected` and `Ready` `Unknown (OrderNotInCode)`: the order is yours, and
   it stays Unknown. A step that happens within one request (a tool an agent calls) is a `registry` step; see
   "Walking a journey against the code".
4. `atlas flows` until each flow is `Ready=True` or deliberately Unknown. A False `Resolved` or `Connected` means
   the code or the flow is wrong: decide which with `references/boundaries.md`. A False
   `Documented` means an author field is empty.

A file may hold several flows separated by `---`. Do not copy locations, edges, surfaces a chain reaches, or
conditions into the file; atlas computes them each run. A surface or call step, with the surface id copied from
`atlas query`, is still accepted for a plan that names a route not called yet. The format is `schema/flow.schema.json` in the flow-atlas
package, whose `docs/schema.md` and `docs/responsibilities.md` explain it.

## Walking a journey against the code

A journey, scenario or user story written outside the code (an issue, a product document) names what a customer does,
step by step, with branches. Walking it tells which steps the code has and which it does not; it does not tell whether
the customer gets the result the journey describes.

1. For each step, find what carries it out, from atlas output only: the request (`atlas chains`, `atlas query`), or,
   for what happens inside one request, such as a tool an agent calls in a conversation turn or an event a handler
   emits, the registry entry (`atlas query --kind registries`). If neither lists it, atlas does not observe it in the
   configured sources: read the `limit:` lines and the coverage, and open the code, before you call the step missing.
2. Write one flow per path of the journey: its steps in the journey's order, `chain` for a request and `registry` for
   an entry, `sources` naming the journey, and a role per step. A step nothing carries out yet is yours to name, as
   intent and not as a fact from the code: a `surface` (the route you mean to add) or a `registry` entry (the tool you
   mean to add) with `lifecycle: planned`; never a chain id atlas did not list.
   A branch that takes another request or entry is a flow of its own, reusing the shared steps through a `flow` step; a
   branch that differs only in the data or the reply is not structure and stays out of the flows.
3. `atlas flows` gives each step its place in the code, `planned`, or `NOT FOUND`. Report them as the journey's
   gaps: a planned step is work the journey still needs; an active step not found is one the flow expects and atlas
   does not place, which `atlas diff` shows as `gone` only where a change removed it. A step found is a step the code
   has, not a step that works: a registry step is found by its key occurring in a producer file, and a result the
   customer does not get is found by running it (tests, end-to-end runs, a person walking it), not by atlas. Say which
   steps you could not place and why.
4. The order of registry steps, and of requests the code does not link, stays Unknown. Do not add steps or edges to
   make it True.

`atlas export arazzo` gives a runner the journey's requests; registry steps are left out, each with its reason.

## Before finishing

1. `atlas diff <revision you started from>..WORKTREE --format markdown`. It lists only what your change did: new
   findings with their keys, requests that now reach other surfaces, and "Flows the change reaches" (steps built, lost
   or sent elsewhere). Put it in the PR description or hand-off note; each item is something a reviewer should see,
   intended or not.
2. For each new finding, `atlas explain <key>`, then handle it ("Handling a finding").
3. A request the diff lists as added that no flow names is a candidate for `atlas draft flows`.

## When the configuration has fallen behind

Signs: `limit:` lines on stderr (configured files match nothing, a source yields less than half of its baseline),
or FA001 on routes you know are called. Run `atlas inventory`, compare with the configuration, correct it
(`references/config.md`), and check `atlas scan` coverage again. Ask a person before `atlas baseline update`.

## Setting up

`atlas inventory` lists candidates without deciding anything. Write the configuration from it
(`references/config.md`); for a server framework atlas does not parse (Django Ninja, Ktor and others), generate its
OpenAPI document and point the routes at it (`references/openapi.md`), run `atlas scan` until every source yields what you expect, run `atlas check`, and go
through a sample of findings with a person. Only then record the baseline.

- Keep call files to the client adapters: screen routes (`context.push("/career/$id")`, `<Link href>`) look like
  requests and come back as FA002. React Router's and TanStack Router's navigations are known by their import and are
  not read as requests.
- What the code sets where atlas does not read it, you declare, each with a comment naming the line you read: a
  client's base (`calls[].base` with how it joins a path, `join`, or `calls[].prefix`, from a Dio `baseUrl` or an
  `axios.create({ baseURL })` given a value atlas does not read; and, in code read as text, `calls[].receivers`, the
  names the client is called on, and `calls[].baseValues`, the values that hold its base URL), the path an Express,
  @koa/router or Hono router or a Fastify plugin is mounted at, a FastAPI router included at, a Flask blueprint registered at, a Django URLconf included at or a Go file's routers are served at (`routes[].mounts`), a Nest global prefix set from a variable
  (`routes[].prefix`), a registration helper's method (`routes[].calls[].method`), the `data-*`
  attributes a template's scripts request (`calls[].dataUrls`), the method a project's wrapper around fetch sends
  when the call states none (`calls[].wrappers`, after reading that it hands its URL and init to fetch). A `limit:`
  line tells you when one is missing; never declare one to make a finding go away. A limit on a call whose method is
  not read fits routes of several methods, and trace and chains leave it out: when the call goes through such a
  wrapper, declare the wrapper; otherwise there is nothing to declare.

## Handling a finding

Run `atlas explain <key>` before deciding: it shows the calls or surfaces of a similar path. A candidate whose handler
does the same work under another path means one side was renamed; fix the side the contract or the other callers
disagree with. With no such candidate, the route or the caller is missing, or atlas does not read it (see `limit:`
lines and "Reading the output"): open the code to tell which. Do not point a call at a candidate because its path is
close. Then decide whether it is a defect, a plan or a false positive (`references/boundaries.md`):

- Fix it when the finding is the bug: wire the missing caller, remove the dead route, add the producer, point the
  call at the served path. `references/rules.md` lists the usual causes per rule.
- When the code is right on purpose, add an exception that names the decision:

  ```yaml
  # flows/atlas-exceptions.yaml (or <out>/exceptions.yaml)
  - rule: FA001
    key: FA001|orders|GET /orders/{id}/history
    reason: The service ships first; the app screen follows in the next release.
    decidedBy: docs/orders.md#history
    reviewBy: 2026-12-31
  ```

  Surfaces served to clients outside the repository go into `publicSurfaces` in the configuration.
- When the finding is wrong: if the configuration caused it (a missing call file, prefix or mount), correct the
  configuration. If the extractor misread a file, add an exception whose reason says which file and how it was misread,
  and report the misreading so the extractor can be fixed. A rule that is mostly wrong for the repository is switched
  off there (`rules.<id>.enabled: false`) with a person's agreement.

Never run `atlas baseline update` unless a person asks for it after seeing the findings it would accept. A request
for the outcome ("only show new problems from now on") is not that: show the findings, say which you think are debt,
defects or misreadings, and stop for the person to say "record the baseline". Never edit generated code to satisfy a finding.

## Machine-readable output

`--format json` or `--format yaml` prints documents that follow the flow-atlas package's `schema/*.schema.json`, each
with `apiVersion`, `kind` and `provenance` (the commit and files read, with digests). Read these instead of parsing the
text output; branch on a condition's `reason`, not its `message`. `atlas check --format sarif` gives the findings as
SARIF 2.1.0 for code-scanning and IDE viewers; `atlas export arazzo` prints the flows as Arazzo 1.0 for API workflow and
e2e tools, which still need parameters, request bodies and success criteria filled in. It writes nothing to `--out`:
save its output at the repository root (`atlas export arazzo > flows.arazzo.yaml`), since the description files it
names in the repository are relative to the root.

## Reading the output

- `atlas check` starts and ends with the counts. Its last line splits the calls: matched, unserved (FA002), not
  decided (a `limit:` line says why), not taken for requests, and not checked (no route source for the target, or FA002 off).
  Only "unserved" is a finding. Calls listed as reaching a route only an OpenAPI document declares go to a route the
  code was not found to have: a hand-written contract given as a route source, or a handler atlas did not find. Open
  the code before calling either built.
- Finding status: `new` is yours; `baseline` is accepted debt; `excepted` is covered; `expired-exception` needs a person.
- In a trace, `=` joins a call to a surface by method and path; `~` joins a route to an outbound call its handler
  runs: written in the handler's own code or the functions it calls (evidence `static`), or held in a method of a name
  the handler calls (evidence `name`), or, for a Spring page, made by the template its view name renders (`via view
  <name>`) or sent by the client that follows its redirect (`via redirect`). A `~` by name through a generic name
  (`get`, `send`) needs a look at the code.
- A call's `in <name>` is the function holding the string. A string in an error label or a log message is not a
  request even if it looks like a path; the scope usually shows that.
- Only configured files are read, and in them only what is written for certain: literal paths, with the meaning a
  standard or the framework gives them. A URL from a variable, another template engine, or htmx and Vue attributes
  is not read and not guessed. So "no caller" means none that atlas can read; check the code before removing anything,
  and declare surfaces served outside the repository in `publicSurfaces`. No finding does not prove a flow is complete.

## References

- Interpreting boundaries, deciding defect, plan or false positive: `references/boundaries.md`
- Rules, causes, resolutions, when an exception fits: `references/rules.md`
- Writing or correcting the configuration: `references/config.md`
- Reading routes from a framework's generated OpenAPI document, and how to generate it: `references/openapi.md`
