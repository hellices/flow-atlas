# Direction and scope

Decided November 2026, after applying atlas to a private TypeScript monorepo (mobile app, BFF and services) and to a
server-rendered Spring Boot application, and after surveying prior art. This document records the evidence, the
decision, the scope atlas supports for certain, and the extensions left open.

## Decision

atlas is a deterministic checker of declared flows against an endpoint inventory, with an agent skill that puts the
inventory in front of an agent before it designs a change, and an Arazzo export for viewers and runners. Its own value
is the part no other tool does: holding a declared flow against the code.

What atlas reads, it reads for certain:

- A route or call is read only when its meaning is fixed by a standard or by a framework's documented behavior, and its
  value is written as a literal. Anything else is reported as not read, never guessed.
- Where a framework can describe its own routes (an OpenAPI document, an introspection endpoint), that description is
  preferred to reading the code.
- What static reading cannot see (URLs built at run time, other template engines, client libraries' indirections) is
  left to runtime observation, as an extension, rather than to more parsing.

A guessed call that is wrong is worse than a call not found: it joins the wrong route, hides a real gap and produces
findings nobody acts on.

### Who writes a flow: three layers

A flow's structure comes from atlas; only its words come from an agent or a person.

1. **Chains (atlas).** One request and every surface it reaches in that request, fan-out included, derived on every
   run (`atlas chains`).
2. **What may follow (atlas).** The requests a chain's result offers, such as the links and forms of a page its
   handler renders (a chain's `next`).
3. **Intent (agent or person).** Titles, labels, owners, each step's role, and for a journey across requests, which
   chains in which order, picked from atlas output.

A check fails only on facts from layers 1 and 2: a chain that is gone, a step the code does not reach. Layer 3 is
checked for presence and for naming chains that exist; whether it is right is a person's review of the pull request
that changes the flow file. An order the code neither shows nor contradicts, such as two requests one app makes or a
hand-off from one client to another, stays `Connected: Unknown`.

Measured on the private monorepo, the derived chains alone covered 45 of 65 routes, where 27 flows written by hand
earlier covered 37; the remaining 20 were routes nothing calls or whose callers atlas cannot read. The values an agent
writes per flow fell from a step list, surface ids, an entry and roles to a title, labels and one role.

## Evidence

### Static extraction has a known ceiling

- The one reproducible comparison of static architecture-recovery tools for microservices (Bakhtin et al., 2024)
  found 13 tools, of which 9 ran and 3 produced nothing usable. On 17 Spring applications with hand-built ground
  truth, the best tool reached an overall F1 of 0.86, but only 0.66 on endpoints; the best on endpoints reached 0.79;
  four tools combined reached 0.91 overall. The authors conclude that no single static tool suffices. Those
  applications are backend to backend; templates and browser code, which atlas also reads, are harder.
- The closest open-source tool to atlas's call matching, tieline, reports a URL built at run time as `unverifiable`
  and does not try to resolve it.
- Running atlas's own extractor over 25 patterns common in real templates and scripts gave 9 read correctly, 7 read
  in part or wrongly, and 9 missed. Standard HTML attributes, Thymeleaf link expressions with literal paths, and
  `fetch` with literal or template-string URLs were right. URLs from model variables, other template engines (JSP,
  Jinja, Django, Handlebars), htmx and Vue attributes, and URLs assembled through wrappers or a client's base URL were
  missed or misread. Each fix for the second group is a parser for one more dialect.

### The ecosystem settled each part elsewhere

| Part | Where the ecosystem gets it | Examples |
|---|---|---|
| endpoint inventory | the framework's own description | springdoc, Spring Boot Actuator `/actuator/mappings`, Encore, tRPC |
| call edges | runtime observation | OpenTelemetry service graph, Kiali, Datadog and Azure service maps, Postman Insights, mitmproxy2swagger, HAR to OpenAPI |
| flow verification | execution | Pact, Redocly Respect and the Jentic Arazzo runner for Arazzo |
| flow visualization | standard viewers | Arazzo UI (diagram, sequence, flowchart) |

Two cautions from the same survey: Optic, which inferred and diffed OpenAPI from captured traffic, is archived, and so
is ts-rest. Keeping such tools alive is costly, which argues for a narrow scope.

### The gap atlas fills

- No tool found checks a declared Arazzo workflow, or any declared multi-step flow, against the code. Arazzo tools
  lint the document (Spectral, the Jentic validator) or run it against a server (Respect, the Jentic runner).
- Spec-driven development frameworks for agents (GitHub Spec Kit, OpenSpec, BMAD, Kiro) leave the agreement between
  specification and code to the agent or to the team's process; none has a deterministic check.
- Agents leave documentation behind: in a study of 29,669 agent-authored pull requests, 63% changed code without
  changing its documentation (De Michele and Tantithamthavorn, 2026).

### The pattern is established

- A skill that tells the agent when to run a deterministic tool, with the tool doing the work: Anthropic's own skills,
  Speakeasy's `extract-openapi-from-code`.
- A declared model checked against the code in CI, failing the pull request: Spring Modulith `verify()`, ArchUnit,
  dependency-cruiser.
- Findings must be actionable, nearly free of false positives and shown where developers already work, or they are
  ignored (Sadowski et al., "Lessons from building static analysis tools at Google", CACM 2018).

### What atlas showed in practice

- Replaying 478 commits of the private monorepo, the caller and producer rules fired on 5 pull requests, all real
  problems; 2 stayed unnoticed until a separate manual audit. Structural flow defects are rare (about one in a hundred
  commits), and most defects in the same period were about fields, wiring and runtime state, which atlas does not see.
  The value is in catching the rare structural break when the pull request is open, not in catching most defects.
- In the Spring application, all 9 "no caller" findings were REST endpoints served on purpose to clients outside the
  repository. Declaring them in `publicSurfaces` is the fix; without it the rule would be noise there.

## Scope

| Area | Read for certain | Not read (reported, never guessed) |
|---|---|---|
| routes | OpenAPI 2.0 and 3.x documents, an OpenAPI 3 document's concrete paths matched before its templated ones; NestJS, Express, Fastify, FastAPI and Flask (and Quart) registrations with literal paths (NestJS's also held in constants of any file: a `const`, a literal-initialized enum member, an `as const` object's property, followed through imports, re-exports, tsconfig `paths` and workspace packages), in the forms each router documents (every method it has, chains of them, Express's `route(path)` and arrays of paths, @koa/router's named routes and `redirect`, Fastify's `route({ method, url })`, Hono's `on` and a method that takes the path set before it in its chain, FastAPI's `add_api_route`, Nest's `@QueryMethod`), each in its router's path syntax at the version the nearest package.json gives (path-to-regexp 8 for Express 5, @koa/router 14 and Nest 11, Express 4's, find-my-way's and Hono's: optional groups and parameters, wildcards, parameters sharing a segment, parameters' regexps), Express routers and sub-applications under literal or declared mount paths (`use` chains included), @koa/router routers under their literal `prefix` and nested `use` paths, Hono groups under `route` paths and `basePath`, Fastify plugins under the literal `prefix` of each `register`, FastAPI routers under their literal or declared `APIRouter` and `include_router` prefixes, nested and imported, Flask blueprints under the literal or declared `url_prefix` of each registration, nested and imported, with Werkzeug's converters and each application's and blueprint's static files route, and applications under their literal mounts, Django's URLconfs from `ROOT_URLCONF` (`path` with its converters, `re_path` where its regex's shape is certain, `include` under each pattern) and Django REST framework's routers, with the methods each view takes, Go's Gin groups (nested, with `Static*`), chi routers under `Route` and `Mount` paths (with their regexp parameters) and ServeMux patterns at the Go version the nearest go.mod gives, each router followed through variables, closures, struct fields, methods, constants and the calls between the functions of the route files' packages, and a router a ServeMux serves under `http.StripPrefix`, Nest controllers under a literal global prefix (less its literal `exclude` paths) and URI version (`@Version`, `@Controller({ version })`, `defaultVersion`, `VERSION_NEUTRAL`) from the component's bootstrap, or a declared prefix, and under the literal paths `RouterModule.register` gives their modules, Spring MVC handler types under a literal `addPathPrefix` whose predicate is `forAnnotation`, `forBasePackage` or an `isAnnotationPresent` lambda, Next.js route handlers, API routes and pages by their file paths, with the HEAD and OPTIONS Next.js answers itself, the metadata routes whose paths Next.js fixes (`robots`, `manifest`, `sitemap`), the files of `public/` (at their percent-encoded paths) and the metadata files of `app/` (with the OPTIONS Next.js answers for them), ranked as Next.js serves them; Starlette path converters and StaticFiles mounts; configured registration helpers, with the method as an argument or fixed; Spring MVC mapping annotations with literal paths in Java and Kotlin, a type's mapping joined to its methods' and the methods united as Spring does; the `@HttpExchange` mappings of an interface a controller implements; `registerMapping` with a literal `RequestMappingInfo`; Spring's router functions a `@Bean` returns (WebMvc.fn and WebFlux.fn: `RouterFunctions.route()`'s builder, the static composition, Kotlin's `router { }` and `coRouter { }`), their predicates' methods and paths, nests and `resources`; the login and logout POST endpoints of Spring Security's `formLogin` and `logout`, from their defaults and literal setters on the configurer; ASP.NET Core in C#: minimal APIs on the application and its nested `MapGroup` groups, followed through locals and the extension and static methods the code passes a builder to, controllers' attribute routes (`[Route]`, `[HttpGet]` and the others, `[AcceptVerbs]`, tokens, `~/`) and the conventional routes `MapControllerRoute` gives the rest, in ASP.NET Core's template syntax (constraints, optional parameters, defaults, catch-alls, segments of several parts), the OpenAPI document `MapOpenApi` and the health checks `MapHealthChecks` map, and the files of the project's `wwwroot` only where the code calls `UseStaticFiles` or `MapStaticAssets` | paths in constants or expressions, path syntax a router rejects or no template holds (a wildcard before the end, a Hono regexp that may take a `/`), or beyond `:name` where the router or its version is not read (named in a limit), Kotlin string templates, router functions, predicates and mappings not spelled out or built outside a `@Bean` (named in a limit), a path without a leading `/` other than Hono's and @koa/router 15's (which puts its prefixes before it as text, read exactly) and a route chained on a receiver not traced to its router (named in a limit), the files of a directory `express.static` or FastAPI's `frontend` serves (named in a limit), composed annotations, a Security customizer defined elsewhere, a router or prefix built at run time, an @koa/router prefix set twice, a Go router held where atlas does not trace it (a parameter no read call passes a router, a value a branch may replace, a map, a slice or a library function it is handed to; named in a limit), a ServeMux pattern with a host or written for Go before 1.22, a chi regexp in RE2's own syntax, a `RouterModule` path or an `addPathPrefix` prefix or predicate not spelled out (their routes are left out with a limit), Next.js image metadata routes (their paths are generated; named in a limit), Django's admin site, a `re_path` regex whose shape is not certain and a view whose methods are not read (named in a limit); whether a request other than GET or HEAD without the trailing `/` a document's path ends with reaches it (the framework decides; named in a limit); a handler whose name the operationId does not carry (named in a limit); in ASP.NET Core, a route mapped on a builder no call atlas reads passes, a path or prefix not spelled out, a controller deriving from a class outside the files, `UsePathBase`, Razor Pages and components, hubs, YARP and dynamic routes, and the fingerprinted and compressed names `MapStaticAssets` serves (named in a limit) |
| OpenAPI documents | committed `openapi.*`, `swagger.*` and `*.openapi.*` files; the paths Nest's `SwaggerModule.setup`, `@fastify/swagger-ui` and `/openapi.json` routes serve a document at; for a Spring project whose build names springdoc-openapi (or whose code builds a `GroupedOpenApi`), `/v3/api-docs` or a literal `springdoc.api-docs.path`, behind the literal base path of the web stack its starter is for, and one document per literal group of a `GroupedOpenApi` bean (a `@Bean` method of a component the application scans) or `springdoc.group-configs[n].group`, from `application.properties`/`.yml` with Spring Boot's precedence | springdoc declared only for tests, in `dependencyManagement` or a Maven profile; settings of a profile's file or document (which profile runs is decided at launch), values with `${...}` placeholders, group names built in code or hidden by a parameter, builders no scanned `@Bean` method returns, documents on the management port, settings the environment overrides; which group describes which component |
| client calls in code | TypeScript and JavaScript parsed: string literals, template strings and concatenations, a part that is not a literal standing for unknown text; a leading `const` of the same file joined to the URL; methods stated at the call, or alike at every use of a `const` holding the URL; the default method of a wrapper around fetch the configuration names, where the call states none; the two branches of a conditional naming one path as one call; the root path `/` only in a request's place (a request call's URL, a JSX `href`, `action`, `formAction` or `src`, a navigation of Next.js's router or of the window's Location); the window Location's navigations (`location.href = url`, `assign`, `replace`) and React Router's `redirectDocument` as GET; a function of a client @hey-api/openapi-ts generated, where another configured file of the component names it; `new URL(path, base)` as a relative path against the page's own address or the request a Next.js handler answers, and from the root of the host a base the code spells out names; the host of a URL that starts with a constant of another file; each path joined to the base its client states, by the library's own rule (RFC 3986 resolution or appending with one `/`): axios's `baseURL` and a request interceptor that puts text before the URL, Ky's `prefix` and `baseUrl` (or `prefixUrl` before Ky 2) at the version the package.json gives, openapi-fetch's `baseUrl`, RTK Query's `fetchBaseQuery` with the method it sends, a request's own base, an Angular `environment` property every file `fileReplacements` may put in its place gives alike and an `InjectionToken`'s value its providers agree on (injected with `inject` or `@Inject`) before a URL, the base each caller of a @hey-api/openapi-ts or orval function gives in its options, and a path without a leading `/` through such a client; the text a module's helper puts before a path parameter, before the paths passed to it. Python f-strings with any replacement field as unknown text. In code read as text, a URL built by `+`, by a string's interpolations, by formatting (Go's `fmt.Sprintf`, `String.format`, C#'s `string.Format`, Python's `str.format` and `%`) or by a builder (Go's `url.JoinPath` and `path.Join`, OkHttp's `HttpUrl.Builder`, Spring's `UriComponentsBuilder`, Ktor's `appendPathSegments`, Swift's `appendingPathComponent`) as one, each value a hole, a string constant of the file in its place and the configured base in place of a value `baseValues` names; the method of the calls that send a URL held in a value, where they agree; the path parameters a resty client sets for its requests; a path without a leading `/` in Retrofit's annotations, .NET's `HttpRequestMessage` and the calls on the call source's `receivers`, joined to its configured `base`; Dart's `Uri.http(host, path)` from the host's root; Refit's `[PathPrefix]` and Spring's `@HttpExchange` interfaces with their methods' paths and methods; OpenFeign's `@RequestLine`; the method a client library sets through its own API where the code states it as a literal or the library's constant (a call named for it, an annotation or attribute, a builder chain, an argument or option, a `URLRequest`'s `httpMethod`), a method held in a value left `*`. In any language, absolute URLs to a loopback host or the host of the target's `origins` entry | paths assembled across functions or files, a client's base URL held in a value (taken from the call source's `base` or `prefix`; without one, the client's requests are named in a limit), interceptors and hooks other than those read (named in a limit), a path with a `.` or `..` segment joined to the configured base, which clients remove or send as written (named in a limit), an Angular `environment` property the files of `fileReplacements` give differently and an `InjectionToken` whose providers differ or are not read (named in a limit), a URL through a client with a base that starts with a value (named in a limit), the method a project's own wrapper sends when the call states none and the configuration does not name the wrapper, a path handed to a function after its first argument (no method before it) and an absolute URL to another host, also one a conditional in the URL's leading hole names (both named in a limit), a URL resolved by `new URL(path, base)` against a base held in any other value (named in a limit), a builder call that may change a path otherwise and a format verb that writes more than its value (named in a limit), Ktor's typed resources and Alamofire's routers (named in a limit), other Kotlin and Python constructs, and other languages, beyond strings that look like paths. A function of a generated client that no other configured file names (named in a limit). Never requests: compared strings, arguments of text tests (`startsWith`, `includes`, `split`, `replace` and the like), a `path` option that does not start at the root; a client helper's configured base put straight before a path parameter (`` `/api/v1${path}` ``), and other text a helper puts so, whose callers' paths are the requests; a client's base option, and the configured base written as a value; the text an interceptor sets as a request's own URL (`` config.url = `/v2${config.url}` ``), which is put before each request's URL instead; the `matcher` of a Next.js middleware's or proxy's exported `config`; a lone `/` anywhere else (a separator, a join, a key); the app's own routes in a client-side router's components and functions, React Router's and TanStack Router's known by their import, by name or as a namespace, or through a module of the repository that passes one on (outline's `ProfiledRoute`, React Router's `Route` wrapped by Sentry's `withSentryRouting` or not) (`Link`/`NavLink`/`Navigate` `to`, React Router 5's `Redirect`, a history's `push` and `replace`, `navigate()`, `redirect()`, `matchPath`, `useRouteMatch`, route definitions, `createFileRoute`), unless the navigation reloads the document, and the route tree TanStack Router generates; a JSX `placeholder`, `title`, `alt` or `aria-label`; a message given to Lingui's macros (`` t`/month` ``); a string only tested for truth or tested itself (`p.startsWith(x)`); the base `new URL` resolves a URL against; a value that goes, through a `const`, an array's membership tests and iterations, a data object's property, the parameter of a function the file declares or imports from the repository, or a function's result to its calls, also in the files of the repository that import the binding (not into code atlas does not parse, such as Svelte markup), only to such places or into a URL on another host; in code read as text, a path given to an exception (thrown, or a class named `Error`, `Exception` or `...Error`, `...Exception`) or to Kotlin's `error`, `TODO`, `require` and `check` (both named in a limit), an argument of a method of strings, in the file's language, that tests or cuts text (`endsWith`, `replaceFirst`, `startswith`, `HasPrefix` and the like), a text property of Flutter's `InputDecoration` (`prefixText`), the first argument of ASP.NET Core's `Map...`, `MapGroup` and `MapForwarder` and the path `UseExceptionHandler` re-executes at; in any language, a path ending in one of the file extensions atlas lists (`.png`, `.json`, `.log` and the like) that no route of the target serves |
| client calls in HTML | start-tag attributes `href`, `src`, `action`, `formaction` with root-relative literal values (the root `/` included), methods as the HTML standard defines them, and a form with no action submitting to its page's URL; Thymeleaf link expressions in `th:*` URL attributes, `th:attr` items and `[[...]]` in JavaScript-inlined scripts, with a literal base, quoted, appended to or a literal substitution, a preprocessed `__${...}__` or appended `${...}` as a value; page-relative links and forms with no action resolved against the path of each route whose view renders the template; a path with a file extension where a route of the target spells it out; inline scripts as JavaScript; the `data-*` attributes the configuration names as URLs a script requests, of unknown method | link expressions whose URL is a value (a model variable, a fragment parameter, a conditional) and page-relative URLs in a template no read route renders (both named in a limit), other template engines, htmx, Alpine or Vue attributes, a `th:method` other than GET or POST (its method depends on whether Spring's hidden-method filter is on, so it is `*`) |
| matching | the route a framework dispatches a request to, by its documented rule: registration order (Express, @koa/router without `exclusive`, Hono, Nest on Express with the default `routeResolutionStrategy`, Starlette) within one router in one function body, under a router's single mount; Nest's `specificity` strategy; find-my-way's precedence; Spring's and Next.js's ranking; ASP.NET Core's `Order` and route precedence, its literals matched whatever their case; a trailing `/` as each framework treats it, with the options that change it where literal (Express's `strict` and settled `strict routing`, Fastify's `ignoreTrailingSlash` and `prefixTrailingSlash`, Hono's `strict`, Spring 6's default and `setUseTrailingSlashMatch`, Starlette's `redirect_slashes`, Next.js's `trailingSlash`); AdonisJS's parameter matchers; Fastify's `constraints` as a condition on headers | the order of routers registered in different files, of Nest's controllers, or of a router mounted twice (every route a request fits stays a target); whether a handler atlas does not see passes the request on; a framework option or version not spelled out (named in a limit; a trailing `/` is then matched either way); a call's headers, so a constrained route (named in a limit) |
| handler reach | TypeScript and JavaScript, a Next.js page with the layouts and templates around it; a Spring page handler's view name as a literal, a string constant of its file or the result of a private method of its class, at Spring Boot's default template location; the GET a `redirect:` view name leads to, a request the client makes next; as what a page offers next, the links and forms of the server components a Next.js page renders and of the template a Spring view name renders | other view resolvers, view names built at run time, a redirect URL that starts with a value (named in a limit), a Next.js client module's links, an address passed as a prop to another component |

The configuration reference (`skills/flow-atlas/references/config.md`) gives the exact reading of each style.

A finding about absence is limited by this scope. "No caller" and "no route serves this call" mean none among the
configured and readable call sites. A call reaches a route as the framework dispatches it: one that no route takes
(a trailing `/` a strict router tells apart, a value a matcher refuses) is answered 404 or 405, a fact of the code,
and reported; one the router answers with a redirect reaches its route only once the client follows it, a second
request, so it is matched to none and neither it nor the route is reported. A route that an earlier route of its
router always answers for is dead code: no rule of its own reports it, since that would judge the code rather than a
flow, but where it has no caller its FA001 names the route that takes its requests. A call whose method is not read is matched to the routes its path fits only when
they all take one method. Where they take several, which one it calls is not read: atlas leaves it unmatched, a limit
names it, and none of those routes is reported as having no caller. Declare surfaces served outside the repository in `publicSurfaces`, and record a
decision as an exception.

Rules that keep the scope:

1. A new syntax is read only when a standard or the framework's documentation fixes its meaning and its value is a
   literal. Otherwise it goes into the "not read" column.
2. A framework-emitted description is preferred to reading the framework's code.
3. Where a reading cannot settle a value, it stops and says so (coverage, limits); it does not split, guess or default
   to something that looks plausible.

## Trimmed after eight repositories

In November 2026 atlas was configured and run on eight repositories of different shapes: a TypeScript and Kotlin
monorepo with a mobile app, a BFF and services; a Spring and Flutter app; a Spring Modulith service; a FastAPI and React
app; a Next.js app with an agent; an Express and Spring pair; a Rust, MCP and browser-extension workspace. What no
repository used was removed:

- **FA006 contract versions**, the `cases` command and the surface-seeded `draft flow <surface>`: configured nowhere, or
  replaced by chain drafts.
- **`feedback` and `stats`**: on 49 judged findings, `stats` only restated the judgements; its three verdicts could not
  tell a defect from a plan; feedback did not change what `check` reported. `publicSurfaces`, exceptions and correcting
  the configuration covered every case.
- **OKF `generated`, `verified`, `stale_after`, the trust tier and `Fresh`**: no check read `generated`; a
  self-declared `verified` made a flow machine-confirmed with nothing checked; a passed `stale_after` was reported as
  FA007, a code finding, though it is a calendar reminder. `sources` stays, in OKF's shape.
- **`EntryCalled`**: always True for chain steps, whose entry is copied from the chain.

`Connected` changed: two chain steps with no `next` between them were False when different components made the
requests. On two repositories that failed real journeys (an outside client's sequence, a queue an extension fills and
an app polls), so every such pair is now `Unknown (OrderNotInCode)`, as the rule above already said.

FA004 stays. It found six real defects on three repositories (artifact kinds an app does not render, an agent tool
missing from its tool list) and only noise on registries whose entries live in data or are served by one generic
route; the configuration reference now says which registries to leave out.

## Possible extensions

None of these is committed. Each fits the decision above and would be taken up when a real repository needs it.

- **Routes from Spring Boot Actuator.** Read the JSON of `/actuator/mappings`, generated like springdoc's document in a
  test, as a route source. It includes functional routes and composed annotations, and would replace reading Spring
  annotations where an application can produce it.
- **Which springdoc group is a component's.** A `GroupedOpenApi` states the paths and packages it takes
  (`pathsToMatch`, `packagesToScan`); the group whose literal patterns take every route of a component could be its
  description, where no customizer filters the document further. Today several groups stay `SeveralServedDocuments`.
- **Observed calls.** Read a HAR file from Playwright end-to-end runs, or OpenTelemetry spans with `http.route`, as
  calls with evidence `observed`. This covers what static reading does not: URLs from variables, other template
  engines, client wrappers.
- **Page routes in the Arazzo export.** Write, per component, an OpenAPI document of the routes its authored document
  leaves out (server-rendered pages), so every flow step becomes an Arazzo operation and the whole flow renders in an
  Arazzo viewer. A trial on the Spring application rendered both flows completely in Arazzo UI, with one participant
  per component when each component has one source description.
- **Unknown connections beyond chains.** Chain steps already leave an order the code does not show as Unknown. A
  surface-step pair whose side is outside the readable scope still reports `False`.
- **What an app does next.** A chain's `next` comes from rendered pages today. The requests a mobile or single-page
  app makes after a response could come from observed calls, so journeys there could be connected from evidence too.
- **Running the flows.** Hand the exported Arazzo to Redocly Respect or the Jentic runner, so a flow is checked by
  executing it as well as against the code.
- **Bridges.** Publish routes and flows to a Backstage catalog, or read Pact contracts as declared calls.

## Boundaries other than HTTP

Reviewed against the repositories atlas was run on (the 42 of one workspace). None is taken up now; each says what
would change that.

| Boundary | What the code holds | Decision |
|---|---|---|
| Messaging (Kafka, Event Hubs, queues) | One service both publishes and listens; the topic is a configuration property (`${EVENTS_TOPIC:events}`), not a literal, and the environment may override it | Not read from code, which cannot settle the topic. When a repository declares its channels in an AsyncAPI document, read its channels as the HTTP side reads OpenAPI: as declared surfaces, a publish and a subscribe meeting on one channel |
| Python handlers into their outbound calls | FastAPI handlers in three repositories call only services outside the repository; the Python agent of the TypeScript monorepo is served by a vendored library whose routes no code in the repository registers | Not built: no handler with an in-repository next hop to check it against. Taken up with the first one, by linking a route's `def` body to the calls in it, as TypeScript handlers are |
| MCP tools | `@McpTool` registrations are literal; which tool an agent calls is chosen by the model at run time | A call to a tool is never a code fact, so no chain runs through one. At most the tools are listed as surfaces, with the agents configured to reach their servers, when a repository needs that |
| Tauri commands | `invoke("name")` against `#[tauri::command]`, both literal | Out of scope: a desktop application's boundary, without a method or a path to match |
| Jinja and Django templates | Links by route name (`{% url 'name' %}`, `url_for`) | Out of scope by the rule above: Django's routes come from its URLconfs (or a generated OpenAPI document); its templates' links are not read |

## Before widening the scope

Measure, on at least two repositories over two to four weeks:

1. how often an agent's `query` or `trace` before a change led it to reuse an existing endpoint instead of adding one;
2. the share of findings people acted on, counted from the fixes and exceptions in the history; a rule below 70% is
   turned off or narrowed;
3. the time spent per supported framework on reading changes.

If the first is close to zero, atlas should shrink to the flow check and the Arazzo export.

## Sources

- Bakhtin, Li, Soldani, Brogi, Cerny, Scandariato, Taibi. Comparison of Static Analysis Architecture Recovery Tools
  for Microservice Applications. arXiv:2403.06941 (registered report), results arXiv:2412.08352.
- Schneider, Scandariato. Automatic extraction of security-rich dataflow diagrams for microservice applications
  written in Java (Code2DFD). Journal of Systems and Software, 2023.
- tieline: https://github.com/nugehs/tieline
- Spring Boot Actuator mappings endpoint: https://docs.spring.io/spring-boot/api/rest/actuator/mappings.html
- Encore Flow: https://github.com/encoredev/encore/blob/main/docs/ts/observability/flow.md
- OpenTelemetry service graph connector:
  https://github.com/open-telemetry/opentelemetry-collector-contrib/blob/main/connector/servicegraphconnector/README.md
- mitmproxy2swagger: https://github.com/alufers/mitmproxy2swagger
- Optic (archived): https://github.com/opticdev/optic
- Redocly Respect: https://github.com/Redocly/redocly-cli/blob/main/docs/%40v2/commands/respect.md
- Jentic Arazzo tools and Arazzo UI: https://github.com/jentic/jentic-arazzo-tools, https://arazzo-ui.jentic.com
- Pact: https://docs.pact.io/
- GitHub Spec Kit: https://github.com/github/spec-kit; OpenSpec: https://github.com/Fission-AI/OpenSpec
- Speakeasy `extract-openapi-from-code` skill:
  https://github.com/speakeasy-api/sdk-generation-skills/blob/master/skills/extract-openapi-from-code/SKILL.md
- Anthropic skills: https://github.com/anthropics/skills
- Spring Modulith documentation: https://docs.spring.io/spring-modulith/reference/documentation.html
- De Michele, Tantithamthavorn. Documentation Drift in AI-Generated Pull Requests. arXiv:2610.27381.
- Sadowski, van Gogh, Jaspan, Söderberg, Winter. Lessons from Building Static Analysis Tools at Google. CACM 61(4),
  2018. https://cacm.acm.org/research/lessons-from-building-static-analysis-tools-at-google/
