# flow-atlas

Find where flows that cross components of a monorepo come apart: an API no client calls, a client call no service
serves, a call across a boundary the manifests do not declare, an artifact nothing produces, a contract version
nothing uses. Every finding comes with a file and a line, and the same code always gives the same findings: no LLM is
involved.

It is built for coding agents. An agent works on part of a repository at a time, so it easily adds a second API that
does what an existing one does, builds the service side and forgets the client, or puts one component's job into
another. flow-atlas shows those gaps where the work happens, instead of in a later review or audit. The agent skill in
[`skills/flow-atlas`](skills/flow-atlas/SKILL.md) tells an agent when to run it and how to handle what it finds.

## What it finds

| Rule | Finds |
|---|---|
| FA001 | a route that no client in the repository calls |
| FA002 | a call to a path its target component does not serve |
| FA003 | a call between components the manifests do not declare, and component cycles |
| FA004 | a registry entry (artifact, tool, event) with no producer or no consumer |
| FA006 | a contract version that is neither active nor referenced |
| FA007 | a flow description that the code does not bear out |

Causes and fixes per rule: [rules.md](skills/flow-atlas/references/rules.md).

## Languages and frameworks

| Reads | From |
|---|---|
| routes | TypeScript and JavaScript code (NestJS decorators, Express, Fastify and other `app.get("/x")` receivers), FastAPI decorators, Spring MVC annotations with Spring Security's login and logout, and the OpenAPI 2.0 or 3.x document of any framework |
| client calls | TypeScript and JavaScript parsed; HTML templates (Thymeleaf `@{...}` links, root-relative `href`, `action` and `data-*` URLs); Kotlin, Python and other languages as text |
| what a route's handler calls next | TypeScript and JavaScript; for Spring MVC, the requests in the template a handler's view name renders |

For a Spring app, read its annotations (`styles: [spring]`) and give it springdoc's document as well: routes keep their
controller lines and take the document's operationIds. For Django REST framework (drf-spectacular), Flask (flask-smorest, flasgger) and the rest,
give atlas the document the framework generates; it finds each operation's handler by the operationId where it can.
[`fixtures/openapi`](fixtures/openapi/README.md) holds eight documents that seven frameworks actually generate (Fastify in both formats), and
[openapi.md](skills/flow-atlas/references/openapi.md) how to produce one without serving it.

## Who does what

atlas generates what the code settles: routes, calls, how they connect, operationIds, OpenAPI descriptions and how
far they agree with the code, flow traces, flow drafts, and the findings above.

An agent or a person writes what needs intent: a flow's title, what each component does in it, its owner, whether a
step is planned, why a finding is an accepted exception. atlas does not guess these; it checks that they are written
and still hold.

The skill gives the criteria for judgments in between: whether a hop belongs to the component it sits in, whether a
gap is a defect, a plan or a false positive. See [docs/responsibilities.md](docs/responsibilities.md).

## Install

Node.js 20 or later.

```bash
npx github:hellices/flow-atlas --help        # run without installing; prepare builds it on install
npm install -g github:hellices/flow-atlas    # install the atlas command
```

Recent npm versions may ask before running install scripts; if `prepare` is blocked, install the packed release
(`npm install -g <flow-atlas-x.y.z.tgz URL>`).

The skill is the `skills/flow-atlas` directory and follows the [Agent Skills](https://agentskills.io) specification,
so GitHub Copilot, Claude Code, Codex, Cursor and other hosts load it the same way. With GitHub CLI 2.90 or later:

```bash
gh skill install hellices/flow-atlas flow-atlas
```

or copy the directory into your host's skills directory (for example `.github/skills/` or `.agents/skills/`).

## Use

```bash
atlas inventory --root <repo>                 # candidate components, routes, client calls, versioned files
atlas scan --root <repo>                      # what each configured source yielded
atlas query --path /orders                    # surfaces and calls by path or component
atlas trace "bff|GET /screens/order/{id}"     # callers upstream and services downstream
atlas draft flow "bff|GET /screens/home"      # a flow draft from the code, the author's fields marked
atlas flows                                   # flow descriptions held against the code
atlas check --root <repo>                     # findings new since the baseline
atlas check --since main                      # findings the current change introduced
atlas check --format sarif > atlas.sarif      # findings as SARIF 2.1.0 (code scanning, IDE viewers)
atlas diff main..WORKTREE --format markdown   # flow changes and new findings for a PR description
atlas export arazzo                           # flows as Arazzo 1.0 for API workflow and e2e tools
atlas explain <key>                           # one finding with nearby paths
atlas baseline update                         # accept the current findings as known debt
atlas feedback <key> false-positive --note "why"
atlas stats                                   # per-rule action and false-positive rates
```

`--ref <commit>` reads a commit without checking it out, and every write goes to `--out`, so a repository you must not
change can be analysed with `--out` outside it. Writing the configuration: [config.md](skills/flow-atlas/references/config.md);
expect two or three rounds of `scan` and correction before the findings are worth trusting.

## Day to day

Once the configuration reads what it should, record the current findings with `atlas baseline update`. From then on
only new findings appear: existing debt is reduced on its own schedule, and each change answers only for what it
introduced.

A new finding is fixed, or recorded in the exceptions file with the decision behind it and a date to look again; when
the date passes, the finding comes back. A wrong finding is recorded with `feedback`, and `stats` shows each rule's
false-positive rate; a rule that is mostly wrong for a repository is switched off there, or its extractor fixed.

atlas reports and does not block by default. To fail CI on new findings, use `--fail-on-new`.

## How traces connect

`trace` joins two kinds of link. A call joins a route when the method and path agree (`=`). Inside a component, a
route's handler is followed through local functions, relative imports and re-exports, and joins an outbound call
(`~`) in two ways: the handler's own code runs the request (evidence `static`), or the request sits in a method whose
name the handler calls (evidence `name`). The second covers ports and adapters: the handler calls
`deps.backend.getOrder()` and the adapter's `getOrder` makes the HTTP request. Because it joins by name, a link
through a common name such as `get` or `send` is worth opening. For a Spring page, the requests in the template its
view name renders are its outbound calls (`via view <name>`).

## Flows and schemas

A flow is written in `flows/*.flow.yaml` as a Kubernetes-style object (`apiVersion`, `kind: Flow`, `metadata`,
`spec`), with Arazzo-style steps that name the repository's own routes and calls, each with the role its component
plays. Its metadata carries [Open Knowledge Format](https://github.com/GoogleCloudPlatform/knowledge-catalog/tree/main/okf)
trust fields: `sources`, `generated`, `verified` and `stale_after`. `atlas flows` reports Kubernetes-style conditions
for each flow (`Ready`, `Resolved`, `Connected`, `EntryCalled`, `ProducesListed`, `Documented`, `Fresh`) and its OKF
trust tier.

Everything printed with `--format json` or `--format yaml` follows the JSON Schemas in [`schema/`](schema), with
`apiVersion`, `kind` and an SLSA-shaped `provenance` (the commit and files read, with digests) and no timestamps, so
the same inputs give the same document. Route paths are OpenAPI path templates (`{id}`). Why each field is there:
[docs/schema.md](docs/schema.md) and [docs/standards.md](docs/standards.md).

## Develop

```bash
pnpm install
pnpm build
pnpm test
```

`fixtures/shop` is a small monorepo with nine planted problems; the tests check that exactly those are found, that
baselines, exceptions and `--since` work, that commits are read without a checkout, that flows trace from a web client
through a BFF handler's port call to a service, and that SARIF and Arazzo output pass the official schemas.

If you install dependencies through a registry mirror, keep the mirror's URLs out of the committed lockfile:

```bash
git config filter.public-registry.clean "node scripts/public-registry.mjs"
git config filter.public-registry.smudge cat
```

## Limits

Routes and calls are read from string literals. A path assembled across several functions, or a URL taken from a
server response, is not seen and shows up as FA001. Only configured files are read, so no finding does not prove a
flow complete. Field-level contract checks are not implemented yet.

## License

MIT. The official schemas under `test/standards/` are third-party material under their publishers' terms.
