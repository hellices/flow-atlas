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
