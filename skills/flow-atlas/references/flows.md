# Flows and journeys

A flow has three layers, and only the last is yours:

1. **Chains (atlas).** One request and every surface it reaches in that request, fan-out included:
   `mobile->bff|POST /orders` and what its handler calls. `atlas chains` derives them on every run.
2. **What may follow (atlas).** A chain's `next` lists the requests its result offers, such as the links and forms of
   a page its handler renders.
3. **Intent (you).** A flow's title, labels and owner, each step's role, and, for a journey across requests, which
   chains in which order, picked from what atlas lists.

The structural conditions (`Resolved`, `Connected`) fail only on facts from the code: a chain that is gone, a step the
code does not reach. What you write fails other checks: `Documented` when a title or role is empty, and the schema
check when a field is invalid. None of those says the code is wrong.

## Writing a flow

1. `atlas chains --unnamed` lists the requests no flow names yet; `atlas draft flows` prints a Flow for each (narrow it
   with `--component`). Save the output under `flows/<name>.flow.yaml`, or `<out>/flows/` for a repository you must not
   change.
2. Fill only the `agent:` lines: `title`, `labels`, each step's `role`, and `sources` when a decision or issue is behind
   the flow. Keep every line without a marker; the step, its chain and the entry come from the code.
3. For a journey across requests (open a page, then submit its form; attach, then send), write a flow whose steps are
   chains, in order. Take each following chain from the previous chain's `next` when atlas lists one; then `Connected`
   is True from the code. Two requests with nothing in the code linking them, whether one component makes both or
   one client hands off to another, give `Connected` and `Ready` `Unknown (OrderNotInCode)`: the order is yours, and
   it stays Unknown. A step that happens within one request (a tool an agent calls) is a `registry` step; see
   "Walking a journey against the code".
4. `atlas flows` until each flow is `Ready=True` or deliberately Unknown. A False `Resolved` or `Connected` means
   the code or the flow is wrong: decide which with `boundaries.md`. A False `Documented` means an author field is
   empty.

A file may hold several flows separated by `---`. It holds only what you write: atlas computes locations, edges,
the surfaces a chain reaches and conditions on each run. A surface or call step, with the surface id copied from
`atlas query`, is still accepted for a plan that names a route not called yet (`lifecycle: planned`). The format is
`schema/flow.schema.json` in the flow-atlas package, whose `docs/schema.md` and `docs/responsibilities.md` explain it.

## What you write, and what checks it

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
| the OpenAPI document the framework generates, for a component atlas cannot parse (`routes[].openapi`, `openapi.md`) | `scan` coverage and `limit:` lines |
| `origins`: the base URL each component runs at in an environment, from the deployment files | `export arazzo` notes a missing one; a `limit:` line names a host calls go to that no origin states |
| `openapi.<component>` when atlas reports its description `ambiguous` | `export arazzo` refuses until it is set |
| `openapi.<component>` or `routes[].openapi` for a component with no description, when a flow step uses it | `export arazzo` leaves its steps out, says so in the workflow (`x-flow-atlas.omitted`) and prints a `limit:` per step |
| a document outside the repository, committed or published (`openapi.<component>`: its URL, or the path the component serves it at) | `export arazzo` writes it by file name with a `limit:` until then |

`publicSurfaces`, an exception or a baseline update each needs a reason a person would accept.

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
   mean to add) with `lifecycle: planned`; a `chain` step takes only an id atlas lists.
   A branch that takes another request or entry is a flow of its own, reusing the shared steps through a `flow` step; a
   branch that differs only in the data or the reply is not structure and stays out of the flows.
3. `atlas flows` gives each step its place in the code, `planned`, or `NOT FOUND`. Report them as the journey's
   gaps: a planned step is work the journey still needs; an active step not found is one the flow expects and atlas
   does not place, which `atlas diff` shows as `gone` only where a change removed it. A step found is a step the code
   has, not a step that works: a registry step is found by its key occurring in a producer file, and a result the
   customer does not get is found by running it (tests, end-to-end runs, a person walking it), not by atlas. Say which
   steps you could not place and why.
4. The order of registry steps, and of requests the code does not link, stays Unknown.

`atlas export arazzo` gives a runner the journey's requests; registry steps are left out, each with its reason
(`output.md`).

## Past a hand-off

Where a handler queues work for a worker or calls an object injected from another package, atlas stops. Say that it
stops there and what continues it, from the repository's design documents, its tests or runtime traces; the chain ends
there in the flow too.
