import { describe, expect, it } from "vitest";
import { callPath, joinRoute, methodsMatch, pathsMatch, routeTemplate } from "../src/paths.js";
import { cycleSearch, cycles, surfacePattern } from "../src/rules.js";
import { routesFromPython, routesFromTypeScript } from "../src/extract/routes.js";
import { documentStart } from "../src/extract/apidocs.js";
import { callsFromText, callsFromTypeScript } from "../src/extract/calls.js";
import { Reach } from "../src/extract/reach.js";
import { similarity } from "../src/nearby.js";
import ts from "typescript";
import { resolveApiDescriptions, servedDocuments } from "../src/extract/apidocs.js";
import type { ApiDocument, Surface } from "../src/model.js";
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
      "def add_endpoint(app, path):",
      "    add_endpoint(app, '/agent')",
      "add_endpoint(app, AGENT_PATH)",
    ].join("\n");
    const spec = { component: "svc", files: [], styles: ["fastapi" as const], calls: [{ name: "add_endpoint", pathArg: 1, method: "POST" }] };
    const routes = routesFromPython("a.py", text, spec, limits).map((s) => `${s.method} ${s.path}`);
    expect(routes).toEqual(["GET /ok", "POST /agent"]);
    const not = (line: number, expr: string) => `routes svc: a.py:${line} registers a path the file does not spell out (${expr}); its routes are not read`;
    expect(limits).toEqual([not(2, "ITEMS"), not(4, 'f"/items/{KIND}"'), not(10, "AGENT_PATH")]);
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
