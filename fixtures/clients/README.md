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
  (`server`, which need not exist), and the call source with what a user would name in it (`base` and `join`, or
  `prefix`, where the code holds the base in a value, and `baseValues`, the values that hold it; `receivers`, `wrappers`,
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
| `axios` | axios 1 | sets the env var the app's config module reads to the recording server, imports the modules and calls each exported function (instances with base paths and interceptors) |
| `ky` | Ky 2 | sets the env var the app's config module reads to the recording server, imports the modules and calls each exported function (`create` with `prefix`/`baseUrl`, `extend`) |
| `ofetch` | ofetch 1 | sets the env var the app's config module reads to the recording server and resolves `$fetch`'s relative paths against it as a page's origin, then calls each exported function |
| `angularhttp` | Angular HttpClient (withFetch) | builds an injector from the app's `appConfig` and calls each service method, subscribing to it, with the environment's `apiUrl` pointed at the recording server |
| `rtkquery` | RTK Query (fetchBaseQuery) | dispatches each endpoint's `initiate` through the app's store, relative base URLs resolved against the recording server as a page's origin would be |
| `openapifetch` | openapi-fetch (types from openapi-typescript) | imports the app's module and calls each exported function; the client's base URL, a path on the page's origin, resolved against the recording server as a browser would |
| `heyapi` | @hey-api/openapi-ts (client-fetch, generated SDK) | imports the app's module and calls each exported function, each calling the generated SDK; the configured base URL, a path on the page's origin, resolved against the recording server |
| `orval` | orval (axios functions with a mutator) | imports the app's module and calls each exported function, each calling a generated function; the axios instance's base URL resolved against the recording server |
| `requests` | Requests | sets the app's `API_URL` setting to the recording server and calls each function its modules define (module functions, a `Session` with a `urljoin` helper, a `BaseUrlSession` subclass) |
| `httpx` | HTTPX | sets the app's `API_URL` setting to the recording server and calls each function its modules define, on a `Client` and an `AsyncClient` with `base_url`, the async ones awaited |
| `restclient` | Spring RestClient (Spring Framework 7, Boot 4) | starts the application with no web server and its base-URL property set to the recording server, and calls each public method of its `RestClient` client and its `@HttpExchange` interface proxy |
| `webclient` | Spring WebClient (Spring Framework 7, Boot 4) | starts the application with no web server and its base-URL property set to the recording server, and calls each public method of its client, blocking on the Mono or Flux it returns |
| `resttemplate` | Spring RestTemplate (Spring Framework 7, Boot 4) | starts the application with no web server and its base-URL properties set to the recording server, and calls each public method of its two clients (`RestTemplateBuilder.rootUri`, a URL field) |
| `feign` | OpenFeign 13 (plain Feign, Java 11 client) | builds each Feign client with the `api.base-url` setting set to the recording server, and calls each method of each interface |
| `retrofit` | Retrofit 3 (Kotlin, kotlinx.serialization converter) | builds each service as the app's module does, its configured base URL's origin pointed at the recording server, and calls every method of each service interface once |
| `okhttp` | OkHttp 5 (Kotlin) | builds the app's shared client and data source with its configured base URL's origin pointed at the recording server, and calls every public method once |
| `ktorclient` | Ktor client 3 (OkHttp engine, Resources) | builds the app's client, its default request's base URL origin pointed at the recording server, and calls every public method of each service once |
| `dotnethttpclient` | HttpClient with IHttpClientFactory (.NET 10) | registers the app's typed and named clients as it does at startup, the configured base addresses pointed at the recording server, and calls each client method |
| `refit` | Refit 16 | registers the app's Refit interfaces through IHttpClientFactory as it does at startup, the configured base address pointed at the recording server, and calls each interface method |
| `gohttp` | Go net/http client | calls each exported function of the users package with `USERS_API_URL` set to the recording server, and each method of the SDK-style client built with that URL |
| `resty` | resty v2 | builds the app's clients with the recording server as their base URL and calls each of their methods |
| `dio` | dio 5 | calls each public method of the app's repositories (`dart:mirrors`), their Dio clients built with the recording server as the API host |
| `darthttp` | package:http 1 | calls each public method of the app's services (`dart:mirrors`), given the recording server's origin and, for `Uri.http`, its host |
| `urlsession` | URLSession (Foundation; FoundationNetworking on Linux) | calls each public method of the app's API types, given the recording server's URL |
| `alamofire` | Alamofire 5 | calls each public method of the app's clients, given the recording server's URL (the router's through `API_SERVER_URL`) |
