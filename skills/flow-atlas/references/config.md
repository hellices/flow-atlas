# Configuration

`atlas` reads only what the configuration names. You write the configuration; `atlas inventory` gives the raw
material: components from manifests, files that register routes (and in which style), files whose strings look like
client requests and OpenAPI documents. It does not choose; many candidates are tests
helpers, tools or contracts, not clients. A manifest in the platform folders a cross-platform framework builds as
part of the app beside them (`android/`, `ios/` and the like of a Flutter app, a React Native app or an Expo module) is
that app's, not a component; components that would share a name are named by their paths (`mobile-app`), or numbered where the paths do not
tell them apart, with a note. Expect two or three rounds of `atlas scan` and correction before the
findings are worth reading.

```yaml
# Components: from manifests, or listed.
manifest:
  kind: component-json        # any JSON with name, provides, consumes
  glob: "services/*/component.json"
components:                   # used when there are no manifests
  - { name: web, path: apps/web }

# Where each component serves routes.
routes:
  - component: orders
    files: ["services/orders/src/**/*.ts"]
    styles: [nest]            # nest | express | fastapi | spring | next
    receivers: [app, router]  # express receivers; default app, router, server, fastify
    mounts:                   # where an Express router file is served, when its `use` path is not a literal
      "services/orders/src/routes/collect.js": /collect
    constants: "Path$"        # const names whose string value is a GET route (SSE paths and the like)
    operationIds: nest-swagger  # name operations ClassName_methodName, as @nestjs/swagger does by default
    calls:                    # registration helpers, TypeScript or Python: registerRoute(app, "POST", "/x", handler); positions count from 0
      - { name: registerRoute, methodArg: 1, pathArg: 2 }
      - { name: add_agent_endpoint, pathArg: 2, method: POST }   # a helper that always registers one method ("*" for all)
  - component: payments       # any framework: its generated OpenAPI 2.0/3.x document (references/openapi.md)
    openapi: services/payments/openapi.json
    files: ["services/payments/src/main/**/*.java"]   # searched for the handlers of documented operations

# Which files of one component call another. Keep these narrow: the client adapters, not the whole app.
calls:
  - { from: web, to: bff, files: ["apps/web/src/api/**/*.ts"] }
  - { from: app, to: api, files: ["app/lib/**/data/**/*.dart"], prefix: /api/v1 }   # the client's base path (Dio baseUrl, axios baseURL)
  - { from: web, to: api, files: ["src/main/resources/templates/**/*.html"], dataUrls: [data-api-url] }   # data-* a script requests
  - from: spa
    to: api
    files: ["apps/spa/src/**/*.ts"]
    wrappers:                 # the project's own wrappers around fetch: URL first, init second
      - { name: authFetch, defaultMethod: GET }   # authFetch(url) sends GET, as fetch does; a method in the init is kept
  - { from: android, to: bff, files: ["apps/android/**/api/**/*.kt"] }

# Registries whose entries one side produces and another consumes.
registries:
  - name: document
    active: { file: catalog/active.json, pattern: "(.+)-v\\d+\\.schema\\.json" }   # or field: name for objects
    producers: ["services/**"]
    consumers: ["apps/**"]

# Surfaces used by clients outside the repository. `*` stays within a segment, `**` crosses segments.
publicSurfaces:
  - "orders|GET /health"
  - "orders|* /admin/**"

exclude: ["**/legacy/**"]     # added to the defaults: tests, generated, node_modules, dist, build

flows: ["flows/**/*.flow.yaml"]   # flow descriptions, read at the same revision as the code (this is the default)

origins:                      # base URL each component is served at: `atlas export arazzo`, and absolute URLs read as calls
  orders: http://localhost:3001
openapi:                      # to override the OpenAPI description atlas finds for a component, or give one it finds none of
  orders: services/orders/openapi.json   # a file (in the repository, or absolute), a served path, or a URL

rules:
  FA003: { cycles: false }    # when the repository already checks cycles
  FA004: { enabled: false }   # any rule can be switched off for a repository
```

## Order of work

1. Components. Check `atlas scan` lists every component you expect and the declared edges.
2. Routes. Compare the surface count per component with the route candidates `inventory` found. A component with
   zero surfaces usually means a wrong glob or a style that is not set.
3. Calls. Add one entry per client-to-server pair, pointing at the client adapter files `inventory` listed for that
   client. FA001 is only evaluated for components that appear as `to`. Run `atlas check` and open a few FA001
   findings: a route that is in fact called points to call files missing from `files`, or a call shape the extractor
   cannot read.
4. Registries, if the repository has a list whose entries both a producer and a consumer name literally in code
   (artifact kinds a backend issues and an app renders, tools an agent registers and calls). Leave out lists whose
   entries live in data rows, are served by one generic route, or are rendered generically: every entry then comes
   back as FA004 with nothing to fix.
5. Read the `coverage` block of `atlas scan`: every source should read files and yield items; for calls, `matched`
   close to `items` means the paths line up, and `reached from a surface` shows how many outbound calls a trace can
   continue through. A registry's line counts the active files read and the entries they list; one that reads no file
   or lists nothing also gives a `limit:` line, usually a moved file or a `pattern` or `field` that no longer fits.
6. Run `atlas baseline update` once, with the person who owns the repository. The baseline also records what each
   source yielded; a later check warns when a source falls below half of that, which usually means code moved and
   the configuration did not.

## What the extractors read

TypeScript and JavaScript are parsed with the TypeScript compiler: string and template literals inside configured
call files, the method from `.get(`/`.post(` callees, a method string in the same argument list
(`request("/x", "POST")`) or a `method:` property nearby, and the function or method that holds the string. A URL that
starts with a `const` of the same file (`${base}/orders`, `API + "/orders"`) is joined to that constant's value, found
by the scopes around the use (an origin with no path, `https://api.example.com`, keeps its host for the check below); a
constant used only that way is a base, not a request of its own. A URL held in a `const` takes the method that every
use requesting it states (`fetch(url, { method: "POST" })`); uses that differ or state none leave it `*`. A wrapper the call source names in `wrappers` is read as fetch is, with
its own default: called by the name written there (`authFetch`, or `api.authFetch` for that member call only), with
the URL as its first argument, it sends `defaultMethod` when there is no second argument or the second is an object
literal in which nothing may set `method`; a method the call states (`{ method: "PUT" }`, also after a spread,
or `authFetch(url, "POST")`) is kept; an init held in a value, or one where a spread, a computed key (`[key]: verb`),
a getter, a `__proto__` or a `method` held in a value comes last among what may set it, leaves it `*`. The wrapper is
read before what its name says without the entry: a wrapper named `post` or `fetch` sends its own default. A wrapper whose default is not
fetch's GET (one that always posts, say) says so in `defaultMethod`. Without the entry, a wrapper's call that states no
method is `*`: atlas does not read into the wrapper. A method named in brackets (`path["startsWith"]`) is
the method named after a dot. A string in a type
(`path: "/m" | "/r"`) names a value and is no request, nor is a string compared (`===`, `!==`, `==`, `!=`, `case`) or
handed to a method that tests or cuts text (`startsWith`, `endsWith`, `includes`, `indexOf`, `match`, `search`, `test`,
`split`, `replace` other than the window's `location.replace(url)` and Next.js's router's). fetch, axios, ky, got and project wrappers take their URL first, so a path
handed to a function after its first argument (`requireAsset(assets, id, "/devices")`) is not read unless a literal
method comes before it (`request("POST", "/x")`), or the function is XMLHttpRequest's `open(method, url)` or Angular's
`request(method, url)` with the method held in a value, or a `redirect(status, url)`; the window's `open(url, target)`
(the global `open`, or `open` on a global `window` or `document`, not a binding of that name the code declares) takes its URL first. A limit names the functions such paths went to. A `path` option is
read as Node's `http.request` defines it, from the root: one joined to another value (`` path: `${dir}/raw` ``) is no
request. When both branches of a conditional name the same request (`` base ? `${base}/chat` : "/chat" ``) they are
one call, which joins a base only when both branches do. Branches whose paths differ once the configured `prefix` is
put before a root-relative one, and a branch to a host other than the target's, are read on their own. An
absolute URL, in code of any language, is a request to the call source's target when its
host is a loopback address (`localhost`, `127.x.x.x`, `[::1]`) or the host of the target's `origins` entry; a URL to any
other host, a link to another site for one, is not read, and a limit names the host. A client's own helper that puts
the configured `prefix` straight before a path it is given (`` `/api/v1${path}` ``, `"/api/v1" + path`, the value built
from that one parameter alone) is the prefix written once more, not a request: the paths passed to it are read where
they are written, with the prefix, and a limit names where the helper was left out. A path with a hole
(`` `/orders/${id}` ``), another base, or text after the value is still a request. A path that already starts with the
prefix still gets it, since a service may nest the same segment. Routes come
from Nest decorators, Express-style receivers and registration helpers; their paths are written as OpenAPI templates
(`:id` becomes `{id}`), and an `operationId` in the route options or `@ApiOperation` is kept. A registration whose path
is not a literal (a `const`, a template, an expression; in Python a name or an f-string) registers nothing, and a limit
names its file, line and expression. A `const` of the file named in `constants` is read as a GET route at its value,
so a GET registered on it at that path gives no limit; another method or a prefix does. For each TypeScript route the handler is
followed through local functions, relative imports and re-exports, and the member methods it calls are kept, except
those called on the handler's own parameters (`res.send()`, `reply.code()`), which belong to the framework, as does the
registration call itself; an
outbound call of the same component held in a method of that name continues the trace. A route file that is also one
of its component's call files does not turn its own registrations into calls. An Express router, `Router()` from `express` (`express.Router()`, a named import, a destructured require), serves
its routes under each literal path it is mounted at with `use` (an inline middleware first is the pathless overload),
nested and imported routers included (also from `module.exports = { router }`), `./r.js` standing for `r.ts`, on a
router or on an `express()` application, created there or imported from a relative module; routers are told apart by their bindings, so a
shadowing name is another value. Where a mount path is not a literal and `mounts` does not give it, its routes are not
read and a limit says so. The `next` style reads Next.js route handlers, `app/**/route.ts` exporting `GET`, `POST` and
the like (declared, re-exported by name, or re-exported with `export *`), with `app/` at the component's directory or
under its `src/`: route groups and slots add no segment, private folders and intercepting routes are not served, `[id]`
is `{id}`, `[...rest]` is `{rest}/**` (one segment or more) and `[[...rest]]` is `{*rest}` (none or more). Next.js
answers HEAD with the GET handler when the file exports GET and no HEAD, and OPTIONS by itself when it exports no
OPTIONS; those surfaces are `implicit`,
reached only by a request that names the method, and no rule expects a caller for them. As Next.js does, a request is
matched to the most specific route path first (a static name, then `[x]`, then catch-alls), and a method that route lacks
matches nothing else. API routes under `pages/api` answer every method from their default export, written or
re-exported, and their folders are plain segments. Pages (`app/**/page.tsx`, and Pages Router pages outside
`pages/api`) are GET routes at their paths, with the HEAD Next.js answers itself. What the server runs while it renders
the default export (a function component, also one named by `export { Page as default }` or re-exported from another
module, or a class component's `render`, its own or one it inherits from a class of the file or a relative import) belongs to the page's request, prop values and what computes a handler or an
address included; client modules (`"use client"`), addresses (`href`, `src`, `srcSet`, `poster`, `action`), event handlers (`onClick`) and functions
passed as props do not: a `<Link href>`, an `<a href>` or an address Next.js's router navigates to (`push` or `replace`, also
`useRouter().push`; also parenthesized or with `as const`) is a GET, and a `redirect` from `next/navigation` keeps the
method of the request it answers (`*`); each reaches
the page it names as a request of its own. Include `.tsx` in the route
files to read them. Other languages are read as text: Kotlin templates (`$x`, `${x}`),
format strings (`%s`, `%d`) and `{x}` become wildcards, as does every replacement field of a Python f-string; the verb
comes from the call whose first argument the literal is (type arguments allowed, as in `dio.get<T>(`; also when the literal starts the next line) and the scope
from the last `fun`, `func` or `def` before it. A path given to an exception is a label, not a request: an argument
of a call that is thrown (`throw BffUnavailable("/my")`, `throw new X(...)`, Python's `raise X(...)`), of a class named
as Java's, Kotlin's, Dart's and Python's own exceptions are (`Exception("/x")`, `IllegalStateException("/x")`,
`SomeError("/x")`), and in
Kotlin of the standard library's throwing functions `error`, `TODO`, `require` and `check` (not a member of that name);
a request written inside those parentheses (`throw ApiFailure(http.get("/x").status)`) is still read, and a limit names
the exceptions such paths went to. Log and print calls are read as before: their names come from libraries, not the
language. FastAPI
decorators are read from Python, with Starlette's converters (`{name:path}` is kept as written and takes any text,
none included, after the `/` written before it, so `/x/{name:path}` matches `/x/` and `/x/a/b`; a request without
that `/` (`/x`) gets there only by the redirect Starlette answers when no route, of any method, surely matches it,
unlike `{*name}`, which matches `/x` itself. atlas drops a call's trailing `/`, so a call written `/x/` is read as
`/x`. `{id:int}`, `{id:float}` and `{id:uuid}` are kept as written and take one segment their regex takes; `{id:str}` is
`{id}`; a convertor registered elsewhere is not read, so its segment may take anything; a `path` converter before a
suffix is not matched, so that route is left out with a limit), and `app.mount("/x", StaticFiles(...))` serves GET
(and an implicit HEAD) at `/x/{path:path}`, as Starlette compiles a mount; another mounted application
is not read, and a limit says so. The `spring` style reads `@RequestMapping` on a class as a prefix for the
`@GetMapping`, `@PostMapping`, `@PutMapping`, `@DeleteMapping`, `@PatchMapping` and `@RequestMapping` methods under
it, in Java and Kotlin (paths joined, methods united as Spring does), and the POST endpoints Spring Security's
`formLogin` and `logout` serve, in the lambda or the chained form. A mapping path may be a string constant the file
declares (`static final String PATH = "/x"`, `const val PATH = "/x"`, joined with `+` to literals and other such
constants), since an annotation argument is a compile-time constant. A name is found as the language finds it: in the
types around the mapping, innermost first, then a Kotlin file's top level, or `Type.PATH` for a type the file declares
once. A name that could be inherited (past a type with a supertype), one imported by name, a constant of another
file, any other expression and a Kotlin string template (`"$BASE/users"`) register nothing, and a limit names the
mapping where it is written. A Security URL held in a constant registers nothing. A Security setter counts only on the configurer: in a
lambda, on a chain that starts at its parameter; in the chained form, on the chain that continues `formLogin()` or
`logout()`. A page handler that returns a view name (`return "movies/detail"`) leads to the requests in
`src/main/resources/templates/movies/detail.html` of its application, where Spring Boot's default Thymeleaf resolver
looks; a `@RestController` or `@ResponseBody` handler's string is its response, not a view. The name may be a
`static final String` (Kotlin `const val`) the file declares, or what a private method of the handler's class returns
when the handler returns its result and the class declares one method of that name. A name starting with `redirect:`
is a redirect (Spring MVC's view resolution: the rest is the URL): it leads to a GET of that path, which the client
that made the request sends next (a chain's `next`, `via redirect`), from a GET or POST route (after another method
the client may keep it, so its method is `*`); the current request's URI variables (`{id}`) and any value appended in
code are values, a relative URL is resolved against the route's path, and one starting with a value is named in a
limit. A route source's
`openapi` document adds every operation it declares, whatever the language; see `references/openapi.md`.

HTML files in a call source are read as templates, from the attributes of start tags: Thymeleaf link expressions
(`@{/reviews/{id}(id=${...})}`) in `th:href`, `th:src`, `th:action`, `th:formaction`, the configured `th:data-*` and
`th:attr` items, and root-relative URLs in `href`, `action`, `src`, `formaction` and the configured `data-*`; also the
requests inline scripts without a `src` (written, or rendered by `th:src` or `th:attr`) make,
and link expressions in `[[...]]` where a script has `th:inline="javascript"`. A link's base may be quoted
(`@{'/owners?page=1'}`) and appended to (`@{'/owners/' + ${id}}`), or a literal substitution (`@{|/owners/${id}|}`),
as long as it starts with text; a preprocessed value (`@{/owners/__${owner.id}__}`) is a value in the path. A link
whose URL is a value (`@{${url}}`, a fragment parameter `@{__${link}__}`, a conditional) is not read, and a limit names
it. A page-relative link (`@{__${owner.id}__/edit}`) and a form with no `action` (or an empty one), which submits to the
URL of its page, are resolved against the path of each route whose view renders the template: one call per path, which
only the routes of that path reach (the call's `page`). In a template no route atlas reads renders (a fragment file),
they are not read, and a limit names them. A path ending in a file extension (`.html`, `.css`) names a file and is
not read, unless a route of the target serves it with that extension spelled out (`@GetMapping("/vets.html")`). A link is a GET. A form action takes the
form's method, and a submit button's `formaction` its `formmethod`, else its form's; a submit control with no form
owner (none around it, or a `form` attribute naming no form) submits nothing. A plain `method` or `formmethod`
is read as the HTML standard defines it: `get` or `post`, nothing sent for `dialog`, and GET for any other value, as a
browser does; `th:formmethod` just writes `formmethod`, so a literal (`post`, `'post'`) is read the same way and a
computed value (`${m}`) is `*`. Thymeleaf's `th:method` (or `data-th-method`) replaces a
form's method: GET and POST as written, and any other value
`*`, since Spring turns the hidden `_method` field into that method only when its HiddenHttpMethodFilter is on, which
Spring Boot leaves off. HTML gives a `data-*` value no meaning, so only the attributes a call source names in
`dataUrls` (those the project's scripts request, as `data-api-url`) are read: any method, and one ending in `/` is a
base the script appends a segment to. Only the exact `script` and `style` elements hold raw text. A plain
attribute Thymeleaf replaces (`href` next to `th:href`) is not requested; `th:attrappend` and `th:attrprepend` join
their value to the plain one. Text outside attributes, commented-out markup and absolute URLs, which name other sites,
are skipped.

Routers differ in which of several matching routes serves a request. Spring picks the most specific (a pattern without
a catch-all first, and of two catch-alls the longer; then the lower score, one per variable and a hundred per wildcard,
within a segment too; then the longer pattern), so for
a `spring` component a request whose path is fully known reaches that route only (`/movies/search`, not
`/movies/{id}`). Express, Fastify, Nest and FastAPI follow registration order,
which atlas does not read, so there a request reaches every route it fits.

A request whose method is not read (`*`: a project's wrapper called without a method and not named in `wrappers`, an
init built at run time, a `data-*` URL) is matched to those routes only when they all take one method, or all take any. Where they take several,
which one it calls depends on the method, which atlas does not settle: it leaves the call unmatched, a limit names the
call and the methods, FA002 is not reported for it and FA001 for none of the routes it fits. A wrapper's own code is not read, so `authFetch(url)` is
such a request even when the wrapper hands its arguments to `fetch`, until the call source names it in `wrappers` with
the method it sends by default; `authFetch(url, { method: "POST" })` states its method either way.

An interpolation matches any text within its segment, but fixed text around it must agree: `support-options{}`
matches `support-options`, not `status`. A request whose path is built far from the call (passed through several
functions, read from a response) is not seen. Such routes show up as FA001; list them in `publicSurfaces` or add the file that holds the path. A route in `publicSurfaces` that no component calls starts a chain of its own, entered from `outside`, so a flow can name it.

## Where state lives

atlas finds each component's OpenAPI description itself: a committed `openapi.(json|yaml)`, `swagger.*` or
`*.openapi.*` under the component, else the path its code serves the document at (`SwaggerModule.setup` with
`jsonDocumentUrl` or `<path>-json`, `@fastify/swagger-ui` `routePrefix` + `/json`, a route at `/openapi.json` and the
like; for a component read with `styles: [spring]`, what springdoc serves for its Maven or Gradle project, see
`references/openapi.md`). `atlas inventory` lists them. Only the server's base URL is yours to give, per environment, in `origins`;
read it from the repository's deployment files.

`atlas export arazzo` writes a step only when its component's description is decided. A component with none (a plain
HTTP server atlas reads from code) has its steps left out with a `limit:`, and the workflows that lose steps say so in
`x-flow-atlas.omitted`; set `openapi.<component>` or `routes[].openapi` to write them. The export prints to stdout,
not to `--out`; save it at the repository root (`atlas export arazzo > flows.arazzo.yaml`), because a description
file in the repository is written relative to the root. A file outside it (a
committed link to one included) is written by its file name, with a `limit:` to commit it or publish it and set
`openapi.<component>` to its URL; if it is the document the component serves, set `openapi.<component>` to the served
path and `origins` to the server's base URL.

Flow descriptions are also read from `<out>/flows/`, so a repository atlas must not write to can still be described.

All writes go to `--out` (default `<root>/.atlas`; `export arazzo` prints to stdout instead): `graph.json`, `last-check.json` and `baseline.json` (keys and
coverage). Exceptions are read from `<root>/flows/atlas-exceptions.yaml`, then `<out>/exceptions.yaml`.
To analyse a repository you must not change, keep the configuration and all state in `--out` and use
`--ref <commit>` to read commits without checking them out.
