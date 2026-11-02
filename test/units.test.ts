import { describe, expect, it } from "vitest";
import { callPath, joinRoute, methodsMatch, pathsMatch, routeTemplate } from "../src/paths.js";
import { cycleSearch, cycles, surfacePattern } from "../src/rules.js";
import { routesFromTypeScript } from "../src/extract/routes.js";
import { documentStart } from "../src/extract/apidocs.js";
import { callsFromText, callsFromTypeScript } from "../src/extract/calls.js";
import { Reach } from "../src/extract/reach.js";
import { similarity } from "../src/nearby.js";
import ts from "typescript";
import { extractVersions } from "../src/extract/registries.js";
import { resolveApiDescriptions, servedDocuments } from "../src/extract/apidocs.js";
import type { ApiDocument, Surface } from "../src/model.js";
import { trustTier } from "../src/flows.js";
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

describe("extractVersions", () => {
  const files: Record<string, string> = {
    "schemas/flow-v1.json": "{}",
    "schemas/flow-v2.json": "{}",
    "schemas/action-flow-v1.json": "{}",
    "schemas/action-flow-v2.json": "{}",
    "active.json": JSON.stringify(["flow-v2.json"]),
  };
  const source: Source = { ref: "TEST", list: () => Object.keys(files), read: (p) => files[p], asOf: () => "2026-11-01T00:00:00Z" };
  const config = normalizeConfig({
    versions: [
      {
        name: "schema",
        files: "schemas/*.json",
        pattern: "(.+)-v(\\d+)\\.json",
        active: { file: "active.json", pattern: "(.+)\\.json" },
        companionOf: "^action-(.+)$",
        references: [],
      },
    ],
  });

  it("lets a companion share the activity of its owning version", () => {
    const active = Object.fromEntries(extractVersions(source, config).map((v) => [v.id, v.active]));
    expect(active).toEqual({ "flow-v1": false, "flow-v2": true, "action-flow-v1": false, "action-flow-v2": true });
  });
});

describe("surfacePattern", () => {
  const isPublic = surfacePattern(["api|* /admin/**", "api|GET /health"]);
  it("matches exact entries and globs", () => {
    expect(isPublic("api|GET /health")).toBe(true);
    expect(isPublic("api|PUT /admin/home/cards")).toBe(true);
    expect(isPublic("api|POST /health")).toBe(false);
    expect(isPublic("web|GET /admin/x")).toBe(false);
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

describe("OKF trust metadata", () => {
  it("derives the trust tier from verified alone, a bare mapping counting as one event", () => {
    expect(trustTier(undefined)).toBe("unverified");
    expect(trustTier({ by: "process:nightly" })).toBe("machine-confirmed");
    expect(trustTier([{ by: "process:nightly" }, { by: "human:lead", at: "2026-10-02T09:00:00Z" }])).toBe("human-reviewed");
  });

  it("accepts OKF actors and timestamps and rejects malformed ones", () => {
    const flow = (metadata: Record<string, unknown>) => ({
      apiVersion: "flow-atlas.dev/v1alpha1",
      kind: "Flow",
      metadata: { name: "a", ...metadata },
      spec: { steps: [{ stepId: "s", surface: "api|GET /x" }] },
    });
    expect(validate("flow", flow({ generated: { by: "claude-code/opus-4", at: "2026-10-01T09:00:00Z" }, verified: { by: "human:lead" } }))).toEqual([]);
    expect(validate("flow", flow({ generated: { by: "claude" } })).length).toBeGreaterThan(0);
    expect(validate("flow", flow({ stale_after: "2026-10-01" })).length).toBeGreaterThan(0);
    expect(validate("flow", flow({ sources: [{ resource: "docs/a.md", author: "team:docs" }] }))).toEqual([]);
    expect(validate("flow", flow({ sources: [{ resource: "docs/a.md", author: "the docs team" }] })).length).toBeGreaterThan(0);
  });
});
