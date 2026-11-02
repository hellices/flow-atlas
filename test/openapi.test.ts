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
import type { Coverage } from "../src/model.js";
import { toArazzo } from "../src/arazzo.js";
import type { LoadedFile } from "../src/flows.js";

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
    expect(handlerNames("OrdersController_read", "GET", "/orders/{id}")).toContain("read");
    expect(handlerNames("read", "GET", "/orders/{id}")).toEqual(["read"]);
    expect(handlerNames("Admin_APIController_list", "GET", "/admin")).toEqual(["Admin_APIController_list", "APIController_list", "list"]);
    expect(handlerNames("Cats_findAll", "GET", "/cats")).toEqual(["Cats_findAll", "findAll"]);
    expect(handlerNames("api_v1_orders_retrieve", "GET", "/api/v1/orders/{id}")).toEqual(["api_v1_orders_retrieve"]);
  });
  it("finds definitions in Python, TypeScript and Java but not calls", () => {
    expect(definitionLines("a.py", "x = read()\nasync def read(id):\n", "read")).toEqual([2]);
    expect(definitionLines("a.ts", "this.read(1);\n  async read(@Param() id: string): Promise<X> {\n", "read")).toEqual([2]);
    expect(definitionLines("A.java", "return read(id);\n  public ResponseEntity<Map<String, Object>> read(@PathVariable String id) {\n", "read")).toEqual([2]);
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
    expect(graph.limits).toEqual([]);
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
