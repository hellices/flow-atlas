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
import { nextRoute } from "../src/extract/routes.js";
import { pathsMatch } from "../src/paths.js";
import { loadFlows, type FlowObject, type LoadedFile } from "../src/flows.js";
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

describe("SARIF locations", () => {
  it("encode each path segment", () => {
    expect(uriOf("src/order#client.ts")).toBe("src/order%23client.ts");
    expect(uriOf("src/my file.ts")).toBe("src/my%20file.ts");
    expect(uriOf("src/a.ts")).toBe("src/a.ts");
  });
});

/**
 * Rules of the frameworks atlas reads that the scenarios in fixtures/scenarios do not reach, one row per rule, and the
 * edge cases of name resolution that review turned up. Each row is a way real code is written.
 */
describe("framework rules", () => {
  const scanned = (files: Record<string, string>, routes: Record<string, unknown> = {}) => {
    const config = normalizeConfig({ components: [{ name: "api", path: "" }], routes: [{ component: "api", files: ["**/*.{js,ts}"], styles: ["express", "next"], ...routes }] });
    return scan(memory(files), config).surfaces.map((s) => `${s.id}${s.implicit ? " (implicit)" : ""}`).sort();
  };

  it("serves a Next.js file at the path its folders give", () => {
    const rows: Array<[string, string | undefined]> = [
      ["src/app/(shop)/@modal/orders/[id]/route.ts", "/orders/{id}"],
      ["app/files/[...path]/route.js", "/files/{path}/**"],
      ["app/files/[[...path]]/route.js", "/files/{*path}"],
      ["app/_lib/route.ts", undefined],
      ["app/(.)photo/route.ts", undefined],
      ["pages/api/users/index.ts", "/api/users"],
      ["pages/api/_health.ts", "/api/_health"],
      ["pages/api/(v1)/@me.ts", "/api/(v1)/@me"],
      ["app/page.tsx", undefined],
    ];
    expect(rows.map(([file]) => nextRoute(file)?.path)).toEqual(rows.map(([, path]) => path));
    // A required catch-all takes one segment or more, an optional one none or more.
    expect([pathsMatch("/files/{path}/**", "/files"), pathsMatch("/files/{path}/**", "/files/a/b"), pathsMatch("/files/{*path}", "/files")]).toEqual([false, true, true]);
  });

  it("reads every way a Next.js handler is exported, and the methods Next.js answers itself", () => {
    const files = {
      "app/items/route.ts": "export async function POST(req) {}\nexport const GET = () => new Response();\nfunction put() {}\nexport { put as PUT };",
      "app/orders/route.ts": 'export { GET } from "./handlers";\nexport { create as DELETE } from "./handlers";',
      "app/orders/handlers.ts": "export function GET() {}\nexport function create() {}",
      "pages/api/ping.ts": "export default function handler(req, res) {}",
    };
    expect(scanned(files)).toEqual([
      "api|* /api/ping",
      "api|DELETE /orders",
      "api|GET /items",
      "api|GET /orders",
      "api|HEAD /items (implicit)",
      "api|HEAD /orders (implicit)",
      "api|OPTIONS /items (implicit)",
      "api|OPTIONS /orders (implicit)",
      "api|POST /items",
      "api|PUT /items",
    ]);
  });

  it("reaches what a framework answers by itself only by a request that names the method", () => {
    const files = {
      "app/api/items/route.ts": "export function GET() {}",
      "web/a.ts": 'export const any = () => request("/api/items");\nexport const head = () => fetch("/api/items", { method: "HEAD" });',
    };
    const config = normalizeConfig({
      components: [{ name: "api", path: "app" }, { name: "web", path: "web" }],
      routes: [{ component: "api", files: ["app/**/*.ts"], styles: ["next"] }],
      calls: [{ from: "web", to: "api", files: ["web/**/*.ts"] }],
    });
    const graph = scan(memory(files), config);
    const matched = graph.edges.filter((e) => e.kind === "match").map((e) => `${graph.calls.find((c) => c.id === e.from)!.method} -> ${e.to}`);
    expect(matched.sort()).toEqual(["* -> api|GET /api/items", "HEAD -> api|HEAD /api/items"]);
    expect(evaluate(graph, config).map((f) => f.key)).toEqual([]);
  });

  it("serves an Express router under every mount the code states", () => {
    const rows: Array<[string, Record<string, string>, string[]]> = [
      [
        "nested routers, required from relative modules",
        {
          "app.js": 'const api = require("./api");\napp.use("/v1", api);\napp.get("/health", h);',
          "api.js": 'const { Router } = require("express");\nconst api = Router();\nconst orders = require("./orders");\napi.use("/shop", orders);\nmodule.exports = api;',
          "orders.js": 'const express = require("express");\nconst router = express.Router();\nrouter.get("/orders", h);\nmodule.exports = router;',
        },
        ["api|GET /health", "api|GET /v1/shop/orders"],
      ],
      [
        "TypeScript routers imported as ./x.js, one mounted on the other",
        {
          "app.ts": 'import api from "./api.js";\napp.use("/v1", api);',
          "api.ts": 'import { Router } from "express";\nimport orders from "./orders.js";\nconst api = Router();\napi.use("/shop", orders);\napi.get("/ping", h);\nexport default api;',
          "orders.ts": 'import express from "express";\nconst orders = express.Router();\norders.get("/list", h);\nexport default orders;',
        },
        ["api|GET /v1/ping", "api|GET /v1/shop/list"],
      ],
      ["an inline middleware before the router", { "app.js": 'const express = require("express");\nconst r = express.Router();\nr.get("/x", h);\napp.use((req, res, next) => next(), r);' }, ["api|GET /x"]],
      ["a Router from another library", { "app.js": 'const sdk = require("sdk");\nconst r = sdk.Router();\nr.get("/x", h);\napp.use("/v", r);' }, []],
      [
        "another value under the router's name",
        { "app.js": 'const express = require("express");\nconst r = express.Router();\nr.get("/x", h);\napp.use("/a", r);\nfunction other() { const r = makeSomething(); app.use("/b", r); }' },
        ["api|GET /a/x"],
      ],
    ];
    for (const [, files, surfaces] of rows) expect(scanned(files)).toEqual(surfaces);
  });
});

describe("names resolve by their bindings", () => {
  const read = (code: string) => callsFromTypeScript("a.ts", code, { from: "a", to: "b", files: [] }).map((c) => `${c.method} ${c.path}${c.based ? " based" : ""}`);

  it("joins a URL to the const it starts with, and to no other value of that name", () => {
    const rows: Array<[string, string[]]> = [
      ['const API = "/api";\nfetch(API + "/users");', ["GET /api/users"]],
      ["const base = ('/api');\nfetch(`${base}/users`);", ["GET /api/users"]],
      ['const items = "/items";\nfetch(items);\nfetch(`${items}/${id}`);', ["* /items", "GET /items/{}"]],
      ['const base = "/a";\nfunction f(base) { return fetch(`${base}/b`); }', ["* /a", "GET /b based"]],
      ['const base = "/api";\nfor (const base of bases) fetch(`${base}/users`);', ["* /api", "GET /users based"]],
      ['const base = "/api";\ntry {} catch (base) { fetch(`${base}/users`); }', ["* /api", "GET /users based"]],
      ['const base = "/api";\nfunction f() { if (x) { var base = y; } return fetch(`${base}/users`); }', ["* /api", "GET /users based"]],
    ];
    expect(rows.map(([code]) => read(code))).toEqual(rows.map(([, calls]) => calls));
  });

  it("keeps the escaped braces of a Python f-string literal", () => {
    const text = 'r = client.get(f"/tenants/{{tenant}}/{tid}/items")';
    expect(callsFromText("a.py", text, { from: "a", to: "b", files: [] }).map((c) => `${c.method} ${c.path}`)).toEqual(["GET /tenants/{tenant}/{}/items"]);
  });
});
