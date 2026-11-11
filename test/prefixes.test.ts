import { describe, expect, it } from "vitest";
import { normalizeConfig } from "../src/config.js";
import { extractRoutes, routesFromPython, routesFromTypeScript } from "../src/extract/routes.js";
import { excludePattern } from "../src/extract/nest.js";
import type { Source } from "../src/source.js";

const memory = (files: Record<string, string>): Source => ({
  ref: "WORKTREE",
  list: () => Object.keys(files),
  read: (p) => files[p],
  asOf: () => "2026-11-01T00:00:00Z",
});

const routes = (files: Record<string, string>, entry: Record<string, unknown>, components = [{ name: "api", path: "api" }]) => {
  const limits: string[] = [];
  const config = normalizeConfig({ components, routes: [{ component: "api", files: ["api/**"], ...entry }] });
  const ids = extractRoutes(memory(files), config, undefined, [], limits).map((s) => `${s.method} ${s.path}`);
  return { ids, limits };
};

describe("FastAPI router prefixes", () => {
  const fastapi = { styles: ["fastapi"] };

  it("joins a router's prefix and the prefix of each include, through nested includes and imports", () => {
    const files = {
      "api/app/main.py": 'from fastapi import FastAPI\nfrom app.api import api_router\n\napp = FastAPI()\napp.include_router(api_router, prefix="/api/v1")\n',
      "api/app/api.py": [
        "from fastapi import APIRouter",
        "from app.routes import items",
        "from .routes.users import router as users_router",
        "from . import routes",
        "",
        'api_router = APIRouter(prefix="/core")',
        "api_router.include_router(items.router)",
        'api_router.include_router(users_router, prefix="/people")',
        'api_router.include_router(router=routes.shared, prefix="/a")',
        'api_router.include_router(routes.shared, prefix="/b")',
      ].join("\n"),
      "api/app/routes/__init__.py": "from fastapi import APIRouter\n\nshared = APIRouter()\n\n\n@shared.get('')\ndef root(): ...\n",
      "api/app/routes/items.py": 'from fastapi import APIRouter\n\nrouter = APIRouter(prefix="/items")\n\n\n@router.get("/")\ndef a(): ...\n@router.get("/{id}")\ndef b(): ...\n',
      "api/app/routes/users.py": 'from fastapi import APIRouter\n\nrouter: APIRouter = APIRouter(tags=["users"], prefix="/users")\n\n\n@router.post("/signup")\ndef c(): ...\n',
    };
    expect(routes(files, { ...fastapi, receivers: ["app", "router", "shared"] })).toEqual({
      ids: ["GET /api/v1/core/a", "GET /api/v1/core/b", "GET /api/v1/core/items", "GET /api/v1/core/items/{id}", "POST /api/v1/core/people/users/signup"],
      limits: [],
    });
  });

  it("leaves a router unread where a prefix is not spelled out or it is included nowhere, and says so", () => {
    const files = {
      "api/main.py": [
        "from fastapi import FastAPI",
        "from .config import settings",
        "from .orders import router as orders",
        "from .hooks import router as hooks",
        "app = FastAPI()",
        "app.include_router(orders, prefix=settings.API_V1_STR)",
        'app.include_router(hooks, prefix=f"{settings.API_V1_STR}/hooks")',
        "app.include_router(make_router())",
        "@app.get('/healthz')",
        "def healthz(): ...",
      ].join("\n"),
      "api/orders.py": 'from fastapi import APIRouter\nrouter = APIRouter(prefix="/orders")\n@router.get("/")\ndef a(): ...\n',
      "api/hooks.py": "from fastapi import APIRouter\nrouter = APIRouter()\n@router.post('/paid')\ndef b(): ...\n",
      "api/legacy.py": "from fastapi import APIRouter\nrouter = APIRouter(prefix=PREFIX)\n@router.get('/x')\ndef c(): ...\n",
      "api/dead.py": "from fastapi import APIRouter\nold = APIRouter()\n@old.get('/y')\ndef d(): ...\n",
    };
    const { ids, limits } = routes(files, { ...fastapi, receivers: ["app", "router", "old"] });
    expect(ids).toEqual(["GET /healthz"]);
    expect(limits).toEqual([
      "routes api: api/main.py:6 includes orders with a prefix the file does not spell out (settings.API_V1_STR); the routes of api/orders.py (router) are not read (declare where it is served in mounts)",
      "routes api: api/main.py:7 includes hooks with a prefix the file does not spell out (f\"{settings.API_V1_STR}/hooks\"); the routes of api/hooks.py (router) are not read (declare where it is served in mounts)",
      "routes api: router in api/legacy.py has a prefix the file does not spell out (PREFIX); its routes are not read (declare where it is served in mounts)",
      "routes api: old in api/dead.py is included nowhere in the route files; its routes are not read (declare where it is served in mounts)",
      "routes api: api/main.py:8 includes make_router(), which atlas does not trace to an APIRouter of the route files",
    ]);
  });

  it("serves a router file where mounts declares it, under it the routers it includes, and the whole entry under prefix", () => {
    const files = {
      "api/main.py": "from fastapi import FastAPI\nfrom .v1 import api_router\napp = FastAPI()\napp.include_router(api_router, prefix=settings.API_V1_STR)\n",
      "api/v1.py": 'from fastapi import APIRouter\nfrom .items import router\napi_router = APIRouter()\napi_router.include_router(router, prefix="/items")\n',
      "api/items.py": "from fastapi import APIRouter\nrouter = APIRouter()\n@router.get('/{id}')\ndef a(): ...\n",
    };
    expect(routes(files, { ...fastapi, mounts: { "api/v1.py": "/api/v1" } })).toEqual({ ids: ["GET /api/v1/items/{id}"], limits: [] });
    expect(routes(files, { ...fastapi, mounts: { "api/v1.py": "/api/v1" }, prefix: "/svc" }).ids).toEqual(["GET /svc/api/v1/items/{id}"]);
  });

  it("serves an application another mounts under the mount's path, and reads no prefix a ** argument may set", () => {
    const files = {
      "api/main.py": 'from fastapi import FastAPI\nfrom .sub import app as sub\napp = FastAPI()\napp.mount("/v1", sub)\napp.mount(path="/v2", app=sub)\n',
      "api/sub.py": 'from fastapi import FastAPI, APIRouter\napp = FastAPI()\nrouter = APIRouter(prefix="/r")\napp.include_router(router)\n@app.get("/items")\ndef a(): ...\n@router.get("/b")\ndef b(): ...\n',
    };
    expect(routes(files, fastapi)).toEqual({ ids: ["GET /v1/items", "GET /v2/items", "GET /v1/r/b", "GET /v2/r/b"], limits: [] });
    const spread = {
      "api/main.py": "from fastapi import FastAPI, APIRouter\napp = FastAPI()\nrouter = APIRouter(**opts)\nother = APIRouter()\napp.include_router(router)\napp.include_router(other, **kw)\n@router.get('/a')\ndef a(): ...\n@other.get('/b')\ndef b(): ...\n",
    };
    expect(routes(spread, { ...fastapi, receivers: ["router", "other"] })).toEqual({
      ids: [],
      limits: [
        "routes api: router in api/main.py has a prefix the file does not spell out (**opts); its routes are not read (declare where it is served in mounts)",
        "routes api: api/main.py:6 includes other with a prefix the file does not spell out (**kw); the routes of api/main.py (other) are not read (declare where it is served in mounts)",
      ],
    });
  });

  it("takes a name a function binds as its own, not the module's router", () => {
    const files = {
      "api/main.py": [
        "from fastapi import FastAPI, APIRouter",
        "app = FastAPI()",
        "router = APIRouter()",
        'app.include_router(router, prefix="/public")',
        '@router.get("/a")',
        "def a(): ...",
        "def register(",
        "    router,",
        "):",
        '    @router.get("/x")',
        "    def x(): ...",
        "def wire(app, router):",
        '    app.include_router(router, prefix="/w")',
        "def local():",
        "    router = make_router()",
        '    @router.get("/y")',
        "    def y(): ...",
        // A name bound in a nested function is that function's own.
        "def factory():",
        "    def inner():",
        "        router = make_router()",
        '    @router.get("/z")',
        "    def z(): ...",
        // The arguments of a call bind nothing.
        "def mount_more():",
        "    app.include_router(",
        "        router=router,",
        '        prefix="/more",',
        "    )",
      ].join("\n"),
    };
    expect(routes(files, { styles: ["fastapi"] })).toEqual({
      ids: ["GET /public/a", "GET /more/a", "GET /x", "GET /y", "GET /public/z", "GET /more/z"],
      limits: [
        "routes api: api/main.py registers routes on router, which atlas does not trace to a FastAPI application or APIRouter of the route files; they are read at the paths written",
        "routes api: api/main.py:13 includes router, which atlas does not trace to an APIRouter of the route files",
      ],
    });
  });

  it("serves the StaticFiles an application mounts under where that application is mounted", () => {
    const files = {
      "api/main.py": 'from fastapi import FastAPI\nfrom .sub import app as sub\napp = FastAPI()\napp.mount("/v1", sub)\napp.mount("/assets", StaticFiles(directory="a"))\n',
      "api/sub.py": 'from fastapi import FastAPI\napp = FastAPI()\napp.mount("/static", StaticFiles(directory="s"))\n',
    };
    expect(routes(files, { styles: ["fastapi"] })).toEqual({
      ids: ["GET /assets/{path:path}", "HEAD /assets/{path:path}", "GET /v1/static/{path:path}", "HEAD /v1/static/{path:path}"],
      limits: [],
    });
    const unread = { ...files, "api/main.py": "from fastapi import FastAPI\nfrom .sub import app as sub\napp = FastAPI()\napp.mount(settings.V1, sub)\n" };
    expect(routes(unread, { styles: ["fastapi"] })).toEqual({
      ids: [],
      limits: [
        "routes api: api/main.py:4 mounts sub at a path the file does not spell out (settings.V1); the routes of api/sub.py (app) are not read (declare where it is served in mounts)",
      ],
    });
  });

  it("reads one file's routers alone, and a receiver it cannot trace at the paths written, with a limit", () => {
    const limits: string[] = [];
    const text = 'router = APIRouter(prefix="/a")\napp = FastAPI()\napp.include_router(router, prefix="/b")\n@router.get("")\ndef a(): ...\n@app.get("")\ndef b(): ...\n';
    expect(routesFromPython("m.py", text, { component: "c", files: [] }, limits).map((s) => s.path)).toEqual(["/b/a"]);
    expect(limits).toEqual([]);
    expect(routesFromPython("n.py", "def f(router):\n    @router.get('/x')\n    def a(): ...\n", { component: "c", files: [] }, limits).map((s) => s.path)).toEqual(["/x"]);
    expect(limits).toEqual([
      "routes c: n.py registers routes on router, which atlas does not trace to a FastAPI application or APIRouter of the route files; they are read at the paths written",
    ]);
  });
});

describe("NestJS global prefix and versioning", () => {
  const nest = { styles: ["nest"] };
  const controllers = {
    "api/src/orders.controller.ts": [
      "@Controller('orders')",
      "export class OrdersController {",
      "  @Get(':id') read() {}",
      "  @Version('2') @Get() list() {}",
      "  @Version(['1', VERSION_NEUTRAL]) @Post() create() {}",
      "  @All('any') any() {}",
      "}",
      "@Controller({ path: 'health', version: VERSION_NEUTRAL })",
      "export class HealthController {",
      "  @Get() health() {}",
      "  @Post() ping() {}",
      "}",
    ].join("\n"),
  };
  const bootstrap = (body: string) => ({ ...controllers, "api/src/main.ts": `async function bootstrap() {\n  const app = await NestFactory.create(AppModule);\n${body}\n}\n` });

  it("puts the global prefix and the URI version before every route but those it excludes, which keep the version", () => {
    const files = bootstrap(
      [
        "  const globalPrefix = 'api';",
        "  app.setGlobalPrefix(globalPrefix, { exclude: [{ path: 'health', method: RequestMethod.GET }, 'orders/:id', 'none{/*rest}'] });",
        "  app.enableVersioning({ type: VersioningType.URI, defaultVersion: ['1', '3'], prefix: 'version-' });",
      ].join("\n"),
    );
    expect(routes(files, nest)).toEqual({
      ids: [
        "GET /version-1/orders/{id}",
        "GET /version-3/orders/{id}",
        "GET /api/version-2/orders",
        "POST /api/version-1/orders",
        "POST /api/orders",
        // `orders/:id` keeps out every path of one segment after orders, as Nest matches it against the route's path.
        "* /version-1/orders/any",
        "* /version-3/orders/any",
        "GET /health",
        "POST /api/health",
      ],
      limits: [],
    });
  });

  it("enables URI versioning with `v` by default, and leaves the path alone for the other types or no versioning", () => {
    expect(routes(bootstrap("  app.enableVersioning();"), nest).ids.slice(0, 3)).toEqual(["GET /orders/{id}", "GET /v2/orders", "POST /v1/orders"]);
    expect(routes(bootstrap("  app.enableVersioning({ type: VersioningType.URI, prefix: false, defaultVersion: '1' });"), nest).ids[0]).toBe("GET /1/orders/{id}");
    expect(routes(bootstrap("  app.enableVersioning({ type: VersioningType.HEADER, header: 'X-Version' });"), nest).ids.slice(0, 3)).toEqual(["GET /orders/{id}", "GET /orders", "POST /orders"]);
    expect(routes(controllers, nest).ids.slice(0, 3)).toEqual(["GET /orders/{id}", "GET /orders", "POST /orders"]);
  });

  it("says what it cannot read and leaves out the routes it decides", () => {
    const unread = routes(
      bootstrap("  app.setGlobalPrefix(process.env.PREFIX, { exclude: ['health', ...EXTRA, 'x(.*)', { path: 'y', method }] });\n  app.enableVersioning({ type: VersioningType.URI, defaultVersion: config.version });"),
      nest,
    );
    // Only the excluded routes have a known path; of them, the neutral ones need no default version.
    expect(unread.ids).toEqual(["GET /health", "POST /health"]);
    expect(unread.limits).toEqual([
      "routes api: api/src/main.ts:3 sets a global prefix the file does not spell out (process.env.PREFIX); the routes under it are not read (declare it in prefix)",
      "routes api: api/src/main.ts:3 excludes from the global prefix a path the file does not spell out (...EXTRA); a route it excludes is read under the prefix",
      "routes api: api/src/main.ts:3 excludes from the global prefix a pattern atlas does not read ('x(.*)'); a route it excludes is read under the prefix",
      "routes api: api/src/main.ts:3 excludes from the global prefix an entry atlas does not read ({ path: 'y', method }); a route it excludes is read under the prefix",
      "routes api: api/src/main.ts:4 sets a default version the file does not spell out (config.version); the routes that take it are not read",
    ]);
    // A spread in the options may set any of them.
    const spread = routes(bootstrap("  app.setGlobalPrefix('api', { ...options });\n  app.enableVersioning({ type: VersioningType.URI, prefix: 'v', ...extra });"), nest);
    expect(spread.ids).toEqual([]);
    expect(spread.limits).toEqual([
      "routes api: api/src/main.ts:3 excludes from the global prefix a path the file does not spell out ({ ...options }); a route it excludes is read under the prefix",
      "routes api: api/src/main.ts:4 enables versioning the file does not spell out ({ type: VersioningType.URI, prefix: 'v', ...extra }); the routes are not read",
    ]);
    expect(routes(bootstrap("  app.setGlobalPrefix('api', { ...options });"), nest).ids[0]).toBe("GET /api/orders/{id}");
    // The configuration states the prefix the code takes from the environment.
    expect(routes(bootstrap("  app.setGlobalPrefix(process.env.PREFIX);"), { ...nest, prefix: "/api" }).ids[0]).toBe("GET /api/orders/{id}");
  });

  it("reads the bootstrap the configuration names, and no application whose calls disagree", () => {
    const two = {
      ...controllers,
      "api/src/main.ts": "app.setGlobalPrefix('api');",
      "api/src/admin.ts": "admin.setGlobalPrefix('admin');",
      "api/src/main.spec.ts": "app.setGlobalPrefix('test');",
    };
    const both = routes(two, nest);
    expect(both.ids).toEqual([]);
    expect(both.limits).toEqual([
      "routes api: api/src/main.ts:1, api/src/admin.ts:1 set the global prefix differently, and which application serves a controller is not read, so no route of the controllers is (name the application's bootstrap file in bootstrap)",
    ]);
    expect(routes(two, { ...nest, bootstrap: "api/src/main.ts" }).ids[0]).toBe("GET /api/orders/{id}");
    // Outside the component and the route files, a bootstrap is read only where the configuration names it.
    const outside = { ...controllers, "server/main.ts": "app.setGlobalPrefix('api');" };
    expect(routes(outside, nest).ids[0]).toBe("GET /orders/{id}");
    expect(routes(outside, { ...nest, bootstrap: "server/main.ts" }).ids[0]).toBe("GET /api/orders/{id}");
    expect(routes(controllers, { ...nest, bootstrap: "server/main.ts" }).limits).toEqual(["routes api: the bootstrap file server/main.ts is not there"]);
  });

  it("says a default version an accessor gives is not read", () => {
    const accessor = routes(bootstrap("  app.enableVersioning({ type: VersioningType.URI, get defaultVersion() { return config.version; } });"), nest);
    expect(accessor.ids).toEqual(["GET /v2/orders", "POST /v1/orders", "POST /orders", "GET /health", "POST /health"]);
    expect(accessor.limits).toEqual([
      "routes api: api/src/main.ts:3 sets a default version the file does not spell out (get defaultVersion() { return config.version; }); the routes that take it are not read",
    ]);
  });

  it("compares the settings of several bootstraps by their values", () => {
    const named = (value: string) => `const globalPrefix = '${value}';\napp.setGlobalPrefix(globalPrefix);`;
    const differ = routes({ ...controllers, "api/src/main.ts": named("api"), "api/src/admin.ts": named("admin") }, nest);
    expect(differ.ids).toEqual([]);
    expect(differ.limits).toEqual([
      "routes api: api/src/main.ts:2, api/src/admin.ts:2 set the global prefix differently, and which application serves a controller is not read, so no route of the controllers is (name the application's bootstrap file in bootstrap)",
    ]);
    // A configured prefix takes the place of the ones the files set; the exclusions still have to agree.
    expect(routes({ ...controllers, "api/src/main.ts": named("api"), "api/src/admin.ts": named("admin") }, { ...nest, prefix: "/api" }).ids[0]).toBe("GET /api/orders/{id}");
    const same = routes({ ...controllers, "api/src/main.ts": named("api"), "api/src/admin.ts": "app.setGlobalPrefix('api');" }, nest);
    expect([same.ids[0], same.limits]).toEqual(["GET /api/orders/{id}", []]);
    const versions = routes(
      { ...controllers, "api/src/main.ts": "const v = '1';\napp.enableVersioning({ type: VersioningType.URI, defaultVersion: v });", "api/src/admin.ts": "app.enableVersioning({ type: VersioningType.URI, defaultVersion: '1' });" },
      nest,
    );
    expect([versions.ids[0], versions.limits]).toEqual(["GET /v1/orders/{id}", []]);
    // Two settings the files do not spell out are not taken as the same.
    const unread = routes({ ...controllers, "api/src/main.ts": "app.setGlobalPrefix(PREFIX);", "api/src/admin.ts": "app.setGlobalPrefix(PREFIX);" }, nest);
    expect(unread.limits).toEqual([
      "routes api: api/src/main.ts:1, api/src/admin.ts:1 set the global prefix differently, and which application serves a controller is not read, so no route of the controllers is (name the application's bootstrap file in bootstrap)",
    ]);
  });

  it("reads a controller version given by shorthand, and none where a spread may give it", () => {
    const limits: string[] = [];
    const app = { prefix: "", exclude: [], versioning: { uri: true as const, prefix: "v", defaults: ["1"] } };
    const read = (text: string) => routesFromTypeScript("a.ts", text, { component: "c", files: [], styles: ["nest"] }, { limits, nest: app }).map((s) => s.path);
    expect(read("const version = '2';\n@Controller({ path: 'orders', version })\nclass A {\n  @Get() a() {}\n}")).toEqual(["/v2/orders"]);
    expect(read("@Controller({ ...opts, path: 'o' })\nclass B {\n  @Get() a() {}\n  @Version('3') @Get('b') b() {}\n}")).toEqual(["/v3/o/b"]);
    expect(limits).toEqual(["routes c: a.ts:1 gives a version the file does not spell out ({ ...opts, path: 'o' }); its routes are not read"]);
    // A spread after the path may set it too.
    limits.length = 0;
    expect(read("@Controller({ path: 'o', version: '2', ...opts })\nclass C {\n  @Get() a() {}\n}")).toEqual([]);
    expect(limits).toEqual([
      "routes c: a.ts:1 gives a version the file does not spell out ({ path: 'o', version: '2', ...opts }); its routes are not read",
      "routes c: a.ts:1 registers a path the file does not spell out ({ path: 'o', version: '2', ...opts }); its routes are not read",
    ]);
  });

  it("gives a route a version the controller or method states, and none where it is not spelled out", () => {
    const limits: string[] = [];
    const text = "@Controller({ path: 'a', version: V })\nclass A {\n  @Get() a() {}\n  @Version('3') @Get('b') b() {}\n}";
    const app = { prefix: "", exclude: [], versioning: { uri: true as const, prefix: "v", defaults: undefined } };
    expect(routesFromTypeScript("a.ts", text, { component: "c", files: [], styles: ["nest"] }, { limits, nest: app }).map((s) => s.path)).toEqual(["/v3/a/b"]);
    expect(limits).toEqual(["routes c: a.ts:1 gives a version the file does not spell out (V); its routes are not read"]);
  });

  it("compiles an exclude path as path-to-regexp 8 does", () => {
    const test = (pattern: string, path: string) => excludePattern(pattern)?.test(path);
    expect(test("health", "/health")).toBe(true);
    expect(test("health", "/HEALTH/")).toBe(true);
    expect(test("health", "/health/live")).toBe(false);
    expect(test("health/*splat", "/health")).toBe(false);
    expect(test("health/*splat", "/health/live/deep")).toBe(true);
    expect(test("health{/*splat}", "/health")).toBe(true);
    expect(test(".well-known{/*wildcard}", "/.well-known/openid-configuration")).toBe(true);
    expect(test("cats/:id", "/cats/:id")).toBe(true);
    expect(test("sitemap.xml", "/sitemapxxml")).toBe(false);
    for (const p of ["cats/(.*)", "cats/*", "cats?", "{/a"]) expect(excludePattern(p)).toBeUndefined();
  });
});

describe("route prefixes in the configuration", () => {
  it("puts a declared prefix before the routes of the other styles", () => {
    const express = { "api/app.js": "const app = express();\napp.get('/a', h);\n" };
    expect(routes(express, { styles: ["express"], prefix: "/svc" }).ids).toEqual(["GET /svc/a"]);
    const spring = { "api/A.java": '@RestController\n@RequestMapping("/a")\nclass A {\n  @GetMapping("/b") String b() { return ""; }\n}\n' };
    expect(routes(spring, { styles: ["spring"], prefix: "/ctx" }).ids).toEqual(["GET /ctx/a/b"]);
  });

  it("rejects a mount, a prefix or a bootstrap it cannot use", () => {
    const entry = (more: Record<string, unknown>) => () => normalizeConfig({ routes: [{ component: "api", files: [], ...more }] });
    expect(entry({ mounts: { "a.py": "api" } })).toThrow("mounts maps a file to the path it is served under");
    expect(entry({ mounts: ["a.py"] })).toThrow("mounts maps a file");
    expect(entry({ prefix: "api" })).toThrow("prefix is a path starting with /");
    expect(entry({ bootstrap: "main.ts" })).toThrow("bootstrap is read for the nest style only");
    expect(entry({ styles: ["nest"], bootstrap: ["main.ts"] })).toThrow("bootstrap names one file");
    expect(entry({ styles: ["nest"], bootstrap: "main.ts", prefix: "/api", mounts: { "a.js": "/a" } })).not.toThrow();
  });
});
