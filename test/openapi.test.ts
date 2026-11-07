import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { definitionLines, describedOperations, handlerNames } from "../src/extract/openapi.js";
import { documentPathKeys, resolveApiDescriptions } from "../src/extract/apidocs.js";
import { validate } from "../src/schema.js";
import { extractRoutes } from "../src/extract/routes.js";
import { loadConfig, normalizeConfig } from "../src/config.js";
import { WorktreeSource, type Source } from "../src/source.js";
import { scan } from "../src/scan.js";
import { inventory } from "../src/inventory.js";
import { Reach } from "../src/extract/reach.js";
import type { Coverage } from "../src/model.js";
import { toArazzo } from "../src/arazzo.js";
import type { LoadedFile } from "../src/flows.js";
import { seedsFor, trace, traceText } from "../src/flow.js";

const root = fileURLToPath(new URL("../fixtures/openapi", import.meta.url));
const doc = (name: string) => describedOperations(name, readFileSync(join(root, name), "utf8"))!;
const ops = (name: string) => doc(name).operations.map((o) => `${o.method} ${o.path} ${o.operationId ?? "-"}`).sort();

describe("documents frameworks generate", () => {
  it("reads FastAPI's OpenAPI 3.1 with its derived operationIds and without hidden routes", () => {
    expect(doc("py-fastapi.json").version).toBe("3.1.0");
    expect(ops("py-fastapi.json")).toEqual([
      "GET /api/v1/orders/{order_id} read_order_api_v1_orders__order_id__get",
      "GET /api/v1/orders/{order_id}/history orderHistory",
      "POST /api/v1/orders create_order_api_v1_orders_post",
    ]);
  });
  it("reads flask-smorest's OpenAPI 3.0, which derives no operationId", () => {
    expect(doc("py-smorest.json").version).toBe("3.0.3");
    expect(ops("py-smorest.json")).toEqual([
      "GET /api/v1/orders/{order_id} -",
      "GET /api/v1/orders/{order_id}/history orderHistory",
      "POST /api/v1/orders -",
    ]);
  });
  it("reads flasgger's Swagger 2.0, which lists only documented routes", () => {
    expect(doc("py-flasgger.json").version).toBe("2.0");
    expect(ops("py-flasgger.json")).toEqual(["GET /api/v1/orders/{order_id} -", "POST /api/v1/orders -"]);
  });
  it("reads drf-spectacular's OpenAPI 3.0 and drops Django's trailing slashes", () => {
    expect(ops("py-drf.json")).toEqual([
      "GET /api/v1/orders/{id} api_v1_orders_retrieve",
      "GET /api/v1/orders/{id}/history api_v1_orders_history_retrieve",
      "GET /internal/health internal_health_retrieve",
      "POST /api/v1/orders api_v1_orders_create",
    ]);
  });
  it("reads Nest's OpenAPI 3.0 with Controller_method operationIds", () => {
    expect(ops("node-nest.json")).toEqual([
      "GET /api/v1/orders/{id} OrdersController_read",
      "GET /api/v1/orders/{id}/history orderHistory",
      "POST /api/v1/orders OrdersController_create",
    ]);
  });
  it("reads @fastify/swagger in both Swagger 2.0 and OpenAPI 3.0 modes to the same operations", () => {
    expect(doc("node-fastify-swagger.json").version).toBe("2.0");
    expect(doc("node-fastify-openapi.json").version).toBe("3.0.3");
    expect(ops("node-fastify-swagger.json")).toEqual(ops("node-fastify-openapi.json"));
    expect(ops("node-fastify-openapi.json")).toEqual([
      "GET /api/v1/orders/{orderId} -",
      "GET /api/v1/orders/{orderId}/history orderHistory",
      "POST /api/v1/orders -",
    ]);
  });
  it("reads springdoc's OpenAPI 3.1 and drops the host of its generated server", () => {
    expect(doc("java-springdoc.json").basePath).toBe("/");
    expect(ops("java-springdoc.json")).toEqual([
      "GET /api/v1/orders/{orderId} read",
      "GET /api/v1/orders/{orderId}/history orderHistory",
      "POST /api/v1/orders create",
    ]);
  });
});

describe("describedOperations", () => {
  it("joins Swagger 2.0 basePath and an OpenAPI 3 server path to each path", () => {
    const swagger = describedOperations("a.yaml", "swagger: '2.0'\nbasePath: /v2\npaths:\n  /items/{id}:\n    get: {operationId: getItem}\n")!;
    expect(swagger.operations).toEqual([
      { method: "GET", key: "/items/{id}", path: "/v2/items/{id}", operationId: "getItem", at: { file: "a.yaml", line: 5 } },
    ]);
    const openapi = describedOperations("b.yaml", "openapi: 3.0.3\nservers: [{url: 'https://api.example.com/base/'}]\npaths:\n  /x:\n    post: {}\n")!;
    expect(openapi.operations.map((o) => o.path)).toEqual(["/base/x"]);
  });
  it("gives the path key each operation is written under, by its full path", () => {
    const keys = documentPathKeys("swagger: '2.0'\nbasePath: /v2\npaths:\n  /items/{itemId}/:\n    get: {}\n");
    expect([...keys!]).toEqual([["GET /v2/items/{}", "/items/{itemId}/"]]);
  });
  it("drops the host of network-path and absolute server URLs and keeps a relative path", () => {
    const base = (url: string) => describedOperations("s.yaml", `openapi: 3.0.3\nservers: [{url: '${url}'}]\npaths: {}\n`)!.basePath;
    expect(base("//api.example.com/v1")).toBe("/v1");
    expect(base("https://api.example.com/v2/")).toBe("/v2/");
    expect(base("/v3")).toBe("/v3");
    expect(base("v4")).toBe("/v4");
    expect(base("https://{environment}.example.com/api/v1")).toBe("/api/v1");
    expect(base("{scheme}://api.example.com/v5")).toBe("/v5");
    expect(base("https://api.example.com/{version}")).toBe("/");
    expect(base("https://example.com/v1?token={token}")).toBe("/v1");
    expect(base("/v2#{section}")).toBe("/v2");
  });

  it("ignores path-level fields that are not operations", () => {
    const api = describedOperations("c.yaml", "openapi: 3.1.0\npaths:\n  /x:\n    parameters: []\n    summary: s\n    get: {}\n")!;
    expect(api.operations.map((o) => o.method)).toEqual(["GET"]);
  });
  it("reads only Swagger 2.0 and OpenAPI 3.x", () => {
    const read = (head: string) => describedOperations("v.yaml", `${head}\npaths:\n  /x:\n    get: {}\n`)?.version;
    expect(read("swagger: '2.0'")).toBe("2.0");
    expect(read("swagger: 2.0")).toBe("2.0");
    expect(read("openapi: 3.0.3")).toBe("3.0.3");
    expect(read("openapi: 3.1.0")).toBe("3.1.0");
    expect(read("swagger: '1.2'")).toBeUndefined();
    expect(read("openapi: 4.0.0")).toBeUndefined();
    expect(read("openapi: 3")).toBeUndefined();
  });

  it("refuses what is not an OpenAPI document", () => {
    expect(describedOperations("d.yaml", "components: []\n")).toBeUndefined();
    expect(describedOperations("e.json", "{not json")).toBeUndefined();
  });
});

describe("handler lookup", () => {
  it("derives the handler names framework conventions put in an operationId", () => {
    expect(handlerNames("read_order_api_v1_orders__order_id__get", "GET", "/api/v1/orders/{order_id}")).toContain("read_order");
    expect(handlerNames("OrdersController_read", "GET", "/orders/{id}")).toEqual(["OrdersController_read", "OrdersController.read", "read"]);
    expect(handlerNames("read", "GET", "/orders/{id}")).toEqual(["read"]);
    expect(handlerNames("Admin_APIController_list", "GET", "/admin")).toEqual([
      "Admin_APIController_list",
      "Admin.APIController_list",
      "Admin_APIController.list",
      "APIController_list",
      "list",
    ]);
    expect(handlerNames("Cats_findAll", "GET", "/cats")).toEqual(["Cats_findAll", "Cats.findAll", "findAll"]);
    expect(handlerNames("api_v1_orders_retrieve", "GET", "/api/v1/orders/{id}")).toEqual(["api_v1_orders_retrieve"]);
  });
  it("finds definitions in Python, TypeScript and Java but not calls", () => {
    expect(definitionLines("a.py", "x = read()\nasync def read(id):\n", "read")).toEqual([2]);
    expect(definitionLines("a.ts", "this.read(1);\nclass A {\n  async read(@Param() id: string): Promise<X> {\n  }\n}\n", "read")).toEqual([3]);
    expect(definitionLines("A.java", "return read(id);\n  public ResponseEntity<Map<String, Object>> read(@PathVariable String id) {\n", "read")).toEqual([2]);
  });
  it("finds Java declarations whatever follows their opening parenthesis", () => {
    const java = [
      "  @GetMapping(\"/x\")",
      "  public Order read(@RequestParam(required = false) String id) {",
      "  int size() { return items.size(); }",
      "  else read(id);",
      "  Order o = read(id);",
    ].join("\n");
    expect(definitionLines("A.java", java, "read")).toEqual([2]);
    expect(definitionLines("A.java", java, "size")).toEqual([3]);
    expect(definitionLines("A.java", '  @Operation(summary = "x") public static <T> List<T> all(Class<T> type) {', "all")).toEqual([1]);
  });
  it("finds generic TypeScript functions and methods", () => {
    const text = ["export function load<T>(id: string): Promise<T> {", "class A {", "  async read<T extends object>(id: string): Promise<T> {", "  }", "}", "load<Order>(1);"].join("\n");
    expect(definitionLines("a.ts", text, "load")).toEqual([1]);
    expect(definitionLines("a.ts", text, "read")).toEqual([3]);
  });
  it("finds a TypeScript method whose signature runs over several lines, as prettier writes it", () => {
    const text = [
      "@Controller('order')",
      "export class OrderController {",
      "  public constructor(private readonly orderService: OrderService) {}",
      "",
      "  @Get(':id')",
      "  @UseGuards(AuthGuard('jwt'))",
      "  public async read(",
      "    @Param('id') id: string,",
      "    @Query('withDetails') withDetails?: string",
      "  ): Promise<OrderResponse> {",
      "    return this.orderService.read(id);",
      "  }",
      "}",
    ].join("\n");
    expect(definitionLines("order.controller.ts", text, "read")).toEqual([7]);
    expect(definitionLines("order.controller.js", text.replace(/: \w+(<\w+>)?/g, ""), "read")).toEqual([7]);
  });
  it("finds a method of a named class by Class.method, in parsed scripts only", () => {
    const text = "class PlatformController {\n  getPlatforms() {}\n}\nclass PlatformsController {\n  getPlatforms() {}\n}\n";
    expect(definitionLines("a.ts", text, "getPlatforms")).toEqual([2, 5]);
    expect(definitionLines("a.ts", text, "PlatformsController.getPlatforms")).toEqual([5]);
    expect(definitionLines("A.kt", "fun PlatformsController.getPlatforms() = 1\n", "PlatformsController.getPlatforms")).toEqual([]);
  });
  it("finds a TypeScript function by its body, not by its overload signatures or calls", () => {
    const text = "export function load(id: string): Order;\nexport function load(id: number): Order;\nexport function load(id: unknown): Order {\n  return load(String(id));\n}\n";
    expect(definitionLines("a.ts", text, "load")).toEqual([3]);
  });
  it("finds a one-line TypeScript method", () => {
    expect(definitionLines("a.ts", "class A {\n  handle() { return 1; }\n}\nhandle();\n", "handle")).toEqual([2]);
  });
  it("finds Kotlin functions by fun, not calls", () => {
    const kt = "fun main() {\n  target(arg)\n  val x = target(arg)\n}\n@GetMapping(\"/x\")\nsuspend fun target(id: String): String = id\n";
    expect(definitionLines("A.kt", kt, "target")).toEqual([6]);
    expect(definitionLines("A.java", "    target(arg)\n", "target")).toEqual([]);
  });
});

describe("routes from an OpenAPI document", () => {
  const config = loadConfig(join(root, "atlas.config.yaml"));
  const surfaces = extractRoutes(new WorktreeSource(root), config);
  const at = (id: string) => {
    const s = surfaces.find((x) => x.id === id)!;
    return `${s.evidence} ${s.at.file}:${s.at.line}`;
  };

  it("places operations on their handlers by derived name, explicit id, or the document", () => {
    expect(at("fastapi|GET /api/v1/orders/{order_id}")).toBe("name apps/fastapi/main.py:7");
    expect(at("fastapi|GET /api/v1/orders/{order_id}/history")).toBe("text apps/fastapi/main.py:16");
    expect(at("nestjs|POST /api/v1/orders")).toBe("name apps/nestjs/main.ts:15");
    expect(at("spring|GET /api/v1/orders/{orderId}")).toBe("name apps/spring-springdoc/src/main/java/lab/OrdersApplication.java:30");
    expect(at("django-drf|GET /api/v1/orders/{id}")).toBe("declared py-drf.json:31");
    expect(at("flasgger|POST /api/v1/orders")).toBe("declared py-flasgger.json:11");
    expect(surfaces.find((s) => s.id === "nestjs|POST /api/v1/orders")?.described).toEqual({ file: "node-nest.json", line: 28 });
  });

  it("takes the document it read as the component's OpenAPI description", () => {
    const graph = scan(new WorktreeSource(root), config);
    expect(graph.apiDescriptions?.find((d) => d.component === "spring")).toMatchObject({
      status: "chosen",
      location: "java-springdoc.json",
      reason: "ReadForRoutes",
    });
    // Documents whose operationIds name no handler, or that write none.
    expect(graph.limits).toEqual([
      "routes flask-smorest: 2 operations of py-smorest.json have no operationId to find a handler by (GET /api/v1/orders/{order_id}, POST /api/v1/orders); they stay at their line in the document",
      "routes flasgger: 2 operations of py-flasgger.json have no operationId to find a handler by (POST /api/v1/orders, GET /api/v1/orders/{order_id}); they stay at their line in the document",
      "routes django-drf: no handler was found in the configured route files for 4 operations of py-drf.json (api_v1_orders_create, api_v1_orders_retrieve, api_v1_orders_history_retrieve, internal_health_retrieve); they stay at their line in the document",
      "routes fastify: 2 operations of node-fastify-openapi.json have no operationId to find a handler by (GET /api/v1/orders/{orderId}, POST /api/v1/orders/); they stay at their line in the document",
      "routes fastify-swagger: 2 operations of node-fastify-swagger.json have no operationId to find a handler by (GET /api/v1/orders/{orderId}, POST /api/v1/orders/); they stay at their line in the document",
    ]);
  });

  const memory = (files: Record<string, string>): Source => ({
    ref: "WORKTREE",
    list: () => Object.keys(files),
    read: (p) => files[p],
    asOf: () => "2026-01-01T00:00:00Z",
  });

  it("adds the document's operationId and place to a route the code registers", () => {
    const source = memory({
      "svc/app.ts": 'const app = express();\napp.get("/items/:id", (req, res) => res.json({}));\n',
      "svc/openapi.yaml": "openapi: 3.0.3\npaths:\n  /items/{id}:\n    get: {operationId: getItem}\n  /items:\n    post: {}\n",
    });
    const config = normalizeConfig({
      components: [{ name: "svc", path: "svc" }],
      routes: [{ component: "svc", files: ["svc/**/*.ts"], styles: ["express"], receivers: ["app"], openapi: "svc/openapi.yaml" }],
    });
    const coverage: Coverage[] = [];
    const surfaces = extractRoutes(source, config, undefined, coverage);
    expect(surfaces.map((s) => `${s.id} ${s.evidence} ${s.at.file}:${s.at.line} ${s.operationId ?? "-"}`)).toEqual([
      "svc|GET /items/{id} static svc/app.ts:2 getItem",
      "svc|POST /items declared svc/openapi.yaml:6 -",
    ]);
    expect(surfaces[0]!.described).toEqual({ file: "svc/openapi.yaml", line: 4 });
    expect(coverage.find((c) => c.source === "routes svc")).toMatchObject({ files: 2, items: 2 });
  });

  it("keeps the document's place when a handler name matches more than once", () => {
    const source = memory({
      "svc/a.py": "def read():\n    pass\n",
      "svc/b.py": "def read():\n    pass\n",
      "svc/openapi.json": '{"openapi":"3.1.0","paths":{"/x":{"get":{"operationId":"read"}}}}',
    });
    const config = normalizeConfig({
      components: [{ name: "svc", path: "svc" }],
      routes: [{ component: "svc", files: ["svc/**/*.py"], openapi: "svc/openapi.json" }],
    });
    expect(extractRoutes(source, config)[0]).toMatchObject({ evidence: "declared", at: { file: "svc/openapi.json", line: 1 } });
  });

  it("reads operationIds that are not identifiers", () => {
    expect(definitionLines("a.py", "def read():\n", "read[")).toEqual([]);
    const source = memory({
      "svc/a.py": '@app.get("/x", operation_id="read[")\ndef x():\n    pass\n',
      "svc/openapi.json": '{"openapi":"3.1.0","paths":{"/x":{"get":{"operationId":"read["}}}}',
    });
    const config = normalizeConfig({ components: [{ name: "svc", path: "svc" }], routes: [{ component: "svc", files: ["svc/**/*.py"], openapi: "svc/openapi.json" }] });
    expect(extractRoutes(source, config)[0]).toMatchObject({ evidence: "text", at: { file: "svc/a.py", line: 1 } });
  });

  it("falls back to the quoted operationId when the handler name matches more than once", () => {
    const source = memory({
      "svc/a.py": '@router.get("/x", operation_id="read")\ndef read():\n    pass\n',
      "svc/b.py": "def read():\n    pass\n",
      "svc/openapi.json": '{"openapi":"3.1.0","paths":{"/x":{"get":{"operationId":"read"}}}}',
    });
    const config = normalizeConfig({ components: [{ name: "svc", path: "svc" }], routes: [{ component: "svc", files: ["svc/**/*.py"], openapi: "svc/openapi.json" }] });
    expect(extractRoutes(source, config)[0]).toMatchObject({ evidence: "text", at: { file: "svc/a.py", line: 1 } });
  });

  it("merges a document with code routes from another entry of the same component, in either order", () => {
    const source = memory({
      "svc/app.ts": 'app.get("/items/:id", (req, res) => res.json({}));\n',
      "svc/openapi.yaml": "openapi: 3.0.3\npaths:\n  /items/{itemId}:\n    get: {operationId: getItem}\n",
    });
    const code = { component: "svc", files: ["svc/**/*.ts"], styles: ["express"] };
    const doc = { component: "svc", files: [], openapi: "svc/openapi.yaml" };
    for (const routes of [[code, doc], [doc, code]]) {
      const surfaces = extractRoutes(source, normalizeConfig({ components: [{ name: "svc", path: "svc" }], routes }));
      expect(surfaces).toEqual([
        expect.objectContaining({
          id: "svc|GET /items/{id}",
          evidence: "static",
          at: { file: "svc/app.ts", line: 1 },
          operationId: "getItem",
          described: { file: "svc/openapi.yaml", line: 4 },
          describedPath: "/items/{itemId}",
        }),
      ]);
    }
  });

  it("keeps document metadata on the surface two entries both register", () => {
    const source = memory({
      "svc/app.ts": 'app.get("/items/:id", (req, res) => res.json({}));\n',
      "svc/openapi.yaml": "openapi: 3.0.3\npaths:\n  /items/{id}:\n    get: {operationId: getItem}\n",
    });
    const entry = { component: "svc", files: ["svc/**/*.ts"], styles: ["express"] };
    const config = normalizeConfig({ components: [{ name: "svc", path: "svc" }], routes: [entry, { ...entry, openapi: "svc/openapi.yaml" }] });
    expect(extractRoutes(source, config)).toEqual([
      expect.objectContaining({ id: "svc|GET /items/{id}", evidence: "static", operationId: "getItem", describedPath: "/items/{id}" }),
    ]);
  });

  it("takes operationIds and places from the description the configuration chooses", () => {
    const source = memory({
      "svc/a.yaml": "openapi: 3.0.3\npaths:\n  /x:\n    get: {operationId: idA}\n",
      "svc/b.yaml": "openapi: 3.0.3\npaths:\n  /x:\n    get: {operationId: idB}\n",
    });
    const routes = [
      { component: "svc", files: [], openapi: "svc/a.yaml" },
      { component: "svc", files: [], openapi: "svc/b.yaml" },
    ];
    const pick = (openapi?: Record<string, string>) =>
      extractRoutes(source, normalizeConfig({ components: [{ name: "svc", path: "svc" }], routes, ...(openapi ? { openapi } : {}) }))[0];
    expect(pick()).toMatchObject({ operationId: "idA", described: { file: "svc/a.yaml" } });
    expect(pick({ svc: "svc/b.yaml" })).toMatchObject({ operationId: "idB", described: { file: "svc/b.yaml" } });
  });

  it("follows the located TypeScript handler of a documented operation", () => {
    const files = {
      "svc/orders.controller.ts": [
        'import { Controller, Get } from "@nestjs/common";',
        "@Controller()",
        "export class OrdersController {",
        "  constructor(private readonly port: OrdersPort) {}",
        "  @Get(ROUTE)",
        '  @ApiOperation({ operationId: "listOrders" })',
        "  list() {",
        "    return this.port.findAll();",
        "  }",
        "  read(id: string) {",
        "    return this.port.findOne(id);",
        "  }",
        "}",
      ].join("\n"),
      "svc/openapi.json": JSON.stringify({
        openapi: "3.0.3",
        paths: { "/api/orders": { get: { operationId: "listOrders" } }, "/api/orders/{id}": { get: { operationId: "OrdersController_read" } } },
      }),
    };
    const source = memory(files);
    const config = normalizeConfig({ components: [{ name: "svc", path: "svc" }], routes: [{ component: "svc", files: ["svc/**/*.ts"], openapi: "svc/openapi.json" }] });
    const surfaces = extractRoutes(source, config, new Reach(source));
    expect(surfaces.map((s) => `${s.id} ${s.evidence} ${(s.reaches ?? []).join(",")}`)).toEqual([
      "svc|GET /api/orders text findAll",
      "svc|GET /api/orders/{id} name findOne",
    ]);
  });

  it("follows the handler a route registration passes with its operationId", () => {
    const files = {
      "svc/app.ts": [
        "export default async function plugin(orders) {",
        '  orders.get(ROUTE, { schema: { operationId: "history" } }, async () => store.history());',
        "}",
      ].join("\n"),
      "svc/openapi.json": JSON.stringify({ openapi: "3.0.3", paths: { "/history": { get: { operationId: "history" } } } }),
    };
    const source = memory(files);
    const config = normalizeConfig({ components: [{ name: "svc", path: "svc" }], routes: [{ component: "svc", files: ["svc/**/*.ts"], openapi: "svc/openapi.json" }] });
    expect(extractRoutes(source, config, new Reach(source))[0]).toMatchObject({ evidence: "text", at: { file: "svc/app.ts", line: 2 }, reaches: ["history"] });
  });

  it("keeps the handlers of the real fixtures followed", () => {
    const graph = scan(new WorktreeSource(root), config);
    expect(graph.surfaces.filter((s) => s.reaches).map((s) => s.id).sort()).toEqual([
      "fastify-swagger|GET /api/v1/orders/{orderId}/history",
      "fastify|GET /api/v1/orders/{orderId}/history",
      "nestjs|GET /api/v1/orders/{id}",
      "nestjs|GET /api/v1/orders/{id}/history",
      "nestjs|POST /api/v1/orders",
    ]);
  });

  it("ignores a Python mention of an operationId that does not declare it", () => {
    const source = memory({
      "svc/a.py": 'log.info("theId")\n@router.get("/x", operation_id = "theId")\ndef x():\n    pass\n',
      "svc/openapi.json": '{"openapi":"3.1.0","paths":{"/x":{"get":{"operationId":"theId"}}}}',
    });
    const config = normalizeConfig({ components: [{ name: "svc", path: "svc" }], routes: [{ component: "svc", files: ["svc/**/*.py"], openapi: "svc/openapi.json" }] });
    expect(extractRoutes(source, config)[0]).toMatchObject({ evidence: "text", at: { file: "svc/a.py", line: 2 } });
  });

  it("takes a quoted operationId only where code declares it, not where a body mentions it", () => {
    const files = {
      "svc/a.ts": [
        'function helper() { return lookup("listOrders"); }',
        "class C {",
        '  @ApiOperation({ operationId: "readOrder" }) read() { return this.port.findOne(); }',
        "}",
      ].join("\n"),
      "svc/openapi.json": JSON.stringify({ openapi: "3.0.3", paths: { "/orders": { get: { operationId: "listOrders" } }, "/orders/{id}": { get: { operationId: "readOrder" } } } }),
    };
    const source = memory(files);
    const config = normalizeConfig({ components: [{ name: "svc", path: "svc" }], routes: [{ component: "svc", files: ["svc/**/*.ts"], openapi: "svc/openapi.json" }] });
    const surfaces = extractRoutes(source, config, new Reach(source));
    expect(surfaces.map((s) => `${s.id} ${s.evidence} ${s.at.file}:${s.at.line} ${s.reaches === undefined ? "-" : s.reaches.join(",")}`)).toEqual([
      "svc|GET /orders declared svc/openapi.json:1 -",
      "svc|GET /orders/{id} text svc/a.ts:3 findOne",
    ]);
    expect(Object.keys(surfaces[1]!.at)).toEqual(["file", "line"]);
  });

  it("exports an operationPath with the key the document writes", () => {
    const graph = scan(new WorktreeSource(root), config);
    expect(graph.surfaces.find((s) => s.id === "fastify|POST /api/v1/orders")?.describedPath).toBe("/api/v1/orders/");
    const flow = {
      apiVersion: "flow-atlas.dev/v1alpha1",
      kind: "Flow",
      metadata: { name: "create" },
      spec: { steps: [{ stepId: "create", surface: "fastify|POST /api/v1/orders" }] },
    } as LoadedFile["flows"][number]["object"];
    const files: LoadedFile[] = [{ file: "f.flow.yaml", text: "", errors: [], flows: [{ object: flow, line: 1, stepLine: () => 1 }] }];
    const { document } = toArazzo(graph, files, config, { title: "t" });
    const step = (document.workflows as Array<{ steps: Array<Record<string, unknown>> }>)[0]!.steps[0]!;
    expect(step.operationPath).toBe("{$sourceDescriptions.fastify.url}#/paths/~1api~1v1~1orders~1/post");
  });

  it("says a document outside the repository is not read at the revision", () => {
    const outside = join(root, "py-drf.json");
    const source = { ...memory({}), ref: "0123456789abcdef0123" };
    const config = normalizeConfig({ components: [{ name: "svc", path: "svc" }], routes: [{ component: "svc", files: [], openapi: outside }] });
    const limits: string[] = [];
    const surfaces = extractRoutes(source, config, undefined, [], limits);
    expect(surfaces).toHaveLength(4);
    expect(surfaces[0]!.at.file).toBe(outside);
    expect(limits).toEqual([`routes svc: ${outside} is outside the repository and is read as it is now, not at 0123456789ab`]);
  });

  it("says which documented operations have no handler in the route files, and which have no operationId to find one by", () => {
    const source = memory({
      "svc/views.py": "class UserViewSet(viewsets.ModelViewSet):\n    queryset = User.objects.all()\n",
      "svc/schema.yml": "openapi: 3.0.3\npaths:\n  /api/users/:\n    get: {operationId: users_list}\n    post: {operationId: users_create}\n  /api/health/:\n    get: {}\n",
    });
    const limits: string[] = [];
    const routes = (files: string[]) => normalizeConfig({ components: [{ name: "svc", path: "svc" }], routes: [{ component: "svc", files, openapi: "svc/schema.yml" }] });
    extractRoutes(source, routes(["svc/**/*.py"]), undefined, [], limits);
    expect(limits).toEqual([
      "routes svc: no handler was found in the configured route files for 2 operations of svc/schema.yml (users_list, users_create); they stay at their line in the document",
      "routes svc: 1 operation of svc/schema.yml has no operationId to find a handler by (GET /api/health/); it stays at its line in the document",
    ]);
    // Where no route files are configured, no handler was looked for.
    limits.length = 0;
    extractRoutes(source, routes([]), undefined, [], limits);
    expect(limits).toEqual([]);
  });

  it("says a trace stops at a documented operation whose handler was not found", () => {
    const source = memory({
      "svc/views.py": "class UserViewSet(viewsets.ModelViewSet):\n    pass\n",
      "svc/schema.yml": "openapi: 3.0.3\npaths:\n  /api/users/:\n    get: {operationId: users_list}\n",
    });
    const graph = scan(source, normalizeConfig({ components: [{ name: "svc", path: "svc" }], routes: [{ component: "svc", files: ["svc/**/*.py"], openapi: "svc/schema.yml" }] }));
    const text = traceText(trace(graph, seedsFor(graph, "svc|GET /api/users")));
    expect(text).toContain("not traced: no handler of this operation was found in the configured route files");
    expect(text).not.toContain("TypeScript");
  });

  it("follows the method of the class the operationId names, though another class on its line has one of that name", () => {
    const source = memory({
      "api/users.ts": "class A { read() { return this.a(); } a() {} } class B { read() { return this.b(); } b() {} }\n",
      "api/openapi.json": JSON.stringify({ openapi: "3.0.0", paths: { "/users": { get: { operationId: "B_read" } } } }),
    });
    const config = normalizeConfig({ components: [{ name: "api", path: "api" }], routes: [{ component: "api", files: ["api/**/*.ts"], openapi: "api/openapi.json" }] });
    const [surface] = extractRoutes(source, config, new Reach(source), [], []);
    expect(surface).toMatchObject({ evidence: "name", at: { file: "api/users.ts", line: 1 }, reaches: ["b"] });
  });

  it("finds and follows a Nest handler whose signature runs over several lines", () => {
    const source = memory({
      "api/order.controller.ts": [
        "@Controller('order')",
        "export class OrderController {",
        "  public constructor(private readonly orderService: OrderService) {}",
        "",
        "  @Get(':id')",
        "  public async read(",
        "    @Param('id') id: string",
        "  ): Promise<OrderResponse> {",
        "    return this.orderService.findOne(id);",
        "  }",
        "}",
      ].join("\n"),
      "api/openapi.json": JSON.stringify({ openapi: "3.0.0", paths: { "/api/v1/order/{id}": { get: { operationId: "OrderController_read" } } } }, null, 2),
    });
    const config = normalizeConfig({ components: [{ name: "api", path: "api" }], routes: [{ component: "api", files: ["api/**/*.ts"], openapi: "api/openapi.json" }] });
    const limits: string[] = [];
    const [surface] = extractRoutes(source, config, new Reach(source), [], limits);
    expect(surface).toMatchObject({ evidence: "name", at: { file: "api/order.controller.ts", line: 6 }, reaches: ["findOne"] });
    expect(limits).toEqual([]);
  });

  it("reports a document that cannot be read as a limit instead of stopping", () => {
    const dir = mkdtempSync(join(tmpdir(), "atlas-openapi-"));
    const config = normalizeConfig({ components: [{ name: "svc", path: "svc" }], routes: [{ component: "svc", files: [], openapi: dir }] });
    const limits: string[] = [];
    expect(extractRoutes(memory({}), config, undefined, [], limits)).toEqual([]);
    expect(limits).toEqual([`routes svc: the OpenAPI document ${dir} could not be read (EISDIR)`]);
  });

  it("lists every document read for routes as a candidate when several are", () => {
    const config = normalizeConfig({
      components: [{ name: "svc", path: "svc" }],
      routes: [
        { component: "svc", files: [], openapi: "svc/a.json" },
        { component: "svc", files: [], openapi: "svc/b.json" },
      ],
    });
    expect(resolveApiDescriptions([], [], config)).toEqual([
      { component: "svc", status: "ambiguous", reason: "SeveralReadForRoutes", message: "candidates: svc/a.json, svc/b.json", candidates: ["svc/a.json", "svc/b.json"] },
    ]);
  });

  it("rejects an empty or relative describedPath", () => {
    const graph = scan(new WorktreeSource(root), config);
    const surface = graph.surfaces.find((s) => s.describedPath)!;
    for (const bad of ["", "orders"]) {
      const broken = { ...graph, surfaces: [{ ...surface, describedPath: bad }] };
      expect(validate("graph", broken).length).toBeGreaterThan(0);
    }
    expect(validate("graph", graph)).toEqual([]);
  });

  it("reports a missing or foreign document as a limit", () => {
    const source = memory({ "svc/notes.yaml": "title: notes\n" });
    const config = normalizeConfig({
      components: [{ name: "svc", path: "svc" }],
      routes: [
        { component: "svc", files: [], openapi: "svc/openapi.yaml" },
        { component: "svc", files: [], openapi: "svc/notes.yaml" },
      ],
    });
    const limits: string[] = [];
    expect(extractRoutes(source, config, undefined, [], limits)).toEqual([]);
    expect(limits).toEqual([
      "routes svc: the OpenAPI document svc/openapi.yaml is not there at this revision",
      "routes svc: svc/notes.yaml is not a Swagger 2.0 or OpenAPI 3 document",
    ]);
  });
});

describe("documents springdoc serves", () => {
  const files = (entries: Record<string, string>): Source => ({
    ref: "WORKTREE",
    list: () => Object.keys(entries),
    read: (p) => entries[p],
    asOf: () => "2026-01-01T00:00:00Z",
  });
  const controller = {
    "svc/src/main/java/lab/App.java": "package lab;\n\n@SpringBootApplication\nclass App {}\n",
    "svc/src/main/java/lab/ItemsController.java": 'package lab;\n@RestController\nclass ItemsController {\n  @GetMapping("/items")\n  List<String> list() { return List.of(); }\n}\n',
  };
  const POM = [
    "<project>",
    "  <dependencies>",
    "    <dependency>",
    "      <groupId>org.springdoc</groupId>",
    "      <artifactId>springdoc-openapi-starter-webmvc-ui</artifactId>",
    "    </dependency>",
    "  </dependencies>",
    "</project>",
  ].join("\n");
  const RESOURCES = "svc/src/main/resources";
  const run = (entries: Record<string, string>, extra: Record<string, unknown> = {}, styles = ["spring"]) => {
    const config = normalizeConfig({
      components: [{ name: "svc", path: "svc" }],
      routes: [{ component: "svc", files: ["svc/src/main/**/*.{java,kt}"], styles }],
      ...extra,
    });
    const graph = scan(files({ ...controller, ...entries }), config);
    const d = graph.apiDescriptions.find((x) => x.component === "svc");
    return {
      documents: graph.apiDocuments.map((x) => `${x.location} ${x.convention} ${x.at.file}:${x.at.line}`),
      description: d ? `${d.status} ${d.location ?? "-"} ${d.reason}` : "-",
      limits: graph.limits,
    };
  };

  it("finds the documents a real springdoc application serves, as its own test shows", () => {
    const app = "apps/spring-springdoc-groups";
    const config = (openapi?: Record<string, string>) =>
      normalizeConfig({
        components: [{ name: "catalog", path: app }],
        routes: [{ component: "catalog", files: [`${app}/src/main/**/*.java`], styles: ["spring"] }],
        ...(openapi ? { openapi } : {}),
      });
    const graph = scan(new WorktreeSource(root), config());
    expect(graph.apiDocuments.map((d) => `${d.component} ${d.kind} ${d.location} ${d.convention} ${d.at.file}:${d.at.line}`)).toEqual([
      `catalog served /api-docs springdoc api-docs.path ${app}/src/main/resources/application.yml:6`,
      `catalog served /api-docs/internal springdoc group-configs ${app}/src/main/resources/application.yml:8`,
      `catalog served /api-docs/public springdoc group ${app}/src/main/java/lab/CatalogApplication.java:23`,
    ]);
    expect(graph.apiDescriptions).toEqual([
      {
        component: "catalog",
        status: "ambiguous",
        reason: "SeveralServedDocuments",
        message: "candidates: /api-docs, /api-docs/internal, /api-docs/public",
        candidates: ["/api-docs", "/api-docs/internal", "/api-docs/public"],
      },
    ]);
    expect(graph.limits).toEqual([
      `openapi catalog: ${app}/src/main/resources/application-dev.yml:3 sets springdoc.api-docs.path for the profile dev, which is chosen at launch; it is not read`,
    ]);
    expect(validate("graph", graph)).toEqual([]);
    expect(scan(new WorktreeSource(root), config({ catalog: "/api-docs/public" })).apiDescriptions[0]).toMatchObject({
      status: "chosen",
      location: "/api-docs/public",
      reason: "AuthorOverride",
    });
  });

  it("lists in the inventory what each Maven or Gradle project's springdoc serves", () => {
    const served = inventory(new WorktreeSource(root), []).apiDocuments.filter((d) => d.kind === "served");
    expect(served.map((d) => `${d.component} ${d.location} ${d.convention} ${d.at.file}:${d.at.line}`)).toEqual([
      "spring-springdoc /v3/api-docs springdoc default apps/spring-springdoc/pom.xml:23",
      "spring-springdoc-groups /api-docs springdoc api-docs.path apps/spring-springdoc-groups/src/main/resources/application.yml:6",
      "spring-springdoc-groups /api-docs/internal springdoc group-configs apps/spring-springdoc-groups/src/main/resources/application.yml:8",
      "spring-springdoc-groups /api-docs/public springdoc group apps/spring-springdoc-groups/src/main/java/lab/CatalogApplication.java:23",
    ]);
  });

  it("serves /v3/api-docs where the build names springdoc and nothing moves it", () => {
    expect(run({ "svc/pom.xml": POM })).toEqual({
      documents: ["/v3/api-docs springdoc default svc/pom.xml:5"],
      description: "chosen /v3/api-docs ServedByCode",
      limits: [],
    });
    expect(run({ "svc/build.gradle.kts": 'dependencies {\n  implementation("org.springdoc:springdoc-openapi-starter-webmvc-ui:2.8.13")\n}\n' }).documents).toEqual([
      "/v3/api-docs springdoc default svc/build.gradle.kts:2",
    ]);
    expect(run({ "svc/build.gradle": "dependencies {\n  implementation libs.springdoc.openapi.starter.webmvc.ui\n}\n" }).documents).toEqual([
      "/v3/api-docs springdoc default svc/build.gradle:2",
    ]);
  });

  it("finds none without springdoc, or where the configuration does not read Spring", () => {
    const yml = { [`${RESOURCES}/application.yml`]: "springdoc:\n  api-docs:\n    path: /docs\n" };
    expect(run({ "svc/pom.xml": "<project/>\n", ...yml })).toEqual({ documents: [], description: "none - NoneFound", limits: [] });
    expect(run({ "svc/build.gradle": "dependencies {\n  // implementation 'org.springdoc:springdoc-openapi-starter-webmvc-ui:2.8.13'\n}\n" }).documents).toEqual([]);
    expect(run({ "svc/pom.xml": "<project>\n<!-- <artifactId>springdoc-openapi-starter-webmvc-ui</artifactId> -->\n</project>\n" }).documents).toEqual([]);
    expect(run({ "svc/pom.xml": POM }, {}, []).documents).toEqual([]);
  });

  it("reads the path, groups and context path from application.yml and application.properties", () => {
    const yml = [
      "server:",
      "  servlet:",
      "    context-path: /shop",
      "springdoc:",
      "  api-docs:",
      "    path: /docs",
      "  swagger-ui:",
      "    path: /ui.html",
      "  group-configs:",
      "    - group: admin",
      "      paths-to-match: /admin/**",
    ].join("\n");
    expect(run({ "svc/pom.xml": POM, [`${RESOURCES}/application.yml`]: yml }).documents).toEqual([
      `/shop/docs springdoc api-docs.path ${RESOURCES}/application.yml:6`,
      `/shop/docs/admin springdoc group-configs ${RESOURCES}/application.yml:10`,
    ]);
    const properties = ["# documents", "springdoc.apiDocs.path=/docs", "springdoc.group-configs[0].group = admin", "springdoc.group-configs[1].group: ops"].join("\n");
    expect(run({ "svc/pom.xml": POM, [`${RESOURCES}/application.properties`]: properties }).documents).toEqual([
      `/docs springdoc api-docs.path ${RESOURCES}/application.properties:2`,
      `/docs/admin springdoc group-configs ${RESOURCES}/application.properties:3`,
      `/docs/ops springdoc group-configs ${RESOURCES}/application.properties:4`,
    ]);
  });

  it("lets application.properties over application.yml, and config/ over both, decide the path", () => {
    const docs = (path: string) => `springdoc:\n  api-docs:\n    path: ${path}\n`;
    expect(
      run({
        "svc/pom.xml": POM,
        [`${RESOURCES}/application.yml`]: docs("/a"),
        [`${RESOURCES}/application.properties`]: "springdoc.api-docs.path=/b\n",
      }).documents,
    ).toEqual([`/b springdoc api-docs.path ${RESOURCES}/application.properties:1`]);
    expect(
      run({
        "svc/pom.xml": POM,
        [`${RESOURCES}/application.properties`]: "springdoc.api-docs.path=/b\n",
        [`${RESOURCES}/config/application.yml`]: docs("/c"),
      }).documents,
    ).toEqual([`/c springdoc api-docs.path ${RESOURCES}/config/application.yml:3`]);
  });

  it("reads GroupedOpenApi beans whose group is a literal or a constant of the file, in Java and Kotlin", () => {
    const java = [
      "package lab;",
      "",
      "@Configuration",
      "class Docs {",
      '  static final String ADMIN = "admin";',
      "  @Bean GroupedOpenApi publicApi() {",
      '    return GroupedOpenApi.builder().group("public").pathsToMatch("/api/**").build();',
      "  }",
      "  @Bean GroupedOpenApi adminApi() {",
      "    return GroupedOpenApi.builder().pathsToMatch(\"/admin/**\").group(ADMIN).build();",
      "  }",
      "  // @Bean GroupedOpenApi oldApi() { return GroupedOpenApi.builder().group(\"old\").build(); }",
      "}",
    ].join("\n");
    const kotlin = [
      "package lab",
      "",
      "@Configuration",
      "class KotlinDocs {",
      "  @Bean",
      "  fun internalApi(): GroupedOpenApi = GroupedOpenApi.builder()",
      '      .group("internal")',
      '      .pathsToMatch("/internal/**")',
      "      .build()",
      "}",
    ].join("\n");
    expect(run({ "svc/pom.xml": POM, "svc/src/main/java/lab/Docs.java": java, "svc/src/main/kotlin/lab/Docs.kt": kotlin })).toEqual({
      documents: [
        "/v3/api-docs springdoc default svc/pom.xml:5",
        "/v3/api-docs/admin springdoc group svc/src/main/java/lab/Docs.java:10",
        "/v3/api-docs/internal springdoc group svc/src/main/kotlin/lab/Docs.kt:7",
        "/v3/api-docs/public springdoc group svc/src/main/java/lab/Docs.java:7",
      ],
      description: "ambiguous - SeveralServedDocuments",
      limits: [],
    });
  });

  it("takes springdoc as present when the code builds a group, though the build does not name it", () => {
    const java = 'package lab;\n@Configuration\nclass Docs {\n  @Bean GroupedOpenApi api() { return GroupedOpenApi.builder().group("public").build(); }\n}\n';
    expect(run({ "svc/pom.xml": "<project/>\n", "svc/src/main/java/lab/Docs.java": java }).documents).toEqual([
      "/v3/api-docs springdoc default svc/src/main/java/lab/Docs.java:4",
      "/v3/api-docs/public springdoc group svc/src/main/java/lab/Docs.java:4",
    ]);
  });

  it("serves no document where springdoc is turned off, and only the groups without the default one", () => {
    const off = { "svc/pom.xml": POM, [`${RESOURCES}/application.properties`]: "springdoc.api-docs.enabled=false\nspringdoc.group-configs[0].group=admin\n" };
    expect(run(off)).toEqual({ documents: [], description: "none - NoneFound", limits: [] });
    const groupsOnly = { "svc/pom.xml": POM, [`${RESOURCES}/application.yml`]: "springdoc:\n  enable-default-api-docs: false\n  group-configs:\n    - group: admin\n" };
    expect(run(groupsOnly).documents).toEqual([`/v3/api-docs/admin springdoc group-configs ${RESOURCES}/application.yml:4`]);
  });

  it("says what it does not read instead of guessing", () => {
    const yml = (body: string) => ({ "svc/pom.xml": POM, [`${RESOURCES}/application.yml`]: body });
    expect(run(yml("springdoc:\n  api-docs:\n    path: ${DOCS_PATH:/docs}\n"))).toEqual({
      documents: [],
      description: "none - NoneFound",
      limits: [`openapi svc: ${RESOURCES}/application.yml:3 sets springdoc.api-docs.path to \${DOCS_PATH:/docs}, resolved at run time; the documents springdoc serves are not read`],
    });
    expect(run(yml("springdoc:\n  api-docs:\n    enabled: ${DOCS_ENABLED:true}\n")).limits).toEqual([
      `openapi svc: ${RESOURCES}/application.yml:3 sets springdoc.api-docs.enabled to \${DOCS_ENABLED:true}, resolved at run time; the documents springdoc serves are not read`,
    ]);
    expect(run(yml("server:\n  servlet:\n    context-path: ${BASE}\n")).limits).toEqual([
      `openapi svc: ${RESOURCES}/application.yml:3 sets server.servlet.context-path to \${BASE}, resolved at run time; the documents springdoc serves are not read`,
    ]);
    expect(run(yml("springdoc:\n  use-management-port: true\n"))).toEqual({
      documents: [],
      description: "none - NoneFound",
      limits: [`openapi svc: ${RESOURCES}/application.yml:2 serves springdoc's documents on the management port (springdoc.use-management-port); they are not read`],
    });
    expect(run(yml("springdoc:\n  group-configs:\n    - group: ${GROUP}\n"))).toEqual({
      documents: ["/v3/api-docs springdoc default svc/pom.xml:5"],
      description: "chosen /v3/api-docs ServedByCode",
      limits: [`openapi svc: ${RESOURCES}/application.yml:3 sets springdoc.group-configs[0].group to \${GROUP}, resolved at run time; that group's document is not read`],
    });
    const built = 'package lab;\n@Configuration\nclass Docs {\n  @Bean GroupedOpenApi api(@Value("${group}") String name) {\n    return GroupedOpenApi.builder().group(name).build();\n  }\n}\n';
    expect(run({ "svc/pom.xml": POM, "svc/src/main/java/lab/Docs.java": built }).limits).toEqual([
      "openapi svc: svc/src/main/java/lab/Docs.java:5 builds a GroupedOpenApi whose group the file does not spell out (name); that group's document is not read",
    ]);
  });

  it("leaves out what applies only under a profile, and says so", () => {
    const yml = ["springdoc:", "  api-docs:", "    path: /docs", "---", "spring:", "  config:", "    activate:", "      on-profile: prod", "springdoc:", "  api-docs:", "    enabled: false"].join("\n");
    expect(run({ "svc/pom.xml": POM, [`${RESOURCES}/application.yml`]: yml, [`${RESOURCES}/application-dev.properties`]: "springdoc.group-configs[0].group=debug\nlogging.level.root=DEBUG\n" })).toEqual({
      documents: [`/docs springdoc api-docs.path ${RESOURCES}/application.yml:3`],
      description: "chosen /docs ServedByCode",
      limits: [
        `openapi svc: ${RESOURCES}/application-dev.properties:1 sets springdoc.group-configs[0].group for the profile dev, which is chosen at launch; it is not read`,
        `openapi svc: ${RESOURCES}/application.yml:11 sets springdoc.api-docs.enabled for the profile prod, which is chosen at launch; it is not read`,
      ],
    });
  });

  it("gives every component of one application its documents, and says a limit once", () => {
    const config = normalizeConfig({
      components: [
        { name: "orders", path: "src/main/java/lab/orders" },
        { name: "billing", path: "src/main/java/lab/billing" },
      ],
      routes: [
        { component: "orders", files: ["src/main/java/lab/orders/**/*.java"], styles: ["spring"] },
        { component: "billing", files: ["src/main/java/lab/billing/**/*.java"], styles: ["spring"] },
      ],
    });
    const source = files({
      "build.gradle.kts": 'dependencies {\n  implementation("org.springdoc:springdoc-openapi-starter-webmvc-ui:2.8.13")\n}\n',
      "src/main/resources/application-local.yml": "springdoc:\n  api-docs:\n    path: /local-docs\n",
      "src/main/java/lab/App.java": "package lab;\n@SpringBootApplication\npublic class App {}\n",
      "src/main/java/lab/support/Docs.java": 'package lab.support;\n@Configuration\nclass Docs {\n  @Bean GroupedOpenApi publicApi() { return GroupedOpenApi.builder().group("public").build(); }\n}\n',
      "src/main/java/lab/orders/OrdersController.java": '@RestController\nclass OrdersController {\n  @GetMapping("/api/orders")\n  List<String> list() { return List.of(); }\n}\n',
      "src/main/java/lab/billing/BillingController.java": '@RestController\nclass BillingController {\n  @GetMapping("/api/bills")\n  List<String> list() { return List.of(); }\n}\n',
    });
    const graph = scan(source, config);
    expect(graph.apiDocuments.map((d) => `${d.component} ${d.location}`)).toEqual([
      "billing /v3/api-docs",
      "billing /v3/api-docs/public",
      "orders /v3/api-docs",
      "orders /v3/api-docs/public",
    ]);
    expect(graph.limits).toEqual([
      "openapi orders, billing: src/main/resources/application-local.yml:3 sets springdoc.api-docs.path for the profile local, which is chosen at launch; it is not read",
    ]);
  });

  it("takes the group the builder's last group(...) sets", () => {
    const java = (chain: string) => `package lab;\n@Configuration\nclass Docs {\n  @Bean GroupedOpenApi api(@Value("\${g}") String name) {\n    return GroupedOpenApi.builder()${chain}.build();\n  }\n}\n`;
    expect(run({ "svc/pom.xml": POM, "svc/src/main/java/lab/Docs.java": java('.group("public").group("internal")') }).documents).toEqual([
      "/v3/api-docs springdoc default svc/pom.xml:5",
      "/v3/api-docs/internal springdoc group svc/src/main/java/lab/Docs.java:5",
    ]);
    expect(run({ "svc/pom.xml": POM, "svc/src/main/java/lab/Docs.java": java('.group("public").group(name)') })).toEqual({
      documents: ["/v3/api-docs springdoc default svc/pom.xml:5"],
      description: "chosen /v3/api-docs ServedByCode",
      limits: ["openapi svc: svc/src/main/java/lab/Docs.java:5 builds a GroupedOpenApi whose group the file does not spell out (name); that group's document is not read"],
    });
  });

  it("does not take a constant for a parameter or local of the same name that hides it", () => {
    const docs = (method: string) =>
      ["package lab;", "@Configuration", "class Docs {", '  static final String GROUP = "public";', method, "}"].join("\n");
    // Only the default document: the group is reported, never listed.
    const hidden = (file: string, text: string, line: number) =>
      expect(run({ "svc/pom.xml": POM, [file]: text })).toEqual({
        documents: ["/v3/api-docs springdoc default svc/pom.xml:5"],
        description: "chosen /v3/api-docs ServedByCode",
        limits: [`openapi svc: ${file}:${line} builds a GroupedOpenApi whose group the file does not spell out (GROUP); that group's document is not read`],
      });
    const java = "svc/src/main/java/lab/Docs.java";
    hidden(java, docs('  @Bean GroupedOpenApi api(@Value("${docs.group}") String GROUP) {\n    return GroupedOpenApi.builder().group(GROUP).build();\n  }'), 6);
    hidden(java, docs('  @Bean GroupedOpenApi api(Environment env) {\n    String GROUP = env.getProperty("docs.group");\n    return GroupedOpenApi.builder().group(GROUP).build();\n  }'), 7);
    const lambda = (parameters: string) =>
      docs(`  @Bean GroupedOpenApi api() {\n    BinaryOperator<String> pick = ${parameters} -> GroupedOpenApi.builder().group(GROUP).build().getGroup();\n    return null;\n  }`);
    hidden(java, lambda("(left, GROUP)"), 6);
    hidden(java, lambda("(String left, String GROUP)"), 6);
    hidden(java, lambda("(var left, var GROUP)"), 6);
    const kotlin = (body: string) => ["package lab", "@Configuration", "class Docs {", "  @Bean", body, "}", 'const val GROUP = "public"'].join("\n");
    const kt = "svc/src/main/kotlin/lab/Docs.kt";
    hidden(kt, kotlin("  fun api(GROUP: String): GroupedOpenApi = GroupedOpenApi.builder().group(GROUP).build()"), 5);
    hidden(kt, kotlin('  fun api(): GroupedOpenApi = listOf("a").map { left, GROUP -> GroupedOpenApi.builder().group(GROUP).build() }.first()'), 5);
    const constant = '  @Bean GroupedOpenApi api(@Value("${docs.title}") String title) {\n    return GroupedOpenApi.builder().group(GROUP).displayName(title).build();\n  }';
    expect(run({ "svc/pom.xml": POM, [java]: docs(constant) }).documents).toEqual([
      "/v3/api-docs springdoc default svc/pom.xml:5",
      "/v3/api-docs/public springdoc group svc/src/main/java/lab/Docs.java:6",
    ]);
    const unrelated = docs("  @Bean GroupedOpenApi api() {\n    BinaryOperator<String> pick = (left, right) -> left;\n    return GroupedOpenApi.builder().group(GROUP).build();\n  }");
    expect(run({ "svc/pom.xml": POM, [java]: unrelated }).documents).toContain("/v3/api-docs/public springdoc group svc/src/main/java/lab/Docs.java:7");
  });

  it("resolves YAML aliases and merge keys as Spring Boot's loader does, at the alias", () => {
    const yml = (body: string) => run({ "svc/pom.xml": POM, [`${RESOURCES}/application.yml`]: body }).documents;
    expect(yml("docs: &docs /internal\nspringdoc:\n  api-docs:\n    path: *docs\n")).toEqual([`/internal springdoc api-docs.path ${RESOURCES}/application.yml:4`]);
    expect(yml("base: &base\n  path: /merged\nspringdoc:\n  api-docs:\n    <<: *base\n")).toEqual([`/merged springdoc api-docs.path ${RESOURCES}/application.yml:5`]);
    expect(yml("base: &base\n  path: /merged\nspringdoc:\n  api-docs:\n    <<: *base\n    path: /own\n")).toEqual([`/own springdoc api-docs.path ${RESOURCES}/application.yml:6`]);
    expect(yml("admin: &admin\n  group: admin\nspringdoc:\n  group-configs:\n    - *admin\n")).toEqual([
      "/v3/api-docs springdoc default svc/pom.xml:5",
      `/v3/api-docs/admin springdoc group-configs ${RESOURCES}/application.yml:5`,
    ]);
  });

  it("decodes .properties escapes as java.util.Properties does", () => {
    const properties = (body: string) => run({ "svc/pom.xml": POM, [`${RESOURCES}/application.properties`]: body }).documents;
    expect(properties("springdoc.api-docs.path=\\u002finternal\n")).toEqual([`/internal springdoc api-docs.path ${RESOURCES}/application.properties:1`]);
    expect(properties("springdoc.api-docs.path=/v3/\\u0061pi-docs\n")).toEqual([`/v3/api-docs springdoc api-docs.path ${RESOURCES}/application.properties:1`]);
    expect(properties("spring\\u0064oc.api-docs.path=/keyed\n")).toEqual([`/keyed springdoc api-docs.path ${RESOURCES}/application.properties:1`]);
    expect(properties("springdoc.api-docs.path=/a\\:b\\=c\n")).toEqual([`/a:b=c springdoc api-docs.path ${RESOURCES}/application.properties:1`]);
    expect(properties("springdoc.api-docs.path\\\n    =/continued\n")).toEqual([`/continued springdoc api-docs.path ${RESOURCES}/application.properties:1`]);
  });

  it("reads springdoc's switches only as springdoc's conditions do", () => {
    const properties = (body: string) => run({ "svc/pom.xml": POM, [`${RESOURCES}/application.properties`]: body });
    // @ConditionalOnProperty without havingValue: only "false", in any case, turns the endpoints off.
    expect(properties("springdoc.api-docs.enabled=off\n").documents).toEqual(["/v3/api-docs springdoc default svc/pom.xml:5"]);
    expect(properties("springdoc.api-docs.enabled=FALSE\n").documents).toEqual([]);
    expect(properties("springdoc.use-management-port=FALSE\n").documents).toEqual(["/v3/api-docs springdoc default svc/pom.xml:5"]);
    expect(properties("springdoc.enable-default-api-docs=False\nspringdoc.group-configs[0].group=admin\n").documents).toEqual([
      `/v3/api-docs/admin springdoc group-configs ${RESOURCES}/application.properties:2`,
    ]);
    // Read in a SpEL expression: anything but true or false stops the application or moves the documents.
    for (const [key, value] of [["springdoc.enable-default-api-docs", "off"], ["springdoc.enable-default-api-docs", "1"], ["springdoc.use-management-port", "1"], ["springdoc.use-management-port", "no"]])
      expect(properties(`${key}=${value}\n`)).toEqual({
        documents: [],
        description: "none - NoneFound",
        limits: [`openapi svc: ${RESOURCES}/application.properties:1 sets ${key} to ${value}, which springdoc reads only as true or false; the documents springdoc serves are not read`],
      });
  });

  it("serves a group only from a bean the application registers, and says when that is not settled", () => {
    const pom = { "svc/pom.xml": POM };
    const helper = 'package lab;\n@Configuration\nclass Docs {\n  static GroupedOpenApi group() {\n    return GroupedOpenApi.builder().group("helper").build();\n  }\n}\n';
    expect(run({ ...pom, "svc/src/main/java/lab/Docs.java": helper })).toEqual({
      documents: ["/v3/api-docs springdoc default svc/pom.xml:5"],
      description: "chosen /v3/api-docs ServedByCode",
      limits: ["openapi svc: svc/src/main/java/lab/Docs.java:5 builds a GroupedOpenApi outside a @Bean method; whether a bean registers it is not settled, so its group's document is not read"],
    });
    const bean = (pkg: string, annotation: string) => `package ${pkg};\n${annotation}\nclass Docs {\n  @Bean GroupedOpenApi api() { return GroupedOpenApi.builder().group("public").build(); }\n}\n`;
    expect(run({ ...pom, "svc/src/main/java/lab/Docs.java": bean("lab", "@Component") }).documents).toContain("/v3/api-docs/public springdoc group svc/src/main/java/lab/Docs.java:4");
    expect(run({ ...pom, "svc/src/main/java/lab/Docs.java": bean("lab", "") }).limits).toEqual([
      "openapi svc: svc/src/main/java/lab/Docs.java:4 builds a GroupedOpenApi in a @Bean method of Docs, which is not a @Configuration or other component; whether it is registered is not settled, so its group's document is not read",
    ]);
    expect(run({ ...pom, "svc/src/main/java/other/Docs.java": bean("other", "@Configuration") }).limits).toEqual([
      "openapi svc: svc/src/main/java/other/Docs.java:4 builds a GroupedOpenApi in a @Bean method of Docs, in package other, which no @SpringBootApplication of the project scans by default; whether it is registered is not settled, so its group's document is not read",
    ]);
    const scanned = { "svc/src/main/java/lab/App.java": 'package lab;\n@SpringBootApplication(scanBasePackages = "other")\nclass App {}\n' };
    expect(run({ ...pom, ...scanned, "svc/src/main/java/other/Docs.java": bean("other", "@Configuration") }).limits).toEqual([
      "openapi svc: svc/src/main/java/other/Docs.java:4 builds a GroupedOpenApi in a @Bean method of Docs, in package other, while the project sets which packages are scanned (svc/src/main/java/lab/App.java:2); whether it is registered is not settled, so its group's document is not read",
    ]);
  });

  it("counts springdoc only where the build puts it on the application's runtime classpath", () => {
    const pom = (body: string) => run({ "svc/pom.xml": `<project>\n${body}\n</project>\n` });
    const dependency = (scope = "") => `<dependency>\n<groupId>org.springdoc</groupId>\n<artifactId>springdoc-openapi-starter-webmvc-ui</artifactId>${scope}\n</dependency>`;
    expect(pom(`<dependencyManagement>\n<dependencies>\n${dependency()}\n</dependencies>\n</dependencyManagement>`).documents).toEqual([]);
    expect(pom(`<dependencies>\n${dependency("<scope>test</scope>")}\n</dependencies>`).documents).toEqual([]);
    expect(pom(`<dependencies>\n${dependency("<scope>provided</scope>")}\n</dependencies>`).documents).toEqual([]);
    expect(pom(`<build>\n<plugins>\n<plugin>\n<groupId>org.springdoc</groupId>\n<artifactId>springdoc-openapi-maven-plugin</artifactId>\n</plugin>\n</plugins>\n</build>`).documents).toEqual([]);
    expect(pom(`<dependencies>\n${dependency("<scope>runtime</scope>")}\n</dependencies>`).documents).toEqual(["/v3/api-docs springdoc default svc/pom.xml:5"]);
    expect(pom(`<profiles>\n<profile>\n<id>docs</id>\n<dependencies>\n${dependency()}\n</dependencies>\n</profile>\n</profiles>`)).toEqual({
      documents: [],
      description: "none - NoneFound",
      limits: ["openapi svc: svc/pom.xml:8 names springdoc in a Maven profile, which is activated at build time; it is not read"],
    });
    const gradle = (body: string) => run({ "svc/build.gradle.kts": body }).documents;
    const coordinates = '"org.springdoc:springdoc-openapi-starter-webmvc-ui:2.8.13"';
    for (const configuration of ["testImplementation", "compileOnly", "developmentOnly", "annotationProcessor"])
      expect(gradle(`dependencies {\n  ${configuration}(${coordinates})\n}\n`)).toEqual([]);
    expect(gradle(`dependencies {\n  implementation(platform("org.springdoc:springdoc-openapi-bom:2.8.13"))\n}\n`)).toEqual([]);
    expect(gradle(`plugins {\n  id("org.springdoc.openapi-gradle-plugin") version "1.9.0"\n}\n`)).toEqual([]);
    expect(gradle(`buildscript {\n  dependencies {\n    classpath(${coordinates})\n  }\n}\n`)).toEqual([]);
    expect(gradle(`subprojects {\n  dependencies {\n    implementation(${coordinates})\n  }\n}\n`)).toEqual([]);
    expect(gradle(`dependencies {\n  runtimeOnly(${coordinates})\n}\n`)).toEqual(["/v3/api-docs springdoc default svc/build.gradle.kts:2"]);
    expect(run({ "svc/build.gradle": "dependencies {\n  api group: 'org.springdoc', name: 'springdoc-openapi-starter-webmvc-ui', version: '2.8.13'\n}\n" }).documents).toEqual([
      "/v3/api-docs springdoc default svc/build.gradle:2",
    ]);
  });

  it("lets a later or higher-precedence group list, even an empty one, replace an earlier one", () => {
    const admin = "springdoc:\n  group-configs:\n    - group: admin\n      paths-to-match: /admin/**\n";
    expect(run({ "svc/pom.xml": POM, [`${RESOURCES}/application.yml`]: admin, [`${RESOURCES}/config/application.yml`]: "springdoc:\n  group-configs: []\n" }).documents).toEqual([
      "/v3/api-docs springdoc default svc/pom.xml:5",
    ]);
    expect(run({ "svc/pom.xml": POM, [`${RESOURCES}/application.yml`]: admin, [`${RESOURCES}/application.properties`]: "springdoc.group-configs=\n" }).documents).toEqual([
      "/v3/api-docs springdoc default svc/pom.xml:5",
    ]);
    const repeated = "springdoc.group-configs[0].group=one\nspringdoc.group-configs[0].paths-to-match=/x/**\nspringdoc.group-configs[0].group=two\n";
    expect(run({ "svc/pom.xml": POM, [`${RESOURCES}/application.properties`]: repeated }).documents).toEqual([
      "/v3/api-docs springdoc default svc/pom.xml:5",
      `/v3/api-docs/two springdoc group-configs ${RESOURCES}/application.properties:3`,
    ]);
  });

  it("takes a parameter whatever its type, annotations or modifiers for one that hides a constant", () => {
    const docs = (parameter: string) =>
      ["package lab;", "@Configuration", "class Docs {", '  static final String GROUP = "public";', `  @Bean GroupedOpenApi api(${parameter}) {`, "    return GroupedOpenApi.builder().group(GROUP).build();", "  }", "}"].join("\n");
    for (const parameter of ["Map<String, List<Foo>> GROUP", "String[] GROUP", "String GROUP[]", 'final @Value("${g}") String GROUP', "String... GROUP", "@NonNull Map<String, Map<String, String>>[] GROUP"])
      expect(run({ "svc/pom.xml": POM, "svc/src/main/java/lab/Docs.java": docs(parameter) })).toEqual({
        documents: ["/v3/api-docs springdoc default svc/pom.xml:5"],
        description: "chosen /v3/api-docs ServedByCode",
        limits: ["openapi svc: svc/src/main/java/lab/Docs.java:6 builds a GroupedOpenApi whose group the file does not spell out (GROUP); that group's document is not read"],
      });
  });

  it("reads nothing from a .properties file Spring Boot cannot load", () => {
    const body = "springdoc.api-docs.path=/ok\nother.value=\\uZZZZ\n";
    expect(run({ "svc/pom.xml": POM, [`${RESOURCES}/application.properties`]: body })).toEqual({
      documents: [],
      description: "none - NoneFound",
      limits: [`openapi svc: ${RESOURCES}/application.properties:2 has a malformed \\uxxxx escape, so Spring Boot cannot load the file and the application does not start; the documents springdoc serves are not read`],
    });
    expect(run({ "svc/pom.xml": POM, [`${RESOURCES}/application-dev.properties`]: body })).toEqual({
      documents: ["/v3/api-docs springdoc default svc/pom.xml:5"],
      description: "chosen /v3/api-docs ServedByCode",
      limits: [`openapi svc: ${RESOURCES}/application-dev.properties:2 has a malformed \\uxxxx escape, so Spring Boot cannot load the file under the profile dev; it is not read`],
    });
  });

  it("puts in front only the base path of the web stack springdoc's starter is for", () => {
    const prefixes = `${RESOURCES}/application.properties`;
    const both = "server.servlet.context-path=/legacy\nspring.webflux.base-path=/reactive\n";
    expect(run({ "svc/pom.xml": POM, [prefixes]: both }).documents).toEqual([`/legacy/v3/api-docs springdoc default svc/pom.xml:5`]);
    const flux = { "svc/build.gradle.kts": 'dependencies {\n  implementation("org.springdoc:springdoc-openapi-starter-webflux-ui:2.8.13")\n}\n' };
    expect(run({ ...flux, [prefixes]: both }).documents).toEqual([`/reactive/v3/api-docs springdoc default svc/build.gradle.kts:2`]);
    expect(run({ ...flux, [prefixes]: "server.servlet.context-path=/legacy\n" }).documents).toEqual([`/v3/api-docs springdoc default svc/build.gradle.kts:2`]);
    // springdoc 1.x: springdoc-openapi-ui is the MVC one.
    expect(run({ "svc/build.gradle": "dependencies {\n  implementation 'org.springdoc:springdoc-openapi-ui:1.8.0'\n}\n", [prefixes]: both }).documents).toEqual([
      "/legacy/v3/api-docs springdoc default svc/build.gradle:2",
    ]);
    const unknown = { "svc/pom.xml": "<project/>\n", "svc/src/main/java/lab/Docs.java": 'package lab;\n@Configuration\nclass Docs {\n  @Bean GroupedOpenApi api() { return GroupedOpenApi.builder().group("public").build(); }\n}\n' };
    expect(run({ ...unknown, [prefixes]: "server.servlet.context-path=/legacy\n" })).toEqual({
      documents: [],
      description: "none - NoneFound",
      limits: [
        `openapi svc: ${RESOURCES}/application.properties:1 sets server.servlet.context-path, which applies only to a Servlet application, and the build does not settle the web stack; the documents springdoc serves are not read`,
      ],
    });
    expect(run(unknown).documents).toEqual(["/v3/api-docs springdoc default svc/src/main/java/lab/Docs.java:4", "/v3/api-docs/public springdoc group svc/src/main/java/lab/Docs.java:4"]);
  });
});
