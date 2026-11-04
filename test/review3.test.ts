import { mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";
import { describe, expect, it } from "vitest";
import { documentUrl, toArazzo } from "../src/arazzo.js";
import { loadConfig, normalizeConfig } from "../src/config.js";
import { declarationOf, resolveModule } from "../src/extract/binding.js";
import { callsFromText, callsFromTypeScript } from "../src/extract/calls.js";
import { extractComponents } from "../src/extract/components.js";
import { Reach } from "../src/extract/reach.js";
import { nextRoute, routesFromPython } from "../src/extract/routes.js";
import { inventory } from "../src/inventory.js";
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

describe("navigation to the root", () => {
  const paths = (code: string) => callsFromTypeScript("a.tsx", code, { from: "a", to: "a", files: [] }).map((c) => c.path);
  it("is read through wrappers that leave the value as it is", () => {
    const rows = ['router.push("/");', 'router.push(("/"));', 'redirect("/" as const);', 'router.replace("/" satisfies string);', 'const a = <a href={("/")}>home</a>;'];
    expect(rows.map(paths)).toEqual(rows.map(() => ["/"]));
    expect(paths('log("/");')).toEqual([]);
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
      ["app/items/[product-id]/route.ts", "/items/{product-id}"],
      ["pages/api/(v1)/@me.ts", "/api/(v1)/@me"],
      ["app/page.tsx", "/"],
      ["app/stories/[slug]/page.tsx", "/stories/{slug}"],
      ["app/layout.tsx", undefined],
      ["pages/blog/index.tsx", "/blog"],
      ["pages/_app.tsx", undefined],
    ];
    expect(rows.map(([file]) => nextRoute(file)?.path)).toEqual(rows.map(([, path]) => path));
    // Read from the component's root: a project in a directory named app keeps its own app/ as the router.
    expect(nextRoute("apps/app/app/api/items/route.ts", "apps/app")?.path).toBe("/api/items");
    expect(nextRoute("apps/app/src/app/api/items/route.ts", "apps/app")?.path).toBe("/api/items");
    // A required catch-all takes one segment or more, an optional one none or more.
    const catchAll: Array<[string, string, boolean]> = [
      ["/files/{path}/**", "/files", false],
      ["/files/{path}/**", "/files/a", true],
      ["/files/{path}/**", "/files/a/b", true],
      ["/files/{*path}", "/files", true],
      ["/files/{*path}", "/files/a", true],
    ];
    expect(catchAll.map(([route, call]) => pathsMatch(route, call))).toEqual(catchAll.map(([, , m]) => m));
  });

  it("reads every way a Next.js handler is exported, and the methods Next.js answers itself", () => {
    const files = {
      "app/items/route.ts": "export async function POST(req) {}\nexport const GET = () => new Response();\nfunction put() {}\nexport { put as PUT };",
      "app/orders/route.ts": 'export { GET } from "./handlers";\nexport { create as DELETE } from "./handlers";',
      "app/orders/handlers.ts": "export function GET() {}\nexport function create() {}",
      "app/stock/route.ts": 'export * from "./handlers";',
      "app/stock/handlers.ts": "export function POST() {}",
      "pages/api/ping.ts": "export default function handler(req, res) {}",
      "pages/api/legacy.ts": 'export { default } from "../../server/legacy";',
      "server/legacy.ts": "export default function legacy(req, res) {}",
    };
    expect(scanned(files)).toEqual([
      "api|* /api/legacy",
      "api|* /api/ping",
      "api|DELETE /orders",
      "api|GET /items",
      "api|GET /orders",
      "api|HEAD /items (implicit)",
      "api|HEAD /orders (implicit)",
      "api|OPTIONS /items (implicit)",
      "api|OPTIONS /orders (implicit)",
      "api|OPTIONS /stock (implicit)",
      "api|POST /items",
      "api|POST /stock",
      "api|PUT /items",
    ]);
  });

  it("follows what a server page runs while rendering, and not its links or what the browser runs later", () => {
    const files = {
      "app/notes/[id]/page.tsx": [
        'import Link from "next/link";',
        'import { Card } from "../../../components/card";',
        'import { ServerCard } from "../../../components/server-card";',
        "export async function generateMetadata() { return {}; }",
        'const stats = () => fetch("/api/stats");',
        'const renderRow = () => fetch("/api/rows");',
        "export default async function Note() {",
        '  const note = await fetch("/api/notes/1");',
        '  return <Card note={note}><Link href="/create">new</Link><ServerCard data={stats()} render={renderRow} /></Card>;',
        "}",
      ].join("\n"),
      "components/card.tsx": '"use client";\nexport function Card({ note }) { return <button onClick={() => router.push("/create")}>{note}</button>; }',
      "components/server-card.tsx": 'export async function ServerCard({ data }) { const tags = await fetch("/api/tags"); return <p>{tags}</p>; }',
      "app/api/notes/[id]/route.ts": "export function GET() {}",
      "app/create/page.tsx": "export default function Create() { return null; }",
    };
    const config = normalizeConfig({
      components: [{ name: "web", path: "" }],
      routes: [{ component: "web", files: ["app/**/*.{ts,tsx}"], styles: ["next"] }],
      calls: [{ from: "web", to: "web", files: ["app/**/*.tsx", "components/**/*.tsx"] }],
    });
    const graph = scan(memory(files), config);
    const page = graph.surfaces.find((s) => s.id === "web|GET /notes/{id}")!;
    expect(page.at.line).toBe(7);
    const reach = graph.edges.filter((e) => e.kind === "reach" && e.from === page.id).map((e) => graph.calls.find((c) => c.id === e.to)!.path);
    expect(reach.sort()).toEqual(["/api/notes/1", "/api/stats", "/api/tags"]);
  });

  it("renders a Pages Router class page through its render method", () => {
    const files = {
      "pages/notes.tsx": [
        'import React from "react";',
        "export default class Notes extends React.Component {",
        "  render() { const notes = this.load(); return <ul>{notes}</ul>; }",
        '  load() { return fetch("/api/notes"); }',
        '  clicked() { return fetch("/api/clicked"); }',
        "}",
      ].join("\n"),
    };
    const config = normalizeConfig({
      components: [{ name: "web", path: "" }],
      routes: [{ component: "web", files: ["pages/**/*.tsx"], styles: ["next"] }],
      calls: [{ from: "web", to: "web", files: ["pages/**/*.tsx"] }],
    });
    const graph = scan(memory(files), config);
    const page = graph.surfaces.find((s) => s.id === "web|GET /notes")!;
    const reach = graph.edges.filter((e) => e.kind === "reach" && e.from === page.id).map((e) => graph.calls.find((c) => c.id === e.to)!.path);
    expect(reach).toEqual(["/api/notes"]);
  });

  it("picks a Next.js route by its path, then its method, as Next.js does", () => {
    const files = {
      "app/api/users/me/route.ts": "export function GET() {}",
      "app/api/users/[id]/route.ts": "export function GET() {}\nexport function DELETE() {}",
      "web/a.ts": 'export const me = () => fetch("/api/users/me");\nexport const leave = () => fetch("/api/users/me", { method: "DELETE" });',
    };
    const config = normalizeConfig({
      components: [{ name: "api", path: "" }, { name: "web", path: "web" }],
      routes: [{ component: "api", files: ["app/**/*.ts"], styles: ["next"] }],
      calls: [{ from: "web", to: "api", files: ["web/**/*.ts"] }],
    });
    const graph = scan(memory(files), config);
    expect(graph.edges.filter((e) => e.kind === "match").map((e) => e.to)).toEqual(["api|GET /api/users/me"]);
    // The me route has no DELETE: Next.js answers 405 rather than trying /api/users/[id].
    expect(evaluate(graph, config).map((f) => f.key).filter((k) => k.startsWith("FA002"))).toEqual(["FA002|web->api|DELETE /api/users/me"]);
  });

  it("drops a route registration from the calls, and keeps the request its handler makes on the same path", () => {
    const files = { "bff/routes.ts": 'app.get("/users", async (req, res) => res.json(await client.get("/users")));', "core/routes.ts": 'app.get("/users", h);' };
    const config = normalizeConfig({
      components: [{ name: "bff", path: "bff" }, { name: "core", path: "core" }],
      routes: [{ component: "bff", files: ["bff/*.ts"], styles: ["express"] }, { component: "core", files: ["core/*.ts"], styles: ["express"] }],
      calls: [{ from: "bff", to: "core", files: ["bff/*.ts"] }],
    });
    const graph = scan(memory(files), config);
    expect(graph.calls.map((c) => `${c.method} ${c.path}`)).toEqual(["GET /users"]);
    // The handler's request belongs to the bff route that holds it, not to core's route of the same path.
    expect(graph.edges.filter((e) => e.kind === "reach").map((e) => `${e.from} -> ${graph.calls.find((c) => c.id === e.to)!.path}`)).toEqual(["bff|GET /users -> /users"]);
    // A path built with `+` is the registration; a call written inside it runs, and its request is read.
    const built = scan(memory({ "bff/routes.ts": 'app.get("/" + (sync(client.get("/health")), "ready"), h);' }), config);
    expect(built.calls.map((c) => `${c.method} ${c.path}`)).toEqual(["GET /health"]);
  });

  it("reaches what a framework answers by itself only by a request that names the method", () => {
    const files = {
      "site/app/api/items/route.ts": "export function GET() {}",
      "web/a.ts": 'export const any = () => request("/api/items");\nexport const head = () => fetch("/api/items", { method: "HEAD" });',
    };
    const config = normalizeConfig({
      components: [{ name: "api", path: "site" }, { name: "web", path: "web" }],
      routes: [{ component: "api", files: ["site/**/*.ts"], styles: ["next"] }],
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
          "app.js": 'const app = require("express")();\nconst api = require("./api");\napp.use("/v1", api);\napp.get("/health", h);',
          "api.js": 'const { Router } = require("express");\nconst api = Router();\nconst orders = require("./orders");\napi.use("/shop", orders);\nmodule.exports = api;',
          "orders.js": 'const express = require("express");\nconst router = express.Router();\nrouter.get("/orders", h);\nmodule.exports = router;',
        },
        ["api|GET /health", "api|GET /v1/shop/orders"],
      ],
      [
        "TypeScript routers imported as ./x.js, one mounted on the other",
        {
          "app.ts": 'import express from "express";\nimport api from "./api.js";\nconst app = express();\napp.use("/v1", api);',
          "api.ts": 'import { Router } from "express";\nimport orders from "./orders.js";\nconst api = Router();\napi.use("/shop", orders);\napi.get("/ping", h);\nexport default api;',
          "orders.ts": 'import express from "express";\nconst orders = express.Router();\norders.get("/list", h);\nexport default orders;',
        },
        ["api|GET /v1/ping", "api|GET /v1/shop/list"],
      ],
      [
        "a router exported in an object, mounted on an app another module creates",
        {
          "server.js": 'const express = require("express");\nexport const app = express();',
          "main.js": 'import { app } from "./server.js";\nconst { router } = require("./routes");\napp.use("/api", router);',
          "routes.js": 'const express = require("express");\nconst router = express.Router();\nrouter.get("/items", h);\nmodule.exports = { router };',
        },
        ["api|GET /api/items"],
      ],
      [
        "a router through a barrel's export *, and through a const alias",
        {
          "app.ts": 'import express from "express";\nimport { orders } from "./routes/index.js";\nconst app = express();\nconst shop = orders;\napp.use("/shop", shop);',
          "routes/index.ts": 'export * from "./orders.js";',
          "routes/orders.ts": 'import { Router } from "express";\nexport const orders = Router();\norders.get("/list", h);',
        },
        ["api|GET /shop/list"],
      ],
      [
        "a router a namespace import holds",
        {
          "app.ts": 'import express from "express";\nimport * as routes from "./routes.js";\nconst app = express();\napp.use("/api", routes.router);',
          "routes.ts": 'import { Router } from "express";\nexport const router = Router();\nrouter.get("/items", h);',
        },
        ["api|GET /api/items"],
      ],
      [
        "a require the file declares itself is not CommonJS's",
        { "app.js": 'const require = (m) => fake;\nconst express = require("express");\nconst app = express();\nconst r = express.Router();\nr.get("/x", h);\napp.use("/v", r);' },
        [],
      ],
      [
        "a router mounted twice, once through a bracketed use",
        { "app.js": 'const express = require("express");\nconst app = express();\nconst r = express.Router();\nr.get("/x", h);\napp.use("/a", r);\napp["use"]("/b", r);' },
        ["api|GET /a/x", "api|GET /b/x"],
      ],
      ["an inline middleware before the router", { "app.js": 'const express = require("express");\nconst app = express();\nconst r = express.Router();\nr.get("/x", h);\napp.use((req, res, next) => next(), r);' }, ["api|GET /x"]],
      ["use on something that is not an Express application", { "app.js": 'const express = require("express");\nconst r = express.Router();\nr.get("/x", h);\nregistry.use("/admin", r);' }, []],
      ["a Router from another library", { "app.js": 'const sdk = require("sdk");\nconst r = sdk.Router();\nr.get("/x", h);\napp.use("/v", r);' }, []],
      [
        "another value under the router's name",
        { "app.js": 'const express = require("express");\nconst app = express();\nconst r = express.Router();\nr.get("/x", h);\napp.use("/a", r);\nfunction other() { const r = makeSomething(); app.use("/b", r); }' },
        ["api|GET /a/x"],
      ],
    ];
    for (const [, files, surfaces] of rows) expect(scanned(files)).toEqual(surfaces);
  });
});

describe("registration helpers in the configuration", () => {
  it("take argument positions as whole numbers from 0", () => {
    const helper = (call: Record<string, unknown>) => () => normalizeConfig({ components: [{ name: "api", path: "" }], routes: [{ component: "api", files: ["*.ts"], calls: [{ name: "reg", ...call }] }] });
    expect(helper({ pathArg: 1, methodArg: 0 })).not.toThrow();
    expect(helper({ pathArg: 0, method: "GET" })).not.toThrow();
    expect(helper({ pathArg: 0, method: "*" })).not.toThrow();
    for (const bad of [{ pathArg: 1.5, method: "GET" }, { pathArg: -1, method: "GET" }, { pathArg: 0, methodArg: -1 }, { pathArg: 0, methodArg: 1.5 }, { pathArg: 0, methodArg: 1, method: 123 }, { pathArg: 0, method: 123 }, { pathArg: 0, method: "" }, { name: "", pathArg: 0, method: "GET" }, { pathArg: 0 }, { pathArg: 0, methodArg: 1, method: "GET" }]) {
      expect(helper(bad), JSON.stringify(bad)).toThrow(/registration helper/);
    }
  });
});

describe("inventory", () => {
  it("offers a Next.js file by the names it exports, however the export is indented", () => {
    const files: Record<string, string> = {
      "app/a/route.ts": "  export async function GET() {}",
      "app/b/route.ts": "const GET = h;\nexport { GET as helper };",
      "app/e/route.ts": "export let GET = async () => new Response();",
      "app/f/route.ts": "export var POST = handler;",
      // A type-only export is no handler.
      "app/g/route.ts": "type H = () => Response;\nexport { type H as GET };",
      "pages/api/c.ts": 'export { default as helper } from "./impl";',
      "pages/api/d.ts": 'export { handler as default } from "./impl";',
    };
    const offered = inventory(memory(files), []).routes.map((r) => r.file).sort();
    expect(offered).toEqual(["app/a/route.ts", "app/e/route.ts", "app/f/route.ts", "pages/api/d.ts"]);
  });

  it("offers request shapes, and not a Dart router's registrations", () => {
    const files: Record<string, string> = {
      "agent/a.py": 'r = client.get(rf"{base}/orders")',
      "lib/api.dart": "final r = await dio.get('/orders');",
      "lib/server.dart": "router.get('/orders', handler);\napp.post('/items', create);",
      "lib/shelf.dart": "final api = Router();\napi.get('/orders', handler);\nfinal admin = new Router();\nadmin.get('/users', handler);",
      // Cascades register on the receiver before `..`.
      "lib/cascade.dart": "final router = Router()..get('/x', handler);\nrouter..post('/y', handler);",
      // Next.js's prefetch loads a route ahead; it is no request wrapper. A wrapper named after fetch is.
      "web/nav.ts": 'router.prefetch("/dashboard");',
      "web/me.ts": 'const me = authFetch("/api/me");',
      // A shelf Router taken from a prefixed import registers routes too.
      "lib/prefixed.dart": "final routes = shelf.Router();\nroutes.get('/x', handler);",
    };
    expect(inventory(memory(files), []).calls.map((c) => `${c.file} ${c.count}`).sort()).toEqual(["agent/a.py 1", "lib/api.dart 1", "web/me.ts 1"]);
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
      ['const base = "/api";\nfunction f() { class C { static { var base = y; } } return fetch(`${base}/users`); }', ["GET /api/users"]],
      ['const base = "/api";\nconst C = class base { static u = fetch(`${base}/users`); };', ["* /api", "GET /users based"]],
      ['switch (k) {\n  case 0: const base = "/api";\n  case 1: fetch(`${base}/users`);\n}', ["GET /api/users"]],
      // `using` belongs to its block; the body's `var` is not seen from a parameter's default.
      ['const base = "/api";\nfunction f() { { using base = y; } return fetch(`${base}/users`); }', ["GET /api/users"]],
      ['const base = "/api";\nfunction f(u = fetch(`${base}/users`)) { var base = y; }', ["GET /api/users"]],
      // A const that names another has its value.
      ['const API = "/api";\nconst BASE = API;\nfetch(`${BASE}/users`);', ["GET /api/users"]],
      // Parentheses and assertions around the base leave it the base.
      ['const BASE = "/api";\nfetch((BASE) + "/users");\nfetch((BASE as string) + "/items");', ["GET /api/users", "GET /api/items"]],
      ['class Client extends make(fetch("/schema")) {}', ["GET /schema"]],
    ];
    expect(rows.map(([code]) => read(code))).toEqual(rows.map(([, calls]) => calls));
  });

  it("resolves a relative module only inside the repository", () => {
    const exists = (f: string) => ["x.ts", "src/x.ts"].includes(f);
    // `../../x` from src/a.ts is above the repository; it is not the root's x.ts.
    expect([resolveModule("src/a.ts", "../x.js", exists), resolveModule("src/a.ts", "./x", exists), resolveModule("src/a.ts", "../../x", exists)]).toEqual(["x.ts", "src/x.ts", undefined]);
    // A specifier with its extension is that file: `./foo.ts` is never foo.ts.ts.
    expect(resolveModule("src/a.ts", "./foo.ts", (f) => f === "src/foo.ts.ts")).toBeUndefined();
    // `..` to the repository root takes its index file.
    expect(resolveModule("src/a.ts", "..", (f) => f === "index.ts")).toBe("index.ts");
  });

  it("takes the innermost scope's binding, as JavaScript does", () => {
    // The line of the declaration the last use of `name` resolves to; undefined for a global.
    const bound = (code: string, name: string) => {
      const sf = ts.createSourceFile("a.ts", code, ts.ScriptTarget.Latest, true);
      const uses: ts.Identifier[] = [];
      const visit = (n: ts.Node): void => {
        if (ts.isIdentifier(n) && n.text === name) uses.push(n);
        ts.forEachChild(n, visit);
      };
      visit(sf);
      const decl = declarationOf(uses[uses.length - 1]!);
      return decl && sf.getLineAndCharacterOfPosition(decl.getStart(sf)).line + 1;
    };
    const rows: Array<[string, string, number | undefined]> = [
      // The catch binding, not the `var` its block hoists to the function.
      ["try {} catch (e) {\n  var e;\n  consume(e);\n}", "e", 1],
      // A namespace keeps its own `var`s.
      ["namespace N {\n  var hidden = 1;\n}\nconsume(hidden);", "hidden", undefined],
      ["namespace N {\n  if (x) { var inner = 1; }\n  consume(inner);\n}", "inner", 2],
      ["import X = Outer.A;\nnamespace N {\n  import X = Inner.B;\n  consume(X);\n}", "X", 3],
      ['import api from "./api";\nnamespace Scope {\n  namespace api { export function get() {} }\n  export const x = api.get();\n}', "api", 3],
    ];
    expect(rows.map(([code, name]) => bound(code, name))).toEqual(rows.map(([, , line]) => line));
  });

  it("keeps the escaped braces of a Python f-string literal", () => {
    const text = [
      'r = client.get(f"/tenants/{{tenant}}/{tid}/items")',
      'w = client.get(f"/sizes/{value:{width}}/x")',
      // A brace in a quoted string of the expression is text; a quote in the format spec is a fill character.
      "q = client.get(f\"/keys/{'}'}/users\")",
      "p = client.get(f\"/pad/{n:'>10}/x\")",
      // A request made inside a field runs too.
      "s = f\"{requests.get('/users')}\"",
      // Python 3.12: a field may hold a string in the f-string's own quote.
      's = f"{requests.get("/same")}"',
      // A route's own f-string path is no request; a request in its field still is.
      "@app.get(f\"/{requests.get('/config').text}\")",
    ].join("\n");
    expect(callsFromText("a.py", text, { from: "a", to: "b", files: [] }).map((c) => `${c.method} ${c.path}`)).toEqual([
      "GET /tenants/{tenant}/{}/items",
      "GET /sizes/{}/x",
      "GET /keys/{}/users",
      "GET /pad/{}/x",
      "GET /users",
      "GET /same",
      "GET /config",
    ]);
    // A route literal is read as Python reads it: escapes decoded.
    // `\N{name}` needs Unicode's name table: that route is not read rather than read with the escape left in.
    const routes = '@app.get("/say/\\"hi\\"")\ndef a(): ...\n@app.get("/a\\x2fb")\ndef b(): ...\n@app.get("/foo\\057bar")\ndef c(): ...\n@app.get("/e/\\U0001F600")\ndef d(): ...\n@app.get("/caf\\N{LATIN SMALL LETTER E WITH ACUTE}")\ndef e(): ...';
    expect(routesFromPython("r.py", routes, { component: "c", files: [] }).map((s) => s.path)).toEqual(['/say/"hi"', "/a/b", "/foo/bar", "/e/\u{1F600}"]);
    // Literals written next to each other are one, as Python joins them; one that is an f-string makes the path unknown.
    // Comments may stand between them; a backslash before CRLF joins the lines.
    const joined = '@app.get("/api" "/users")\ndef a(): ...\n@app.get("/api"\n         f"/{v}")\ndef b(): ...\nadd_endpoint(app, "/v1" \'/items\', h)\n@app.get(\n  "/v2"  # base\n  "/orders"\n)\ndef c(): ...\n@app.get("/v3\\\r\n/carts")\ndef d(): ...';
    const helper = { component: "c", files: [], calls: [{ name: "add_endpoint", pathArg: 1, method: "POST" }] };
    expect(routesFromPython("r.py", joined, helper).map((s) => `${s.method} ${s.path}`)).toEqual(["GET /api/users", "GET /v2/orders", "GET /v3/carts", "POST /v1/items"]);
    // The path may be passed by name.
    // A mount's path and app by name.
    const mounted = 'app.mount(path="/static", app=StaticFiles(directory="s"))\napp.mount(app=StaticFiles(directory="t"), path="/assets")';
    expect(routesFromPython("r.py", mounted, { component: "c", files: [] }).map((s) => `${s.method} ${s.path}`)).toEqual(["GET /static/**", "HEAD /static/**", "GET /assets/**", "HEAD /assets/**"]);
    const named = '@app.get(path="/items")\ndef a(): ...\n@app.api_route(methods=["PUT"], path="/carts")\ndef b(): ...\n@app.get(response_model=X)\ndef c(): ...';
    expect(routesFromPython("r.py", named, { component: "c", files: [] }).map((s) => `${s.method} ${s.path}`)).toEqual(["GET /items", "PUT /carts"]);
  });
});
