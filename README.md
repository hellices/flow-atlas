# flow-atlas

Find where flows that cross components of a monorepo come apart: an API no client calls, a client call no service
serves, a call across a boundary the manifests do not declare, an artifact nothing produces. Every finding comes with a file and a line, and the same code always gives the same findings: no LLM is
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
| FA007 | a flow description that the code does not bear out |

Causes and fixes per rule: [rules.md](skills/flow-atlas/references/rules.md).

## Languages and frameworks

| Reads | From |
|---|---|
| routes | TypeScript and JavaScript code (NestJS decorators under the global prefix and URI version the bootstrap sets, Express, Fastify and other `app.get("/x")` receivers, Express routers under their mount paths, Next.js route handlers, pages, metadata routes and public files), FastAPI decorators under their routers' prefixes and Starlette StaticFiles mounts, Spring MVC annotations with Spring Security's login and logout, and the OpenAPI 2.0 or 3.x document of any framework |
| client calls | TypeScript and JavaScript parsed (literals, template strings, concatenations); HTML templates (root-relative `href`, `src`, `action`, `formaction` and configured `data-*` URLs, Thymeleaf `@{...}` links, page-relative links and forms with no action against the pages that show them, inline scripts); Kotlin, Python and other languages as text |
| what a route's handler calls next | TypeScript and JavaScript; for Spring MVC, the requests in the template a handler's view name renders, and the GET its `redirect:` leads to; for a Next.js page, the links and forms its server components and layouts render |

atlas reads only what a file states for certain: a path written as a literal, with the meaning a standard or the
framework's documentation gives it. A URL taken from a variable, another template engine, or htmx and Vue attributes
are not read, and nothing is guessed in their place, so "no caller" means none among what atlas can read.
[docs/direction.md](docs/direction.md) gives the scope, the research it rests on, and the extensions left open.

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
atlas inventory --root <repo>                 # candidate components, routes, client calls
atlas scan --root <repo>                      # what each configured source yielded
atlas query --path /orders                    # surfaces and calls by path or component
atlas trace "bff|GET /screens/order/{id}"     # callers upstream and services downstream
atlas chains --unnamed                        # each request and everything it reaches, that no flow names yet
atlas draft flows                             # a flow draft per such chain; only the author's fields are left
atlas flows                                   # flow descriptions held against the code
atlas check --root <repo>                     # findings new since the baseline
atlas check --since main                      # findings the current change introduced
atlas check --format sarif > atlas.sarif      # findings as SARIF 2.1.0 (code scanning, IDE viewers)
atlas diff main..WORKTREE --format markdown   # flow changes and new findings for a PR description
atlas export arazzo > flows.arazzo.yaml       # flows as Arazzo 1.0 (stdout; keep it at the repository root)
atlas explain <key>                           # one finding with nearby paths
atlas baseline update                         # accept the current findings as known debt
```

`--ref <commit>` reads a commit without checking it out, and every write goes to `--out` (`export` prints to stdout), so a repository you must not
change can be analysed with `--out` outside it. Writing the configuration: [config.md](skills/flow-atlas/references/config.md);
expect two or three rounds of `scan` and correction before the findings are worth trusting.

Every command exits 0 when it is done and 2 on an error. `check --fail-on-new` exits 1 when there are new findings, and
`export arazzo` exits 1 when there is nothing to export: no active flow, none of the name `--flow` gives, or no step
an OpenAPI description names.

## Day to day

Once the configuration reads what it should, record the current findings with `atlas baseline update`. From then on
only new findings appear: existing debt is reduced on its own schedule, and each change answers only for what it
introduced.

A new finding is fixed, or recorded in the exceptions file with the decision behind it and a date to look again; when
the date passes, the finding comes back. A wrong finding is fixed in the configuration when that caused it; a misread
file is recorded as an exception that says which file was misread and how. A rule that is mostly wrong for a
repository is switched off there (`rules.<id>.enabled: false`), or its extractor fixed.

atlas reports and does not block by default. To fail CI on new findings, use `--fail-on-new`.

## How traces connect

`trace` joins two kinds of link. A call joins a route when the method and path agree (`=`). A call whose method atlas
does not read (a project's wrapper around `fetch` that is given none, a `data-*` URL) joins the routes its path fits
only when they all take one method; where they take several, which one it calls depends on the method, so it joins
none of them and a `limit:` line names it. A wrapper the configuration names in `calls[].wrappers`, with the method
it sends by default (GET for one that hands its arguments to `fetch`), is read as `fetch` is. Routes from an OpenAPI 3
document are joined as the specification says, a concrete path (`/users/me`) before a templated one (`/users/{id}`);
a call that leaves out the trailing `/` a document's path ends with joins it only by GET or HEAD, since what a server
does with another method depends on its framework (a `limit:` names it). A function of a client @hey-api/openapi-ts
generated is a call only where another configured file's code names it, or names a generated helper that calls it. Inside a component, a
route's handler is followed through local functions, relative imports and re-exports, and joins an outbound call
(`~`) in two ways: the handler's own code runs the request (evidence `static`), or the request sits in a method whose
name the handler calls (evidence `name`). The second covers ports and adapters: the handler calls
`deps.backend.getOrder()` and the adapter's `getOrder` makes the HTTP request. Because it joins by name, a link
through a common name such as `get` or `send` is worth opening. For a Spring page, the requests in the template its
view name renders are its outbound calls (`via view <name>`); for a Next.js page, the links and forms its server
components and layouts render (`via view <file>`). Either is a request the page offers next, not part of its own.
view name renders are its outbound calls (`via view <name>`), and so is the GET its `redirect:` leads to (`via
redirect`); both are requests the client makes next, not part of the page's own request.

## Flows and schemas

A flow is written in `flows/*.flow.yaml` as a Kubernetes-style object (`apiVersion`, `kind: Flow`, `metadata`,
`spec`), with Arazzo-style steps that name the repository's own routes and calls, each with the role its component
plays, and `sources` naming the decisions behind it. `atlas flows` reports Kubernetes-style conditions for each flow
(`Ready`, `Resolved`, `Connected`, `ProducesListed`, `Documented`). A flow file is reviewed like code, in the pull
request that changes it.

Everything printed with `--format json` or `--format yaml` follows the JSON Schemas in [`schema/`](schema), with
`apiVersion`, `kind` and an SLSA-shaped `provenance` (the commit and files read, with digests) and no timestamps, so
the same inputs give the same document. Route paths are OpenAPI path templates (`{id}`). Why each field is there:
[docs/schema.md](docs/schema.md) and [docs/standards.md](docs/standards.md).

## Develop

```bash
pnpm install   # also points git at the hooks in .githooks
pnpm check     # strict types (tsc) and the type-aware lint (typescript-eslint)
pnpm build
pnpm test
```

The pre-commit hook runs `pnpm check` and the pre-push hook runs the tests; a pre-push hook of your own in
`.git/hooks` runs before them, with the same refs, and still runs when `ATLAS_SKIP_TESTS=1` skips the tests. CI runs the
same checks.

`fixtures/shop` is a small monorepo with eight planted problems; the tests check that exactly those are found, that
baselines, exceptions and `--since` work, that commits are read without a checkout, that flows trace from a web client
through a BFF handler's port call to a service, and that SARIF and Arazzo output pass the official schemas.

[`fixtures/scenarios`](fixtures/scenarios/README.md) holds small repositories in the shapes of real ones atlas was run
on, each with the result that run showed once the reading was right. A misreading found on a real repository becomes a
scenario there before it is fixed; tests for anything else cover framework rules no scenario reaches.

[`fixtures/frameworks`](fixtures/frameworks/README.md) holds an application for each of 58 frameworks (Node, Bun, Python,
JVM, .NET, Go, Rust, Elixir, Ruby, PHP, Swift and Dart ones: from Express, Next.js, FastAPI, Django, Spring Boot and
ASP.NET Core to Phoenix, Rails, Laravel, Axum and Vapor), each with the routes the framework itself reports serving; the tests compare atlas's reading with them, and list where it still falls short.
[`fixtures/clients`](fixtures/clients/README.md) does the same for calls: code on each client library, with the
requests it sends when run against a server that records them. The `frameworks` workflow installs each framework and
library and checks those routes and requests again, weekly on its latest release.

If you install dependencies through a registry mirror, keep the mirror's URLs out of the committed lockfile:

```bash
git config filter.public-registry.clean "node scripts/public-registry.mjs"
git config filter.public-registry.smudge cat
```

## Limits

Routes and calls are read from string literals. A path assembled across several functions, or a URL taken from a
server response, is not seen and shows up as FA001. A path handed to a function after its first argument, and an
absolute URL to a host that is neither a loopback address nor the target's `origins` entry, are not read as calls; a
`limit:` line names them, as it names a path given to an exception in code read as text and a client helper that puts
the configured `prefix` before the path it is given. Only configured files are read, so no finding does not prove a flow complete. Field-level contract checks are not implemented yet.

## License

MIT. The official schemas under `test/standards/` are third-party material under their publishers' terms.
