---
name: flow-atlas
description: Use in a monorepo when a change crosses components — designing or adding an HTTP route, a client call, a registry entry (artifact, tool, event) or a contract version, checking whether something that does the job already exists, following or documenting a flow from the app through the BFF to the services, and before finishing such work or opening a PR. The deterministic `atlas` CLI generates the facts and flow drafts; you write the intent (titles, roles, decisions) and interpret component boundaries, and atlas checks what you wrote.
license: MIT
compatibility: Requires Node.js 20+ and the atlas CLI from this repository (npx github:hellices/flow-atlas, or npm install -g github:hellices/flow-atlas). Reads git; writes only to --out.
metadata:
  version: "0.1.0"
  schema: flow-atlas.dev/v1alpha1
---

# flow-atlas

The repository's own AGENTS.md, design documents and governance tests take precedence over this skill.

## Three parts

atlas generates what the code settles. You write what needs intent, and atlas checks it. Between the two, you interpret
which work belongs to which component, with the criteria in `references/boundaries.md`. Everything you decide goes
into a file atlas reads (flow files, the exceptions file, the configuration, feedback), so the next run and the next
agent see it.

### atlas generates: never write these by hand

| Fact | Command |
|---|---|
| surfaces, calls, edges, operationIds, registries, contract versions | `scan` |
| surfaces and calls by path, method or component | `query` |
| a surface's callers upstream and the services it reaches downstream | `trace` |
| a Flow draft: name, steps along the code's path, entry when one component calls it, candidates where it branches | `draft flow` |
| whether a Flow holds in code, and whether its author fields are written | `flows` (conditions) |
| findings with locations and nearby paths | `check`, `explain` |
| what changed between revisions | `diff` |
| configuration candidates and how much the configuration covers | `inventory`, `scan` |
| each component's OpenAPI descriptions, how far committed ones agree with the code, and which one is the component's when the code decides it | `scan`, `inventory` |

Do not grep `graph.json`, guess callers from text search, or type surface ids from memory: copy them from atlas output.

### You write: atlas checks it

| What | Checked by |
|---|---|
| a Flow's `title` and each step's `role` | `Documented` |
| `owner`, `labels`, `sources`, `lifecycle` (planned when a step is not built) | schema; `Resolved` counts planned steps apart |
| `generated: { by: <tool>/<model>, at }` once you have written a flow's intent; `stale_after` when it should be reviewed (OKF) | schema; `Fresh` |
| the entry component when several call the first step; the next step where the handler branches | `EntryCalled`, `Connected` |
| `produces` | `ProducesListed` |
| exceptions: reason, `decidedBy`, `reviewBy` | expiry brings the finding back |
| false positives, with why | `stats` |
| the configuration | `scan` coverage |
| `origins`: the base URL each component runs at in an environment, from the deployment files | `export arazzo` notes a missing one |
| `openapi.<component>` when atlas reports its description `ambiguous` | `export arazzo` refuses until it is set |

Do not hand your part to the tool: no `publicSurfaces`, exception or baseline update without a reason a person would
accept. Never write a `verified` entry with a `human:` actor: that records a person's review, and the flow's trust tier
(`unverified`, `machine-confirmed`, `human-reviewed`) depends on it.

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

1. `atlas query --path <path or fragment>` and `atlas query --component <name>` to see what already exists.
2. `atlas trace <closest surface>` to see the chain: client call, BFF route, the port methods its handler reaches,
   the service route each one matches.
3. Decide: reuse, extend, or add. Write down the surface keys you will add or change and which component owns each hop.
   If two components would end up doing the same step, settle that before writing code.
4. If the repository keeps flows (`flows/*.flow.yaml`), update the Flow, or start a new one with
   `atlas draft flow <surface>` (see "Writing a flow"). Mark steps that do not exist yet `lifecycle: planned`.

## While implementing

After adding a route or a client call, run `atlas trace <surface>`. Upstream should show the caller you intended and
downstream the calls you intended. An empty side means either not wired yet, or wired in a way the tool cannot read
(a path built far from the call, a handler in another language); open the code and say which.

## Writing a flow

1. `atlas draft flow <first surface>` prints a Flow with everything the code settles; add `--to <surface>` to follow
   the code to a given end. Save it under `flows/<name>.flow.yaml` (or `<out>/flows/` for a repository you must not
   change).
2. Fill every `agent:` comment: `title`, each step's `role` (what the component does and leaves to others), `owner`,
   `lifecycle`, `produces`; pick the entry and the next steps where the draft lists candidates. Keep the values
   without a marker; they come from the code.
3. `atlas flows` until the flow is `Ready=True`. A False `Resolved`, `Connected` or `EntryCalled` means the code or
   the flow is wrong: decide which with `references/boundaries.md`. A False `Documented` means an author field is empty.

A file may hold several flows separated by `---`. Surface ids write path parameters as OpenAPI templates (`{id}`).
Do not copy locations, edges or conditions into the file; atlas computes them each run. The format is
`schema/flow.schema.json` in the flow-atlas package, whose `docs/schema.md` and `docs/responsibilities.md` explain it.

## Before finishing

1. `atlas check --since <revision you started from>`. Only findings your change introduced appear.
2. For each: `atlas explain <key>` shows the locations and similar paths. Then fix it, or record an exception, or
   record a false positive. See "Handling a finding".
3. Put `atlas diff <base>..WORKTREE --format markdown` (or `<base>..HEAD`) and the `trace` of each new surface in
   the PR description or hand-off note.

## When the configuration has fallen behind

Signs: `limit:` lines on stderr (configured files match nothing, a source yields less than half of its baseline),
or FA001 on routes you know are called. Run `atlas inventory`, compare with the configuration, correct it
(`references/config.md`), and check `atlas scan` coverage again. Ask a person before `atlas baseline update`.

## Setting up

`atlas inventory` lists candidates without deciding anything. Write the configuration from it
(`references/config.md`), run `atlas scan` until every source yields what you expect, run `atlas check`, and go
through a sample of findings with a person. Only then record the baseline.

## Handling a finding

Decide first whether it is a defect, a plan or a false positive (`references/boundaries.md`), then:

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
- When the finding is wrong: `atlas feedback <key> false-positive --note "<why>"`. If the extractor misread a file,
  say which file and how.

Never run `atlas baseline update` unless a person asks for it. Never edit generated code to satisfy a finding.

## Machine-readable output

`--format json` or `--format yaml` prints documents that follow the flow-atlas package's `schema/*.schema.json`, each
with `apiVersion`, `kind` and `provenance` (the commit and files read, with digests). Read these instead of parsing the
text output; branch on a condition's `reason`, not its `message`. `atlas check --format sarif` gives the findings as
SARIF 2.1.0 for code-scanning and IDE viewers; `atlas export arazzo` gives the flows as Arazzo 1.0 for API workflow and
e2e tools, which still need parameters, request bodies and success criteria filled in.

## Reading the output

- Finding status: `new` is yours; `baseline` is accepted debt; `excepted` is covered; `expired-exception` needs a person.
- In a trace, `=` joins a call to a surface by method and path; `~` joins a route to an outbound call its handler
  runs: written in the handler's own code or the functions it calls (evidence `static`), or held in a method of a name
  the handler calls (evidence `name`). A `~` by name through a generic name (`get`, `send`) needs a look at the code.
- A call's `in <name>` is the function holding the string. A string in an error label or a log message is not a
  request even if it looks like a path; the scope usually shows that.
- Only configured files are read. No finding does not prove a flow is complete.

## References

- Interpreting boundaries, deciding defect, plan or false positive: `references/boundaries.md`
- Rules, causes, resolutions, when an exception fits: `references/rules.md`
- Writing or correcting the configuration: `references/config.md`
