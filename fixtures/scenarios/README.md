# Scenarios from real repositories

Each directory here is a small repository in the shape of one atlas was run on: the same frameworks, the same way of
writing routes and calls, the same configuration, with names and business logic replaced. `expected.yaml` holds what
that run showed once atlas read the code right, and `case` says what went wrong before. `test/scenarios.test.ts` runs
each one through scan, check, chains, flows and inventory, and compares everything exactly, so a change that moves any
result shows as a difference in a case someone met.

| Scenario | Shape | What it pins down |
|---|---|---|
| `fastapi-react` | FastAPI backend, React client through an `authFetch` wrapper | a helper that registers POST, a StaticFiles mount (GET and an implicit HEAD), a mounted sub-application left unread with a limit, `{x:path}`, inventory styles by language |
| `express-spring-twins` | the same API in Express and Spring, a k6 load script as client | Express routers served only under a literal or declared mount path; an undeclared one left out with a limit |
| `nextjs-app` | a Next.js app whose browser code calls its own route handlers | route handlers as surfaces, the HEAD and OPTIONS Next.js answers itself, no cycle for a component calling itself |
| `nextjs-pages` | a Next.js app whose pages link to each other, and a client of one route handler | pages as GET surfaces, links and share-link helpers reaching them, a literal type that is no request |
| `flutter-spring` | a Flutter app on Dio, a Spring backend under `/api/v1` | verbs with type arguments and paths on the next line, a declared client prefix, call files narrowed to the code that calls Dio |
| `spring-modulith-groups` | one Spring Boot application whose Spring Modulith modules are the components, springdoc with two groups | the default document and one per `GroupedOpenApi` group, found from the build file and beans outside the modules, shared by every module, left ambiguous |
| `ts-monorepo-bases` | Kotlin app → BFF → core service → file service, and a Python agent | URLs built on a `const` base, f-string URLs, route registrations that are no requests, `res.send()` that names no port, a journey whose order only the flow states |

To add one: reproduce the shape in a new directory with an `atlas.config.yaml` (and `flows/` if the case is about
flows), run it, check every line of the result against the real repository, and write `expected.yaml`. A scenario that
only passes because its expected result was copied from the output proves nothing.
