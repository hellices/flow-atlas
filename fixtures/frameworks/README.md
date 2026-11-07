# Routes as each framework serves them

Each directory here is a small application written on one framework's own library, exercising the routing features
the framework's guide documents (`docs:` in its `framework.yaml`). Beside it:

- `oracle.*` asks the framework, from its installed library, for the routes the application serves: the route table
  the framework dispatches with, or, where the framework keeps none, the routes as the application registers them,
  each confirmed by a request the framework answers with that route's handler. It prints them as JSON.
- `routes.json` is what the oracle printed, written by `node scripts/frameworks.mjs <name>`: one route a line, its
  method (`*` for a route that takes any) and its path in the form below, with the framework's own spelling as `raw`.
- `atlas.config.yaml` is how a user would point atlas at the application.
- `gaps.yaml` lists where atlas's reading differs, each with the reason: `missing` routes atlas does not read, `extra`
  surfaces it reads that the framework does not serve, or `unread:` when atlas does not read the framework at all.

`test/frameworks.test.ts` (part of `pnpm test`, no framework installed) scans each application and fails on any
difference `gaps.yaml` does not list, and on any listed difference that no longer occurs, so the list only shrinks.
The `frameworks` workflow installs each framework, reruns its oracle and fails when the routes differ from
`routes.json`; once a week it does so on the frameworks' latest releases, so a change in how a framework serves its
routes shows before a user meets it.

## The form both sides are compared in

- A parameter is `{}`, wherever it stands in a segment (`/flights/{}-{}`), and so is a wildcard within a segment
  (`*.png`, `t?st`); `{**}` is the rest of the path, one segment or more, slashes included.
- A route that also takes the path with nothing after its last `/` (Spring's `{*rest}`, Starlette's `{name:path}`,
  Next.js's `[[...slug]]`) is written as two: the path before that `/`, and the same with `/{**}`. A parameter segment
  beside the same path with `/{**}` after it is one segment or more, `{**}`, on both sides.
- Hosts and subdomains are not part of the form; a fixture leaves out routes that depend on them.
- No trailing `/` but on the root; a path is compared without the query.
- HEAD beside a GET of the same path, and OPTIONS beside any other method, are left out on both sides: frameworks
  answer them by themselves.

## Adding a framework

1. Create `fixtures/frameworks/<name>/` with the application under its usual source directory, its dependency
   manifest and lock file (`package.json` and `package-lock.json`, `pyproject.toml` and `uv.lock`, `pom.xml`,
   `*.csproj`, `go.mod` and `go.sum`), and `framework.yaml` naming the guide (`docs`) and the `setup`, `latest` and
   `oracle` commands, run in the directory. A lock names no registry mirror: rewrite an npm lock's `resolved` URLs to
   `https://registry.npmjs.org/` (npm still installs through the registry you configure), and write Python
   dependencies as `uv pip compile pyproject.toml --generate-hashes --no-header` output, which names no index.
2. Write the oracle against the framework's route table; check what it prints against the framework's documentation.
3. Run `node scripts/frameworks.mjs <name>`, write `atlas.config.yaml`, run `pnpm vitest run test/frameworks.test.ts`
   and list each difference in `gaps.yaml` after checking that atlas, not the oracle, is wrong.
4. Add the framework's toolchain to `.github/workflows/frameworks.yml` if it needs one not there yet.

| Fixture | Framework | Oracle |
|---|---|---|
| `express` | Express 5 | the routes as registered, each confirmed by a request Express dispatches to its handler |
| `fastify` | Fastify 5 | the routes Fastify passes to its `onRoute` hook, each confirmed by a request Fastify dispatches to its handler |
| `koa` | Koa 3 with @koa/router | the `stack` of each router the application uses, nested routers included, each route confirmed by a request it dispatches to its handler |
| `hono` | Hono 4 | the application's route table, each route confirmed by a request Hono answers with that route's handler (`matchedRoutes`) |
| `nest` | NestJS (Express platform) | the routes Nest registers on the Express router under its controllers' handlers, checked against its "Mapped" log, each confirmed by a request Nest dispatches to that handler |
| `nextjs` | Next.js 16 | the dispatch table `next build` writes (routes-manifest, the app-path and pages manifests, each route handler's exported methods), each route requested from `next start` |
| `fastapi` | FastAPI | the route table Starlette dispatches with, included routers and mounted applications expanded |
| `flask` | Flask 3 | the rules `app.url_map` dispatches with, blueprints' prefixes and the static route included |
| `django` | Django with Django REST framework | the patterns Django's URL resolver dispatches with, written out by Django's `normalize()`; methods from DRF's actions, class views' allowed methods, or function views' 405s (`*` where none) |
| `spring` | Spring Boot 4 (web MVC) | the DispatcherServlet's handler mappings: handler methods' mapping info, URL handler patterns, and router functions through `RouterFunctions.Visitor`, each confirmed by a request |
| `aspnetcore` | ASP.NET Core 10 | the route table the routing middleware matches with, each path confirmed by a request it dispatches to that endpoint |
| `gin` | Gin | the route table `Engine.Routes()` reports, from the trees Gin dispatches with |
| `chi` | chi 5 | the routing tree `chi.Walk` walks, mounted routers included |
| `nethttp` | net/http `ServeMux` (Go 1.22+) | the patterns as registered, each confirmed by a request `ServeMux` dispatches to its handler |
