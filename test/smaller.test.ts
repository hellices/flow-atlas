import { describe, expect, it } from "vitest";
import { normalizeConfig } from "../src/config.js";
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
