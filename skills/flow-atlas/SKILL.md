---
name: flow-atlas
description: Map and check cross-component HTTP flows in a monorepo with the deterministic `atlas` CLI. Use before adding or changing a route, a client call or a registry entry (tool, event, artifact), when finding where a request breaks between components, when writing a flow or walking a journey against the code, and before opening a PR on such a change.
license: MIT
compatibility: Requires Node.js 20+ and the atlas CLI from this repository (npx github:hellices/flow-atlas, or npm install -g github:hellices/flow-atlas). Reads git; writes only to --out.
metadata:
  version: "0.2.0"
  schema: flow-atlas.dev/v1alpha1
---

# flow-atlas

The repository's own AGENTS.md, design documents and governance tests take precedence over this skill.

## The rule: atlas owns the structure, you own the words

atlas derives from the code what the code settles: routes, calls, and **chains** (one request and every surface it
reaches in that request), with what may follow each. You write only intent: a flow's title and roles, which chains make
a journey and in which order, and decisions. atlas checks what you write against the code.

- Copy surface ids, chain ids and step orders from atlas output (`chains`, `query`, `draft flows`); a following step
  comes from a chain's `next`. Where atlas does not list what the code shows, the configuration or atlas is behind:
  say so, and keep it out of the flow.
- Keep what atlas cannot settle visible: an order the code does not link stays `Unknown (OrderNotInCode)`, an edge
  joined `by name` stays one, and `unchained` surfaces stay listed. Steps or edges written by hand to make them True are not checked by anything.
- Every decision goes into a file atlas reads (flow files, the exceptions file, the configuration), so the next run
  and the next agent see it. What you write is a proposal until a person reviews the pull request that adds it.

## Setup

- `atlas --help` lists the commands; `atlas trace --help` and the like give one. Without a global install, run
  `npx github:hellices/flow-atlas --help`, or ask the user to install it.
- The configuration is `<root>/atlas.config.yaml`, `<out>/atlas.config.yaml`, or `--config <file>`. With none, write
  one first (`references/config.md`, "Order of work").
- atlas writes to `<root>/.atlas` by default. When the repository must not change, or the task says not to change
  files, pass `--out <dir outside it>` to every command: every write goes there.

## Designing a change

1. `atlas query --path <path or fragment>` and `atlas chains --component <name>`: what already exists, and the requests
   the code makes with everything each reaches.
2. `atlas trace <closest surface>`: one route's callers upstream and the calls its handler reaches downstream.
3. Decide reuse, extend or add; write down the surface keys you will add or change and which component owns each hop
   (`references/boundaries.md`). Settle it before writing code when two components would do the same step.
4. Where the repository keeps flows (`flows/*.flow.yaml`), update the flow (`references/flows.md`).

## While implementing

After adding a route or a client call, `atlas trace <surface>`: upstream should show the caller you meant, downstream
the calls you meant. An empty side is either not wired yet or wired in a way atlas does not read (a path built far from
the call, another language, work queued for a worker, an object injected from another package): open the code and say
which. Where a component's routes come from a generated OpenAPI document, regenerate it in the same change.

## Before finishing

1. `atlas diff <revision you started from>..WORKTREE --format markdown`: the new findings, the requests that now reach
   other surfaces, and the flows the change reaches. Put it in the PR description or hand-off note: each item is one a
   reviewer should see, intended or not.
2. For each new finding, `atlas explain <key>`, then handle it (`references/rules.md`, "Handling a finding").
3. A new request no flow names is a candidate for `atlas draft flows`.

## The baseline is a person's decision

Run `atlas baseline update` only when a person asks for that command after seeing the findings it would accept. A
request for the outcome ("only show new problems from now on", "set up checks so only new issues fail") is not that
request: run `atlas check`, show the findings, say which you think are debt, defects or misreadings, and stop for the
person to say "record the baseline". Leave `baseline.json` unwritten until then, in the repository and in `--out`.

## Reading the output

atlas reports evidence, not verdicts. Judging what it means for a flow (a defect, a plan, a misreading) is yours.

- A `limit:` line is where reading stopped, with the file, line and expression. Open the code there before concluding
  anything. Where it names a configuration entry to set, set it; where none fits, judge the code yourself. atlas reads
  the forms a technology documents, as written, and leaves the rest to you.
- In a trace, `=` is a call matched by method and path; `?` one that fits only because an interpolated value takes
  the route's fixed text, so read the call before counting it as a caller; `~` a call the handler runs (by `name`:
  check it in the code).
- A finding states the facts it rests on; it is where to look, not what to do. "No caller" means none atlas can read.
- Each fact is listed once: count findings and chains as atlas lists them.

`references/output.md` has the rest: the counts `check` prints, finding states, trace evidence in detail, and the
JSON, SARIF and Arazzo output.

## References

| When | Read |
|---|---|
| which component owns a hop, where a flow starts and ends, how far to trust an edge, and whether a gap is a defect, a plan or a false positive | `references/boundaries.md` |
| handling a finding, what each rule means, when an exception fits | `references/rules.md` |
| writing or correcting the configuration, or a `limit:` names an entry | `references/config.md` |
| a server framework atlas does not parse: reading its generated OpenAPI document | `references/openapi.md` |
| writing a flow, or walking a journey or scenario against the code | `references/flows.md` |
| reading counts, statuses and trace evidence in detail; JSON, SARIF and Arazzo output | `references/output.md` |
