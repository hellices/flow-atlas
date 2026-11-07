import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it, vi } from "vitest";
import { main } from "../src/commands.js";
import { normalizeConfig } from "../src/config.js";
import { extractCalls } from "../src/extract/calls.js";
import { inventory } from "../src/inventory.js";
import { scan } from "../src/scan.js";
import type { Source } from "../src/source.js";

const memory = (files: Record<string, string>): Source => ({
  ref: "WORKTREE",
  list: () => Object.keys(files),
  read: (p) => files[p],
  asOf: () => "2026-11-01T00:00:00Z",
});

describe("a route source with a document and no code files", () => {
  it("reads the document's operations, as files: [] does", () => {
    const files = { "api/openapi.json": JSON.stringify({ openapi: "3.0.3", info: { title: "t", version: "1" }, paths: { "/items": { get: {} } } }) };
    const config = normalizeConfig({ components: [{ name: "api", path: "api" }], routes: [{ component: "api", openapi: "api/openapi.json" }] });
    expect(scan(memory(files), config).surfaces.map((s) => s.id)).toEqual(["api|GET /items"]);
  });
});

describe("Express routers built by chaining use", () => {
  const scanned = (files: Record<string, string>) => {
    const config = normalizeConfig({ components: [{ name: "api", path: "" }], routes: [{ component: "api", files: ["**/*.{js,ts}"], styles: ["express"] }] });
    const graph = scan(memory(files), config);
    return { surfaces: graph.surfaces.map((s) => s.id).sort(), limits: graph.limits };
  };
  const items = 'import { Router } from "express";\nconst router = Router();\nrouter.get("/items", h);\nexport default router;';

  it("serves a router under the chain that mounts it, exported in place or held in a name", () => {
    expect(
      scanned({
        "main.ts": 'import express from "express";\nimport routes from "./routes";\nconst app = express();\napp.use(routes);',
        "routes.ts": 'import { Router } from "express";\nimport items from "./items";\nconst api = Router()\n  .use(items);\nexport default Router().use("/api", api);',
        "items.ts": items,
      }),
    ).toEqual({ surfaces: ["api|GET /api/items"], limits: [] });
  });

  it("reads a chain exported with module.exports, a router created as use's argument, and a bracketed use", () => {
    expect(
      scanned({
        "app.js": 'const express = require("express");\nconst routes = require("./routes");\nconst items = require("./items");\nconst app = express();\napp.use("/v1", routes);\napp.use("/v2", express.Router()["use"]("/shop", items));',
        "routes.js": 'const express = require("express");\nconst items = require("./items");\nmodule.exports = express.Router().use(items);',
        "items.js": 'const express = require("express");\nconst router = express.Router();\nrouter.get("/items", h);\nmodule.exports = router;',
      }).surfaces,
    ).toEqual(["api|GET /v1/items", "api|GET /v2/shop/items"]);
  });

  it("still leaves a chain mounted at a path the code does not spell out unread, and says so", () => {
    const read = scanned({
      "main.ts": 'import express from "express";\nimport items from "./items";\nconst app = express();\napp.use(prefix, express.Router().use(items));',
      "items.ts": items,
    });
    expect(read.surfaces).toEqual([]);
    expect(read.limits[0]).toContain("router router in items.ts is mounted where the code gives no literal path");
  });
});

describe("a host in a template's leading hole", () => {
  const read = (code: string, origins: Record<string, string> = {}) => {
    const config = normalizeConfig({ components: [{ name: "web", path: "" }, { name: "api", path: "" }], calls: [{ from: "web", to: "api", files: ["a.ts"] }], origins });
    const limits: string[] = [];
    const calls = extractCalls(memory({ "a.ts": code }), config, [], undefined, limits).map((c) => `${c.method} ${c.path}${c.based ? " based" : ""}`);
    return { calls, limits };
  };
  const hostLimit = "calls web->api: URLs to other.example (a.ts:1) are not read as requests to api; set origins.api if that is its host";

  it("is named in the limit the whole conditional gets, and the request of the other branch is still read", () => {
    expect(read("fetch(prod ? 'https://other.example/api/status' : '/api/status');")).toEqual({ calls: ["GET /api/status"], limits: [hostLimit] });
    expect(read("fetch(`${prod ? 'https://other.example' : ''}/api/status`);")).toEqual({ calls: ["GET /api/status based"], limits: [hostLimit] });
    expect(read("fetch((prod ? 'https://other.example' : '') + '/api/status');")).toEqual({ calls: ["GET /api/status based"], limits: [hostLimit] });
  });

  it("leaves out a URL whose every branch names another host, and reads an inline script's alike", () => {
    expect(read("fetch(`${prod ? 'https://other.example' : 'https://more.example'}/api/status`);").calls).toEqual([]);
    const config = normalizeConfig({ components: [{ name: "web", path: "" }, { name: "api", path: "" }], calls: [{ from: "web", to: "api", files: ["a.html"] }] });
    const limits: string[] = [];
    const html = "<p>status</p>\n<script>\nfetch(`${prod ? 'https://other.example' : ''}/api/status`);\n</script>";
    expect(extractCalls(memory({ "a.html": html }), config, [], undefined, limits).map((c) => `${c.method} ${c.path} ${c.at.line}`)).toEqual(["GET /api/status 3"]);
    expect(limits).toEqual([hostLimit.replace("a.ts:1", "a.html:3")]);
  });

  it("says nothing of a loopback host or the target's origin", () => {
    expect(read("fetch(`${dev ? 'http://localhost:3000' : ''}/api/status`);").limits).toEqual([]);
    expect(read("fetch(`${prod ? 'https://other.example' : ''}/api/status`);", { api: "https://other.example" }).limits).toEqual([]);
  });
});

/** What a command prints on stdout and on stderr, and its exit code. */
function run(...args: string[]): { code: number; stdout: string; stderr: string } {
  let stdout = "";
  let stderr = "";
  const out = vi.spyOn(process.stdout, "write").mockImplementation((chunk) => ((stdout += String(chunk)), true));
  const log = vi.spyOn(console, "log").mockImplementation((...items: unknown[]) => void (stdout += `${items.join(" ")}\n`));
  const err = vi.spyOn(process.stderr, "write").mockImplementation((chunk) => ((stderr += String(chunk)), true));
  try {
    return { code: main(args), stdout, stderr };
  } finally {
    out.mockRestore();
    log.mockRestore();
    err.mockRestore();
  }
}

describe("limit lines", () => {
  const root = fileURLToPath(new URL("../fixtures/scenarios/nx-angular-nest", import.meta.url));
  const limit = "limit: calls ui->api: URLs to remote.example";

  it("go to stderr, once, from scan as from check", () => {
    for (const command of ["scan", "check"]) {
      const { code, stdout, stderr } = run(command, "--root", root, "--out", mkdtempSync(join(tmpdir(), "atlas-limits-")));
      expect(code).toBe(0);
      expect(stdout).not.toContain("limit:");
      expect(stderr.split("\n").filter((l) => l.startsWith(limit))).toHaveLength(1);
    }
  });
});

describe("inventory's client call candidates", () => {
  const offered = (files: Record<string, string>) => inventory(memory(files), []).calls.map((c) => `${c.file} ${c.count}`);
  const angular = 'import { HttpClient } from "@angular/common/http";\nimport { inject, Injectable } from "@angular/core";\n';

  it("count a request given as an object, a generated client's or axios's config", () => {
    expect(offered({ "sdk.gen.ts": "export const readItems = (options) => (options?.client ?? client).get({ url: '/api/v1/items/', ...options });" })).toEqual(["sdk.gen.ts 1"]);
    expect(offered({ "a.js": "import axios from 'axios';\naxios({ method: 'post', url: '/api/items', data });\naxios.request({ url: \"/api/items/1\" });" })).toEqual(["a.js 2"]);
    // A generated client's types name each operation's URL as a literal type, which requests nothing.
    expect(offered({ "types.gen.ts": "export type ReadItemsData = {\n    query?: never;\n    url: '/api/v1/items/';\n};" })).toEqual([]);
  });

  it("count Angular's and axios's verb calls, type arguments allowed, on the names the file binds to the client", () => {
    const service = `${angular}@Injectable()\nexport class Items {\n  constructor(private http: HttpClient) {}\n  list() { return this.http.get<Item[]>('/api/items'); }\n  add(i: Item) { return this.http.post<Item>(\n    '/api/items', i);\n  }\n}`;
    expect(offered({ "items.service.ts": service })).toEqual(["items.service.ts 2"]);
    expect(offered({ "feed.service.ts": `${angular}export class Feed {\n  private readonly http = inject(HttpClient);\n  load() { return this.http.get('/api/feed'); }\n}` })).toEqual(["feed.service.ts 1"]);
    const instance = "import axios from 'axios';\nconst api = axios.create({ baseURL: '/api' });\nexport const list = () => api.get<Item[]>('/items');\nexport const one = () => axios.get('/items/1');";
    expect(offered({ "api.ts": instance })).toEqual(["api.ts 2"]);
  });

  it("still leave out a verb call on any other receiver in a script, which registers a route as often as it requests one", () => {
    expect(offered({ "server.ts": "import express from 'express';\nconst app = express();\napp.get<Params>('/items', h);\nrouter.post('/items', h);" })).toEqual([]);
    expect(offered({ "mixed.ts": `${angular}const http: HttpClient = h;\nrouter.get('/items', h);` })).toEqual([]);
    expect(offered({ "untyped.ts": "class S { constructor(private http) {}\n  list() { return this.http.get('/api/items'); } }" })).toEqual([]);
  });
});

describe("inventory's components in an Nx workspace", () => {
  const offered = (files: Record<string, string>) => inventory(memory(files), []).components.map((c) => `${c.name} ${c.path} ${c.manifest}`);
  const project = (name: string) => JSON.stringify({ name, projectType: "application" });

  it("are its projects, by the name project.json gives, without the root package.json that serves them all", () => {
    expect(
      offered({
        "nx.json": "{}",
        "package.json": JSON.stringify({ name: "folio", dependencies: { nx: "^21.0.0" } }),
        "apps/api/project.json": project("api"),
        "apps/client/project.json": project("client"),
        "libs/ui/project.json": project("ui"),
        "libs/ui/package.json": JSON.stringify({ name: "@folio/ui-kit" }),
      }),
    ).toEqual(["api apps/api apps/api/project.json", "client apps/client apps/client/project.json", "ui libs/ui libs/ui/project.json"]);
  });

  it("is the root project of a standalone workspace, by its project.json", () => {
    expect(offered({ "nx.json": "{}", "package.json": JSON.stringify({ name: "@notes/source" }), "project.json": project("api") })).toEqual(["api  project.json"]);
  });

  it("does not take a project.json outside an Nx workspace for a manifest", () => {
    expect(offered({ "package.json": JSON.stringify({ name: "web" }), "tools/project.json": project("tool") })).toEqual(["web  package.json"]);
  });
});

describe("inventory's served documents", () => {
  const documents = (files: Record<string, string>) => inventory(memory(files), []).apiDocuments.map((d) => `${d.location} ${d.convention} ${d.at.file}:${d.at.line}`);

  it("include drf-spectacular's schema view at the path its urlconf gives it", () => {
    const urls = [
      "from django.urls import include, path",
      "from drf_spectacular.views import SpectacularAPIView, SpectacularSwaggerView",
      "",
      "urlpatterns = [",
      '    path("api/", include(router.urls), name="api"),',
      '    path("api/schema/", SpectacularAPIView.as_view(), name="schema"),',
      "    path('api/schema.yaml', views.SpectacularYAMLAPIView.as_view()),",
      '    path("api/schema/swagger-ui/", SpectacularSwaggerView.as_view(url_name="schema"), name="swagger-ui"),',
      '    # path("old/schema/", SpectacularAPIView.as_view()),',
      "]",
    ].join("\n");
    expect(documents({ "backend/project/urls.py": urls })).toEqual([
      "/api/schema/ drf-spectacular urlconf backend/project/urls.py:6",
      "/api/schema.yaml drf-spectacular urlconf backend/project/urls.py:7",
    ]);
  });
});
