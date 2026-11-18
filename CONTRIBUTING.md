# Contributing

## Build and test

```bash
pnpm install   # also points git at the hooks in .githooks
pnpm check     # strict types (tsc) and the type-aware lint (typescript-eslint)
pnpm build
pnpm test
```

The pre-commit hook runs `pnpm check` and the pre-push hook runs the tests. A pre-push hook of your own in `.git/hooks`
runs before them, with the same refs, and still runs when `ATLAS_SKIP_TESTS=1` skips the tests. CI runs the same checks.

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

[`evals/flow-atlas/eval.yaml`](evals/flow-atlas/eval.yaml) runs the skill with a coding agent on `fixtures/shop`:
whether the agent loads it when a change crosses components and leaves it alone otherwise, runs atlas instead of
reading the code by hand, finds and fixes a planted finding, and stops before recording a baseline nobody approved.
Its graders are deterministic. It costs model requests, so the `skill-eval` workflow runs it on demand, weekly and
after a change to the skill lands on `main`. To run it locally with GitHub Copilot:

```bash
pnpm build && npm pack --pack-destination /tmp && npm install -g /tmp/flow-atlas-*.tgz
GITHUB_TOKEN=$(gh auth token) npx @microsoft/vally-cli eval -e evals/flow-atlas/eval.yaml --runs 1
```

## Registry mirrors

If you install dependencies through a registry mirror, keep the mirror's URLs out of the committed lockfile:

```bash
git config filter.public-registry.clean "node scripts/public-registry.mjs"
git config filter.public-registry.smudge cat
```
