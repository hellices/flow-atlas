# Contributing

Pull requests are open to the repository's collaborators. To propose a change or report a problem, open an issue.

## Build and test

```bash
pnpm install   # also points git at the hooks in .githooks
pnpm check     # strict types (tsc) and the type-aware lint (typescript-eslint)
pnpm build
pnpm test
```

The pre-commit hook runs `pnpm check` and the pre-push hook runs the tests. A pre-push hook of your own in `.git/hooks`
runs before them, with the same refs, and still runs when `ATLAS_SKIP_TESTS=1` skips the tests. CI runs the same checks.

## Changing what atlas reads

atlas produces evidence for an agent or a person to judge flows by; it does not judge them. A change to what it reads
keeps the four properties in [docs/responsibilities.md](docs/responsibilities.md#what-the-tools-output-must-be):

- **General.** Follow the technology's documented rule or its source, at the version the repository depends on, and
  cite it in the skill reference that covers it (`references/config.md`, `openapi.md` or `rules.md` under `skills/flow-atlas/`). No rule that only one repository's naming makes true.
- **Nothing left out silently.** Whatever the new reading cannot settle produces a `limit:` line with the file, line
  and expression; a test asserts the line. Prefer a limit to a guess: an unread value, a handler that routes by its own
  code, a route registered another way.
- **Nothing counted twice.** The same route, call or edge read two ways stays one; a finding is not hidden by a match
  that holds only by chance, and not duplicated by a second source.
- **Normalized.** Paths, methods and keys as the schemas in `schema/` give them; a key that changes moves every
  baseline, so it changes only on purpose.

Then: a misreading found on a real repository becomes a scenario under `fixtures/scenarios` first; the reading goes
into `docs/direction.md` (what is read, what is not and why) and the reference the skill loads; and the snapshots of
`fixtures/repositories` are written again when the change moves what atlas read there.

## Fixtures

| Fixtures | What they check |
|---|---|
| [`fixtures/shop`](fixtures/shop) | a small monorepo with eight planted problems: exactly those are found; baselines, exceptions and `--since` work; commits are read without a checkout; flows trace from a web client through a BFF handler's port call to a service; SARIF and Arazzo output pass the official schemas |
| [`fixtures/scenarios`](fixtures/scenarios/README.md) | small repositories in the shapes of real ones atlas was run on, each with the result that run showed once the reading was right. A misreading found on a real repository becomes a scenario before it is fixed |
| [`fixtures/frameworks`](fixtures/frameworks/README.md) | an application for each of 58 frameworks (Node, Bun, Python, JVM, .NET, Go, Rust, Elixir, Ruby, PHP, Swift and Dart), with the routes the framework itself reports serving. The tests compare atlas's reading with them and list where it still falls short |
| [`fixtures/clients`](fixtures/clients/README.md) | code on each of 26 client libraries, with the requests it sends when run against a server that records them |
| [`fixtures/repositories`](fixtures/repositories/README.md) | public repositories pinned at a commit, with what atlas read there |

The `frameworks` workflow installs each framework and library and checks their routes and requests again, weekly on
the latest release. The `repositories` workflow fetches the pinned repositories and fails when a change moves anything
atlas read there.

## The skill

`test/skill.test.ts` checks the skill against the Agent Skills specification, and `test/docs.test.ts` runs every
`atlas` command the README, the skill and its references name, so a renamed command or option fails the tests. CI
also runs `vally lint` on `skills/`, the check skill listings use.

## Registry mirrors

If you install dependencies through a registry mirror, keep the mirror's URLs out of the committed lockfile:

```bash
git config filter.public-registry.clean "node scripts/public-registry.mjs"
git config filter.public-registry.smudge cat
```
