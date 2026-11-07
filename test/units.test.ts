import { describe, expect, it } from "vitest";
import { callPath, joinRoute, methodsMatch, narrowedPath, pathsMatch, routeTemplate } from "../src/paths.js";
import { cycleSearch, cycles, surfacePattern } from "../src/rules.js";
import { routesFromPython, routesFromTypeScript } from "../src/extract/routes.js";
import { documentStart } from "../src/extract/apidocs.js";
import { callsFromText, callsFromTypeScript } from "../src/extract/calls.js";
import { Reach } from "../src/extract/reach.js";
import { similarity } from "../src/nearby.js";
import ts from "typescript";
import { resolveApiDescriptions, servedDocuments } from "../src/extract/apidocs.js";
import type { ApiDocument, Call, Surface } from "../src/model.js";
import { matchCalls, type Ranking } from "../src/match.js";
import { validate } from "../src/schema.js";
import { normalizeConfig } from "../src/config.js";
import type { Source } from "../src/source.js";
import type { Graph } from "../src/model.js";
import { coverageDrops } from "../src/commands.js";

describe("callPath", () => {
  it("takes a leading interpolation as a base address", () => {
    expect(callPath("{}/orders/{}")).toEqual({ path: "/orders/{}", based: true });
  });
  it("keeps a plain path and drops the query", () => {
    expect(callPath("/screens/home?x=1")).toEqual({ path: "/screens/home", based: false });
  });
  it("reads the path of an absolute URL", () => {
    expect(callPath("https://api.example.com/v1/items")).toEqual({ path: "/v1/items", based: true });
  });
  it("rejects files, prose and bare slashes", () => {
    expect(callPath("/assets/logo.png")).toBeUndefined();
    expect(callPath("/not a path")).toBeUndefined();
    expect(callPath("/")).toBeUndefined();
    expect(callPath("orders")).toBeUndefined();
    expect(callPath("/{}")).toBeUndefined();
  });
});

describe("pathsMatch", () => {
  it("matches route parameters and call interpolations", () => {
    expect(pathsMatch("/orders/:id", "/orders/{}")).toBe(true);
    expect(pathsMatch("/orders/{id}/history", "/orders/42/history")).toBe(true);
    expect(pathsMatch("/orders/:id", "/orders/{}/refund")).toBe(false);
    expect(pathsMatch("/orders", "/payments")).toBe(false);
  });
  it("treats an unknown method as any method", () => {
    expect(methodsMatch("GET", "*")).toBe(true);
    expect(methodsMatch("GET", "POST")).toBe(false);
  });
  it("joins controller and method paths", () => {
    expect(joinRoute("orders", ":id")).toBe("/orders/:id");
    expect(joinRoute("/", "")).toBe("/");
  });
});

describe("Starlette's path converter", () => {
  it("takes the rest of the path after the slash written before it, which Spring's {*rest} does not need", () => {
    const text = '@app.get("/files/{name:path}")\ndef f(): ...\napp.mount("/static", StaticFiles(directory="s"))';
    expect(routesFromPython("a.py", text, { component: "c", files: [] }).map((s) => s.id)).toEqual([
      "c|GET /files/{name:path}",
      "c|GET /static/{path:path}",
      "c|HEAD /static/{path:path}",
    ]);
    const rows: Array<[string, string, boolean]> = [
      ["/files/{name:path}", "/files", false],
      ["/files/{name:path}", "/files/a", true],
      ["/files/{name:path}", "/files/a/b", true],
      ["/files/{name:path}", "/files/{}", true],
      ["/files/{name:path}", "/other/a", false],
      ["/{id}/files/{name:path}", "/7/files/a", true],
      ["/files/{*name}", "/files", true],
    ];
    expect(rows.map(([route, call]) => pathsMatch(route, call))).toEqual(rows.map(([, , m]) => m));
  });

  it("leaves out a route with a path converter before its end, with a limit", () => {
    const limits: string[] = [];
    const text = '@app.get("/files/{rest:path}/meta")\ndef f(): ...';
    expect(routesFromPython("a.py", text, { component: "c", files: [] }, limits)).toEqual([]);
    expect(limits).toEqual(["routes c: a.py:1 has a path converter before the end of /files/{rest:path}/meta; the route is not read"]);
  });

  it("reaches the path without that segment only through the redirect the router answers when no route serves it", () => {
    const surface = (method: string, path: string): Surface => ({ id: `s|${method} ${path}`, component: "s", method, path, at: { file: "a.py", line: 1 }, evidence: "text" });
    const call = (method: string, path: string): Call => ({ id: "c", from: "w", to: "s", method, path, at: { file: "b.ts", line: 1 }, evidence: "text", based: false });
    const reached = (surfaces: Surface[], c: Call) => (matchCalls({ surfaces, calls: [c] }).targetsOf.get(0) ?? []).map((s) => s.id);
    const tail = surface("GET", "/files/{name:path}");
    expect(reached([tail], call("GET", "/files"))).toEqual(["s|GET /files/{name:path}"]);
    expect(reached([surface("GET", "/files"), tail], call("*", "/files"))).toEqual(["s|GET /files"]);
    // A route at the path that takes another method answers 405 itself; nothing is redirected.
    expect(reached([surface("POST", "/files"), tail], call("GET", "/files"))).toEqual([]);
    expect(reached([surface("GET", "/{kind}"), tail], call("GET", "/files"))).toEqual(["s|GET /{kind}"]);
    // An interpolated segment may name the path the redirect serves, unless a route serves that path itself.
    expect(reached([surface("GET", "/users"), tail], call("GET", "/{}"))).toEqual(["s|GET /users", "s|GET /files/{name:path}"]);
    expect(reached([surface("GET", "/users"), surface("GET", "/files"), tail], call("GET", "/{}"))).toEqual(["s|GET /users", "s|GET /files"]);
  });

  it("keeps a one-segment converter other than str, whose regex decides a fixed segment", () => {
    const text = '@app.get("/a/{id:int}")\ndef a(): ...\n@app.get("/b/{id:str}")\ndef b(): ...\n@app.get("/c/{v:float}/{u:uuid}/{s:slug}")\ndef c(): ...';
    expect(routesFromPython("a.py", text, { component: "c", files: [] }).map((s) => s.path)).toEqual(["/a/{id:int}", "/b/{id}", "/c/{v:float}/{u:uuid}/{s:slug}"]);
    const uuid = "123e4567-e89b-12d3-a456-426614174000";
    const rows: Array<[string, string, boolean]> = [
      ["/a/{id:int}", "/a/7", true],
      ["/a/{id:int}", "/a/static", false],
      ["/a/{id:int}", "/a/{}", true],
      ["/c/{v:float}/{u:uuid}/{s:slug}", `/c/1.5/${uuid}/x`, true],
      ["/c/{v:float}/{u:uuid}/{s:slug}", `/c/x/${uuid}/x`, false],
      ["/c/{v:float}/{u:uuid}/{s:slug}", "/c/1/7/x", false],
      // A convertor registered elsewhere is not read: its segment may take anything.
      ["/c/{v:float}/{u:uuid}/{s:slug}", `/c/1/${uuid}/{}`, true],
    ];
    expect(rows.map(([route, call]) => pathsMatch(route, call))).toEqual(rows.map(([, , m]) => m));
  });

  it("keeps the redirect only where a route surely serves the path it would leave", () => {
    const surface = (method: string, path: string): Surface => ({ id: `s|${method} ${path}`, component: "s", method, path, at: { file: "a.py", line: 1 }, evidence: "text" });
    const call = (method: string, path: string): Call => ({ id: "c", from: "w", to: "s", method, path, at: { file: "b.ts", line: 1 }, evidence: "text", based: false });
    const reached = (surfaces: Surface[], c: Call) => (matchCalls({ surfaces, calls: [c] }).targetsOf.get(0) ?? []).map((s) => s.id);
    const rest = surface("GET", "/api/static/{rest:path}");
    // `static` is not an int, so `/api/{id:int}` does not match `/api/static` and the router redirects it.
    expect(reached([surface("GET", "/api/{id:int}"), rest], call("GET", "/api/static"))).toEqual(["s|GET /api/static/{rest:path}"]);
    // A convertor that is not read may or may not take `static`: either route may serve it.
    expect(reached([surface("GET", "/api/{s:slug}"), rest], call("GET", "/api/static"))).toEqual(["s|GET /api/{s:slug}", "s|GET /api/static/{rest:path}"]);
    // A route of another method that matches the path answers it (405), so it is not redirected; the call's fixed
    // segments name that path together with the ones the redirect fixes.
    const files = surface("GET", "/api/{tenant}/files/{rest:path}");
    expect(reached([surface("POST", "/api/acme/{item}"), files], call("GET", "/api/acme/{}"))).toEqual([]);
    expect(reached([surface("POST", "/api/other/{item}"), files], call("GET", "/api/acme/{}"))).toEqual(["s|GET /api/{tenant}/files/{rest:path}"]);
    // Whether `/api/{}/{}` is `/api/acme/files` is not known; a route that takes any tenant serves every such path.
    expect(reached([surface("POST", "/api/acme/{item}"), files], call("GET", "/api/{}/{}"))).toEqual(["s|GET /api/{tenant}/files/{rest:path}"]);
    expect(reached([surface("POST", "/api/{t}/{item}"), files], call("GET", "/api/{}/{}"))).toEqual([]);
  });
});

describe("routes an OpenAPI document describes", () => {
  const surface = (method: string, path: string, key?: string, version = "3.1.0"): Surface => ({
    id: `s|${method} ${path}`,
    component: "s",
    method,
    path,
    at: { file: "openapi.json", line: 1 },
    evidence: "declared",
    ...(key ? { described: { file: "openapi.json", line: 1 }, describedPath: key, describedVersion: version } : {}),
  });
  const call = (method: string, path: string, slash = false): Call => ({ id: "c", from: "w", to: "s", method, path, at: { file: "b.ts", line: 1 }, evidence: "static", based: false, ...(slash ? { slash: true as const } : {}) });
  const reached = (surfaces: Surface[], c: Call, ranked = new Map<string, Ranking>()) => (matchCalls({ surfaces, calls: [c] }, ranked).targetsOf.get(0) ?? []).map((s) => s.id);

  it("matches a concrete path before its templated counterparts, as OpenAPI 3 does", () => {
    const me = surface("GET", "/users/me", "/users/me");
    const byId = surface("GET", "/users/{id}", "/users/{id}");
    expect(reached([byId, me], call("GET", "/users/me"))).toEqual(["s|GET /users/me"]);
    expect(reached([byId, me], call("GET", "/users/42"))).toEqual(["s|GET /users/{id}"]);
    // A value in the segment may be `me` or not.
    expect(reached([byId, me], call("GET", "/users/{}"))).toEqual(["s|GET /users/{id}", "s|GET /users/me"]);
    expect(reached([byId, me], call("GET", "/users/{id}"))).toEqual(["s|GET /users/{id}"]);
    // Each method is matched on its own: a templated DELETE is not the concrete GET's counterpart.
    expect(reached([surface("DELETE", "/users/{id}", "/users/{id}"), me], call("DELETE", "/users/me"))).toEqual(["s|DELETE /users/{id}"]);
    // Two templated paths stay ambiguous, as the specification leaves them.
    expect(reached([surface("GET", "/{entity}/me", "/{entity}/me"), surface("GET", "/books/{id}", "/books/{id}")], call("GET", "/books/me"))).toEqual([
      "s|GET /{entity}/me",
      "s|GET /books/{id}",
    ]);
  });

  it("keeps registration order where code alone or a Swagger 2.0 document gives the routes", () => {
    const me = surface("GET", "/users/me", "/users/me");
    expect(reached([surface("GET", "/users/{id}"), me], call("GET", "/users/me"))).toEqual(["s|GET /users/{id}", "s|GET /users/me"]);
    const swagger = [surface("GET", "/users/{id}", "/users/{id}", "2.0"), surface("GET", "/users/me", "/users/me", "2.0")];
    expect(reached(swagger, call("GET", "/users/me"))).toEqual(["s|GET /users/{id}", "s|GET /users/me"]);
  });

  it("matches a request without the trailing slash its route's document writes only for GET and HEAD", () => {
    const list = surface("GET", "/api/users", "/api/users/");
    const create = surface("POST", "/api/users", "/api/users/");
    const item = surface("DELETE", "/api/users/{id}", "/api/users/{id}/");
    expect(reached([list, create], call("GET", "/api/users"))).toEqual(["s|GET /api/users"]);
    expect(reached([list, create], call("POST", "/api/users", true))).toEqual(["s|POST /api/users"]);
    const post = matchCalls({ surfaces: [list, create], calls: [call("POST", "/api/users")] });
    expect(post.targetsOf.size).toBe(0);
    expect(post.slashless.get(0)!.map((s) => s.id)).toEqual(["s|POST /api/users"]);
    expect(matchCalls({ surfaces: [item], calls: [call("DELETE", "/api/users/{}")] }).slashless.get(0)!.map((s) => s.id)).toEqual(["s|DELETE /api/users/{id}"]);
    // A call of unread method to the one route it fits is sent with that route's method.
    expect(matchCalls({ surfaces: [create], calls: [call("*", "/api/users")] }).slashless.size).toBe(1);
    // A route read only from code, or one whose document writes no slash, is matched as before.
    expect(reached([surface("POST", "/api/users")], call("POST", "/api/users"))).toEqual(["s|POST /api/users"]);
    expect(reached([surface("POST", "/api/users", "/api/users")], call("POST", "/api/users", true))).toEqual(["s|POST /api/users"]);
  });

  it("reads the trailing slash a call writes", () => {
    expect(callPath("/api/users/")).toEqual({ path: "/api/users", based: false, slash: true });
    expect(callPath("/api/users/?page=2")).toEqual({ path: "/api/users", based: false, slash: true });
    expect(callPath("/api/users")).toEqual({ path: "/api/users", based: false });
  });
});

describe("cycles", () => {
  it("reports each elementary cycle once", () => {
    const found = cycles(new Set(["a->b", "b->c", "c->a", "c->d"]));
    expect(found).toEqual([["a", "b", "c"]]);
  });
  it("finds none in a chain", () => {
    expect(cycles(new Set(["a->b", "b->c"]))).toEqual([]);
  });
  it("finds a ring of any length", () => {
    const names = Array.from({ length: 20 }, (_, i) => `c${String(i).padStart(2, "0")}`);
    const ring = new Set(names.map((n, i) => `${n}->${names[(i + 1) % names.length]}`));
    expect(cycles(ring)).toEqual([names]);
  });
  it("says when it stopped early, and still reports one cycle per cyclic group", () => {
    const names = ["a", "b", "c", "d", "e", "f"];
    const dense = new Set(names.flatMap((x) => names.filter((y) => y !== x).map((y) => `${x}->${y}`)));
    const search = cycleSearch(dense, 50);
    expect(search.complete).toBe(false);
    expect(search.cycles.length).toBeGreaterThan(0);
    expect(cycleSearch(dense).complete).toBe(true);
  });
});

describe("callsFromText", () => {
  it("reads Kotlin templates and the verb before them", () => {
    const calls = callsFromText("Api.kt", 'val r = http.post("$baseUrl/orders/${id}/pay") {}', { from: "app", to: "api", files: [] });
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({ method: "POST", path: "/orders/{}/pay", based: true });
  });
  it("reads single-quoted Python strings, f-strings included", () => {
    const calls = callsFromText("client.py", "r = http.get('/orders')\nq = http.delete(f'/orders/{order_id}')\n", { from: "app", to: "api", files: [] });
    expect(calls.map((c) => `${c.method} ${c.path}`)).toEqual(["GET /orders", "DELETE /orders/{}"]);
  });
});

describe("routesFromTypeScript", () => {
  const nest = { component: "svc", files: [], styles: ["nest" as const] };
  const ids = (text: string, spec: Parameters<typeof routesFromTypeScript>[2] = nest) =>
    routesFromTypeScript("a.ts", text, spec).map((s) => `${s.method} ${s.path}`);

  it("reads HEAD and OPTIONS routes", () => {
    expect(ids('@Controller("x")\nclass C {\n  @Head() h() {}\n  @Options(":id") o() {}\n}')).toEqual(["HEAD /x", "OPTIONS /x/{id}"]);
    const express = { component: "svc", files: [], styles: ["express" as const] };
    expect(ids('app.options("/orders", h);\napp.head("/orders", h);', express)).toEqual(["OPTIONS /orders", "HEAD /orders"]);
  });
  it("registers nothing for a path the file does not spell out", () => {
    expect(ids("@Controller(API_PREFIX)\nclass C {\n  @Get() a() {}\n}")).toEqual([]);
    expect(ids('@Controller("x")\nclass C {\n  @Get(DETAIL_PATH) a() {}\n  @Get() b() {}\n}')).toEqual(["GET /x"]);
  });
  it("says where a registration's path is one the file does not spell out", () => {
    const unread = (text: string, spec: Parameters<typeof routesFromTypeScript>[2] = nest) => {
      const limits: string[] = [];
      const routes = routesFromTypeScript("a.ts", text, spec, { limits }).map((s) => `${s.method} ${s.path}`);
      return { routes, limits };
    };
    const not = (line: number, expr: string) => `routes svc: a.ts:${line} registers a path the file does not spell out (${expr}); its routes are not read`;
    expect(unread("@Controller(API_PREFIX)\nclass C {\n  @Get() a() {}\n}")).toEqual({ routes: [], limits: [not(1, "API_PREFIX")] });
    expect(unread('@Controller("x")\nclass C {\n  @Get(Paths.DETAIL) a() {}\n  @Get() b() {}\n}')).toEqual({ routes: ["GET /x"], limits: [not(3, "Paths.DETAIL")] });
    const fastify = { component: "svc", files: [], styles: ["express" as const], receivers: ["fastify"] };
    const sse = 'const outputPath = "/outputs";\nconst snapshotPath = "/outputs/snapshot";\nfastify.get(outputPath, h);\nfastify.get(\n  `${snapshotPath}`,\n  h,\n);\nfastify.post("/outputs", h);';
    expect(unread(sse, fastify)).toEqual({ routes: ["POST /outputs"], limits: [not(3, "outputPath"), not(5, "`${snapshotPath}`")] });
    // Named in `constants`, the path is read as a GET route, so nothing is left unread.
    expect(unread(sse, { ...fastify, constants: "^(outputPath|snapshotPath)$" })).toEqual({ routes: ["GET /outputs", "GET /outputs/snapshot", "POST /outputs"], limits: [] });
    // Only a constant that reader turned into a route: an imported one, one computed at run time or a parameter that
    // shadows a read one leaves the registration unread, whatever its name.
    const elsewhere = [
      'import { outputPath } from "./paths";',
      "fastify.get(outputPath, h);",
      "const snapshotPath = makePath();",
      "fastify.get(snapshotPath, h);",
      "function register(fastify, streamPath) {",
      "  fastify.get(streamPath, h);",
      "}",
      'const streamPath = "/stream";',
      "fastify.get(streamPath, h);",
    ].join("\n");
    expect(unread(elsewhere, { ...fastify, constants: "Path$" })).toEqual({
      routes: ["GET /stream"],
      limits: [not(2, "outputPath"), not(4, "snapshotPath"), not(6, "streamPath")],
    });
    // `constants` reads a GET route at the constant's own path; another method, or a router's prefix, is a route it
    // does not give, so that registration is still unread.
    const methods = ['const usersPath = "/users";', "app.get(usersPath, h);", "app.post(usersPath, h);", "app.all(usersPath, h);"].join("\n");
    expect(unread(methods, { ...fastify, receivers: ["app"], constants: "Path$" })).toEqual({
      routes: ["GET /users"],
      limits: [not(3, "usersPath"), not(4, "usersPath")],
    });
    const helperGet = { component: "svc", files: [], constants: "Path$", calls: [{ name: "registerRoute", methodArg: 1, pathArg: 2 }] };
    expect(unread('const usersPath = "/users";\nregisterRoute(app, "GET", usersPath, h);\nregisterRoute(app, "PUT", usersPath, h);', helperGet)).toEqual({
      routes: ["GET /users"],
      limits: [not(3, "usersPath")],
    });
    const nestConst = { ...nest, constants: "Path$" };
    expect(unread('const listPath = "/list";\n@Controller("x")\nclass C {\n  @Get(listPath) a() {}\n}', nestConst)).toEqual({
      routes: ["GET /list"],
      limits: [not(4, "listPath")],
    });
    // A setting read with one argument, a receiver atlas does not know, or a literal that is no path register nothing.
    expect(unread('app.get(SETTING);\ncache.get(key, h);\napp.get("*", h);', { ...fastify, receivers: ["app"] })).toEqual({ routes: [], limits: [] });
    const helper = { component: "svc", files: [], calls: [{ name: "registerRoute", methodArg: 1, pathArg: 2 }] };
    expect(unread('registerRoute(app, "GET", "/a", h);\nregisterRoute(app, "POST", ROUTES.b, h);', helper)).toEqual({ routes: ["GET /a"], limits: [not(2, "ROUTES.b")] });
  });
  it("says where a FastAPI route or a registration helper's path is one the file does not spell out", () => {
    const limits: string[] = [];
    const text = [
      "ITEMS = '/items'",
      "@app.get(ITEMS)",
      "def items(): ...",
      '@app.get(f"/items/{KIND}")',
      "def kind(): ...",
      '@app.get(path="/ok")',
      "def ok(): ...",
      "def                    add_endpoint(app, path):",
      "async def add_endpoint(app, path):",
      "    add_endpoint(app, '/agent')",
      "add_endpoint(app, AGENT_PATH)",
    ].join("\n");
    const spec = { component: "svc", files: [], styles: ["fastapi" as const], calls: [{ name: "add_endpoint", pathArg: 1, method: "POST" }] };
    const routes = routesFromPython("a.py", text, spec, limits).map((s) => `${s.method} ${s.path}`);
    expect(routes).toEqual(["GET /ok", "POST /agent"]);
    const not = (line: number, expr: string) => `routes svc: a.py:${line} registers a path the file does not spell out (${expr}); its routes are not read`;
    expect(limits).toEqual([not(2, "ITEMS"), not(4, 'f"/items/{KIND}"'), not(11, "AGENT_PATH")]);
  });
  it("reads paths given as a list or as { path }", () => {
    expect(ids('@Controller({ path: "x", version: "1" })\nclass C {\n  @Get(["a", "b"]) a() {}\n}')).toEqual(["GET /x/a", "GET /x/b"]);
    expect(ids('@Controller({ version: "1" })\nclass C {\n  @Get("a") a() {}\n}')).toEqual(["GET /a"]);
  });
});

describe("documentStart", () => {
  it("recognizes compact JSON, pretty YAML, and nothing else", () => {
    expect(documentStart('{"openapi":"3.1.0","paths":{}}')).toBe(1);
    expect(documentStart("info: {}\nswagger: '2.0'\n")).toBe(9);
    expect(documentStart('{"name":"pkg","openapi":false}'.replace("openapi", "x"))).toBeUndefined();
    expect(documentStart("{not json")).toBeUndefined();
    expect(documentStart("x-meta:\n  openapi: note\nopenapi: 3.0.0\npaths: {}\n")).toBe(24);
    expect(documentStart('{"swagger":"1.2","apis":[]}')).toBeUndefined();
    expect(documentStart('{"openapi":"4.0.0"}')).toBeUndefined();
  });
});

describe("normalizeConfig", () => {
  it("rejects the removed versions section instead of ignoring it", () => {
    expect(() => normalizeConfig({ versions: [] })).toThrow(/versions: contract-version checks \(FA006\) were removed/);
  });
});

describe("surfacePattern", () => {
  const isPublic = surfacePattern(["api|* /admin/**", "api|GET /health"]);
  it("matches exact entries and globs", () => {
    expect(isPublic("api|GET /health")).toBe(true);
    expect(isPublic("api|PUT /admin/home/cards")).toBe(true);
    expect(isPublic("api|POST /health")).toBe(false);
    expect(isPublic("web|GET /admin/x")).toBe(false);
    // Only `*` and `**` are wildcards; every other character of an entry is itself.
    expect(surfacePattern(["api|GET /a\uE000b"])("api|GET /axxb")).toBe(false);
    expect(surfacePattern(["api|GET /a\uE000b"])("api|GET /a\uE000b")).toBe(true);
  });
});

describe("narrowedPath", () => {
  it("takes the route's fixed segment for a hole, a colon inside it included, and keeps the hole under a parameter", () => {
    expect(narrowedPath("/v1:status", "/{}")).toBe("/v1:status");
    expect(narrowedPath("/api/acme/files", "/api/{}/files")).toBe("/api/acme/files");
    for (const route of ["/{id}", "/:id", "/*", "/{*rest}", "/**", "/{rest:path}", "/file-{id}", "/a*b"]) {
      expect(narrowedPath(route, "/{}"), route).toBe("/{}");
    }
  });
});

describe("pathsMatch with partial interpolations", () => {
  it("lets an interpolation stand for text but keeps the fixed text around it", () => {
    expect(pathsMatch("/devices/:id/support-options", "/devices/{}/support-options{}")).toBe(true);
    expect(pathsMatch("/devices/:id/status", "/devices/{}/support-options{}")).toBe(false);
    expect(pathsMatch("/devices", "/resolve{}")).toBe(false);
    expect(pathsMatch("/resolve", "/resolve{}")).toBe(true);
    expect(pathsMatch("/v2-orders", "/v{}-orders")).toBe(true);
  });
  it("matches a route variable inside a segment by the text around it", () => {
    // The route comes first: `{name}` here is the route's variable, not an interpolation in the call.
    expect([pathsMatch("/files/{name}.txt", "/files/readme.txt"), pathsMatch("/files/{name}.txt", "/files/readme.md")]).toEqual([true, false]);
  });
});

describe("call scope", () => {
  const spec = { from: "web", to: "api", files: [] };
  it("names the function, method or constant that holds a TypeScript call", () => {
    const calls = callsFromTypeScript(
      "a.ts",
      [
        "export function listOrders(base: string) { return fetch(`${base}/orders`); }",
        "class Gateway { readOne(id: string) { return this.json(`/orders/${id}`, \"GET\"); } }",
        "export const cancel = (id: string) => http.post(`/orders/${id}/cancel`);",
      ].join("\n"),
      spec,
    );
    expect(calls.map((c) => [c.scope, c.method, c.path])).toEqual([
      ["listOrders", "GET", "/orders"],
      ["readOne", "GET", "/orders/{}"],
      ["cancel", "POST", "/orders/{}/cancel"],
    ]);
  });
  it("names the Kotlin function before a text call", () => {
    const calls = callsFromText("Api.kt", 'class Api {\n  suspend fun create() = http.post("$base/orders")\n  fun home() = http.get("$base/home")\n}', spec);
    expect(calls.map((c) => c.scope)).toEqual(["create", "home"]);
  });
});

describe("Reach", () => {
  const files: Record<string, string> = {
    "src/http.ts": 'import { show } from "./app/index.js";\nregister(app, "GET", "/x", (req) => show(deps, req.id));',
    "src/app/index.ts": 'export { show } from "./show.js";',
    "src/app/show.ts": "import { format } from \"../format.js\";\nexport async function show(deps, id) { const v = await deps.port.readThing(id); return format(v); }",
    "src/format.ts": "export const format = (v) => v.items.map((i) => helper(i));\nfunction helper(i) { return i.port2.other(); }",
  };
  const source: Source = { ref: "TEST", list: () => Object.keys(files), read: (p) => files[p], asOf: () => "2026-11-01T00:00:00Z" };
  it("follows re-exports, imports and local functions to the member methods a handler calls", () => {
    const reach = new Reach(source);
    const sf = reach.parse("src/http.ts")!.sf;
    const call = (sf.statements[1] as ts.ExpressionStatement).expression;
    expect(reach.from("src/http.ts", call)).toEqual(["map", "other", "readThing"]);
  });

  it("leaves out what the framework's handler parameters answer, and keeps what is kept on them", () => {
    const names = (body: string) => {
      const handler = `app.get("/x", (req, res) => { ${body} });`;
      const reach = new Reach({ ...source, read: (p) => (p === "src/h.ts" ? handler : undefined), list: () => ["src/h.ts"] });
      return reach.from("src/h.ts", (reach.parse("src/h.ts")!.sf.statements[0] as ts.ExpressionStatement).expression);
    };
    const aliases = Array.from({ length: 9 }, (_, i) => `const a${i + 1} = ${i ? `a${i}` : "res"};`).join(" ");
    const rows: Array<[string, string[]]> = [
      // On the response, through parentheses, a fluent chain or any number of aliases: the framework's.
      ["res.status(500).json({}); (res).end(); (res).status(204).sendStatus();", []],
      ["const reply = res; reply.redirect();", []],
      [`${aliases} a9.send();`, []],
      // Kept on a parameter, or returned by one of its methods: the component's, whatever its name.
      ["req.services.mail.send();", ["send"]],
      ["req.services.mail.redirect();", ["redirect"]],
      ["req.getClient().publish();", ["publish"]],
    ];
    expect(rows.map(([body]) => names(body))).toEqual(rows.map(([, out]) => out));
    // A wrapped handler is still the handler.
    const wrapped = 'app.get("/x", ((req, res) => res.send("ok")) as Handler);';
    const reach = new Reach({ ...source, read: (p) => (p === "src/w.ts" ? wrapped : undefined), list: () => ["src/w.ts"] });
    expect(reach.from("src/w.ts", (reach.parse("src/w.ts")!.sf.statements[0] as ts.ExpressionStatement).expression)).toEqual([]);
  });

  it("treats a parameter as the framework's only when every call hands it the response", () => {
    const mixed: Record<string, string> = {
      "src/h.ts": 'function forward(x) { x.send(); }\napp.get("/x", (req, res) => { forward(res); forward(req.mailPort); });',
    };
    const reach = new Reach({ ...source, read: (p) => mixed[p], list: () => Object.keys(mixed) });
    const call = (reach.parse("src/h.ts")!.sf.statements[1] as ts.ExpressionStatement).expression;
    expect(reach.from("src/h.ts", call)).toEqual(["send"]);
  });

  it("treats a parameter the handler hands its response to as the framework's", () => {
    const handled: Record<string, string> = {
      "src/h.ts": 'import * as helpers from "./helpers";\napp.get("/x", (req, res) => { helpers.respond(res); });',
      "src/helpers.ts": 'export function respond(reply) { reply.send("ok"); audit.record(); }',
    };
    const reach = new Reach({ ...source, read: (p) => handled[p], list: () => Object.keys(handled) });
    const call = (reach.parse("src/h.ts")!.sf.statements[1] as ts.ExpressionStatement).expression;
    expect(reach.from("src/h.ts", call)).toEqual(["record"]);
  });
});

describe("similarity", () => {
  it("scores shared fixed segments and is zero without one", () => {
    expect(similarity("/orders/:id/refund", "/orders/{}/refunds")).toBeGreaterThan(0);
    expect(similarity("/orders/:id/refund", "/orders/{}/refund")).toBeGreaterThan(similarity("/orders/:id/refund", "/orders/{}/refunds"));
    expect(similarity("/users", "/orders")).toBe(0);
  });
});

describe("coverageDrops", () => {
  const graph = { coverage: [{ source: "calls web->api", files: 3, items: 4 }] } as unknown as Graph;
  it("warns when a source yields less than half of its baseline", () => {
    expect(coverageDrops(graph, { "calls web->api": 10 })).toHaveLength(1);
    expect(coverageDrops(graph, { "calls web->api": 8 })).toHaveLength(0);
    expect(coverageDrops(graph, { "calls app->api": 5 })).toEqual(["calls app->api yields 0 items, 5 at the baseline; check the configuration"]);
  });
});

describe("routeTemplate", () => {
  it("writes framework parameters as OpenAPI path templates", () => {
    expect(routeTemplate("/orders/:id/items/:itemId?")).toBe("/orders/{id}/items/{itemId}");
    expect(routeTemplate("/orders/{id}")).toBe("/orders/{id}");
    expect(routeTemplate("/files/*")).toBe("/files/*");
  });
});

describe("servedDocuments", () => {
  it("reads the swagger-ui plugin, not a scope function that mentions it", () => {
    const text = [
      "app.register(async (scope) => {",
      '  await scope.register(swagger, { openapi: {} });',
      '  await scope.register(swaggerUi, { routePrefix: "/docs/swagger" });',
      '  scope.get("/openapi.json", () => doc);',
      "});",
      'SwaggerModule.setup("/api", app, doc, { jsonDocumentUrl: "/spec.json" });',
    ].join("\n");
    expect(servedDocuments("a.ts", text, "c").map((d) => `${d.location} ${d.convention}`)).toEqual([
      "/docs/swagger/json fastify-swagger-ui",
      "/openapi.json route",
      "/spec.json nest-swagger jsonDocumentUrl",
    ]);
  });
});

describe("resolveApiDescriptions", () => {
  const at = { file: "x", line: 1 };
  const served = (location: string, aliasOf?: string): ApiDocument => ({ component: "api", kind: "served", location, convention: "route", ...(aliasOf ? { aliasOf } : {}), at, evidence: "static" });
  const file = (location: string, missing: string[]): ApiDocument => ({
    component: "api",
    kind: "file",
    location,
    convention: "committed",
    agreement: { surfaces: 2, covered: 2 - missing.length, missing, extra: 0 },
    at,
    evidence: "text",
  });
  const surfaces = [{ component: "api" }, { component: "api" }] as Surface[];
  const decide = (docs: ApiDocument[], openapi: Record<string, string> = {}) => {
    const [d] = resolveApiDescriptions(docs, surfaces, normalizeConfig({ openapi }));
    return `${d!.status} ${d!.location ?? "-"} ${d!.reason}`;
  };

  it("collapses a UI that shows another served document", () => {
    expect(decide([served("/openapi.json"), served("/docs/json", "/openapi.json")])).toBe("chosen /openapi.json AliasesOfOne");
  });
  it("prefers the one committed file that declares every route, over a served document", () => {
    expect(decide([file("a.yaml", []), file("b.yaml", ["api|GET /x"]), served("/openapi.json")])).toBe("chosen a.yaml FileMatchesCode");
  });
  it("takes the served document over partial files", () => {
    expect(decide([file("a.yaml", ["api|GET /x"]), served("/openapi.json")])).toBe("chosen /openapi.json ServedByCode");
  });
  it("does not choose between documents the code cannot tell apart", () => {
    expect(decide([served("/v1/openapi.json"), served("/v2/openapi.json")])).toBe("ambiguous - SeveralServedDocuments");
    expect(decide([file("a.yaml", []), file("b.yaml", [])])).toBe("ambiguous - SeveralCompleteFiles");
    expect(decide([file("a.yaml", ["api|GET /x"]), file("b.yaml", ["api|GET /y"])])).toBe("ambiguous - SeveralPartialFiles");
  });
  it("lets the author settle it", () => {
    expect(decide([served("/v1/openapi.json"), served("/v2/openapi.json")], { api: "/v2/openapi.json" })).toBe("chosen /v2/openapi.json AuthorOverride");
  });
});

describe("flow metadata", () => {
  it("accepts sources with OKF actors and no longer takes the removed trust fields", () => {
    const flow = (metadata: Record<string, unknown>) => ({
      apiVersion: "flow-atlas.dev/v1alpha1",
      kind: "Flow",
      metadata: { name: "a", ...metadata },
      spec: { steps: [{ stepId: "s", surface: "api|GET /x" }] },
    });
    for (const removed of [{ generated: { by: "claude-code/opus-4" } }, { verified: { by: "human:lead" } }, { stale_after: "2027-01-01T00:00:00Z" }]) {
      // The message names the field, so a flow written for an older atlas says what to delete.
      expect(validate("flow", flow(removed))).toEqual([`/metadata must NOT have additional properties (${Object.keys(removed)[0]})`]);
    }
    expect(validate("flow", flow({ sources: [{ resource: "docs/a.md", author: "team:docs" }] }))).toEqual([]);
    expect(validate("flow", flow({ sources: [{ resource: "docs/a.md", author: "the docs team" }] })).length).toBeGreaterThan(0);
  });
});
