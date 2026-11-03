import { mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";
import { describe, expect, it } from "vitest";
import { documentUrl, toArazzo } from "../src/arazzo.js";
import { loadConfig, normalizeConfig } from "../src/config.js";
import { callsFromText, callsFromTypeScript } from "../src/extract/calls.js";
import { extractComponents } from "../src/extract/components.js";
import { Reach } from "../src/extract/reach.js";
import { nextRoute, routesFromPython, routesFromTypeScript } from "../src/extract/routes.js";
import { loadFlows, type FlowObject, type LoadedFile } from "../src/flows.js";
import { inventory } from "../src/inventory.js";
import type { Graph } from "../src/model.js";
import { uriOf } from "../src/sarif.js";
import { evaluate } from "../src/rules.js";
import { scan } from "../src/scan.js";
import { WorktreeSource, type Source } from "../src/source.js";

const memory = (files: Record<string, string>): Source => ({
  ref: "WORKTREE",
  list: () => Object.keys(files),
  read: (p) => files[p],
  asOf: () => "2026-11-01T00:00:00Z",
});
const shop = fileURLToPath(new URL("../fixtures/shop", import.meta.url));

describe("worktree listing", () => {
  it("does not follow a directory link back up the tree", () => {
    const root = mkdtempSync(join(tmpdir(), "atlas-links-"));
    mkdirSync(join(root, "src"));
    writeFileSync(join(root, "src", "a.ts"), "x");
    writeFileSync(join(root, "real.txt"), "y");
    symlinkSync(root, join(root, "src", "loop"), "dir");
    symlinkSync(join(root, "real.txt"), join(root, "alias.txt"), "file");
    symlinkSync(join(root, "missing.txt"), join(root, "dangling.txt"), "file");
    expect(new WorktreeSource(root).list().sort()).toEqual(["alias.txt", "real.txt", "src/a.ts"]);
  });
});

describe("Arazzo export", () => {
  const config = loadConfig(join(shop, "atlas.config.yaml"));
  const graph = scan(new WorktreeSource(shop), config);

  it("puts the environment's origin before a chosen served path", () => {
    const chosen = { ...config, openapi: { orders: "/v2/openapi.json" }, origins: { orders: "https://orders.example/" } };
    expect(documentUrl("orders", graph, chosen)).toEqual({ url: "https://orders.example/v2/openapi.json" });
    expect(documentUrl("orders", graph, { ...chosen, origins: {} }).note).toContain("set origins.orders");
    expect(documentUrl("orders", graph, { ...chosen, openapi: { orders: "https://specs.example/orders.json" } })).toEqual({ url: "https://specs.example/orders.json" });
    expect(documentUrl("orders", graph, { ...chosen, openapi: { orders: "services/orders/openapi.json" } })).toEqual({
      url: "services/orders/openapi.json",
      file: "services/orders/openapi.json",
    });
  });

  it("does not export an operationId the chosen document lacks", () => {
    const source = new WorktreeSource(shop);
    const flow: FlowObject = { apiVersion: "flow-atlas.dev/v1alpha1", kind: "Flow", metadata: { name: "create" }, spec: { steps: [{ stepId: "create", surface: "orders|POST /orders" }] } };
    const files: LoadedFile[] = [{ file: "f.flow.yaml", text: "", errors: [], flows: [{ object: flow, line: 1, stepLine: () => 1 }] }];
    const named = { ...graph, surfaces: graph.surfaces.map((s) => (s.id === "orders|POST /orders" ? { ...s, operationId: "createOrder" } : s)) } as Graph;
    const chosen = { ...config, openapi: { orders: "services/orders/openapi.json" } };
    expect(() => toArazzo(named, files, chosen, { title: "t", read: (p) => source.read(p) })).toThrow("nothing to export");
    expect(loadFlows(source, config).length).toBeGreaterThan(0);
  });
});

describe("fetch", () => {
  const spec = { from: "a", to: "b", files: [] };
  const method = (code: string) => callsFromTypeScript("a.ts", code, spec).map((c) => c.method);
  it("is GET without a stated method and * when the method is built at run time", () => {
    expect(method("fetch(`${base}/orders`);")).toEqual(["GET"]);
    expect(method("window.fetch(`${base}/orders`, { headers: h });")).toEqual(["GET"]);
    expect(method('fetch(`${base}/orders`, { method: "POST" });')).toEqual(["POST"]);
    expect(method("fetch(`${base}/orders`, { method: verb });")).toEqual(["*"]);
    expect(method("fetch(`${base}/orders`, init);")).toEqual(["*"]);
    expect(method("fetch(`${base}/orders`, { ...init });")).toEqual(["*"]);
  });
});

describe("manifests", () => {
  it("leave out excluded manifests", () => {
    const source = memory({ "web/component.json": '{"name":"web"}', "test/fakes/component.json": '{"name":"web","consumes":["x"]}' });
    const { components } = extractComponents(source, normalizeConfig({ manifest: { kind: "component-json", glob: "**/component.json" }, exclude: ["test/**"] }));
    expect(components).toEqual([expect.objectContaining({ name: "web", path: "web", consumes: [] })]);
  });
});

describe("Reach", () => {
  const reachFrom = (files: Record<string, string>, file: string, statement: number) => {
    const reach = new Reach(memory(files));
    const sf = reach.parse(file)!.sf;
    return reach.from(file, (sf.statements[statement] as ts.ExpressionStatement).expression);
  };

  it("follows a local export alias", () => {
    const files = { "src/a.ts": 'import { handler } from "./h.js";\nregister(() => handler());', "src/h.ts": "const run = () => client.send();\nexport { run as handler };" };
    expect(reachFrom(files, "src/a.ts", 1)).toEqual(["send"]);
  });

  it("resolves JavaScript modules and prefers the TypeScript a .js specifier stands for", () => {
    const js = { "src/a.js": 'import { run } from "./handler.js";\nregister(() => run());', "src/handler.js": "export function run() { return client.js(); }" };
    expect(reachFrom(js, "src/a.js", 1)).toEqual(["js"]);
    const both = { ...js, "src/handler.ts": "export function run() { return client.ts(); }" };
    expect(reachFrom(both, "src/a.js", 1)).toEqual(["ts"]);
    const index = { "src/a.mjs": 'import { run } from "./lib";\nregister(() => run());', "src/lib/index.mjs": "export function run() { return client.mjs(); }" };
    expect(reachFrom(index, "src/a.mjs", 1)).toEqual(["mjs"]);
  });
});

describe("handlers that call directly", () => {
  it("link a route to the fetch its inline handler runs", () => {
    const files = {
      "svc/routes.ts": [
        "export function routes(app, base) {",
        '  app.get("/orders", async (req, res) => {',
        "    res.json(await fetch(`${base}/orders`).then((r) => r.json()));",
        "  });",
        '  app.get("/other", (req, res) => res.json({}));',
        "  const unused = () => fetch(`${base}/never`);",
        "}",
      ].join("\n"),
      "api/orders.ts": 'app.get("/orders", h);',
    };
    const config = normalizeConfig({
      components: [
        { name: "svc", path: "svc" },
        { name: "api", path: "api" },
      ],
      routes: [
        { component: "svc", files: ["svc/**/*.ts"], styles: ["express"] },
        { component: "api", files: ["api/**/*.ts"], styles: ["express"] },
      ],
      calls: [{ from: "svc", to: "api", files: ["svc/**/*.ts"] }],
    });
    const graph = scan(memory(files), config);
    const reach = graph.edges.filter((e) => e.kind === "reach").map((e) => `${e.from} -> ${graph.calls.find((c) => c.id === e.to)!.path} ${e.evidence}`);
    expect(reach).toEqual(["svc|GET /orders -> /orders static"]);
  });
});

describe("already fixed", () => {
  it("reads the methods FastAPI api_route lists", () => {
    const text = '@router.api_route("/orders", methods=["POST"])\n@router.api_route("/ping")';
    expect(routesFromPython("a.py", text, { component: "c", files: [] }).map((s) => `${s.method} ${s.path}`)).toEqual(["POST /orders", "GET /ping"]);
  });
  it("finds a repository-root active list for a top-level versioned directory", () => {
    const files = { "active.json": '["invoice-v1.json","invoice-v2.json"]', "schemas/invoice-v1.json": "{}", "schemas/invoice-v2.json": "{}" };
    expect(inventory(memory(files), []).activeLists).toEqual([{ file: "active.json", names: 2, dir: "schemas" }]);
  });
});

describe("SARIF locations", () => {
  it("encode each path segment", () => {
    expect(uriOf("src/order#client.ts")).toBe("src/order%23client.ts");
    expect(uriOf("src/my file.ts")).toBe("src/my%20file.ts");
    expect(uriOf("src/a.ts")).toBe("src/a.ts");
  });
});

describe("Python registrations", () => {
  it("reads Starlette converters, mounts and configured helpers with a fixed method", () => {
    const text = [
      '@app.get("/files/{name:path}")',
      "def f(name): ...",
      '@app.get("/items/{id:int}")',
      "def g(id): ...",
      'app.mount("/downloads", StaticFiles(directory="out"), name="d")',
      'add_agent_endpoint(app, agent, "/api/chat")',
      "def add_agent_endpoint(app, agent, path): ...",
    ].join("\n");
    const spec = { component: "c", files: [], styles: ["fastapi" as const], calls: [{ name: "add_agent_endpoint", pathArg: 2, method: "POST" }] };
    expect(routesFromPython("a.py", text, spec).map((s) => `${s.method} ${s.path}`)).toEqual(["GET /files/{*name}", "GET /items/{id}", "* /downloads/**", "POST /api/chat"]);
  });

  it("refuses a helper with neither or both of methodArg and method", () => {
    expect(() => normalizeConfig({ routes: [{ component: "c", files: [], calls: [{ name: "r", pathArg: 0 }] }] })).toThrow(/methodArg or method/);
    expect(() => normalizeConfig({ routes: [{ component: "c", files: [], calls: [{ name: "r", pathArg: 0, methodArg: 1, method: "GET" }] }] })).toThrow(/methodArg or method/);
  });
});

describe("base URLs held in a const", () => {
  const spec = { from: "a", to: "b", files: [] };
  const read = (code: string) => callsFromTypeScript("a.ts", code, spec).map((c) => `${c.method} ${c.path}${c.based ? " based" : ""}`);

  it("joins a base to the URLs that start with it and does not read the base as a request", () => {
    const code = [
      "export function create(options) {",
      "  const base = `${options.baseUrl}/media/v3`;",
      "  async function send(route) { return options.fetch(`${base}/${route}`, { method: \"POST\" }); }",
      "  return { send };",
      "}",
    ].join("\n");
    expect(read(code)).toEqual(["POST /media/v3/{} based"]);
    expect(read('const API = "/api";\nfetch(API + "/users");')).toEqual(["GET /api/users"]);
  });

  it("keeps a base that is also a request, and a name a parameter shadows", () => {
    expect(read('const items = "/items";\nfetch(items);\nfetch(`${items}/${id}`);')).toEqual(["* /items", "GET /items/{}"]);
    expect(read('const base = "/a";\nfunction f(base) { return fetch(`${base}/b`); }')).toEqual(["* /a", "GET /b based"]);
  });
});

describe("Python client calls", () => {
  it("reads any f-string field as a value and a verb on the line before", () => {
    const text = ["async def read(self):", "    response = await client.post(", "        f\"{self.base_url.rstrip('/')}/media/v3/photos\",", "        json={},", "    )"].join("\n");
    expect(callsFromText("a.py", text, { from: "a", to: "b", files: [] }).map((c) => `${c.method} ${c.path}${c.based ? " based" : ""}`)).toEqual(["POST /media/v3/photos based"]);
  });
});

describe("inventory styles", () => {
  it("offers a route style only in the files its extractor reads, and counts fetch wrappers", () => {
    const files: Record<string, string> = {
      "api/main.py": '@app.get("/health")\ndef health(): ...',
      "web/src/a.ts": 'app.get("/x", h);\nauthFetch("/api/items");',
    };
    const source: Source = { ref: "WORKTREE", list: () => Object.keys(files), read: (p) => files[p], asOf: () => "2026-11-01T00:00:00Z" };
    const inv = inventory(source, []);
    expect(inv.routes.map((r) => `${r.file} ${r.style}`)).toEqual(["api/main.py fastapi", "web/src/a.ts express"]);
    expect(inv.calls.reduce((n, c) => n + c.count, 0)).toBe(1);
  });
});

describe("Express routers", () => {
  const read = (files: Record<string, string>, extra: Record<string, unknown> = {}) => {
    const source: Source = { ref: "WORKTREE", list: () => Object.keys(files), read: (p) => files[p], asOf: () => "2026-11-01T00:00:00Z" };
    const config = normalizeConfig({ components: [{ name: "api", path: "" }], routes: [{ component: "api", files: ["**/*.js"], styles: ["express"], ...extra }] });
    const graph = scan(source, config);
    return { surfaces: graph.surfaces.map((s) => s.id), limits: graph.limits ?? [] };
  };
  const router = 'const express = require("express");\nconst router = express.Router();\nrouter.get("/orders", h);\nmodule.exports = router;';

  it("serves a router's routes under every literal path it is mounted at, nested routers included", () => {
    const files = {
      "app.js": 'const api = require("./api");\napp.use("/v1", api);\napp.get("/health", h);',
      "api.js": 'const { Router } = require("express");\nconst api = Router();\nconst orders = require("./orders");\napi.use("/shop", orders);\nmodule.exports = api;',
      "orders.js": router,
    };
    expect(read(files).surfaces.sort()).toEqual(["api|GET /health", "api|GET /v1/shop/orders"]);
  });

  it("does not place a router at the root when its mount path is not a literal, unless the configuration declares it", () => {
    const files = { "app.js": 'const c = require("./c");\napp.use(`${PREFIX}/collect`, c);', "c.js": router };
    const unread = read(files);
    expect(unread.surfaces).toEqual([]);
    expect(unread.limits.join("\n")).toMatch(/router router in c\.js is mounted where the code gives no literal path/);
    expect(read(files, { mounts: { "c.js": "/collect" } }).surfaces).toEqual(["api|GET /collect/orders"]);
  });
});

describe("Next.js routes", () => {
  it("serves a route handler at its folder path, without groups and slots, with dynamic segments as parameters", () => {
    expect(nextRoute("apps/web/app/api/chat/stream/route.ts")).toEqual({ path: "/api/chat/stream", pages: false });
    expect(nextRoute("src/app/(shop)/@modal/orders/[id]/route.ts")?.path).toBe("/orders/{id}");
    expect(nextRoute("app/files/[...path]/route.js")?.path).toBe("/files/{*path}");
    expect(nextRoute("app/_lib/route.ts")).toBeUndefined();
    expect(nextRoute("app/(.)photo/route.ts")).toBeUndefined();
    expect(nextRoute("pages/api/users/index.ts")).toEqual({ path: "/api/users", pages: true });
    expect(nextRoute("app/page.tsx")).toBeUndefined();
  });

  it("reads each exported method of a route handler and the default export of an API route", () => {
    const spec = { component: "web", files: [], styles: ["next" as const] };
    const handler = "export async function POST(req) {}\nexport const GET = () => new Response();\nfunction put() {}\nexport { put as PUT };\nexport const dynamic = 'force-dynamic';";
    expect(routesFromTypeScript("app/api/items/route.ts", handler, spec).map((s) => s.id)).toEqual(["web|POST /api/items", "web|GET /api/items", "web|PUT /api/items"]);
    expect(routesFromTypeScript("pages/api/ping.ts", "export default function handler(req, res) {}", spec).map((s) => s.id)).toEqual(["web|* /api/ping"]);
  });
});

describe("cycles", () => {
  it("does not take a component calling its own routes for a cycle", () => {
    const files: Record<string, string> = {
      "app/api/items/route.ts": "export function GET() { return new Response(); }",
      "components/list.tsx": 'export const load = () => fetch("/api/items");',
    };
    const source: Source = { ref: "WORKTREE", list: () => Object.keys(files), read: (p) => files[p], asOf: () => "2026-11-01T00:00:00Z" };
    const config = normalizeConfig({
      components: [{ name: "web", path: "" }],
      routes: [{ component: "web", files: ["app/**/*.ts"], styles: ["next"] }],
      calls: [{ from: "web", to: "web", files: ["components/**/*.tsx"] }],
    });
    const graph = scan(source, config);
    expect(graph.edges.filter((e) => e.kind === "match")).toHaveLength(1);
    expect(evaluate(graph, config).map((f) => f.key)).toEqual([]);
  });
});

describe("clients with a base path", () => {
  it("reads a verb with type arguments and puts the declared client prefix before root-relative paths", () => {
    const files: Record<string, string> = {
      "app/lib/repo.dart": "final r = await _dio.get<Map<String, dynamic>>(\n  '/careers/$id/detail',\n);\nawait dio.post('$base/raw');",
      "api/C.java": '@RestController\n@RequestMapping("/api/v1/careers")\nclass C {\n  @GetMapping("/{id}/detail") Object d(@PathVariable long id) { return null; }\n}',
    };
    const source: Source = { ref: "WORKTREE", list: () => Object.keys(files), read: (p) => files[p], asOf: () => "2026-11-01T00:00:00Z" };
    const config = normalizeConfig({
      components: [{ name: "app", path: "app" }, { name: "api", path: "api" }],
      routes: [{ component: "api", files: ["api/**/*.java"], styles: ["spring"] }],
      calls: [{ from: "app", to: "api", files: ["app/**/*.dart"], prefix: "/api/v1" }],
    });
    const graph = scan(source, config);
    expect(graph.calls.map((c) => `${c.method} ${c.path}${c.based ? " based" : ""}`)).toEqual(["GET /api/v1/careers/{}/detail", "POST /raw based"]);
    expect(graph.edges.filter((e) => e.kind === "match").map((e) => e.to)).toEqual(["api|GET /api/v1/careers/{id}/detail"]);
  });
});
