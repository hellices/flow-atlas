# Requests as each client library sends them

Each directory here is code that makes requests with one HTTP client library, in the shapes the library's guide
documents (`docs:` in its `client.yaml`). Beside it:

- `oracle.*` makes every request the code makes, once: it calls each function the code exports, with the value of the
  environment variable `ARG` (or the number in `ARG_NUMBER`) for each argument, and points the code at the base URL in
  `RECORD_URL`. That URL is a server `scripts/frameworks.mjs` runs; it records each request it receives and answers it
  with `200` and `{}`. The oracle prints `{"library", "version"}`; a call the oracle cannot make is an error.
- `calls.json` is what the server received, written by `node scripts/frameworks.mjs <name>`: one request a line, its
  method and its path, each argument written `{}`, without the query, with the path as sent as `raw`.
- `atlas.config.yaml` is how a user would point atlas at the code: the code's component, the component it calls
  (`server`, which need not exist), and the call source with what a user would name in it (`prefix`, `wrappers`,
  `origins`).
- `gaps.yaml` lists where atlas's reading differs, each with the reason: `missing` requests atlas does not read,
  `extra` calls it reads that the code does not send, or `unread:` when atlas does not read the library at all.

`test/clients.test.ts` (part of `pnpm test`) scans each fixture and fails on any difference `gaps.yaml` does not list,
and on any listed difference that no longer occurs. The `frameworks` workflow runs each oracle again on its toolchain,
weekly on the library's latest release. The rules for toolchains, lock files and recording in CI are those of
[`fixtures/frameworks`](../frameworks/README.md); a client fixture's name differs from every framework fixture's.

## The form both sides are compared in

- `METHOD path`: atlas's `*` (a method it does not read) differs from every method.
- An argument, and anything atlas cannot read in a path (`{}` in its calls), is `{}`; the query is left out; no
  trailing `/` but on the root.

## Adding a library

1. Create `fixtures/clients/<name>/` with the code under its usual source directory, its dependency manifest and lock
   file, and `client.yaml` naming the `toolchain`, the guide (`docs`) and the `setup`, `latest` and `oracle` commands.
2. Write the code in the guide's shapes: a configured base URL or client instance, path arguments in templates or
   concatenations, each method, a body, a query, the library's own ways of naming a request (an interface's
   annotations, a generated client, a typed builder) where it has them.
3. Run `node scripts/frameworks.mjs <name>`, write `atlas.config.yaml`, run `pnpm vitest run test/clients.test.ts` and
   list each difference in `gaps.yaml` after checking that atlas, not the oracle, is wrong.

| Fixture | Library | How the oracle makes the requests |
|---|---|---|
| `fetch` | Fetch API (Node's undici) | imports the app's modules and calls each exported function, a relative URL resolved against the recording server as a page's origin would be |
