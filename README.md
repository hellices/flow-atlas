# flow-atlas

**Check that the services in a monorepo still fit together, while the code is being written.**

flow-atlas reads the routes each service registers and the requests each client sends, and checks a change against the
other services. No LLM is involved: the same code always gives the same findings.

It is built for coding agents. An agent works on one part of a repository at a time, so it easily builds the client
and forgets the service, adds a second API that does what an existing one does, or puts one service's job into another.
flow-atlas shows those gaps while the agent works, instead of in a later review.

![A refund call that no service serves, found by atlas check and fixed](docs/media/demo.gif)

```bash
git clone https://github.com/hellices/flow-atlas && cd flow-atlas
npx github:hellices/flow-atlas check --root fixtures/shop
```

## Contents

- [What it finds](#what-it-finds)
- [Key terms](#key-terms)
- [What it reads](#what-it-reads)
- [Install](#install)
- [Use with a coding agent](#use-with-a-coding-agent)
- [Step by step](#step-by-step)
- [Flows and output](#flows-and-output)
- [Limits](#limits)
- [Documentation](#documentation)
- [Contributing](#contributing)

## What it finds

| Finding | Example | Code in the output |
|---|---|---|
| An API nobody calls | `orders` serves `GET /orders/{id}/history`, and no client in the repository requests it | FA001 |
| A call nothing serves | the demo above | FA002 |
| A dependency that is not declared, or a cycle | `web` calls `orders` directly, but its `component.json` declares only that it uses `bff` | FA003 |
| A registry entry (an artifact, a tool or an event) with one side missing | a `coupon` document is produced, and nothing consumes it | FA004 |
| A written flow the code no longer follows | a flow names a route that was renamed, or two steps the code does not connect | FA007 |

The code is how a finding is named everywhere: in the output, in the exceptions file and in the configuration
(`rules.FA003.enabled: false` switches that check off). Causes and fixes for each:
[rules.md](skills/flow-atlas/references/rules.md).

## Key terms

| Term | Meaning |
|---|---|
| component | a service or app in the monorepo, such as `web`, `bff` or `orders` |
| surface | something a component serves: an HTTP route, most of the time (`orders\|GET /orders/{id}`) |
| call | a request one component sends to another (`bff -> orders  POST /orders`) |
| chain | one request and everything it reaches in turn |
| flow | a journey you describe in a file (`flows/*.flow.yaml`), built from chains, with what each component does in it |
| registry | a list whose entries one component produces and another consumes (artifact kinds, events, the tools an agent calls); a flow step can name an entry |
| limit | a `limit:` line: something atlas saw but could not read for certain, so it left it out rather than guess |
| baseline | the findings you accepted as known debt; `check` shows only findings new since then |

## What it reads

| Language | Routes | Client calls |
|---|---|---|
| TypeScript, JavaScript | Express, Fastify, Koa (@koa/router), Hono, NestJS, Next.js | fetch, axios, Ky, openapi-fetch, RTK Query, Angular HttpClient, @hey-api/openapi-ts, orval |
| Python | FastAPI, Flask, Quart, Django and Django REST framework | Requests, HTTPX |
| Java, Kotlin | Spring MVC, Spring WebFlux, Spring Boot | RestTemplate, RestClient, WebClient, OkHttp, Retrofit, OpenFeign, Ktor client |
| C# | ASP.NET Core (minimal APIs and controllers) | HttpClient, Refit |
| Go | Gin, chi, net/http | net/http, resty |
| Dart, Swift | | package:http, dio, URLSession, Alamofire |
| Any | the OpenAPI 2.0 or 3.x document of any framework | links and forms in HTML templates, Thymeleaf included |

For each route and call, atlas also reads:

- **Paths as the framework writes them:** prefixes, mounts, groups and routers. Each path is read in its router's
  syntax, at the version the project depends on.
- **Methods as the library sets them:** `.get(...)`, annotations, builder chains, or a method passed with the URL.
- **URLs as the code builds them:** template strings, `+`, formatting and URL builders, joined to the client's base
  URL by the library's own rule.
- **Which route a request reaches,** as the framework dispatches it: registration order, router precedence, and how
  it treats a trailing `/`.
- **What a route's handler calls next,** through functions, imports and ports and adapters (TypeScript and
  JavaScript), and the links and forms a Spring or Next.js page renders.

atlas reads only what the code states for certain, with the meaning the framework's documentation or source gives it,
and guesses nothing. What it cannot read is a `limit:` line or, where it cannot see it at all, one of the
[limits](#limits) below.

Every rule, per framework and library: [config.md](skills/flow-atlas/references/config.md#what-the-extractors-read).
How atlas reads each framework and client library is measured against the framework itself in
[`fixtures/frameworks`](fixtures/frameworks/README.md) and [`fixtures/clients`](fixtures/clients/README.md).

<details>
<summary>Which style to pick for a framework</summary>

- **Spring:** read its annotations (`styles: [spring]`) and give atlas springdoc's document as well. Routes keep their
  controller lines and take the document's operationIds.
- **Flask or Quart:** read its code (`styles: [flask]`). Where it uses flask-smorest or flasgger, give atlas the
  document it generates too; flask-smorest's own `Blueprint` is read from that document only.
- **Django:** read its URLconfs (`styles: [django]`) from the settings module that sets `ROOT_URLCONF`. Django REST
  framework is included. The admin site's patterns are left out with a limit.
- **Go on Gin, chi or net/http:** read its code (`styles: [go]`).
- **Django Ninja and the rest:** give atlas the OpenAPI document the framework generates. atlas finds each operation's
  handler by its operationId where it can. [`fixtures/openapi`](fixtures/openapi/README.md) holds eight documents that
  seven frameworks generate, and [openapi.md](skills/flow-atlas/references/openapi.md) shows how to produce one
  without serving it.

</details>

## Install

Requires Node.js 20 or later.

```bash
npx github:hellices/flow-atlas --help        # run without installing; prepare builds it on install
npm install -g github:hellices/flow-atlas    # install the atlas command
```

Recent npm versions may ask before running install scripts. If `prepare` is blocked, install the packed release
instead (`npm install -g <flow-atlas-x.y.z.tgz URL>`).

## Use with a coding agent

The [agent skill](skills/flow-atlas/SKILL.md) teaches an agent when to run atlas (before it adds a route or a call, and
before it opens a PR) and how to treat what it finds. It is the [`skills/flow-atlas`](skills/flow-atlas) directory
and follows the [Agent Skills](https://agentskills.io) specification, so GitHub Copilot, Claude Code, Codex, Cursor
and other hosts load it the same way. The repository is also an [Agent Plugin](https://agent-plugins.org)
(`plugin.json`) that carries the skill.

```bash
copilot plugin install hellices/flow-atlas       # GitHub Copilot CLI, as a plugin
gh skill install hellices/flow-atlas flow-atlas  # GitHub CLI 2.90 or later, the skill alone
```

Or copy the directory into your host's skills directory (for example `.github/skills/` or `.agents/skills/`).
The agent runs the `atlas` command [installed above](#install), or through `npx github:hellices/flow-atlas` when it
is not installed.

### Who does what

| Who | Writes |
|---|---|
| atlas | what the code settles: routes, calls, how they connect, operationIds, OpenAPI descriptions and how far they agree with the code, flow traces, flow drafts, and the findings |
| an agent or a person | what needs intent: a flow's title, what each component does in it, its owner, whether a step is planned, why a finding is an accepted exception. atlas checks that these are written and still hold |
| the skill | the criteria for judgments in between: whether a hop belongs to the component it sits in, and whether a gap is a defect, a plan or a false positive |

More in [docs/responsibilities.md](docs/responsibilities.md).

## Step by step

flow-atlas is meant to be run by your coding agent, through the skill installed above. You ask for an
outcome; the agent runs atlas, reads its output and reports back; you make the decisions the skill leaves to a person.
The skill also starts on its own whenever a change crosses components, so steps 3 and 5 usually need no request.

**The files.** atlas writes the structure (routes, calls, chains, findings) on every run. The agent drafts three
files, and you review them like code:

| File | What the agent writes | What you decide |
|---|---|---|
| `atlas.config.yaml` | the components, routes and call files, from what atlas finds | whether it covers what you care about |
| `flows/*.flow.yaml` | a journey's steps from atlas output, with a title and each step's role | whether the title and roles say what each component owns |
| `flows/atlas-exceptions.yaml` | an entry for a finding that is right on purpose | the reason, who decided, and when to look again |

### 1. Set it up (once)

> *"Set up flow-atlas for this repository."*  ·  *"... and keep everything outside it"* for a repository you must not change

The agent runs `atlas inventory`, writes `atlas.config.yaml` from it ([config.md](skills/flow-atlas/references/config.md)),
and runs `atlas scan` again and again until every source reads what it should, fixing the configuration each round.
With `--out <dir>` it writes nothing into the repository. Every later command takes the same `--root` and `--out`:
`explain` and `baseline update` read what the last `check` wrote there.

**You:** check that the components listed are the services you mean, and read the `limit:` lines it reports: each is
something atlas could not read, and why.

### 2. Accept what is already there

> *"Run atlas check and go through the findings with me."*

The agent runs `atlas check` and `atlas explain` on a sample, opens the code, and sorts each finding: a real problem,
the configuration's mistake (it fixes the configuration), a route served outside the repository (`publicSurfaces`), or
a misread file.

**You:** agree on the result, then say *"record the baseline"*. The skill never runs `atlas baseline update` on its
own. From then on only new findings show up.

### 3. While changing code (automatic)

> *"Add a refund endpoint to orders and call it from the web app."*

Before it writes code, the agent runs `atlas query` and `atlas trace` to see whether something already does the job
and which component should own each hop. After it writes code, it traces the new route to confirm the caller and the
calls it intended, and says so when a side is empty and why.

**You:** settle the plan when the agent reports an existing route that does the same job, or two components that
would end up doing the same step.

### 4. Describe the journeys you want kept (optional)

> *"Write flows for the checkout journey"*  ·  *"Walk issue #123's journey against the code."*

The agent drafts flows with `atlas draft flows`, takes each step from `atlas chains` or, for a tool an agent calls
inside one request, from `atlas query --kind registries`, and marks steps that are not built yet as planned. `atlas
flows` then places each step in the code, or reports it planned or not found; the agent reports those as the
journey's gaps.

**You:** review the flow files in the pull request. A step atlas places is in the code; whether it gives the customer
the right result is for tests and people to check, not atlas.

### 5. Before opening a pull request (automatic)

> *"Open a PR."*

The agent runs `atlas check --since <base>` and fixes, or explains, each new finding. It puts `atlas diff
<base>..WORKTREE --format markdown` in the description: the routes, chains and flows the change reaches.

**You:** decide each exception the agent proposes (a reason, who decided, a review date), and switching a rule off
(`rules.<id>.enabled: false`), which the skill does only with a person's agreement.

### 6. In CI (optional, without an agent)

Run from the repository root, or pass the same `--root` and `--out` to each command.

```bash
atlas check --fail-on-new                       # exit 1 when there are new findings
atlas check --format sarif > atlas.sarif        # findings for code scanning
atlas export arazzo > flows.arazzo.yaml         # flows as Arazzo 1.0, for an API workflow runner
```

atlas reports and does not block by default; `--fail-on-new` makes CI fail on new findings.

<details>
<summary>All commands and options</summary>

```bash
atlas inventory --root <repo>                 # candidate components, routes, client calls
atlas scan --root <repo>                      # what each configured source yielded
atlas query --path /orders                    # surfaces and calls by path or component
atlas query --kind registries                 # registry entries (tools, events) a flow step can name
atlas trace "bff|GET /screens/order/{id}"     # callers upstream and services downstream
atlas chains --unnamed                        # each request and everything it reaches, that no flow names yet
atlas draft flows                             # a flow draft per such chain; only the author's fields are left
atlas flows                                   # flow descriptions held against the code
atlas check --root <repo>                     # findings new since the baseline
atlas check --since main                      # findings the current change introduced
atlas check --format sarif > atlas.sarif      # findings as SARIF 2.1.0 (code scanning, IDE viewers)
atlas diff main..WORKTREE --format markdown   # flow changes, the flows they reach, and new findings for a PR description
atlas export arazzo > flows.arazzo.yaml       # flows as Arazzo 1.0 (stdout; keep it at the repository root)
atlas explain <key>                           # one finding with nearby paths
atlas baseline update                         # accept the current findings as known debt
```

- **Reading without touching the repository.** `--ref <commit>` reads a commit without checking it out, and every
  write goes to `--out` (`export` prints to stdout). A repository you must not change can be analysed with `--out`
  outside it.
- **Exit codes.** Every command exits 0 when it is done and 2 on an error. `check --fail-on-new` exits 1 when there are
  new findings. `export arazzo` exits 1 when there is nothing to export: no active flow, none of the name `--flow`
  gives, or no step an OpenAPI description names.

</details>

## Flows and output

![A flow checked against the code and exported as an Arazzo workflow](docs/media/flows.gif)

- **Flows.** Besides its steps and their roles, a flow can name the decisions behind it (`sources`), what it produces
  (`produces`) and whether it is planned or going away (`lifecycle`). `atlas flows` also reports `ProducesListed`
  (each `produces` entry is in a registry) and `Documented` (the title and every role are written). `atlas draft
  flows` drafts a flow for each chain no flow names yet, leaving only the title and roles to write. A step that is no
  request, such as a tool an agent calls within a conversation turn, names a registry entry (`registry: tool:quote`),
  so a customer journey can be walked against the code step by step: each step is placed in the code, planned, or not
  found. `atlas diff` names the flows a change reaches. A flow file is reviewed like code, in the pull request that
  changes it.
- **Output.** Everything printed with `--format json` or `--format yaml` follows the JSON Schemas in [`schema/`](schema),
  with `apiVersion`, `kind` and an SLSA-shaped `provenance` (the commit and files read, with digests). There are no
  timestamps, so the same inputs give the same document. Route paths are OpenAPI path templates (`{id}`).
- **Standards.** `check --format sarif` prints findings as SARIF 2.1.0. Flow files follow the project's own
  Kubernetes-style schema; only the export is an Arazzo 1.0 document, and it leaves parameters, request bodies and
  success criteria to the tool that runs it. Why each field is there: [docs/schema.md](docs/schema.md) and
  [docs/standards.md](docs/standards.md).

## Limits

- **Only what is written out is read.** A path assembled across several functions, or a URL taken from a server
  response, is not seen, and the route it calls shows up as an API nobody calls (FA001). Such a URL leaves no `limit:`
  line either, so no limit does not prove that everything was read.
- **Some calls are named, not read.** These are not read as calls, and a `limit:` line names each:
  - a path handed to a function after its first argument;
  - an absolute URL to a host that is neither a loopback address nor the target's `origins` entry;
  - a path given to an exception in code read as text.
- **Prefixes are applied, not read as requests.** The text a helper puts before the path it is given (the configured
  base, or a module helper's `` `/api${path}` ``) is applied to the paths passed to the helper.
- **An unread base leaves its calls out.** A request through a client whose base, interceptor or hook atlas does not
  read is left out and named in a limit. Set the call source's `base` and `join` (or `prefix`) where the code holds the
  base in a value.
- **Only configured files are read,** so no finding does not prove a flow complete.
- **A chain ends where the request does.** Work a handler queues for a worker, or hands to an object injected from
  another package, is not followed: the calls the worker makes are read and checked, and start chains of their own,
  but no chain from the user's request reaches them. When they change, `diff` names the flows that name those chains,
  not the flows of the request that handed the work over. Design documents, tests and runtime traces cover that link.
- **Field-level contract checks** are not implemented yet.

## Documentation

| Document | What it covers |
|---|---|
| [SKILL.md](skills/flow-atlas/SKILL.md) | how an agent uses atlas |
| [config.md](skills/flow-atlas/references/config.md) | the configuration, and every rule the extractors follow |
| [rules.md](skills/flow-atlas/references/rules.md) | each finding's causes and fixes |
| [boundaries.md](skills/flow-atlas/references/boundaries.md) | judging whether a hop belongs to its component, and whether a journey's step is missing |
| [openapi.md](skills/flow-atlas/references/openapi.md) | producing and reading OpenAPI documents |
| [docs/traces.md](docs/traces.md) | how traces connect calls, routes and handlers |
| [docs/direction.md](docs/direction.md) | the scope, the research it rests on, and the extensions left open |
| [docs/responsibilities.md](docs/responsibilities.md) | what atlas, agents and people each decide |
| [docs/schema.md](docs/schema.md), [docs/standards.md](docs/standards.md) | the output formats and the standards they follow |

## Contributing

Building, testing, the hooks and the fixtures that check atlas against real frameworks: [CONTRIBUTING.md](CONTRIBUTING.md).

## License

MIT. The official schemas under `test/standards/` are third-party material under their publishers' terms.
