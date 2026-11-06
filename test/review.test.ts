import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";
import { describe, expect, it, vi } from "vitest";
import { sourceNames, toArazzo } from "../src/arazzo.js";
import { main } from "../src/commands.js";
import { loadConfig, normalizeConfig } from "../src/config.js";
import { resolveApiDescriptions } from "../src/extract/apidocs.js";
import { callsFromText, callsFromTypeScript } from "../src/extract/calls.js";
import { extractComponents } from "../src/extract/components.js";
import { Reach } from "../src/extract/reach.js";
import { pythonCode, routesFromPython } from "../src/extract/routes.js";
import { resolveFlows, type FlowObject, type LoadedFile } from "../src/flows.js";
import type { Finding, Graph } from "../src/model.js";
import { nearby } from "../src/nearby.js";
import { callPath } from "../src/paths.js";
import { markdownReport } from "../src/report.js";
import { scan } from "../src/scan.js";
import { WorktreeSource, type Source } from "../src/source.js";

const memory = (files: Record<string, string>): Source => ({
  ref: "WORKTREE",
  list: () => Object.keys(files),
  read: (p) => files[p],
  asOf: () => "2026-11-01T00:00:00Z",
});

function capture(argv: string[]): { code: number; out: string; err: string } {
  let out = "";
  let err = "";
  const o = vi.spyOn(process.stdout, "write").mockImplementation((c) => ((out += String(c)), true));
  const e = vi.spyOn(process.stderr, "write").mockImplementation((c) => ((err += String(c)), true));
  try {
    return { code: main(argv), out, err };
  } finally {
    o.mockRestore();
    e.mockRestore();
  }
}

const shop = fileURLToPath(new URL("../fixtures/shop", import.meta.url));

describe("Arazzo export", () => {
  const config = loadConfig(join(shop, "atlas.config.yaml"));
  const source = new WorktreeSource(shop);
  const graph = scan(source, config);
  const file = (...flows: FlowObject[]): LoadedFile => ({ file: "f.flow.yaml", text: "", errors: [], flows: flows.map((object) => ({ object, line: 1, stepLine: () => 1 })) });
  const flow = (name: string, steps: FlowObject["spec"]["steps"]): FlowObject => ({ apiVersion: "flow-atlas.dev/v1alpha1", kind: "Flow", metadata: { name }, spec: { steps } });

  it("names sources uniquely when component names reduce to the same characters", () => {
    expect([...sourceNames(["a/b", "a.b", "a-b", "c"])]).toEqual([
      ["a-b", "a-b"],
      ["a.b", "a-b-2"],
      ["a/b", "a-b-3"],
      ["c", "c"],
    ]);
  });

  it("drops a step that runs a workflow left out of the export", () => {
    const child = flow("child", [{ stepId: "any", surface: "orders|GET /order-updates" }]);
    const parent = flow("parent", [
      { stepId: "screen", surface: "bff|GET /screens/home" },
      { stepId: "run", flow: "child" },
    ]);
    const anyMethod = { ...graph, surfaces: graph.surfaces.map((s) => (s.id === "orders|GET /order-updates" ? { ...s, id: "orders|* /order-updates", method: "*" } : s)) };
    child.spec.steps[0]!.surface = "orders|* /order-updates";
    const { document, limits } = toArazzo(anyMethod, [file(parent, child)], { ...config, openapi: { bff: "openapi/bff.json" } }, { title: "t", flow: "parent" });
    const workflows = document.workflows as Array<{ workflowId: string; steps: Array<{ stepId: string }> }>;
    expect(workflows.map((w) => `${w.workflowId}:${w.steps.map((s) => s.stepId).join(",")}`)).toEqual(["parent:screen"]);
    expect(limits).toContain("parent.run: flow child is not in this export");
  });
});

describe("commands", () => {
  it("lets inventory read a configuration kept in --out", () => {
    const root = mkdtempSync(join(tmpdir(), "atlas-root-"));
    const out = mkdtempSync(join(tmpdir(), "atlas-out-"));
    mkdirSync(join(root, "skip"));
    writeFileSync(join(root, "skip", "app.ts"), 'app.get("/x", h);\n');
    writeFileSync(join(out, "atlas.config.yaml"), 'exclude: ["skip/**"]\n');
    const r = capture(["inventory", "--root", root, "--out", out, "--format", "json"]);
    expect(r.code).toBe(0);
    const doc = JSON.parse(r.out) as { routes: unknown[]; provenance: { resolvedDependencies: Array<{ name: string }> } };
    expect(doc.routes).toEqual([]);
    expect(doc.provenance.resolvedDependencies.map((d) => d.name)).toContain("config");
  });
});

describe("API descriptions", () => {
  it("keeps a served document whose page shows its own path", () => {
    const doc = { component: "c", kind: "served" as const, location: "/documentation/json", aliasOf: "/documentation/json", convention: "fastify-swagger-ui", at: { file: "a.ts", line: 1 }, evidence: "static" as const };
    expect(resolveApiDescriptions([doc], [], normalizeConfig({}))[0]).toMatchObject({ status: "chosen", location: "/documentation/json", reason: "ServedByCode" });
  });
});

describe("call methods", () => {
  const spec = { from: "a", to: "b", files: [] };
  it("leaves an unknown method property as any method", () => {
    expect(callsFromTypeScript("a.ts", 'request({ url: "/orders", method: "invalid" });', spec).map((c) => c.method)).toEqual(["*"]);
    expect(callsFromTypeScript("a.ts", 'request({ url: "/orders", method: "post" });', spec).map((c) => c.method)).toEqual(["POST"]);
  });
  it("gives each call on a line its own HttpMethod", () => {
    const calls = callsFromText("A.kt", 'request(HttpMethod.Post, "/a"); request(HttpMethod.Get, "/b")', spec);
    expect(calls.map((c) => `${c.method} ${c.path}`)).toEqual(["POST /a", "GET /b"]);
  });
});

describe("manifests", () => {
  it("skips a manifest whose declarations are not lists of strings, with a limit", () => {
    const source = memory({ "web/component.json": '{"name":"web","consumes":1}', "api/component.json": '{"name":"api","provides":["x"]}' });
    const { components, limits } = extractComponents(source, normalizeConfig({ manifest: { kind: "component-json", glob: "*/component.json" } }));
    expect(components.map((c) => c.name)).toEqual(["api"]);
    expect(limits).toEqual(["web/component.json: name must be a string and provides and consumes lists of strings; its declarations were skipped"]);
  });
});

describe("Reach", () => {
  const reachFrom = (files: Record<string, string>, file: string, statement: number) => {
    const reach = new Reach(memory(files));
    const sf = reach.parse(file)!.sf;
    return reach.from(file, (sf.statements[statement] as ts.ExpressionStatement).expression);
  };

  it("follows a default import", () => {
    expect(
      reachFrom(
        { "src/a.ts": 'import helper from "./helper.js";\nregister(() => helper());', "src/helper.ts": "export default function helper() { return client.send(); }" },
        "src/a.ts",
        1,
      ),
    ).toEqual(["send"]);
    expect(
      reachFrom({ "src/a.ts": 'import h from "./h.js";\nregister(() => h());', "src/h.ts": "const go = () => client.post();\nexport default go;" }, "src/a.ts", 1),
    ).toEqual(["post"]);
  });

  it("does not follow a top-level function a parameter shadows", () => {
    const text = "function helper() { return client.remove(); }\nregister((helper) => helper());";
    expect(reachFrom({ "src/a.ts": text }, "src/a.ts", 1)).toEqual([]);
  });

  it("follows a nested function only where it is used", () => {
    const unused = "register(() => { function unused() { client.cancel(); } return client.read(); });";
    expect(reachFrom({ "src/a.ts": unused }, "src/a.ts", 0)).toEqual(["read"]);
    const used = "register(() => { const go = () => client.cancel(); return go(); });";
    expect(reachFrom({ "src/a.ts": used }, "src/a.ts", 0)).toEqual(["cancel"]);
  });
});

describe("FastAPI routes", () => {
  it("ignores decorators in comments and strings", () => {
    const text = ['# @app.get("/old")', 'doc = """', '@app.get("/example")', '"""', 'x = \'@app.get("/inline")\'', '@app.get("/live")', "def live(): ..."].join("\n");
    expect(routesFromPython("a.py", text, { component: "c", files: [] }).map((s) => `${s.method} ${s.path} ${s.at.line}`)).toEqual(["GET /live 6"]);
    expect(pythonCode(text)).toHaveLength(text.length);
  });
});

describe("flow coverage", () => {
  it("counts the surface a terminal call step reaches as covered", () => {
    const config = loadConfig(join(shop, "atlas.config.yaml"));
    const graph = scan(new WorktreeSource(shop), config);
    const match = graph.edges.find((e) => e.kind === "match" && e.to === "orders|POST /orders")!;
    const object: FlowObject = { apiVersion: "flow-atlas.dev/v1alpha1", kind: "Flow", metadata: { name: "one" }, spec: { steps: [{ stepId: "c", call: match.from }] } };
    const report = resolveFlows(graph, [{ file: "f.flow.yaml", text: "", errors: [], flows: [{ object, line: 1, stepLine: () => 1 }] }], "2026-11-01T00:00:00Z");
    expect(report.unassigned).not.toContain("orders|POST /orders");
  });
});

describe("nearby", () => {
  it("leaves out paths that share nothing, whatever the method", () => {
    const graph = { calls: [{ from: "w", to: "api", method: "GET", path: "/users", at: { file: "w.ts", line: 1 } }], surfaces: [] } as unknown as Graph;
    const finding = { rule: "FA001", key: "FA001|api|GET /orders" } as Finding;
    expect(nearby(graph, finding)).toEqual([]);
  });
});

describe("callPath", () => {
  it("does not read a query or fragment as the path", () => {
    expect(callPath("https://api.example?next=/orders")).toBeUndefined();
    expect(callPath("https://api.example#next=/orders")).toBeUndefined();
    expect(callPath("https://api.example/v1/orders?next=/x")).toEqual({ path: "/v1/orders", based: true });
  });
});

describe("markdown report", () => {
  it("keeps a finding on one table row", () => {
    const finding: Finding = { rule: "FA002", key: "k", title: "t", message: "line one\nline | two", at: [{ file: "a.ts", line: 1 }] };
    const text = markdownReport([{ finding, status: "new" }]);
    const rows = text.trim().split("\n");
    expect(rows).toHaveLength(3);
    expect(rows[2]).toContain("line one<br>line \\| two");
  });
});
