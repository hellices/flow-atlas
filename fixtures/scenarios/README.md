# Scenarios from real repositories

Each directory here is a small repository in the shape of one atlas was run on: the same frameworks, the same way of
writing routes and calls, the same configuration, with names and business logic replaced. `expected.yaml` holds what
that run showed once atlas read the code right, and `case` says what went wrong before. `test/scenarios.test.ts` runs
each one through scan, check, chains, flows and inventory, and compares everything exactly (the calls read too, where
`expected.yaml` lists them), so a change that moves any result shows as a difference in a case someone met.

| Scenario | Shape | What it pins down |
|---|---|---|
| `fastapi-react` | FastAPI backend, React client through an `authFetch` wrapper | a helper that registers POST, a StaticFiles mount (GET and an implicit HEAD), a mounted sub-application left unread with a limit, `{x:path}` not reaching the path without its segment where a route serves that path, inventory styles by language, a URL chosen between a base and none read as one call, a wrapper's default method declared in the configuration (GET, as fetch), a method the call states kept, a wrapper call of unread method left unmatched among routes of several methods |
| `fastapi-routers` | FastAPI backend of APIRouters gathered in one router the application includes under a settings prefix, a generated client | a router's prefix and its includes' joined to its routes, through a nested include and the imports naming the routers; the settings prefix declared in `mounts`; a router under an f-string prefix and one included nowhere left out with a limit each |
| `nest-versioned` | Nx NestJS API under a global prefix and URI versioning, an Angular client | the prefix and `v<version>` from the bootstrap found in the component, `@Version` on a method, a controller's version list, `VERSION_NEUTRAL`, literal `exclude` paths and RouteInfo (an excluded route keeps its version), `exclude` entries built at run time named in a limit |
| `express-spring-twins` | the same API in Express and Spring, a k6 load script as client | Express routers served only under a literal or declared mount path; an undeclared one left out with a limit, as is a route on a path the file does not spell out |
| `nextjs-app` | a Next.js app whose browser code calls its own route handlers | route handlers as surfaces, the HEAD and OPTIONS Next.js answers itself, no cycle for a component calling itself |
| `nextjs-pages` | a Next.js app whose pages link to each other, and a client of one route handler | pages as GET surfaces, links and share-link helpers reaching them, a literal type that is no request |
| `flutter-spring` | a Flutter app on Dio, a Spring backend under `/api/v1` | verbs with type arguments and paths on the next line, a declared client prefix, call files narrowed to the code that calls Dio, no components from the app's Android host |
| `spring-modulith-groups` | one Spring Boot application whose Spring Modulith modules are the components, springdoc with two groups | the default document and one per `GroupedOpenApi` group, found from the build file and beans outside the modules, shared by every module, left ambiguous |
| `ts-monorepo-bases` | Kotlin app → BFF → core service → file service, and a Python agent | URLs built on a `const` base, f-string URLs, route registrations that are no requests, `res.send()` that names no port, a journey whose order only the flow states, event streams on paths held in consts named in limits, a Kotlin exception given the path it reports on that is no request |
| `ts-client-strings` | a mobile BFF adapter, a desktop app and its local companion server, a tool whose helper puts `/api/v1` before each path | a path passed to a helper as a label, compared or tested, a `path` option holding a file path, a link to another site, the helper's own `` `/api/v1${path}` ``: none is a request; a loopback URL is |

To add one: reproduce the shape in a new directory with an `atlas.config.yaml` (and `flows/` if the case is about
flows), run it, check every line of the result against the real repository, and write `expected.yaml`. A scenario that
only passes because its expected result was copied from the output proves nothing.
