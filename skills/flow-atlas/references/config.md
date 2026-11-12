# Configuration

`atlas` reads only what the configuration names. You write the configuration; `atlas inventory` gives the raw
material: components from package manifests (`package.json`, `pyproject.toml`, `go.mod`, a Maven or Gradle build,
`pubspec.yaml`, and in an Nx workspace each project's `project.json`, the workspace's root `package.json` left out), to
list under `components:` (the `manifest:` setting reads only `component.json` declarations), files that register
routes (and in which style), files whose strings look like client requests and OpenAPI documents. It does not choose;
many candidates are tests helpers, tools or contracts, not clients. A manifest in the platform folders a cross-platform framework builds as
part of the app beside them (`android/`, `ios/` and the like of a Flutter app, a React Native app or an Expo module) is
that app's, not a component; components that would share a name are named by their paths (`mobile-app`), or numbered where the paths do not
tell them apart, with a note. Expect two or three rounds of `atlas scan` and correction before the
findings are worth reading.

```yaml
# Components: from component.json manifests, or listed.
manifest:
  kind: component-json        # any JSON with name, provides, consumes
  glob: "services/*/component.json"
components:                   # used when there are no manifests
  - { name: web, path: apps/web }   # the directory from the repository root; "." (or "") for the root itself

# Where each component serves routes.
routes:
  - component: orders
    files: ["services/orders/src/**/*.ts"]
    styles: [nest]            # nest | express | fastapi | spring | next | flask | aspnetcore | django | go
    receivers: [app, router]  # express receivers; default app, router, server, fastify
    mounts:                   # where the routers a file declares serve their routes, when the code gives no literal path:
      "services/orders/src/routes/collect.js": /collect   # an Express, @koa/router or Hono router's or a Fastify plugin's mount path and prefix, a FastAPI router's include prefix, a Flask blueprint's url_prefix, the path a Django URLconf is included at, or where a Go file's routers are served
    prefix: /api              # the path every route of the entry is served under, where atlas does not read it: Nest's global prefix from a variable
    bootstrap: services/orders/src/main.ts   # nest: the file that sets the global prefix and versioning, when atlas finds several
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
  - { from: app, to: api, files: ["app/lib/**/data/**/*.dart"], prefix: /api/v1 }   # the client's base path, appended to (Dio's baseUrl); the same as base: /api/v1, join: append
  - from: mobile
    to: api
    files: ["mobile/**/data/*Service.kt"]
    base: /api/v1/            # the path of the base URL the client joins its paths to, where the code sets it in a way atlas does not read
    join: resolve             # resolve: as a URL reference (HttpClient, Retrofit, Ktor, urljoin); append: after it with one / (axios, Ky's prefix, RTK Query)
    receivers: [client]       # code read as text: the names the client is called on; a path without a leading / is read only as their calls' URL
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
   cannot read. For a client generated from the server's OpenAPI document, list the generated client and the files
   that call it (see "Generated clients" below).
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
`split`, `replace` other than the window's `location.replace(url)` and Next.js's router's). The window's Location
navigates with GET, as the HTML standard defines: `location.href = url` (also `window.location`, `document.location`,
or the Location itself set), `location.assign(url)` and `location.replace(url)`. The root path `/` is read only where
the string is in a request's place: the URL, the first argument, of the global fetch, of a call named after an HTTP method or of a
configured wrapper; a JSX `href`, `action`, `formAction` or `src`; a navigation of Next.js's router or of the window's
Location; a branch of a conditional in one of those places. A lone `/` anywhere else is a separator, a join or a key,
and is not read. A client-side router's navigations and route definitions are the app's own routes, which the router
renders in the browser, and are no requests, the names imported one by one or as a namespace (`RR.Link`), or from a
module of the repository that passes the router's own on: a re-export (`export { Route } from "react-router-dom"`), a
`const` holding it, or a `let` every value written to which is the same one, Sentry's `withSentryRouting(Route)`
included, which renders the `Route` it is given with the props it is given (outline's `components/ProfiledRoute`). React
Router (imported from `react-router` or `react-router-dom`, version 5's names included): the
attributes of `Link`, `NavLink`, `Navigate`, `Route` and `Redirect`; the arguments of `redirect`, `replace`, `useNavigate`,
`createBrowserRouter`, `createHashRouter`, `createMemoryRouter`, `useRoutes`, `matchPath`, `matchRoutes`,
`generatePath`, `useMatch`, `useHref`, `useResolvedPath`, `useLinkClickHandler` and `useRouteMatch`, through the
objects, arrays and spreads written there; the function `useNavigate()` returns, and the `navigate` method of a router
those create; the `push` and `replace` of the history `useHistory()` returns, also taken apart. TanStack Router
(imported from `@tanstack/react-router`): the attributes of `Link` and `Navigate`; the arguments of `createFileRoute`,
`createLazyFileRoute`, `createRoute`, `redirect`, `useNavigate` and `getRouteApi`; the function `useNavigate()` returns
and the `navigate` method of `useRouter()` or `createRouter()`; and the route tree its generator writes
(`routeTree.gen.ts`, known by the `FileRoutesByPath` it declares in `@tanstack/react-router`), which holds no request.
A call written there (a loader's `fetch`) still runs and is read. A navigation that loads the document instead is a
GET: a `to` (or TanStack's `href`) beside `reloadDocument` (the last one set, in a spread of an object literal too),
while the navigation's other options stay the router's; and the URL React Router's `redirectDocument(url, init)` takes
first. An absolute URL to another origin is read as any absolute URL is, its root path too. The same names imported from anywhere else are read as before. fetch, axios, ky, got and project wrappers take their URL first, so a path
handed to a function after its first argument (`requireAsset(assets, id, "/devices")`) is not read unless a literal
method comes before it (`request("POST", "/x")`), or the function is XMLHttpRequest's `open(method, url)` or Angular's
`request(method, url)` with the method held in a value, or a `redirect(status, url)`; the window's `open(url, target)`
(the global `open`, or `open` on a global `window` or `document`, not a binding of that name the code declares) takes its URL first. A limit names the functions such paths went to. A `path` option is
read as Node's `http.request` defines it, from the root: one joined to another value (`` path: `${dir}/raw` ``) is no
request. When both branches of a conditional name the same request (`` base ? `${base}/chat` : "/chat" ``) they are
one call, which joins a base only when both branches do. Branches whose paths differ once each is joined to its
client's base, and a branch to a host other than the target's, are read on their own. An
absolute URL, in code of any language, is a request to the call source's target when its
host is a loopback address (`localhost`, `127.x.x.x`, `[::1]`) or the host of the target's `origins` entry; a URL to any
other host, a link to another site for one, is not read, and a limit names the host. A host chosen in a URL's leading
hole (`` `${prod ? "https://other.example" : ""}/api/status` ``) is read as that conditional's branches would be: the
URL is still a request where a branch names no other host, and the limit names the other one. A client's own helper that puts
the base the call source appends to (`prefix`, or `base` with `join: append`) straight before a path it is given
(`` `/api/v1${path}` ``, `"/api/v1" + path`, the value built from that one parameter alone) is the base written once
more, not a request: the paths passed to it are read where they are written, with the base, and a limit names where the
helper was left out. A function of the repository that requests a URL of other text from the root put straight before
a parameter (`` fetch(`/api${path}`) ``, the text not ending in `/`), hands that parameter to no other call, and is
passed a path from the root wherever the code passes it text, puts that text before each of those paths: its URL is
read before them, not as a request of its own, and a limit names it. Where it requests that URL through a client
whose base atlas reads (below), or hands the parameter itself to one (`` (url) => api.get(url) ``), the paths passed to
it are that client's requests, joined to its base. A path with a hole (`` `/orders/${id}` ``), another base, or text after the value is
still a request. A path that already starts with the base still gets it, since a service may nest the same segment; the
base itself, written as a value (`baseUrl: "/api/v1/"`, `this.baseUrl = options.baseUrl || "/api"`, `` `${API}/api/v1` ``),
is no request, and a limit names where.

A string is also no request where its place shows it is text for people or is tested, not sent: a JSX `placeholder`,
`title`, `alt` or `aria-label` (and the other ARIA attributes of text), on an element or as a component's prop of that
name; a message given to one of Lingui's macros (`` t`/month` ``, `msg`, `defineMessage`, `plural`, `select`,
`selectOrdinal`, imported from `@lingui/macro`, `@lingui/core/macro` or `@lingui/react/macro`, and the `t`
`useLingui()` of `@lingui/react/macro` gives); a string tested for truth (`!x`, a condition, the left of `&&`), or one a
test is made on (`prefix.startsWith(x)`, `includes`, `indexOf`, its `length`). Where the code states where a value
goes, atlas follows it there, and the value is no request when every place it reaches is none of the above or a URL on
a host other than the target's: a `const` to each of its uses; an element of an array, written in place or held in a
`const`, to the array's `includes`, `indexOf` and `lastIndexOf`, and through `some`, `every`, `findIndex`,
`findLastIndex`, `forEach`, `map`, `flatMap` and `for...of` to the binding each element is given to; a property of an
object literal to where the object goes and each read of that property (through its key, or every binding of a
destructuring that names it), where the object holds data alone (no method, accessor, `function` value or spread,
which may read it through `this`) and only properties it writes itself are read otherwise; an argument (or a property
of an object written as one) to the uses of the parameter in its place, in a function the file declares or one a module
of the repository exports and the file imports, unless the code writes another value to that function; a function's
result (a `return`, an arrow function's body) to every call of the function: a function declaration, a `const` holding
one, a method of an object held in a `const` (`Route = { albums: () => "/albums" }`, called as `Route.albums()`), or
one called on the spot. A `const` or a function a module exports is followed into the files of the repository that
import it, by the name each import gives it, through modules that pass it on (up to 20) and `ns.name` of a namespace
import; a file whose text holds the name but is code atlas does not parse (a Svelte, Vue or Astro component, MDX,
HTML), an import of that name from a module atlas does not resolve, a module loaded with `import()` or `require()`, a
namespace used whole, a default export, `export * as`, and the files `exclude` leaves out (which are not looked at)
leave it as it is read. So do a `let`, a function `async` or a generator, a parameter read through `arguments` or a rest
parameter (in an iteration's function, anywhere), an element or a function used any other way (passed on, spread,
found with `find`, `call`ed), a key no code reads, and a binding or function no code uses. `homePath()` used only as
`<Route path>` and `<Redirect to>` is therefore no request, and one also used as a form's `action` still is.
`new URL(path, base)` (the global URL) resolves a root-relative path against the base's
origin, with none of its path, so the configured `prefix` is not put before it: against the page's own address
(`location`, its `href` or `origin`, `document.baseURI`, the global `origin`) or the request a Next.js middleware, proxy
or route handler answers (the `url` or `nextUrl` of the first parameter of the function exported as `middleware`,
`proxy`, the default or an HTTP method's name, or given to next-auth's `withAuth` where that is what the file
exports), the path is read as a relative one; against a base the
code spells out, in this file or another, at the host it names, as any absolute URL is; against any other value, whose
host the code does not state, it is not read, and a limit names where. A URL that starts with a value (`` `${API}/orders` ``) may be absolute already and take no base; it is read as
written. The base itself is no request, nor is a URL's
leading constant of another file that names a host other than the target's (`DOCUMENTATION_BASE_URL =
"https://docs.example.com"`), which the limit on other hosts names. Routes come
from Nest decorators, Express-style receivers and registration helpers; their paths are written as OpenAPI templates
(`:id` becomes `{id}`), and an `operationId` in the route options or `@ApiOperation` is kept. A registration whose path
is not a literal (a `const`, a template, an expression; in Python a name or an f-string) registers nothing, and a limit
names its file, line and expression; a Nest path held in a constant is read, as below. A `const` of the file named in `constants` is read as a GET route at its value,
so a GET registered on it at that path gives no limit; another method or a prefix does. For each TypeScript route the handler is
followed through local functions, relative imports and re-exports, and the member methods it calls are kept, except
those called on the handler's own parameters (`res.send()`, `reply.code()`), which belong to the framework, as does the
registration call itself; an
outbound call of the same component held in a method of that name continues the trace. A route file that is also one
of its component's call files does not turn its own registrations into calls. An Express router, `Router()` from `express` (`express.Router()`, a named import, a destructured require), serves
its routes under each literal path it is mounted at with `use` (an inline middleware first is the pathless overload),
nested and imported routers included (also from `module.exports = { router }`), `./r.js` standing for `r.ts`, on a
router or on an `express()` application, created there or imported from a relative module; `use` returns the router,
so a chain (`Router().use(a).use("/b", b)`, `export default Router().use("/api", api)`) is that router with each `use`
a mount on it. An `express()` application mounted with `use` is a sub-application, served under the mount's path; an
application mounted nowhere serves at the root. An @koa/router router (`new Router()` from `@koa/router` or
`koa-router`) serves its routes under its `prefix` (the constructor's option or `prefix()`), under each path it is
nested at with `use(path, r.routes())` (no path is the root) on another router, whose prefix comes before it, or on a
Koa application (`new Koa()`); a prefix set more than once is not read, as @koa/router stacked a second prefix before
version 15.1 and replaces it since. A Hono application (`new Hono()`) serves the routes of another under the path
`route(path, other)` mounts it at, joined to the base path of the instance it is called on, and `basePath(path)` puts
a path before the routes registered through what it returns (Hono's `hono-base.js`). A Fastify plugin, a function
`register` takes in, serves the routes it registers on its first parameter under the `prefix` of each `register` call
(none without one), joined to where the instance it is registered on is served (Fastify's Plugins reference,
`plugin-override.js`), from a `Fastify()` instance; a plugin registered on the first parameter of a function no
`register` takes in, named among the receivers, is placed at the root, as that parameter's routes are read. Routers
are told apart by their bindings, so a shadowing name is another value. Where a mount path or a prefix is not a literal
and `mounts` does not give it (an option object built elsewhere, a computed name that may be `prefix`, a `basePath`
from a variable), or a router is mounted nowhere atlas reads, its routes are not read and a limit says so; a Hono
`basePath` not spelled out takes the path `mounts` declares for its file, and a literal `basePath` called on it adds
to that.

Each router registers routes in the forms its documentation gives, read on a router traced to its package. Every
method it has is a route of that method: Node's HTTP methods on Express and @koa/router (`purge`, `query`; `del` is
`delete` on @koa/router), Fastify's shorthands (`query` and `all` included) and Hono's (`query`, `all`); `all` is any
method (`*`). A registration returns its router, so a chain of them (`router.get(...).post(...)`, after `param`,
`use`, `prefix` or `register`) registers each on that router. Express's `route(path)` registers the methods chained on
it (`app.route("/book").get(h).post(h)`) at its path; Express and @koa/router take an array of paths, each a route.
@koa/router takes a route name before the path where its second argument is a string (`router.get("user",
"/user/:id", h)`), and `redirect(source, destination)` registers `all` at the source. Fastify's full declaration,
`route({ method, url, handler })`, registers each method of `method` (a list too) at `url`, else `path`, constraints
aside. Hono's `on(method, path)` registers each of its methods (a custom one too) at each of its paths, a method given
a handler and no path takes the path the call before it in the chain set (`app.get("/a", h).post(h)`), and a path
without a leading `/` is joined to the base path as one with it (`app.get("*")` is `/**`). @koa/router 15 puts its
prefixes before a path without a leading `/` as text (`Layer._applyPrefix`), which atlas does exactly: the router's own
prefix (the constructor's as written, `prefix()`'s without a final `/`), then up each `use(path, r.routes())` that
nests it the path written there (none written, none put) and that router's prefix, so `router.post("documents.list")`
nested with `use("/", ...)` is `/documents.list`. A route registered with its own handlers runs those, not the ones of
the calls before it in a chain. Where a router is not
traced, only the methods every one of them has, on the receiver itself, are read. A form not read is named in a limit:
a path that does not start with `/` (other than Hono's and @koa/router 15's; an empty one on Hono, which it joins with a
trailing `/`; on @koa/router, one whose joined path has an empty segment, starts with a group or a wildcard, or starts
with no `/`, which no request has), a
method with no path whose path an earlier statement set, a route chained on a receiver not traced, a route on the
instance a `group(path, callback)` hands its callback (Elysia's), which serves under the group's path, an array on a
router that takes none, a `route` option or a redirect source not spelled out.

Each router reads a path in its own syntax, which atlas takes from the package the router is created from, at the
major version the nearest package.json above the file that creates the router gives it (`^5.1.0` gives one; `>=4`, a
tag or a link none): for a Fastify plugin, the file of each `Fastify()` instance it is registered under, ranges that
differ giving none; for a plugin no traced instance takes in, the file that registers the route; for Nest, the
`bootstrap` file where the entry names one, else the controller's.
Express 5 and @koa/router 14 and later compile it with path-to-regexp 8: `{...}` is optional, so `/about{/:section}`
is `/about` and `/about/{section}`; `*name` ending the path is one segment or more (`/files/{name}/**`); in an optional group
it is none or more, `/x{/*name}` taking `/x` and `/x/{*name}` taking `/x/` but not `/x`, both written `/x/{*name}`, as
paths that differ only in a trailing `/` are one route; `:"a name"` is quoted; parameters may share a segment with text
(`/flights/{from}-{to}`, a prefix's `/api/v{version}`). Express 4 writes the path into a regular expression
(path-to-regexp 0.1): `/:id?` is optional and a final `/*` is the rest of the path after its `/`, none included
(`/**`, which takes `/x/` but not `/x`); any other
regular expression is not read. Where no package.json gives Express's version, a path is read where both versions
read it alike, and as Express 4 reads it where Express 5 rejects it, since only Express 4 would start. Nest 11 and later
convert a final `*`, `(.*)` or `+` as their Express adapter does (`abcd/*` is `abcd/{*path}`, `LegacyRouteConverter`)
and hand the path to path-to-regexp 8; earlier Nest is on Express 4, and Nest with `@nestjs/platform-fastify`
installed is read plain. Fastify (find-my-way): `:file(^\d+).png` is `{file}.png`, `:lat-:lng` two parameters, a last
`:id?` optional, `::` a colon, and a final `*` the rest of the path, none included (`/**`, as for Express 4). In a
segment with static text or a regexp, a parameter without its own takes `(.*?)`, empty text too. Hono: `:date{[0-9]+}` is a
parameter, a last `:type?` optional, a `*` segment one segment and a final `/*` the rest of the path (`/**`). The
regexp Fastify or Hono tests a parameter with is kept with the route (`patterns`), as is Spring's `(.*)` for variables
sharing a segment, and a request reaches the route
only where the text it gives the parameter matches it; an interpolated value may. A path its router rejects, one
whose form no path template holds (a wildcard before the end, a Hono regexp that may take a `/`, a segment Hono's
RegExpRouter and TrieRouter read differently), and any syntax beyond `:name` on a receiver not traced to its router,
of an unread version or of another router (Hono's presets, @koa/router before 14) is not read, and a limit names its
file, line, path and why. `express.static` serves the files of a directory and passes on any path it does not hold, so
what it serves is the directory's content: a limit names where it is mounted, and its paths are not read.
@fastify/static (`register(fastifyStatic, { root, prefix })`, the plugin imported under any name, through a
namespace, required or loaded with `import()`, its options in place or in a `const`) registers one route of its own
(index.js, v10): GET and HEAD at its `prefix` (`/` by default, a `/` added unless `prefixAvoidTrailingSlash`) with `*`
after it, under the prefixes of the instance `register` is called on, since fastify-plugin wraps it and the `prefix`
option is its own; with `redirect: true`, where the `/` was added, GET at the prefix as written too. `serve: false`
registers none; `wildcard: false` registers a route per file under `root` as the server starts, which is not read, and
options not spelled out leave its route unread; each says so in a limit. Its routes are `implicit` (`@fastify/static`).
The `next` style reads Next.js route handlers, `app/**/route.ts` exporting `GET`, `POST` and
router or on an `express()` application, created there or imported from a relative module; routers are told apart by their bindings, so a
shadowing name is another value. Where a mount path is not a literal and `mounts` does not give it, its routes are not
read and a limit says so. A FastAPI route on an `APIRouter` is served, as FastAPI documents ("Bigger Applications -
Multiple Files"), at the router's `prefix` joined to its path, under every `include_router` that takes the router in
with that call's `prefix`, under where the router or application it is included into is served; an application
(`FastAPI()`) serves at the root. Routers are followed through nested includes and the imports of the route files
(`items.router` after `from app.api.routes import items`, `utils_router` after `from .utils import router as
utils_router`), and an include under a condition counts. A router whose prefix, or the prefix of an include on its way
to the application, the file does not spell out (`settings.API_V1_STR`, an f-string, a `**` argument that may hold it), and one included nowhere in the
route files, serves nothing atlas can place: its routes are not read, and one limit names the include or the router
and the router files it leaves out. `mounts` gives the path a router file's routers serve their routes under, their own
prefix included, in place of their includes; the routers included into them are read under it. A StaticFiles mount
is served under the prefixes of the application or router it is mounted on. A decorator on a receiver the files bind
to no application or router (a function's parameter, a router made by a factory) is read at the path written, and a
limit says so; a name a function binds (a parameter, or a name its body assigns to anything but `FastAPI()` or
`APIRouter()`) is the function's own, not the file's router, in decorators and includes alike; a decorator on a name
the files bind to an application or router is read whatever the name (`subapi = FastAPI()`, mounted with
`app.mount("/subapi", subapi)`). A Nest controller's routes are served, as Nest documents (docs.nestjs.com/faq/global-prefix,
/techniques/versioning), under the global prefix `setGlobalPrefix` sets, except those an `exclude` entry matches
without the version (a path, or a `{ path, method: RequestMethod.X }`, compiled as path-to-regexp 8 does: `:name`,
`*name` and `{...}`), and with URI versioning (`enableVersioning()` or `type: VersioningType.URI`) after the prefix
`v<version>` (or the `prefix` option's text), the version being the method's `@Version`, else the controller's
`@Controller({ version })`, else `defaultVersion`; a list serves one path per version and `VERSION_NEUTRAL` none. An
excluded route keeps its version. atlas reads those calls in the route files and the component's code (tests and the
other excluded files left out), or in the `bootstrap` file the entry names. Every path, version and exclusion Nest
takes (decorators, `setGlobalPrefix` and its `exclude`, `enableVersioning`, `RouterModule.register`) is read where it is
written in place or held in a constant of any file: a `const` initialized with a literal, a template or a `+` of
such values; an enum member initialized with a literal, or with none: 0 first, else one more than the numeric member before it
(TypeScript's auto-increment, which an ambient enum that is not `const` does not have; `E[0]` maps a numeric enum's
value back to its name); the last own property of that name of an object
literal held `as const` (or in `Object.freeze`, one level deep), where no spread or computed name not read after it may
set it; the elements of a `const` array. A `let`, a parameter, an enum member computed from anything else, an accessor
and what an object inherits (`constructor`) are not read. A name is followed through its imports (aliased, default,
`import * as`) and re-exports (`export { x as y } from`, `export { imported }`, `export * as`, `export *`, which a
module's own export of the name hides; two giving it from different bindings, or one reaching a module not read, give
none), as ECMAScript resolves exports: a relative specifier; else the `paths` (and `baseUrl`) of the nearest
tsconfig.json above the importing file, with what it extends by a relative path, matched as TypeScript does; else a
package the root package.json's `workspaces` or pnpm-workspace.yaml list, at the file Node.js loads: the `exports`
subpath (or its `*` pattern with the longest text before `*`, then the longest key) and the target its conditions
select, which must be one file for an `import` and a `require`, with or without `module-sync` (a subpath not listed or
blocked with null names nothing), else the subpath as a file or `main`. Where that file is a build output not committed,
the package's one TypeScript source whose path mirrors it below their first directories is read in its place
(`dist/types/index.d.ts` and `dist/types.mjs` from `src/types/index.ts`); none or two, and the value is not read. Cycles of imports or constants, and a value built longer than
2048 characters, are left unread; what is not read is named in a limit as above.
Calls that set different values (two applications) leave the controllers' routes unread; a setting not spelled out
agrees with no other. A prefix, version or versioning option
not spelled out leaves the routes it applies to unread, with a limit; an `exclude` entry not spelled out (built with
`.map`, a template) or of other syntax is named in a limit, and the routes it might keep out are read under the
prefix. `RouterModule.register` (from `@nestjs/core`) puts a module's path, after the version and before the
controller's, before the routes of the controllers its `@Module({ controllers })` lists (docs.nestjs.com/recipes/router-module):
an entry's `path` for its `module`, a child entry's joined to its parent's, a module class among `children` its
parent's; `RouterModule` may be imported under any name, the routes, their paths and their children written in place or held in a constant (as above), and modules and controllers are found
through relative imports, else by a class of that name the files declare once. Nest keeps one path per module, so a
module given two is left unread; a path not spelled out leaves the routes it reaches unread, and routes passed to
`register` that are not spelled out leave every controller's, each with a limit. `prefix` states the path every route of the entry is served under: for `nest`, the global prefix, in place of
the one the bootstrap sets (its exclusions and the version still apply); for the other styles, before each path the code
registers. The `next` style reads Next.js route handlers, `app/**/route.ts` exporting `GET`, `POST` and
the like (declared, re-exported by name, or re-exported with `export *`), with `app/` at the component's directory or
under its `src/`: route groups and slots add no segment, private folders and intercepting routes are not served, `[id]`
is `{id}`, `[...rest]` is `{rest}/**` (one segment or more) and `[[...rest]]` is `{*rest}` (none or more). Next.js
answers HEAD with the GET handler when the file exports GET and no HEAD, and OPTIONS by itself when it exports no
OPTIONS; those surfaces are `implicit`,
reached only by a request that names the method, and no rule expects a caller for them. Metadata routes are read where
Next.js fixes their paths: `robots.ts` at the root of `app/` serves `GET /robots.txt`, `manifest.ts` there `GET
/manifest.webmanifest`, and `sitemap.ts` in any segment `GET <segment>/sitemap.xml` (`<segment>/sitemap/{id}.xml` when
it exports `generateSitemaps`, which the request runs too, to find the id asked for), each with the HEAD and OPTIONS
Next.js answers. All three are `implicit`: crawlers
fetch `/robots.txt` by RFC 9309 and the sitemaps it names, browsers the manifest Next.js links from every page's head,
and no code of the app requests them, so no rule expects a caller; a call that fetches one still reaches it. An `icon`, `apple-icon`,
`opengraph-image` or `twitter-image` route written as code (`icon.tsx`) is served at a path Next.js generates, so it is
not read and a limit names it.
Files Next.js serves with no handler of the app's are `implicit` surfaces, listed whatever the route `files` say (an
`exclude` leaves them out): every file under `public/` at the component's directory, at its path from the root as a
request holds it (what the URL Standard percent-encodes in a path, and `%`, percent-encoded: `a b.pdf` is `a%20b.pdf`),
answering GET and HEAD; and `favicon.ico`, `robots.txt`, `manifest.json`, `manifest.webmanifest` at the root of `app/`,
`sitemap.xml` in any segment, and the images written as files in any segment (`icon` as `.ico`, `.jpg`, `.jpeg`, `.png`
or `.svg`, `apple-icon` as `.jpg`, `.jpeg` or `.png`, `opengraph-image` and `twitter-image` as `.jpg`, `.jpeg`, `.png` or
`.gif`, each numbered too, `icon1.png`), at their names in their segment, answering GET, HEAD and OPTIONS through the
route handler Next.js makes of them; in a folder under a route group or a slot an image's name takes the suffix Next.js
computes from the folders (`-` and six base-36 digits of the djb2 hash of `/(group)/folder`,
lib/metadata/get-metadata-route.ts). `next start` serves two routes of its own as well, under the configuration's
`basePath`, where the component's package.json names `next` or it has a `next.config.*`: the build's files at
`/_next/static/{file}/**`, to GET and HEAD, and the image optimizer `next/image` requests at `/_next/image`, to any
method, which it answers only with the default image loader, without `images.unoptimized` and without `output: "export"`
(next-server.ts, `handleNextImageRequest`); a configuration not read (a plugin's wrapper, a value not spelled out)
leaves the routes it decides unread, with a limit. All of these are `implicit`, with a `convention` naming the rule
(`next public`, `next metadata file`, `next build assets`, `next image optimizer`). A request whose method is not read reaches such a file's GET; no rule expects a caller for one. A path ending
in an extension of a file kept in repositories (`.png`, `.svg`, `.json`, `.txt`, `.xml`, `.css`, `.log` and the like) is no call
in any language, being a file path far more often than a request, so a request for such a file is not read. As Next.js does, a
request is matched to the most specific route path first (a public file or a static name, then `[x]`, then
catch-alls), and a method that route lacks matches nothing else; a request with a value in its path (`/editor/${id}`)
reaches each path down to the first that takes every value (`/editor/new` and `/editor/{id}`, not `/{slug}/**`), less
a path whose every request it shares with the call a more specific path takes (`/${section}/new` reaches `/editor/new`
and `/{section}/new`, not `/editor/{id}`). API routes under `pages/api` answer every method from their default export, written or
re-exported, and their folders are plain segments. Pages (`app/**/page.tsx`, and Pages Router pages outside
`pages/api`) are routes at their paths, with the methods Next.js answers them with (server/base-server.ts): a page it
prerenders at build answers GET, and HEAD by itself, and any other method with 405; a page it renders on each request
answers any method (`*`). Under the Pages Router a page with `getServerSideProps`, or with `getInitialProps` (its own,
or a custom `_app`'s for a page without `getStaticProps`), renders on each request; any other is prerendered (as HTML,
or by `getStaticProps`). Under the App Router a page under a dynamic segment (`[id]`, `[...rest]`, `[[...rest]]`) is
never prerendered as a route, whatever `generateStaticParams` gives, so it answers any method; so does a page where it
or a layout above it exports `dynamic = "force-dynamic"`, or `revalidate = 0` with no `dynamic = "force-static"` from
the root down to it (create-component-tree.tsx), and one where what renders it (the page, its layouts and templates,
`generateMetadata`, and what they run, as below) calls a request-time API: `cookies()` or `headers()` from
`next/headers`, `connection()` from `next/server`, `unstable_noStore()` from `next/cache`, under any name they are
imported by, or a `fetch` with `cache: "no-store"` or `"no-cache"` or `next: { revalidate: 0 }` (not where the two
disagree, `no-store` with a revalidate above 0 or false, or `force-cache` with 0, which Next.js unsets), or where the
page reads its `searchParams` (awaits them, reads a property of them or hands them to `use`, from its props
destructured or `props.searchParams`, directly or through a `const`; taking the value alone reads nothing). A page
under `dynamic = "force-static"` is prerendered whatever it calls, request-time APIs answering as for no request; one
under `dynamic = "error"` is prerendered where the build succeeds, which it does not where the page reads the
request; and every page of an app built with `output: "export"` is prerendered. Every page
of one path counts, the slots a layout renders beside it included. A request-time API called in code atlas does not
follow (a package, a module imported by another path than a relative one) or `searchParams` handed on whole are not
seen, so the App Router pages read as prerendered without `force-static` are named in one limit; a segment config
not spelled out is named in a limit too, and the page read as prerendered. Under `cacheComponents` or partial
prerendering Next.js prerenders a shell even of a page that reads the request; a configuration that turns them on, or
may (one not read, or a value not spelled out, from Next.js 14 on), or that may build a static export (`output` not
spelled out), is named in a limit and the pages are read as if it did not. A Server Action
posts to the page it is called from, and Next.js passes such a POST to any App Router page
(`getIsPossibleServerAction`): a prerendered page whose module graph (the page, its layouts and templates, and what
they import, through relative imports, tsconfig `paths` and the workspace's packages, client modules included; not an
import or re-export whose every name is a type, which TypeScript erases) holds
a Server Action (a module marked `"use server"`, or a function whose body starts with it) answers POST too, an
`implicit` surface (`next server action`) Next.js's own client requests. What the server runs while it renders
the default export (a function component, also one named by `export { Page as default }` or re-exported from another
module, or a class component's `render`, its own or one it inherits from a class of the file or a relative import) belongs to the page's request, prop values and what computes a handler or an
address included; client modules (`"use client"`), addresses (`href`, `src`, `srcSet`, `poster`, `action`), event handlers (`onClick`) and functions
passed as props do not: a `<Link href>`, an `<a href>` or an address Next.js's router navigates to (`push` or `replace`, also
`useRouter().push`; also parenthesized or with `as const`, and either branch of a conditional) is a GET, and a
`redirect` from `next/navigation` keeps the method of the request it answers (`*`); each reaches
the page it names as a request of its own. An App Router page renders inside the `layout` and `template` of its folder
and of each folder above it up to `app/`, so what they run while rendering belongs to its request too. The addresses
the links and forms of that server-rendered tree hold (the `href` of `<a>`, `<area>` and Next.js's `<Link>`, the
`action` of `<form>` and Next.js's `<Form>`, the `formAction` of `<button>` and `<input>`; written as a literal, as the
value a comma expression ends in, in a conditional's branches or in a `const` they name, through further `const`s) are what the page offers next (`via view <file>`), as a Spring
template's are: they start chains of their own, which the page's chain lists as `next`. A client module's links, a prop
of another component (what it renders from it is not read), a `<link>`, a Pages Router `_app` and what `notFound()` or an error renders are not read for it. Include `.tsx` in the route
files to read them. The `matcher` of the `config` a `middleware` or `proxy` file exports names the paths it runs on,
not requests. Other languages are read as text: Kotlin templates (`$x`, `${x}`),
`useRouter().push`; also parenthesized or with `as const`) is a GET, and a `redirect` from `next/navigation` keeps the
method of the request it answers (`*`); each reaches
the page it names as a request of its own. Include `.tsx` in the route
files to read them. `inventory` offers the `next` style for a file only where the nearest `package.json` above it
depends on `next`, or none is found. Other languages are read as text: Kotlin templates (`$x`, `${x}`),
format strings (`%s`, `%d`) and `{x}` become wildcards, as does every replacement field of a Python f-string; the
method is the one the client library sets through its own API (below) and the scope comes from the last `fun`, `func`
or `def` before it. A path given to an exception is a label, not a request: an argument
of a call that is thrown (`throw BffUnavailable("/my")`, `throw new X(...)`, Python's `raise X(...)`), of a class named
as Java's, Kotlin's, Dart's and Python's own exceptions are (`Exception("/x")`, `IllegalStateException("/x")`,
`SomeError("/x")`), and in
Kotlin of the standard library's throwing functions `error`, `TODO`, `require` and `check` (not a member of that name);
a request written inside those parentheses (`throw ApiFailure(http.get("/x").status)`) is still read, and a limit names
the exceptions such paths went to. Log and print calls are read as before: their names come from libraries, not the
language. A string written directly in the parentheses of a method of strings, in the file's language, that tests or
cuts text, called on a receiver, is no request either: Java's, Kotlin's and the JVM's (`startsWith`, `contains`,
`replace`, `removePrefix`, `substringBefore`...), Dart's (`endsWith`, `replaceFirst`, `replaceAll`, `contains`...; not
`Uri.replace`, which builds a URL), Python's (`startswith`, `removeprefix`, `find`, `replace`...), C#'s (`StartsWith`,
`Replace`...), Swift's (`hasPrefix`, `replacingOccurrences`...) and those of Go's `strings` package called on
`strings`; type arguments (`helper<T, U>(`) and a keyword's parentheses (`if (...)`) are no call's. Nor, in Dart, a
text property of
Flutter's `InputDecoration` (`labelText`, `hintText`, `helperText`, `prefixText`, `suffixText`, `counterText`,
`errorText`, `semanticCounterText`); nor, in C#, the first argument of ASP.NET Core's `Map`, `MapGet`, `MapPost`,
`MapPut`, `MapDelete`, `MapPatch`, `MapMethods`, `MapGroup`, `MapFallback`, `MapHub`, `MapHealthChecks` and
`MapBlazorHub` or of YARP's `MapForwarder` (a route pattern the application serves; the forwarder's `targetPath`, the
path it sends its requests to, is read), the path `UseExceptionHandler` and `UseStatusCodePagesWithReExecute`
re-execute a request at inside the application (each by position, or by its parameter's name where the argument is
named: `pattern`, `prefix` for `MapGroup`, `path` for `MapBlazorHub`, `errorHandlingPath`, `pathFormat`), or an
argument of `MapFallbackToFile` and `MapFallbackToPage`. FastAPI
decorators, and `add_api_route(path, endpoint, methods=...)` (GET where `methods` is not given or None), are read from Python, with Starlette's converters (`{name:path}` is kept as written and takes any text,
none included, after the `/` written before it, so `/x/{name:path}` matches `/x/` and `/x/a/b`; a request without
that `/` (`/x`) gets there only by the redirect Starlette answers when no route, of any method, surely matches it,
unlike `{*name}`, which matches `/x` itself; a call's trailing `/` is kept beside its path and matched as each router
treats it (see "Which route a request reaches"). `{id:int}`, `{id:float}` and `{id:uuid}` are kept as written and take one segment their regex takes; `{id:str}` is
`{id}`; a convertor registered elsewhere is not read, so its segment may take anything; a `path` converter before a
suffix is not matched, so that route is left out with a limit), and `app.mount("/x", StaticFiles(...))` serves GET
(and an implicit HEAD) at `/x/{path:path}`, as Starlette compiles a mount; another mounted application
is not read, and a limit says so. `app.frontend("/", directory=...)` serves the files a frontend build put in a
directory, and a fallback page for GET and HEAD, wherever no route matches: which paths answer depends on the build,
so they are not read and a limit names the call. The `spring` style reads `@RequestMapping` on a class as a prefix for the
(and an implicit HEAD) at `/x/{path:path}`, as Starlette compiles a mount; an application or router of the route files
that it mounts serves the routes read there under `/x`, as an include would; another mounted application is not read,
and a limit says so. Each application (`FastAPI()`) serves routes of its own, which it adds as it is made, before any
route of the code (fastapi/applications.py, `setup`): GET, and the HEAD Starlette adds, at `openapi_url`
(`/openapi.json`), and where that is set, at `docs_url` (`/docs`) with `swagger_ui_oauth2_redirect_url`
(`/docs/oauth2-redirect`) and at `redoc_url` (`/redoc`), under where the application is served (a mounted one under its
mount). `None` or `""` turns one off; a value the file does not spell out as a path (an f-string, a name, a `**`
argument) leaves them all unread, with a limit. They are `implicit`, with the setting as their `convention` and the
`FastAPI(` line as their place; where a route of the code has the same path, on the application or a router it includes
from any file, FastAPI's answers and is the surface kept. A setting counts only where its route is served:
`docs_url` and the others not at all where `openapi_url` is off, the redirect not where `docs_url` is.
The `flask` style reads Flask, and Quart, which takes Flask's application, blueprints and views and Werkzeug's routing
(quart/app.py, quart/routing.py), from Python, as Flask 3.1 and Werkzeug 3.1 register and match routes (the version
the project depends on is not read; Werkzeug has matched by the rules below since 2.2, Flask's
`PROVIDE_AUTOMATIC_OPTIONS` is 3.1's): `@app.route(rule, methods=[...])` (GET where `methods` is not given), its
shortcuts `get`, `post`, `put`, `delete` and `patch`, and `add_url_rule(rule, endpoint, view_func)`, on an application
(`Flask(...)`, `Quart(...)`, made at the top of a file or in an application factory) or a `Blueprint(...)`, each known
by any name it is imported under and followed through the imports of the route files. A rule's methods are those
given, else its view's: those a `MethodView` defines (`get`, `post` and the others, its bases' included), or the
`methods` a `View` lists; Werkzeug adds HEAD beside GET, and Flask OPTIONS unless the methods,
`provide_automatic_options` or the view's say otherwise (`App.add_url_rule`); both are `implicit`. A blueprint's rules
are served under the `url_prefix` of each of its registrations (`register_blueprint`'s, else the blueprint's own), a
nested blueprint's joined after its parent's, and a blueprint registered twice serves its rules under both; prefixes
and rules are joined as text, as `BlueprintSetupState.add_url_rule` joins them, so `url_prefix="/admin"` and
`@admin.route("/")` serve `/admin/`. A rule's text is read as Werkzeug parses it: `<name>` takes one segment;
`<int:id>`, `<float:x>`, `<uuid:id>`, `<any(a, b):x>` and `<string(length=2):x>` take what their converter's regex
takes, kept as the parameter's pattern (with `signed=True`, and an unsigned `int`'s `fixed_digits`; `min` and `max`,
which check the value, leave the route unread); `<path:rest>` at the end is the rest of the path (`/{rest}/**`); and a
converter the files register on the `url_map` of the application that serves the rule (`app.url_map.converters["list"]
= ListConverter`, a `BaseConverter` whose body sets no regex with a `/`) is kept as `{names:list}`, whose values are
not read. The static files route, `<static_url_path>/<path:filename>` (`/static/<path:filename>` unless
`static_url_path` or `static_folder` say otherwise), of each application, and of each blueprint with a `static_folder`
under its registrations, serves GET, HEAD and OPTIONS; it is `implicit`, with `flask static` (`quart static`) as its
`convention` and the `Flask(` or `Blueprint(` line as its place, and `static_folder=None` turns it off. `mounts` gives
the path a blueprint's file serves its rules under, its own `url_prefix` included, in place of its registrations. Not
read, each with a limit: a rule, `methods`, `url_prefix` or static setting the file does not spell out, `*`/`**`
options, a view whose methods are not read (a class with a base atlas does not trace, a function the code gives
`methods`), a `subdomain` or a `host`, a rule Werkzeug answers with a redirect (`redirect_to`, `alias=True`) or whose
`//` it keeps (`merge_slashes`), an application with `host_matching`, a receiver the files bind to no application or
blueprint (a function's parameter), a blueprint registered nowhere, into itself or under more than 64 prefixes, a
`path` variable before the end of the rule or after text in its segment, a converter whose segments or values atlas
does not read, the OPTIONS of every rule where the files name `PROVIDE_AUTOMATIC_OPTIONS`, and Quart's WebSocket
routes, which answer only a WebSocket handshake. Each application's own `url_map.strict_slashes`, `merge_slashes` and
converters count for its rules; one set on a `url_map` atlas does not trace to an application counts for every one,
and a converter registered there leaves the rules that name it unread. Werkzeug redirects a request to a rule whose
values equal the `defaults` of another rule of the same endpoint with the same arguments to that rule
(`redirect_defaults`), in whichever order they were registered, since `Map.update` sorts an endpoint's rules with more
defaults first: a limit names each such pair, as the request is matched to the rule it fits all the same.
The `django` style reads Django's URLconfs, and Django REST framework's routers and views, from Python, as Django 6.1
and DRF 3.18 build and dispatch them (the version the project depends on is not read). The root URLconf is the module
`ROOT_URLCONF` names, read from each settings module among the route files: a file that sets it, itself or through a
`from x import *` of one that does; a setting (`DEBUG`, `MIDDLEWARE`, `APPEND_SLASH`, `MEDIA_URL`, `STATIC_URL`) is read
where every settings module gives it the same literal value, and Django's default where none sets it. A URLconf's
`urlpatterns` is read from its top-level statements in order (`=`, `+=`, `+`, `append`, `extend`, `insert`, and `if
settings.DEBUG:` and its `else`); a statement under another condition (`if`, `try`, `for`) leaves what it adds unread,
with a limit. Each `path(route, view)` and `re_path(regex, view)` is a pattern, and `include()` of a module named by a
string or imported, a list of patterns, a `(patterns, app_name)` pair or a router's `urls` serves the patterns it names
under its own, joined as `URLResolver.resolve` matches them, each its part of the path in turn; the same URLconf included
twice serves its patterns under both, and one included within itself is read once, with a limit. A `path()` route is
read as `_route_to_regex` reads it: its text as written, and `<name>` or `<converter:name>` a parameter whose regex is
its converter's (`str` any one segment; `int`, `slug` and `uuid` the segments their regex takes, kept as the parameter's
pattern; `path` at the end the rest of the path, `{name}/**`), or that of a converter `register_converter` registers in the route files where the call runs
as the module is imported (at its top level, or under `if settings.DEBUG:`), whose `regex` its class or a base sets; one whose `to_python` may refuse a value (anything but returning it, `str()` of it,
or `int()` of digits), which makes Django try the next pattern, is kept as `{name:converter}`, whose values are not
read. A `re_path()` regex is read where its shape is certain: it starts with `^` (Django searches any other anywhere in
the path), a view's ends with `$` or `\Z` (any other takes any text after it) and an include's does not; outside a
group it holds text, an optional character, and optional or alternative non-capturing groups, each form a path of the
route; each capturing group is a parameter whose regex is its pattern (an unnamed one `{_0}`, `{_1}`, ...); `.+` and
`.*` at the end take the rest of the path (`.*` also `media/`, not `media`); an optional `/` at the end makes the route
take the path with and without it. Anything else is not read, with a limit: a class, `.`, a repeat or a `|` outside a
group, a group that takes some slashes but not any text, one that may take an empty segment, or one at the end of an
include's pattern whose next text it may take (the included patterns match what it leaves). Python's `\d` and `\w` also take the digits and letters of
other scripts; atlas tests ASCII ones, as JavaScript reads them. A view's methods are its own: a function's any (`*`)
unless its decorators say otherwise (`require_http_methods([...])`, compared with the method as written, `require_GET`,
`require_POST`, `require_safe`, DRF's `@api_view([...])`, GET where none is given, with the OPTIONS APIView answers);
Django's and DRF's decorators that check a user, a token or a cache leave them as they are, and any other decorator
leaves the route unread, with a limit. A view that takes no method still takes its pattern's requests, which it
answers with 405: no route is read for it, and a later pattern whose every request it takes is left out, with a
limit. A class's `as_view()` takes each of its `http_method_names` (View's eight, its
own or a base's list, or the one `as_view` is given) it has a handler for along its method resolution order, its bases
in the files and Django's and DRF's generic views (`TemplateView` GET, `RedirectView` every method, `FormView`,
`CreateView` and `UpdateView` GET, POST and PUT, `DeleteView` GET, POST and DELETE, `LoginView`, `LogoutView` POST
only, `APIView`, DRF's generic views and their mixins), and HEAD where it has GET (`View.setup`); HEAD and the OPTIONS
`View` answers are `implicit`; `method_decorator(require_POST, name="dispatch")` limits them. A ViewSet's `as_view(actions)`
takes the methods its actions map. DRF's `SimpleRouter` and `DefaultRouter` (`trailing_slash`, `use_regex_path`, and a
`trailing_slash` set on the router after) serve, for each ViewSet registered on them in the same file, in order, the
list route (`list` GET, `create` POST), each `@action(detail=False)`, the detail route (`retrieve` GET, `update` PUT,
`partial_update` PATCH, `destroy` DELETE) and each `@action(detail=True)` (by name, its `url_path` and `methods`, and
`@<action>.mapping.<method>`), each where the ViewSet has an action it maps (its own methods, its bases' and DRF's
mixins'), at `<prefix>/<lookup>/`, the lookup `lookup_url_kwarg` or `lookup_field` (`pk`) taking
`lookup_value_regex` (`[^/.]+`) or, without regexes, `lookup_value_converter`; a DefaultRouter adds its API root view
(GET) and, as `format_suffix_patterns` does, each pattern again with `.<format>` after it. `static(settings.MEDIA_URL,
...)` serves the files under its prefix while `DEBUG` is `True`, as `staticfiles_urlpatterns()` does under
`STATIC_URL`. DRF's `rest_framework.urls` and Django's `django.contrib.auth.urls` are read as Django and DRF write
them, their routes placed at the `include()`. `mounts` gives the path a URLconf file is served under, in place of where
it is included. Not read, each with a limit: the admin site's patterns (`admin.site.urls`: which models they serve
depends on every installed app's admin module, most of a model's pages take `<path:object_id>` before more segments,
and its views' methods depend on the signed-in user), `i18n_patterns`, another library's patterns (`api.urls` of
Django Ninja), a URLconf that is not among the files read, a route, view or include the file does not spell out, a
view of another module's (but `django.views.static.serve`), a class with a base atlas does not trace, a router
registered on in another file or whose registry is changed, more than 10000 patterns or URLconfs more than 32 deep,
and, where no settings module among the route files sets `ROOT_URLCONF`, every route (declare a URLconf in `mounts`).
The `go` style reads Go services on Gin (`github.com/gin-gonic/gin`, routergroup.go), chi (`github.com/go-chi/chi/v5`,
mux.go) and net/http's ServeMux, each router told by the package it is made from, under any name that package is
imported as: a Gin engine (`gin.New()`, `gin.Default()`) and its groups (`Group(path)`, nested, each path joined to
its parent's by Gin's `joinPaths`, which cleans it and keeps a `/` the route ends with), with `GET` and the other method
functions, `Handle`, `Any` (any method), `Match`, and `Static`, `StaticFS` and `StaticFile`, which serve files with GET
and HEAD at the path (`<path>/*filepath` for a directory) and are `implicit`, with `gin static` as their convention;
a chi router (`chi.NewRouter()`), with its method functions, `Method` and `MethodFunc` (a method `chi.RegisterMethod`
adds in a file read included), `Handle` and `HandleFunc` (any method, or the method a `GET /path` pattern starts with),
`Group` and `With` (the same router), `Route` (a router mounted at the pattern) and `Mount` (a chi router under the
pattern, any other handler for any method at the pattern and everything under it); a ServeMux (`http.NewServeMux()`,
or the `DefaultServeMux` of `http.Handle` and `http.HandleFunc`), its patterns read as Go 1.22 parses them, `[METHOD
][HOST]/[PATH]` with `{name}`, a last `{name...}` or `/` that takes the rest, and `{$}`; GET also serves HEAD
(`implicit`); a ServeMux serves a router under a subtree where `http.StripPrefix` removes the subtree's path, and at
the root where its pattern is `/`. A ServeMux's patterns are read as the Go of the nearest go.mod above the file reads
them: a `go` line before 1.22, none, or `godebug httpmuxgo121=1` (there, or in a `//go:debug` line of a main package of the module) gives Go 1.21's
mux, whose patterns are paths (a method, host or `{` in one is left out with a limit). A file served by
`http.FileServer` is `implicit`, with `net/http FileServer` as its convention. A chi parameter's regexp
(`{id:[0-9]+}`) is kept in `patterns` as chi tests it, `^` and `$` added as text where missing; one in RE2's own syntax
(`\pL`, flags, POSIX classes) leaves its route unread. Routers are followed through variables, blocks and closures,
struct fields and methods (embedded fields too; a struct value copied where Go copies it, a pointer shared),
constants, a `range` over a literal list of strings, and the calls
between the functions of the route files' packages (across packages of the module the go.mod names), each function
read for each call that reaches it, from the functions no code read calls; a router nothing read mounts is served at
the root. `mounts` gives the path the routers a file makes, and the router parameters of its functions that no call
read binds, are served under, in place of their mounts. Not read, each with a limit: a path, method or pattern the
file does not spell out, a group or mount at such a path, a wildcard Gin refuses or within a segment, a registration
on a value atlas does not trace to a router (a parameter no read call passes one, a router or field a branch or loop
may replace, a field no read code sets, a router a function returns from more than one place), a router put in a value
atlas does not follow (a map, a slice, an index, another package's struct other than `http.Server`) or handed to a
registration on a value atlas does not trace, a package-level
variable that a function other than `init` assigns, read in a function no read code calls (another package may have
assigned it first), a router handed to a library function whose result the code drops, a recursive call, calls more
than 32 deep or 20000 in all, a router mounted into itself or at more than 64 paths, `gin.New` options that are not
function literals, `RedirectTrailingSlash` set in a branch or loop, a ServeMux pattern with a host, one Go refuses or one that conflicts with one registered
before it, a router a ServeMux or chi serves without the path stripped (it sees the whole path; it is not read at the
root either), and chi's `middleware.StripSlashes`, `RedirectSlashes`,
`URLFormat`, `StripPrefix` and `PathRewrite`, which route a request by another path than it names (chi's
`middleware.GetHead`, used on a router, makes its GET routes serve HEAD as well, `implicit`, where no HEAD route or
route for any method takes the path). Other Go routers (Echo,
Fiber, gorilla/mux and the rest) are not read.
The `spring` style reads `@RequestMapping` on a class as a prefix for the
`@GetMapping`, `@PostMapping`, `@PutMapping`, `@DeleteMapping`, `@PatchMapping` and `@RequestMapping` methods under
it, in Java and Kotlin (paths joined, methods united as Spring does), and the POST endpoints Spring Security's
`formLogin` and `logout` serve, in the lambda or the chained form. Spring Boot 3 and 4 serve routes of their own in an
application whose own build file (`pom.xml` `project/dependencies`, or a Gradle `dependencies` block, in a runtime
configuration) brings in a web starter (`spring-boot-starter-web`, `-webmvc` or `-webflux`; Spring MVC where both),
with the version from the nearest build file at or above it, as their auto-configuration does: Spring MVC's error page
(`BasicErrorController`), for any method, at `spring.web.error.path` (Spring Boot 4) or `server.error.path` (3), else
`error.path`, else `/error`, none where the code has an `ErrorController` of its own; the static resources, to GET and
HEAD: Spring Boot maps `spring.mvc.static-path-pattern` (`spring.webflux.` under WebFlux), `/**` by default, and
answers 404 for a path no resource is at, so each file of the module's static locations is a route at its path under
the pattern (written as a request holds it, as a Next.js public file is): `spring.web.resources.static-locations`, by
default `classpath:/META-INF/resources/`, `/resources/`, `/static/` and `/public/`, a `classpath:` location read as
`src/main/resources/` and any other (`file:`, a placeholder) named in a limit; the files a dependency's jar holds under
those locations, and a war's `src/main/webapp` (named in a limit), are not read; the WebJars at
`spring.mvc.webjars-path-pattern`, `/webjars/**`, only where the build brings in a WebJars dependency (`org.webjars`
and its groups); none of these where `spring.web.resources.add-mappings` is false or the code takes the web
configuration over (`@EnableWebMvc`, `WebMvcConfigurationSupport`, and WebFlux's); and with
`spring-boot-starter-actuator`, the discovery page at `management.endpoints.web.base-path` (`/actuator`), none where
`management.endpoints.web.discovery.enabled` is false or the base path is empty or `/`, and the health endpoint at
`<base>/health` and `<base>/health/**`, to GET, where the exposure (`management.endpoints.web.exposure.include`,
`health` alone by default, and `exclude`) and its access let it (`management.endpoint.health.access` and
`management.endpoints.access.default`, capped by `access.max-permitted`, from Spring Boot 3.4, and the `enabled`
switches before and beside them); any other endpoint exposed exists where the classpath and the code give it, and a
limit names it.
Settings are read from `application.properties` and `application.yml` as for springdoc (`references/openapi.md`). A
context path, a servlet path or a WebFlux base path, auto-configuration excluded, the actuator on its own port, another
Spring Boot version, a `spring.main.web-application-type` whose starter the build lacks, a setting a profile gives or
one with a placeholder (an exclusion included) leave the routes they decide unread, with a limit, as does an
application the configuration splits into several components, whose routes none of them serves alone.
They are `implicit`, with a `convention` (`spring-boot error`, `spring-boot static resources`, `spring-boot webjars`,
`spring-boot actuator`, `spring-boot actuator health`) and the setting or dependency that brings each in as their
place: a static resource's is its file.
A handler type's routes are served under the
prefix `PathMatchConfigurer.addPathPrefix(prefix, predicate)` gives the types its predicate accepts, the first that
accepts in a configurer's order (docs.spring.io/spring-framework/reference/web/webmvc/mvc-config/path-matching.html).
The prefix is a literal or a constant of the file (one with a `${...}` placeholder is resolved at run time and not
read); the predicate is read where it is `HandlerTypePredicate.forAnnotation(A.class, ...)` (an annotation written on
the type or present through the annotations of its annotations: those the files declare for an `@interface`, and
those Spring (stereotype, web, validation, transaction, security), springdoc and Swagger 2, springfox, Lombok,
Jakarta/javax Validation and Annotations and the JDK declare for their own, which most do not carry, taken by the
qualified name the file names them by (an import, a wildcard import, a qualified use); a type that names a supertype,
or carries an annotation not so resolved, may take one through it and is not decided), `forBasePackage("p", ...)` (the type's qualified name starting with
`p.`) or a lambda testing `isAnnotationPresent(A.class)` (Kotlin's trailing lambda included). Any other predicate, a
prefix not spelled out, a mapping in an interface (whose implementing class decides) and two configurers (two
`configurePathMatch` methods, in one file or two) that disagree leave the routes of the types they may reach unread,
with a limit. Configurers and annotation types are read in the entry's files and the component's code, the excluded
files left out, since a `WebMvcConfigurer` need not be among the controller globs. A controller (`@Controller`,
`@RestController`) that implements an interface with `@HttpExchange` mappings (`@GetExchange`, `@PostExchange`,
`@PutExchange`, `@PatchExchange`, `@DeleteExchange`, `@HttpExchange(url, method)`) is served at them, under its own
prefix, unless it maps a method that overrides it (the same name and parameter types). An interface nested in another
type is named through it (`Outer.Contract`). Spring takes one type-level mapping for the class, the first its type
hierarchy holds: its own `@RequestMapping`, else the `@HttpExchange` of the first interface it lists that carries one,
which the class's own handler methods are served under too. A handler method registered with
`registerMapping(info, handler, method)` is served at the paths and methods of the `RequestMappingInfo.paths(...)
.methods(...).build()` it is given (the last `methods` call sets them; none listed is any method), in place or in a local, as given: no `addPathPrefix` prefix applies to it. Router
functions (WebMvc.fn and WebFlux.fn) a `@Bean` method returns are served at the root, without that prefix too: the
builder of `RouterFunctions.route()` (`GET(pattern, handler)` and the other methods, with a predicate or none,
`route`, `add`, `nest`, `path`, `resources`, `resource`), the static `route`, `nest`, `resources` and `resource` with
`and`, `andRoute`, `andNest`, and Kotlin's `router { }` and `coRouter { }` (`"/x".nest { }`, `"/x" { }`, a method with
a trailing handler). A predicate is read as the methods and paths it takes: `GET(pattern)` and the others, `path`,
`method`, `methods` and `all()`, joined with `and` and `or`; `accept`, `contentType`, `headers`, `param`, `queryParam`
and `version` leave both as they are. A nested route's pattern is joined after its nest's, a route with no pattern of
its own takes any rest of the path within its nest (`/teams/**`), and `resources("/files/**", location)` serves GET
and HEAD at one segment or more under `/files` (`/files/{path}/**`), never the location itself. A local (`final`, `val`, or
never assigned again) or a helper method of the file with no parameters is followed, as is another `@Bean` composed
under a nest or a method predicate, which serves there too; a Kotlin bean with no declared type is a router function
where its expression is the DSL or one `RouterFunctions` builds. Alternatives of a nest that leave the same path and
methods are one; past 20000 nested contexts and statements, or 4096 routes, in a file, the rest is not read, with a
limit; a predicate or router function not spelled out, a lookup function,
`pathExtension`, a statement of control flow in the DSL and a router function built outside a `@Bean` method are
named in a limit and not read. A mapping path may be a string constant the file
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
that made the request sends next (a chain's `next`, `via redirect`), from a GET or POST route (a HEAD from a HEAD
route, which a GET mapping serves when no HEAD mapping fits; after another method the client may keep it, so its method
is `*`); a Kotlin expression body's whole result is read, each branch of an `if` or `when` apart; the current request's URI variables (`{id}`) and any value appended in
code are values, a relative URL is resolved against the route's path, and one starting with a value is named in a
limit. A route source's
`openapi` document adds every operation it declares, whatever the language; see `references/openapi.md`.

The `aspnetcore` style reads ASP.NET Core in C#, from a lexer that keeps comments, preprocessor lines and every string
form (verbatim, raw, interpolated, UTF-8) out of the code. It follows what the program's top-level statements, a static
`Main` and the `Configure` methods of a `UseStartup<T>()` class map on the application (`WebApplication.CreateBuilder`
and its kind, `Build()`, `WebApplication.Create`, an `IApplicationBuilder` or `WebApplication` parameter of
`Configure`, a parameter of `UseEndpoints`' lambda), through locals, the groups `MapGroup` makes (nested, their prefixes
joined), the conventions that return the builder they are called on (`RequireAuthorization`, `WithTags`, Asp.Versioning's
`HasApiVersion`, its `NewVersionedApi`, a group with no prefix) and the extension and static methods of the files it
passes a builder to, each call with its own (`MapTodos(this RouteGroupBuilder group)` called on two groups maps its routes
under both). `MapGet`, `MapPost`, `MapPut`, `MapDelete` and `MapPatch` register their method, `MapMethods` the methods of
an array, list or collection expression (`HttpMethods.Get` included), `Map` any method, and `MapFallback`,
`MapFallbackToFile` and `MapFallbackToController` any method at `{*path:nonfile}` or the pattern given, last of all
(`Order` int.MaxValue). A path is a string literal, a constant of the file or another (`Paths.Api`), `nameof`, or `+`
and interpolation of those. Controllers are read where `MapControllers`, `MapControllerRoute`,
`MapDefaultControllerRoute` or `MapAreaControllerRoute` maps them, under that builder's prefix: public classes, not
nested, abstract or generic, without `[NonController]`, named `...Controller` or deriving from `Controller`,
`ControllerBase` or a class of the files that does (whose route attributes, area and actions they inherit); their
actions are the methods `DefaultApplicationModelProvider.IsAction` takes: public methods, not static, abstract, generic,
an explicit interface implementation, `[NonAction]` (on the method or one it overrides), an override of `System.Object`'s
`ToString`, `Equals` or `GetHashCode`, or the `Dispose()` of `IDisposable` (which `Controller` implements); property
accessors, operators and constructors are no methods there. An action is named by `[ActionName]` (on it or a method it
overrides) or by the method without `Async`; overloads are told apart by their parameter types. `[Route]`, `[HttpGet]` and the other method attributes and `[AcceptVerbs(..., Route = ...)]` give the
routes as `DefaultApplicationModelProvider` builds selectors: each attribute with a template, an `Order` or a `Name` one
route, a template starting with `/` or `~/` replacing the controller's, the others joined to each controller route,
`[controller]`, `[action]` and `[area]` replaced (`[[` and `]]` for brackets) and a method attribute without a template
constraining the methods; an attribute may be written with its namespace, with or without `Attribute`, or through a
`using` alias. An action no attribute route reaches is served by each conventional route whose values it meets
(`DefaultRoutePatternTransformer.SubstituteRequiredValues`): `{controller}` and `{action}` are its names, which the
request writes unless they equal the route's defaults (`{controller=Home}/{action=Index}/{id?}` serves HomeController's
Index at `/`, `/Home`, `/Home/Index` and `/Home/Index/{id}`), and an area route only the controllers of its area.
Templates are read as `RoutePatternParser` reads them: `{id:int}` is `{id}` with the constraint's test as its pattern
(`int`, `long`, `alpha`, `minlength`, `maxlength`, `length`, `required`, and a `regex` within the syntax .NET and
JavaScript read alike, in either case); a constraint atlas does not repeat (`min`, `range`, `guid`, `datetime`, one the
application registers) leaves the parameter `unchecked`; an optional parameter or one with a default serves the path
with and without it (and every segment after it), `{filename}.{ext?}` serves `{filename}` for a segment `{filename}.{ext}` does not take,
and `{*rest}` and `{**rest}` are `{*rest}`. `MapOpenApi` (`/openapi/{documentName}.json`), `MapHealthChecks`, and the
files under the project's `wwwroot` that `MapStaticAssets` and `UseStaticFiles` serve, to GET and HEAD, are `implicit`
(`aspnetcore MapOpenApi`, `aspnetcore MapHealthChecks`, `aspnetcore MapStaticAssets`, `aspnetcore UseStaticFiles`);
`MapStaticAssets`' fingerprinted and compressed names are not read. A path, method list, prefix or receiver not spelled
out, a builder a method maps on that no call read passes it, a controller deriving from a class not among the files, a
`RouteTokenTransformerConvention`, `UsePathBase`, Razor Pages, Razor components, SignalR hubs, gRPC services, YARP and
dynamic routes are left out and named in a limit; so are a `Map(path, handler)` whose handler may branch the middleware
(`IApplicationBuilder.Map`: a lambda whose one parameter has no type or is an `IApplicationBuilder`, a method that takes
one or is not found), a value a compound assignment, `ref` or `out` changes, a parameter of a local function, an
interpolation hole with an alignment, and the code after a string the lexer cannot read. Carter's modules,
FastEndpoints' endpoints and Blazor's pages are not read.

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
their value to the plain one, and a joined URL relative to the page is resolved as a page-relative link is. Text outside attributes, commented-out markup and absolute URLs, which name other sites,
are skipped.

### Which route a request reaches

A call joins the route its framework dispatches the request to, where atlas reads how that framework picks one; where
it does not, the call joins every route its path fits, and a limit names what is not read.

- Registration order. Express, @koa/router (without `exclusive`), Hono and Starlette (FastAPI) answer a request with
  the first route registered whose method and path it fits; Nest on Express registers a controller's routes in the
  order its methods are declared. The order is read within one router in one function body of one file (Python's
  stacked decorators the nearest the definition first, as Python applies them), and a router mounted once (`use`, each
  of its arguments in turn, `route`, `include_router`, `mount`) takes its place where the mount is; routes of routers
  registered in different files, of Nest's controllers, or of a router mounted twice are in no order atlas knows, so
  each stays a target. A route stops a request only where it takes every request the call stands for (`/users/me`
  before `/users/:id`, not a call `/users/${id}`) in the form the call is written (where the router's rule for a
  trailing `/` is not read, only a call without one to a route written without one), and where its last handler does
  not take `next` and pass the request on with it (`next()`, or Express's `next(x)` with an `x` that may be falsy:
  only a surely truthy one, as `next(new Error())`, goes to the error handlers) and, on Express, no callback of the
  route leaves it with `next('route')`; a handler atlas does not see (imported, or a value) may pass it on, and so may
  a Nest route whose version a header, a media type or a function gives.
- Nest's specificity. With `routeResolutionStrategy: 'specificity'` (`NestFactory.create`'s options, written in place
  or given to the function that calls it by each of its calls; @nestjs/core 12 and later), Nest registers every
  controller's routes ranked segment by segment (`RouteSpecificitySorter`: a literal, then a segment of text and a
  parameter, then a parameter, then a wildcard; a path that ends earlier comes after a literal, or last where it has a
  wildcard), those of one rank in declaration order. Another strategy, or one not spelled out, leaves every route a
  target.
- Precedence. Fastify's find-my-way tries a static segment before a parameter, a parameter with a regexp before one
  without, and a parameter before a wildcard, whatever the order; Gin's tree (tree.go `getValue`) tries, segment by
  segment, static text before a parameter before a catch-all, in the tree of the request's method only (a HEAD
  request reaches a HEAD route, not a GET one); chi's (tree.go `findRoute`) tries, from each place in the path, static text, then a
  parameter with a regexp, then one without (one ending at a `/` after one ending at another character), then a
  catch-all, going back where a branch finds no route of the request's method, and a router mounted with `Mount` or
  `Route` as a catch-all after its path, then that router's tree; Go's ServeMux takes the most specific pattern, the one whose
  requests are a strict subset of the other's by method and by path (pattern.go `comparePathsAndMethods`); two that
  share a request with neither more specific conflict, and ServeMux panics as the second is registered, which atlas
  leaves out with a limit. Of patterns that do not conflict, the more specific is the one its tree tries first
  (routing_tree.go): one that names the request's method, then one that names GET for a HEAD request, then one that
  names none, and segment by segment a literal before a wildcard before a remainder. A router ServeMux serves under a
  subtree with `http.StripPrefix` is that subtree to the ServeMux, which picks between it and its own patterns first;
  chi's tree takes a request under a router's mount to that router for any method, so a route of the parent's its
  tree tries after the mount is not reached by such a request; Spring ranks by specificity and Next.js by its file
  conventions, as before. Werkzeug (Flask, Quart) walks a request's segments and tries a segment's static text before
  its variables, and the variables by their weight (`Weighting`: more pieces of static text in the segment first, the
  longer first, then more converters, then lower converter weights: `int` and `float` 50, `string`, `any`, `uuid` and a
  `BaseConverter` 100, `path` 200), whatever the order they were added in; two of one weight with other regexes are
  tried in the order their rules were added, which atlas does not read, so both stay targets. ASP.NET Core's endpoint routing takes, of the routes whose template and constraints a
  request meets, the one with the lowest `Order` (an attribute's `Order` or a literal `WithOrder(n)` chained on the route, 0 for the others, 1 and up for conventional
  routes in the order they are mapped, int.MaxValue for a fallback; one not spelled out leaves the route out of the
  ranking, with a limit), then the lowest precedence (segment by segment: a
  literal, then a constrained parameter or a segment of several parts, then a parameter, then a constrained catch-all,
  then a catch-all), then one that names the method before one that takes any; a route whose constraint atlas does not
  read may refuse the request and keeps no other route from it. It matches a path's literal text whatever its case,
  and HEAD only to a route that takes HEAD.
- Path first. Django's resolver answers a request with the first pattern its path fits, in the order of the URLconf
  and the URLconfs it includes, whatever the method (`URLResolver.resolve`); that pattern's view answers a method it
  does not take with 405, so a later pattern that takes the method is not reached (`/api/items/recent/` is DRF's
  `recent` action's, GET only, and not the detail route's for DELETE).
- Trailing `/`. Express, @koa/router, Nest on Express and ASP.NET Core ignore it. Express's `Router({ strict: true })` makes a
  route take the path as written, a router's `/` taking its mount's path with and without the `/`; an application's
  `strict routing` is read where every `set`, `enable` or `disable` of it is at the top level of the file that creates
  the application, before every route registered there, since the application's router takes it when first used (the
  last one counts). @koa/router's `strict`, which also changes how it joins `/` to a prefix, is not read. Fastify (unless `ignoreTrailingSlash`, at the top of its options or in `routerOptions`), Hono (unless
  `new Hono({ strict: false })`) and Spring 6 and later (the version the nearest pom.xml or build.gradle gives Spring
  Boot or Spring Framework; `setUseTrailingSlashMatch` decides for mapped handlers where the code calls it) match a
  path with a `/` only to a route that has one: find-my-way also gives the empty text after a last `/` to a parameter
  (`/users/:id` takes `/users/`), Fastify serves a plugin's `/` at its prefix with and without the `/`
  (`prefixTrailingSlash`), and Spring joins `@RequestMapping("/owners")` and `@GetMapping("/")` into `/owners/`.
  chi serves the path as the pattern writes it; a router mounted at `/x` serves its `/` at `/x` and `/x/`. Gin serves
  the path as the route writes it, and with `RedirectTrailingSlash` (on unless the code sets it to `false`) redirects a
  request with the `/` added or removed where its tree, walking the request, reaches a route of that form first (so
  `GET /user/groups/` is redirected to `/user/groups` even where `/user/:name/*action` takes it). Go's ServeMux serves
  the path as the pattern writes it, a subtree (`/x/`) and a remainder (`/x/{rest...}`) taking `/x/` and what follows,
  and redirects a request without a `/` that no pattern but a subtree or remainder matches to the path with it, where a
  pattern matches that with nothing left for its remainder (server.go `matchOrRedirect`).
  Werkzeug (Flask, Quart) serves the path as the rule writes it, and answers a request without a `/` with a redirect to
  the path with it where a rule written with one takes that (`strict_slashes`, on by default), unless a rule of that
  same path, or one its matcher tries first (a static segment before a variable), takes the request; a request with a
  `/` is not served by a rule written without one. A rule with `strict_slashes=False`, or every rule where
  `url_map.strict_slashes` is `False`, takes either form; where it is set otherwise than to `True` or `False`, a call
  is matched to its route either way.
  Django serves the path as the pattern writes it; with CommonMiddleware in `MIDDLEWARE` and `APPEND_SLASH` on (the
  default), a request without a `/` that no pattern takes as written, by any method, is answered with a redirect to
  the path with it, where the first pattern that takes that does not say otherwise (`@no_append_slash`); with `DEBUG`
  on, Django raises an error for a DELETE, POST, PUT or PATCH instead. Either way the request reaches no route as
  written.
  Starlette serves the path as the route writes it, and redirects a request no route takes by any method to the path
  with the `/` added or removed where a route takes that (`redirect_slashes`, read from `FastAPI(...)`, or from the
  `APIRouter(...)` an application mounts); a call with a value may be served for some values and redirected for
  others. Next.js redirects every request with a trailing `/` to the path without it, or with `trailingSlash: true`
  every one whose last segment has no `.` to the path with it and a file's (`.` and word characters at its end) to the
  path without it, leaving `/.well-known/` as written, as the object `next.config.*` exports says; a
  configuration a function returns or a plugin wraps is not read. A wildcard written after a `/` (find-my-way's
  `/x/*`, Nest's `x/*`, Express 4's `/x/*`) takes `/x/` but not `/x`.
- Matchers. AdonisJS tests a parameter with the matcher a route's `.where(param, matcher)` or the file's
  `router.where` gives (`router.matchers.number()`, `uuid()`, `slug()`, a RegExp, a string, an object's `match`); a
  matcher not spelled out takes any value.
- Constraints. Fastify takes a request to a route with `constraints` (a version, a host) only where its headers meet
  them; atlas does not read a call's headers, so such a call is matched to none of those routes, and a limit says so.

A call its router answers with a redirect reaches the route there only once the client follows it: it is matched to
none, a limit names the redirect, and neither the call (FA002) nor the route (FA001) is reported. A call no route
takes (a path with a `/` on a strict router, a value a matcher refuses) is reported by FA002, as the framework answers
it with 404 or 405. A route an earlier one of the same router always answers for is reached by no request; FA001 says
which route takes its requests.

### A client's base

Most HTTP clients take a base URL and join each path they are given to it; how, each library documents. atlas reads
the base where the code states it, for the calls made through that client, and the call source's `base` (with `join`)
or `prefix` where it does not: a base held in a value (`process.env.API_URL`, a build's
`BuildConfig`), or a client atlas does not follow. A client's base option is its base, no request of its own.

- `join: resolve` is RFC 3986's resolution of a reference (section 5.2), as the URL Standard, .NET's `Uri` (HttpClient's
  `BaseAddress`), OkHttp's `HttpUrl.resolve` (Retrofit's `baseUrl`, whose documentation shows it), Ktor's
  `DefaultRequest`, Go's `URL.Parse` and Python's `urljoin` do it: a path that starts with `/` replaces the base's
  path, any other replaces what follows its last `/`, so `/api/v1/` and `users` are `/api/v1/users`, `/api/v1` and
  `users` are `/api/users`, and `/health` is `/health` under both.
- `join: append` puts the path after the base's path with one `/`, its own leading `/` dropped, as axios's
  `combineURLs`, Ky's `prefix`, RTK Query's `joinUrls`, httpx's `base_url`, resty's `SetBaseURL` and Refit do. `prefix`
  is this join, the form earlier configurations wrote; a path with its leading `/` gets it as before.

Clients differ on a `.` or `..` segment after the join: the URL Standard, .NET's `Uri`, OkHttp, `urljoin` and httpx
remove it, resty's `url.Parse` and Ktor's `DefaultRequest` send it as written; so a path with one, joined to the
configured base, is left unread with a limit, and one joined to a base read from code (whose libraries send it through
the URL Standard) has it removed. A URL with a host, or one that starts
with a value (`${base}/orders`), keeps its own path. A path without a leading `/` is read only where the place it is
written in makes it relative to a client's base, and only where that base is known; where it is not, a limit names
the place and says to set `base` and `join`.

In TypeScript and JavaScript, atlas follows a call's receiver, through `const`s and imports, to the call that creates
the client, a library's factory imported under any name, and reads the options there:

- axios, `axios.create({ baseURL })` (append, `combineURLs`); the requests are the URL its methods take first (`get`,
  `post` and the others), the instance called with a URL, and the `url` of a request config (`api({ url })`,
  `api.request({ url })`). A request's own `baseURL` takes the instance's place; options held in a value, or with a
  spread, may set one, so they leave the base unread. A request interceptor (`api.interceptors.request.use(fn)`) that
  sets the config's `url` to text before the URL it holds (`` config.url = `/v2${config.url}` ``, a statement of its own
  in the function's body) puts that text before each URL of the instance, an absolute one too (`combineURLs` then
  appends `/v2https://...` to the base); one that writes `url` or `baseURL`
  otherwise, hands the config on, returns anything but the config it is given (or writes that parameter), takes
  options, or is not a function of the file, and a
  change of `api.defaults` whole or of its `baseURL`, leave the instance's requests unread with a limit, as do uses of
  the instance in files atlas cannot all list. Such a rewrite of a config's own URL, there or as the `url` of an object
  that spreads the config, is no request.
- Ky (`ky.create`, `ky.extend`, `instance.extend`, with options or a function of the parent's options, whose
  `` `${options.prefix}/admin` `` is read with the parent's prefix), at the major version the nearest package.json
  above the file that creates it gives: from Ky 2, `prefix` is appended (its readme: "the leading slash of the input
  will essentially be ignored") and `baseUrl` resolves the input as a URL; a relative prefix with a `baseUrl` is not
  read; `prefixUrl`, which Ky 2 refuses whatever its value, leaves the requests unread. Before Ky 2, `prefixUrl` is
  appended, and an input with a leading `/`, which Ky refuses then under a `prefixUrl` set on the instance or the
  request, is no request. `prefix` and `prefixUrl` go before an absolute input too (`resolveInput`, Ky 1's
  constructor), which is then a path on the client's own host; an empty one is none, over the parent's too. `prefix`
  and `baseUrl` are kept apart through `extend` and a request's options, and combined only for the request. A
  `beforeRequest` or `beforeRetry` hook that may return a request (anything but a block with no `return` of a value)
  and an `init` hook, on the instance or in a request's own options, may change any URL: those requests are left
  unread with a limit.
- openapi-fetch, `createClient({ baseUrl })`, and a request's own `baseUrl` (`client.GET("/health", { baseUrl: "/" })`);
  the path, a document's, is written after the base, an absolute one too. A middleware whose `onRequest` may return
  another request than the one it is given, or writes over its `request` parameter, leaves the client's requests
  unread.
- RTK Query, `createApi({ baseQuery: fetchBaseQuery({ baseUrl }) })` and `api.injectEndpoints(...)` on it: each
  endpoint's `query` returns its URL, alone or as an object's `url`, appended with `joinUrls`, with the object's
  `method`, GET where it states none (fetchBaseQuery's). Another `baseQuery` leaves the endpoints unread.

Through such a client, whether its base is read or not, a URL that starts with a value (`` `${year}/summary` ``) may
be absolute, and bypass the base, or a path the base takes; it is not read, and a limit names it. A base the client's options set where atlas does not
read it (a value, a spread or a computed key after it, options held in a value) is taken from the call source's
`base` or `prefix`; without one, a path from the root is still read where the base resolves it (Ky's `baseUrl`), and
none other, and a limit says where. A client none of whose options state a base reads its paths with the call source's
base, as before. A URL held in a `const` is read through the client its uses request it with (`const url = "/users";
api.get(url)`), followed across the files that import it for a path from the root; where its uses request it through
different clients, or through a client and otherwise, a limit names it. A file's path (`/status.json`) is read where
a route of the target serves it under the client's base. A request to the configured base's own path (`fetch("/api")`)
is a request; the base is no request only where it is a value of its own.

In an Angular app, a URL that starts with a value Angular fixes is read with that value
([Configuring application environments](https://angular.dev/tools/cli/environments),
[Defining dependency providers](https://angular.dev/guide/di/dependency-injection-providers)):

- a property of the `environment` object an `environments/environment*.ts` file exports
  (`` `${environment.apiUrl}/users` ``), where each file a `fileReplacements` entry of angular.json (paths from its
  directory) or of an Nx project.json (paths from the workspace's root) puts in its place gives the same literal value,
  and no code writes the property or the object; where they differ, the URLs are left unread with a limit that names
  the files;
- an `InjectionToken`'s value, through `inject(TOKEN)` or a constructor parameter `@Inject(TOKEN)`: what every provider
  the repository writes gives it (`{ provide: TOKEN, useValue: "/api" }`, or `useFactory` returning a value with no
  `deps`), where they agree, else the token's own `factory`; providers that differ, one not read, or none, leave the
  URLs unread with a limit. What a provider gives a token is no request of its own;
- a `readonly` or `private` field initialized with one of these, or such a constructor parameter, that no code of the
  class writes (`` `${this.baseUrl}/${year}` ``).

In code read as text, a path without a leading `/` is read relative to the call source's `base` (or `prefix`) where it
is a whole string argument (not `"users/" + id`) of: Retrofit's `@GET("users/{id}")` and the other verb annotations,
`@HTTP(path = ...)`; .NET's `new HttpRequestMessage(method, "users")`; a call on one of the call source's `receivers`,
taken first or after a method written as a string (`client.get("users/$id")`, `api.request("POST", "projects")`). A
path Dart's `Uri.http(host, path)` or `Uri.https` takes, written with its leading `/` or not, starts at that host's
root, as the package documents; a host written there as a literal is checked as an absolute URL's is. Two type-level
prefixes are read: Refit's `[PathPrefix("/projects")]`, joined before each verb attribute's route of its interface with
one `/` (Refit, `PathPrefixAttribute`), and, in Java and Kotlin, an `@HttpExchange` interface's `url` before each of
its methods' `@GetExchange` and the others, with the method each names, else the interface's. A `[PathPrefix]` on an
interface that extends another or that another of the file extends, written with more than its path, an
`@HttpExchange` interface that extends another and has no type-level mapping of its own (Spring takes it from the
interfaces it extends), or an exchange not spelled out, leaves those requests unread with a limit; an interface with
its own mapping that extends another is read for its own methods, and a limit says those it inherits are not.

In code read as text, a request's method is read where the code states it for certain, as the client library
documents it: a literal method name or the library's own constant for one. A method held in a value, or set where atlas
does not follow (a builder in a variable, a function of the code's own), leaves it `*`. What decides is the call whose
URL argument the literal is, the URL also built inside it (`http.get(Uri.parse("$base/users"))`,
`http.Get(fmt.Sprintf("%s/users", base))`, `session.get(url("/orders"))`), and the code around that call:

- a method call named for a method, the URL its first argument (`client.get(`, `.Post(` on the line after its chain's
  `.`, as gofmt lays out resty's chains, `dio.get<T>(`);
- Retrofit's `@GET("users")` and the other method annotations, `@HTTP(method = "DELETE", path = ...)`; Refit's
  `[Get("/users")]` and the other verb attributes; OpenFeign's `@RequestLine("GET /repos/{owner}")`, a method and a
  path in one string, split as Feign's contract does (the path after the method, a `/` put before one that starts with
  a literal, the query left out; a limit names a request line whose URI starts with a value). A Retrofit method whose
  URL is its `@Url` parameter is a value, and a limit names it;
- Spring: RestTemplate's `getForObject`, `getForEntity`, `headForHeaders`, `postForObject`, `postForEntity`,
  `postForLocation`, `put`, `patchForObject`, `delete`, `optionsForAllow`, and `exchange` or `execute` with an
  `HttpMethod` constant after the URL; RestClient's and WebClient's `get()` (and the other methods) or
  `method(HttpMethod.X)` before `.uri(...)`;
- OkHttp: a `Request.Builder()` chain through `.url(...)` to `.build()` sends the method of its last `get()`, `head()`,
  `post(body)`, `put(body)`, `patch(body)`, `delete()` or `method("PATCH", body)`, and GET where it calls none; a chain
  with another call, one that does not reach `.build()`, or a URL a later `.url(...)` replaces, is `*`;
- Ktor (with `io.ktor.client.request.request` or `submitForm` imported): `client.request(url) { method =
  HttpMethod.Patch }`, the block trailing or given as the `block` argument, GET where it names no `method`, `*` where
  the block is a value; `submitForm`, POST, or GET with `encodeInQuery = true`;
- Go: net/http's `NewRequest(method, url, body)` and `NewRequestWithContext(ctx, method, url, body)`, by the name the
  file imports net/http under, and `PostForm` on it, on its `DefaultClient` or on a name the file declares an
  `http.Client`; resty's `Execute(method, url)`; the method a literal or the `MethodX`
  constant of net/http or resty, by the names the file imports them under;
- Python: `request(method, url)` and `build_request(method, url)` on any receiver (Requests, HTTPX, urllib3, aiohttp
  and http.client take the method first), and the `Request(method, url)` of Requests and HTTPX, by the names the file
  imports; the method upper-cased, as those libraries send it;
- Dart: package:http's `Request(method, url)`, `MultipartRequest` and `StreamedRequest`, `read` and `readBytes` (GET),
  by the prefix the file imports the package under; dio's `query` (QUERY) and the method of `request(path, options:
  Options(method: 'PATCH'))`, `*` without one, since the Dio's own options may set it;
- Swift: Alamofire's `request(url, method: .patch)`, and `AF.request(url)`, GET; a `URLRequest(url:)` handed on as it
  is, or held in a `let`, is GET; held in a `var`, it takes the one `httpMethod` (or Alamofire's `method`) its block
  assigns, GET where it assigns none, and `*` where it is used before that, assigned more than once, in a nested
  block, again as a whole or passed `inout`; URLSession's `data(from:)`, `bytes(from:)` and `download(from:)` are GET;
- C#: HttpClient's `GetAsync`, `GetStringAsync`, `GetStreamAsync`, `GetByteArrayAsync`, `PostAsync`, `PutAsync`,
  `PatchAsync`, `DeleteAsync` and System.Net.Http.Json's `GetFromJsonAsync`, `PostAsJsonAsync`, `PutAsJsonAsync`,
  `PatchAsJsonAsync`, `DeleteFromJsonAsync`; `new HttpRequestMessage(HttpMethod.Patch, uri)` or
  `new HttpRequestMessage(new HttpMethod("PATCH"), uri)`.

Elsewhere an `HttpMethod.Post` written in the same statement on the line as the URL gives the method. In TypeScript and
JavaScript, a `new Request(url, init)` handed to fetch has its init's method (GET without one), unless fetch's own init
or another `new Request(request, init)` sets another; one held in a `let` or `var` is `*`. A Ky instance's `query`
sends QUERY, and a call through openapi-fetch's path-based client (`createPathBasedClient`, `wrapAsPathBasedClient`:
`client["/users/{id}"].GET(init)`) the method it is named for.

### Generated clients

A client @hey-api/openapi-ts generates (`sdk.gen.ts`, each file headed `// This file is auto-generated by
@hey-api/openapi-ts`) holds one function per operation of the document, whether or not the app calls it. Counting each
as a call would give every route a caller. A request in a function of such a file is read only when the code of a
configured call file of the same component that the generator did not write names that function (`usersList`,
`UsersService.readUserMe`; a comment, a string or an import alone does not), or names a declaration of a generated
file that names it in turn, as a TanStack Query plugin's `usersListOptions` calls `usersList`. A `limit:` names the
functions left out, and their routes come back as FA001 unless something else calls them. So list the generated client,
the generated helpers the app uses, and the code that calls them, narrowed to that code: the app's pages, hooks and
loaders, not another generated file such as a router's route tree, whose path strings are navigations. Where the
generated client is all a component's call files hold, nothing could call its functions: each is read as a request, and
a `limit:` says so. Other generators are not recognized, and atlas does not tie the app's calls of their functions to
the requests inside them: their files are read as any code is. Listing such a client counts each of its requests as a
call, used or not, so no route it covers comes back as FA001; leaving it out leaves out the requests only it makes, so
their routes come back as FA001 though the app calls them.

A function of a @hey-api/openapi-ts SDK (`(options?.client ?? client).get({ url: "/health", ...options })`) or of a file
orval generates (headed `Generated by orval`, `customInstance({ url: "/health", method: "GET" }, options)`) hands its
options to the client, and a caller may set the base there (`getHealth({ baseUrl: location.origin })`). hey-api's
client merges the options over its configuration and writes the path after `baseUrl` (`getUrl`); orval's mutator is
the project's own, and is followed only where it spreads its second parameter, with nothing after it that sets
`baseURL`, into a request through an axios instance (orval's custom axios guide: `AXIOS_INSTANCE({ ...config,
...options })`). There, the request is read once for each base its callers give: none (the configured base, as
before), the page's origin (`location.origin`: the path from the root), or a literal or constant (appended; another
host is checked as an absolute URL's is). Options a function of the code hands on (`(options) => getHealth(options)`)
are followed to that function's callers. A caller that sets the base to a value atlas does not read, or after a
spread, or, for hey-api, to a base ending in `/` (which the path's own `/` follows), leaves the request unread with a
limit; other options held in a value, and a use that is no call (the function handed on), are taken to give none, as
the generated function's request is read without its client's own configuration. The base a caller gives is no request
of its own.

Routers differ in which of several matching routes serves a request. Spring picks the most specific (a pattern without
a catch-all first, and of two catch-alls the longer; then the lower score, one per variable and a hundred per wildcard,
within a segment too; then the longer pattern), so for
a `spring` component a request whose path is fully known reaches that route only (`/movies/search`, not
`/movies/{id}`). Express, Fastify, Nest and FastAPI follow registration order,
which atlas does not read, so there a request reaches every route it fits. Routes an OpenAPI 3 document describes
are matched as the specification says, a concrete path before a templated one, and a request without the trailing
slash a document's path ends with is matched to it only by GET or HEAD; see `references/openapi.md`.

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
`x-flow-atlas.omitted`; set `openapi.<component>` or `routes[].openapi` to write them. Where no step can be written,
or no flow is active, there is nothing to export: it exits 1 and says why, where an error exits 2. The export prints to stdout,
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
