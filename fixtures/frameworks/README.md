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

## Where a request goes

An oracle may also print sample requests, written to `dispatch.json`: each a method and a concrete path (`/users/me`,
`/users/value1/`), with the route the framework dispatched it to, as a key of `routes.json`, or `null` where no route
took it. The samples are every route's sample path, the same with a trailing `/`, a path no route takes, each with
every method the routes register (no HEAD or OPTIONS), so they include the requests several routes could take. The
test sends each through atlas's matcher, as a call with that literal path: a request to a route atlas reads must reach
that surface alone, and a request no route took must reach none. A request to a route atlas does not read is a
missing route already and is not compared. `gaps.yaml` lists the requests atlas matches otherwise under `dispatch`,
each `{ request: "METHOD /path", reason }`.

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
   manifest and lock file, and `framework.yaml` naming the `toolchain` (one the workflow sets up: node, python, java,
   dotnet, go, rust, elixir, php, ruby, bun, deno, swift, dart), the guide (`docs`) and the `setup`, `latest` and `oracle`
   commands, run in the directory. A lock names no registry mirror (the tests check every lock file): rewrite an npm
   lock's `resolved` URLs to `https://registry.npmjs.org/` (npm still installs through the registry you configure),
   and write Python dependencies as `uv pip compile pyproject.toml --generate-hashes --no-header` output, which names
   no index.
2. Write the oracle against the framework's route table; check what it prints against the framework's documentation.
3. Run `node scripts/frameworks.mjs <name>`, write `atlas.config.yaml`, run `pnpm vitest run test/frameworks.test.ts`
   and list each difference in `gaps.yaml` after checking that atlas, not the oracle, is wrong.

Without the toolchain installed, push the fixture to a `frameworks/<name>` branch: the workflow runs the fixtures the
branch changes and hands back
what the framework reported, `routes.json` and any lock file the install wrote, as the artifact
`frameworks-<name>` (`gh run download <run> -n frameworks-<name>`). A toolchain the workflow does not set up yet needs a step in `.github/workflows/frameworks.yml`.

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
| `elysia` | Elysia 1.4 (Bun) | the application's route table `app.routes`, each route confirmed by a request `handle` dispatches to its handler |
| `hapi` | hapi 21 | the routes `server.table()` reports, plugins' prefixes included, each confirmed by a request hapi dispatches to its handler |
| `adonisjs` | AdonisJS 7 | the route list `node ace list:routes --json` prints, each route confirmed by a request the booted application dispatches to its handler (`ctx.route`) |
| `nuxt` | Nuxt 4 | the page records Nuxt resolves and the handlers table Nitro compiles into the server, each path checked with vue-router and h3 on those tables and requested from the built server |
| `sveltekit` | SvelteKit 3 (adapter-node) | the server manifest adapter-node builds, each path checked with SvelteKit's `find_route` and requested from the built server |
| `reactrouter` | React Router 8 (framework mode) | the route manifest the server build exports, each path matched by React Router's `matchRoutes` and requested from `react-router-serve` |
| `astro` | Astro 7 (@astrojs/node) | the route table `astro:routes:resolved` reports and the files `astro:build:done` wrote, each route requested from the built server and checked by the `routePattern` that answered |
| `litestar` | Litestar 2 | the route table `app.routes` Litestar builds its router from, its OPTIONS handlers and OpenAPI pages included; a catch-all's parent where Litestar's router dispatches it |
| `starlette` | Starlette | the route table Starlette dispatches with, Mounts of route lists, Routers and applications expanded, HTTPEndpoint methods |
| `aiohttp` | aiohttp 3 | the route table `app.router.routes()` resolves with, nested applications and static resources included; a catch-all's parent where `resolve` reaches it |
| `sanic` | Sanic 25 | the route table `app.router.routes` dispatches with, blueprint and group prefixes and versions applied; a catch-all's parent where `router.get` finds it |
| `falcon` | Falcon 4 | the routes `falcon.inspect.inspect_routes` reports from the router, responders of the resource and OPTIONS; static routes' methods confirmed by requests |
| `tornado` | Tornado 6 | the rules of the application's `wildcard_router`, nested rules and routed-to applications walked, each confirmed by requests through `tornado.testing` reaching its handler |
| `quart` | Quart | the rules `app.url_map` dispatches with, blueprints' prefixes, websocket rules and the static routes included |
| `djangoninja` | Django Ninja | the patterns Django's resolver dispatches with, methods from each Ninja path's operations, each confirmed by Django's test client |
| `webflux` | Spring Boot 4 (WebFlux) | the DispatcherHandler's handler mappings: handler methods' mapping info, URL handler patterns, and router functions through `RouterFunctions.Visitor`, each confirmed by a request |
| `quarkus` | Quarkus 3 (Quarkus REST, reactive routes) | the Quarkus REST deployment's class and method mappers (sub-resource locators included) and the Vert.x Web router's routes, read in a Quarkus test, each confirmed by a request answered by that endpoint or route |
| `micronaut` | Micronaut 4 | the Router bean's `uriRoutes()`, templates expanded and checked by the route's matcher, and static resources from their configuration, each confirmed by a request |
| `ktor` | Ktor 3 | the routing tree `RoutingRoot`'s `getAllRoutes()` gives, read through each route's selector chain, each path confirmed by a `testApplication` request Ktor routes to that node |
| `javalin` | Javalin 7 | the endpoints Javalin's router dispatches with (`allHttpHandlers()`, what the RouteOverview plugin lists) and the static file configurations, each confirmed by a request Javalin dispatches to that endpoint |
| `vertx` | Vert.x Web 5 | the routes `Router.getRoutes()` reports, sub-routers expanded, each confirmed by a request the route answers |
| `fastendpoints` | FastEndpoints 8 (ASP.NET Core 10) | the route table the routing middleware matches with, after `UseFastEndpoints` registers each endpoint class, each path confirmed by a request it dispatches to that endpoint |
| `carter` | Carter 10 (ASP.NET Core 10) | the route table the routing middleware matches with, after `MapCarter` maps each module, each path confirmed by a request it dispatches to that endpoint |
| `blazor` | Blazor Web App (ASP.NET Core 10) | the route table the routing middleware matches with: `MapRazorComponents`' page endpoints, the interactive server endpoints and static assets, each path confirmed by a request it dispatches to that endpoint |
| `echo` | Echo 5 | the route table Echo's router keeps (`Router().Routes()`), each looked up with its own `Router.Route`; its 404 routes left out |
| `fiber` | Fiber 3 | the routes `App.GetRoutes(true)` reports, mounted sub-apps included, each requested through `App.Test` and confirmed by `Ctx.Route` |
| `gorillamux` | gorilla/mux | the routes `Router.Walk` walks, subrouters included, each confirmed by `Router.Match` |
| `hertz` | CloudWeGo Hertz | the route table `Engine.Routes()` reports, each route confirmed by a request Hertz dispatches to it (`FullPath`) |
| `beego` | Beego 2 | the routing trees `PrintTree` reports, each method and route confirmed by a request Beego matches to that route and its handler answers; static directories confirmed by a file request |
| `iris` | Iris 12 | the route table `GetRoutes()` reports (offline routes left out), each route confirmed by a request Iris dispatches to it (`GetCurrentRoute`) |
| `gozero` | go-zero | the routes `Server.Routes()` returns from goctl's generated `routes.go`, each confirmed by a request go-zero's router dispatches to it |
| `axum` | axum 0.8 | the routes as registered, recorded by compiling the app against a forwarding axum, each confirmed by a request axum dispatches to that handler (`MatchedPath`) |
| `actixweb` | Actix Web 4 | the resources of its `ResourceMap`, each method confirmed by a request actix dispatches to that resource (`HttpRequest::match_pattern`) |
| `rocket` | Rocket 0.5 | `Rocket::routes()`, a `<param..>` route's parent confirmed by a request Rocket dispatches to it |
| `phoenix` | Phoenix 1.8 | the route table `Phoenix.Router.routes/1` reports, forwarded Phoenix routers expanded as `mix phx.routes` does, each route confirmed by `Phoenix.Router.route_info/4` |
| `rails` | Rails 8 | the routes `Rails.application.routes` dispatches with, optional groups spelled out from each route's parsed path, engines expanded, each confirmed by a request it dispatches to that route |
| `sinatra` | Sinatra 4 (with sinatra-contrib) | each `Sinatra::Base.routes` table under the path `config.ru` maps its app at, plus public files, each confirmed by a request Sinatra answers with that route's block |
| `grape` | Grape 4 | the routes `API.routes` reports, with prefix, path versions and namespaces, each confirmed by a request Grape's router dispatches to that route |
| `laravel` | Laravel 13 | `route:list --json`, each route's constraints from the router's collection, each path confirmed by the route's own matcher |
| `symfony` | Symfony 8.1 (FrameworkBundle) | `debug:router --format=json` in the dev environment, the collection the URL matcher matches with, each path confirmed by the route's compiled regex |
| `slim` | Slim 4 | the routes the route collector hands FastRoute, split by FastRoute's parser into their optional segments, each confirmed by a request Slim dispatches to that route |
| `vapor` | Vapor 4 | the route table `app.routes.all` reports, each route confirmed by a request the responder dispatches to that route (`req.route`) |
| `dartfrog` | Dart Frog | the route configuration `dart_frog build` renders its server from (checked against `dart_frog list`), each route and `public/` file requested from the built server with every method |
| `shelf` | shelf_router | the routes as registered, each confirmed by a request shelf_router dispatches to that route's own handler |
