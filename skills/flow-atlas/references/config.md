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
    styles: [nest]            # nest | express | fastapi | spring | next
    receivers: [app, router]  # express receivers; default app, router, server, fastify
    mounts:                   # where the routers a file declares serve their routes, when the code gives no literal path:
      "services/orders/src/routes/collect.js": /collect   # an Express, @koa/router or Hono router's or a Fastify plugin's mount path and prefix, or a FastAPI router's include prefix
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
one call, which joins a base only when both branches do. Branches whose paths differ once the configured `prefix` is
put before a root-relative one, and a branch to a host other than the target's, are read on their own. An
absolute URL, in code of any language, is a request to the call source's target when its
host is a loopback address (`localhost`, `127.x.x.x`, `[::1]`) or the host of the target's `origins` entry; a URL to any
other host, a link to another site for one, is not read, and a limit names the host. A host chosen in a URL's leading
hole (`` `${prod ? "https://other.example" : ""}/api/status` ``) is read as that conditional's branches would be: the
URL is still a request where a branch names no other host, and the limit names the other one. A client's own helper that puts
the configured `prefix` straight before a path it is given (`` `/api/v1${path}` ``, `"/api/v1" + path`, the value built
from that one parameter alone) is the prefix written once more, not a request: the paths passed to it are read where
they are written, with the prefix, and a limit names where the helper was left out. A path with a hole
(`` `/orders/${id}` ``), another base, or text after the value is still a request. A path that already starts with the
prefix still gets it, since a service may nest the same segment.

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
method with no path whose path an earlier statement set, a route chained on a receiver not traced, an array on a router
that takes none, a `route` option or a redirect source not spelled out.

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
what it serves is the directory's content: a limit names where it is mounted, and its paths are not read. The `next` style reads Next.js route handlers, `app/**/route.ts` exporting `GET`, `POST` and
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
`opengraph-image` or `twitter-image` file is served at a path Next.js generates, so it is not read and a limit names it.
Files Next.js serves with no handler of the app's are `implicit` surfaces, listed whatever the route `files` say (an
`exclude` leaves them out): every file under `public/` at the component's directory, at its path from the root as a
request holds it (what the URL Standard percent-encodes in a path, and `%`, percent-encoded: `a b.pdf` is `a%20b.pdf`),
answering GET and HEAD; and `favicon.ico`, `robots.txt`, `manifest.json`, `manifest.webmanifest` at the root of `app/`
and `sitemap.xml` in any segment, answering GET, HEAD and OPTIONS through the route handler Next.js makes of them. A request whose method is not read reaches such a file's GET; no rule expects a caller for one. A path ending
in an extension of a file kept in repositories (`.png`, `.svg`, `.json`, `.txt`, `.xml`, `.css`, `.log` and the like) is no call
in any language, being a file path far more often than a request, so a request for such a file is not read. As Next.js does, a
request is matched to the most specific route path first (a public file or a static name, then `[x]`, then
catch-alls), and a method that route lacks matches nothing else; a request with a value in its path (`/editor/${id}`)
reaches each path down to the first that takes every value (`/editor/new` and `/editor/{id}`, not `/{slug}/**`), less
a path whose every request it shares with the call a more specific path takes (`/${section}/new` reaches `/editor/new`
and `/{section}/new`, not `/editor/{id}`). API routes under `pages/api` answer every method from their default export, written or
re-exported, and their folders are plain segments. Pages (`app/**/page.tsx`, and Pages Router pages outside
`pages/api`) are GET routes at their paths, with the HEAD Next.js answers itself. What the server runs while it renders
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
format strings (`%s`, `%d`) and `{x}` become wildcards, as does every replacement field of a Python f-string; the verb
comes from the call whose first argument the literal is (type arguments allowed, as in `dio.get<T>(`; also when the literal starts the next line) and the scope
from the last `fun`, `func` or `def` before it. A path given to an exception is a label, not a request: an argument
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
unlike `{*name}`, which matches `/x` itself. atlas drops a call's trailing `/`, so a call written `/x/` is read as
`/x`. `{id:int}`, `{id:float}` and `{id:uuid}` are kept as written and take one segment their regex takes; `{id:str}` is
`{id}`; a convertor registered elsewhere is not read, so its segment may take anything; a `path` converter before a
suffix is not matched, so that route is left out with a limit), and `app.mount("/x", StaticFiles(...))` serves GET
(and an implicit HEAD) at `/x/{path:path}`, as Starlette compiles a mount; another mounted application
is not read, and a limit says so. `app.frontend("/", directory=...)` serves the files a frontend build put in a
directory, and a fallback page for GET and HEAD, wherever no route matches: which paths answer depends on the build,
so they are not read and a limit names the call. The `spring` style reads `@RequestMapping` on a class as a prefix for the
(and an implicit HEAD) at `/x/{path:path}`, as Starlette compiles a mount; an application or router of the route files
that it mounts serves the routes read there under `/x`, as an include would; another mounted application is not read,
and a limit says so. The `spring` style reads `@RequestMapping` on a class as a prefix for the
`@GetMapping`, `@PostMapping`, `@PutMapping`, `@DeleteMapping`, `@PatchMapping` and `@RequestMapping` methods under
it, in Java and Kotlin (paths joined, methods united as Spring does), and the POST endpoints Spring Security's
`formLogin` and `logout` serve, in the lambda or the chained form. A handler type's routes are served under the
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
