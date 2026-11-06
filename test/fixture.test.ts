import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it, vi } from "vitest";
import { main } from "../src/commands.js";
import { loadConfig } from "../src/config.js";
import { evaluate } from "../src/rules.js";
import { scan } from "../src/scan.js";
import { WorktreeSource } from "../src/source.js";
import { seedsFor, trace, traceText } from "../src/flow.js";
import { flowFindings, loadFlows, resolveFlows, type FlowReport } from "../src/flows.js";
import { schemaForKind, validate } from "../src/schema.js";
import { arazzoErrors, sarifErrors } from "./standards.js";
import { query } from "../src/commands.js";
import { diffGraphs } from "../src/diff.js";
import { toArazzo } from "../src/arazzo.js";
import { parse as parseYaml } from "yaml";
import type { Subgraph } from "../src/model.js";
import { inventory } from "../src/inventory.js";
import { DEFAULT_EXCLUDE } from "../src/config.js";

const root = fileURLToPath(new URL("../fixtures/shop", import.meta.url));
const AS_OF = "2026-11-01T00:00:00Z";
const config = loadConfig(join(root, "atlas.config.yaml"));

const EXPECTED = [
  "FA001|bff|PUT /preferences",
  "FA001|orders|GET /orders/{id}/history",
  "FA001|pricing|POST /discounts",
  "FA002|bff->orders|POST /orders/{}/refund",
  "FA003|cycle|orders->pricing",
  "FA003|undeclared|web->orders",
  "FA004|document|coupon|no-consumer",
  "FA004|document|invoice|no-producer",
];

describe("shop fixture", () => {
  const graph = scan(new WorktreeSource(root), config);

  it("extracts routes from Nest decorators, constants, Express, a registration function and FastAPI", () => {
    const ids = graph.surfaces.map((s) => `${s.component} ${s.method} ${s.path}`).sort();
    expect(ids).toEqual([
      "bff GET /openapi.json",
      "bff GET /screens/home",
      "bff GET /screens/order/{orderId}",
      "bff POST /orders",
      "bff PUT /preferences",
      "orders GET /order-updates",
      "orders GET /orders/{id}",
      "orders GET /orders/{id}/history",
      "orders POST /orders",
      "pricing GET /quotes",
      "pricing POST /discounts",
    ]);
  });

  it("reads declared edges from the manifests", () => {
    expect(graph.declared.map((e) => `${e.from}->${e.to}`).sort()).toEqual([
      "android->bff",
      "bff->orders",
      "bff->pricing",
      "orders->pricing",
      "pricing->orders",
      "web->bff",
    ]);
  });

  it("reports exactly the planted findings", () => {
    expect(evaluate(graph, config).map((f) => f.key)).toEqual(EXPECTED);
  });

  it("lets a configuration switch a rule or the cycle check off", () => {
    const quiet = { ...config, rules: { FA001: { enabled: false }, FA003: { cycles: false } } };
    const keys = evaluate(graph, quiet).map((f) => f.key);
    expect(keys.some((k) => k.startsWith("FA001"))).toBe(false);
    expect(keys).not.toContain("FA003|cycle|orders->pricing");
    expect(keys).toContain("FA003|undeclared|web->orders");
  });

  it("still checks calls to a component whose routes are all gone", () => {
    const noOrders = { ...graph, surfaces: graph.surfaces.filter((s) => s.component !== "orders") };
    const keys = evaluate(noOrders, config).map((f) => f.key);
    expect(keys.filter((k) => k.startsWith("FA002|bff->orders|"))).toEqual([
      "FA002|bff->orders|* /order-updates",
      "FA002|bff->orders|GET /orders/{}",
      "FA002|bff->orders|POST /orders",
      "FA002|bff->orders|POST /orders/{}/refund",
    ]);
  });

  it("treats manifests that declare nothing as allowing nothing, and no manifests as nothing to compare", () => {
    const none = { ...graph, declared: [] };
    expect(evaluate(none, config).filter((f) => f.key.startsWith("FA003|undeclared")).map((f) => f.key)).toEqual([
      "FA003|undeclared|android->bff",
      "FA003|undeclared|bff->orders",
      "FA003|undeclared|bff->pricing",
      "FA003|undeclared|web->bff",
      "FA003|undeclared|web->orders",
    ]);
    const unmanaged = { ...config, manifest: undefined };
    expect(evaluate(none, unmanaged).some((f) => f.key.startsWith("FA003|undeclared"))).toBe(false);
  });

  it("treats a declared public surface as called", () => {
    const open = { ...config, publicSurfaces: ["pricing|POST /discounts"] };
    expect(evaluate(graph, open).map((f) => f.key)).not.toContain("FA001|pricing|POST /discounts");
  });
});

describe("check, baseline and exceptions", () => {
  const out = mkdtempSync(join(tmpdir(), "atlas-"));
  const run = (...args: string[]) => main([...args, "--root", root, "--out", out]);
  const lastItems = () => (JSON.parse(readFileSync(join(out, "last-check.json"), "utf8")) as { items: Array<{ status: string; finding: { key: string } }> }).items;

  it("shows every finding as new before a baseline exists and fails on request", () => {
    expect(run("check")).toBe(0);
    expect(lastItems().filter((i) => i.status === "new")).toHaveLength(EXPECTED.length);
    expect(run("check", "--fail-on-new")).toBe(1);
  });

  it("hides baseline findings after a baseline update", () => {
    expect(run("baseline", "update")).toBe(0);
    expect(run("check", "--fail-on-new")).toBe(0);
    expect(lastItems().every((i) => i.status === "baseline")).toBe(true);
  });

  it("applies exceptions and brings back expired ones", () => {
    const file = join(out, "exceptions.yaml");
    writeFileSync(
      file,
      [
        "- rule: FA001",
        '  key: "bff|PUT /preferences"',
        "  reason: provider first, client follows",
        "- rule: FA004",
        '  key: "document|coupon|no-consumer"',
        "  reason: kept for one release",
        "  reviewBy: 2000-01-01",
      ].join("\n"),
    );
    run("check");
    const byKey = new Map(lastItems().map((i) => [i.finding.key, i.status]));
    expect(byKey.get("FA001|bff|PUT /preferences")).toBe("excepted");
    expect(byKey.get("FA004|document|coupon|no-consumer")).toBe("expired-exception");
  });

});

describe("trace", () => {
  const graph = scan(new WorktreeSource(root), config);
  const ids = (doc: Subgraph) => [...doc.surfaces.map((s) => s.id), ...doc.calls.map((c) => `${c.from}#${c.scope}`)].sort();

  it("follows a screen from the web client through the bff handler's port call to the orders service", () => {
    const doc = trace(graph, seedsFor(graph, "GET /screens/order/:orderId"));
    expect(ids(doc)).toEqual(["bff#getOrder", "bff|GET /screens/order/{orderId}", "orders|GET /orders/{id}", "web#orderScreen"]);
    expect(doc.edges.map((e) => `${e.kind}${e.via ? ` ${e.via}` : ""}`).sort()).toEqual(["match", "match", "reach getOrder"]);
    expect(traceText(doc)).toContain("~ bff -> orders  GET /orders/{} in getOrder");
  });

  it("goes back from a service route to the client that starts the flow", () => {
    const doc = trace(graph, seedsFor(graph, "orders|POST /orders"));
    expect(ids(doc)).toEqual(["android#create", "bff#createOrder", "bff|POST /orders", "orders|POST /orders"]);
  });

  it("finds each component's OpenAPI description where the code serves it or the repository keeps it", () => {
    expect(graph.apiDocuments.map((d) => `${d.component} ${d.kind} ${d.location} ${d.convention}`)).toEqual([
      "bff served /openapi.json route",
      "orders file services/orders/openapi.json committed",
      "orders served /docs-json nest-swagger default",
      "pricing file services/pricing/legacy.openapi.yaml committed",
      "pricing file services/pricing/openapi.yaml committed",
    ]);
    expect(graph.apiDocuments.find((d) => d.location === "services/orders/openapi.json")!.agreement).toEqual({
      surfaces: 4,
      covered: 1,
      missing: ["orders|GET /order-updates", "orders|GET /orders/{id}/history", "orders|POST /orders"],
      extra: 0,
    });
    expect(evaluate(graph, config).map((f) => f.key)).not.toContain("FA001|bff|GET /openapi.json");
  });

  it("decides a component's description only where the code decides it", () => {
    expect(graph.apiDescriptions.map((d) => `${d.component} ${d.status} ${d.location} ${d.reason}`)).toEqual([
      "bff chosen /openapi.json ServedByCode",
      "orders chosen /docs-json ServedByCode",
      "pricing chosen services/pricing/openapi.yaml FileMatchesCode",
    ]);
    expect(graph.apiDescriptions[1]!.message).toBe("services/orders/openapi.json lacks 3 of 4 routes");
  });

  it("names operations as OpenAPI does: explicit ids first, then the configured convention", () => {
    const ops = Object.fromEntries(graph.surfaces.filter((s) => s.operationId).map((s) => [s.id, s.operationId]));
    expect(ops).toEqual({
      "bff|GET /screens/home": "getHome",
      "bff|PUT /preferences": "putPreferences",
      "orders|GET /orders/{id}": "OrdersController_get",
      "orders|POST /orders": "createOrder",
      "orders|GET /orders/{id}/history": "OrdersController_history",
    });
  });

  it("reports how much each configured source yielded", () => {
    const calls = graph.coverage.find((c) => c.source === "calls bff->orders")!;
    expect(calls).toMatchObject({ files: 1, items: 4, matched: 3, linked: 2 });
  });

  it("gives every call a stable id and every edge known ends", () => {
    const callIds = graph.calls.map((c) => c.id);
    expect(new Set(callIds).size).toBe(callIds.length);
    expect(callIds).toContain("bff->orders|POST /orders@services/bff/src/clients/orders.ts#createOrder");
    const known = new Set([...callIds, ...graph.surfaces.map((s) => s.id)]);
    for (const e of graph.edges) expect(known.has(e.from) && known.has(e.to)).toBe(true);
  });
});

describe("flows", () => {
  const source = new WorktreeSource(root);
  const graph = scan(source, config);
  const flow = (doc: FlowReport, name: string) => doc.items.find((f) => f.metadata.name === name)!;
  const cond = (doc: FlowReport, name: string) => Object.fromEntries(flow(doc, name).status.conditions.map((c) => [c.type, `${c.status} ${c.reason}`]));

  it("resolves the steps, follows the edges between them and reports conditions", () => {
    const doc = resolveFlows(graph, loadFlows(source, config), AS_OF);
    const view = flow(doc, "view-order");
    expect(view.metadata.annotations).toEqual({ "flow-atlas.dev/location": "flows/orders.flow.yaml:4" });
    expect(view.status.entry).toEqual({ component: "web", callers: ["web->bff|GET /screens/order/{}@apps/web/src/api.ts#orderScreen"] });
    expect(view.status.steps[0]!.toNext!.edges.map((e) => e.kind)).toEqual(["reach", "match"]);
    expect(cond(doc, "view-order")).toEqual({
      Ready: "True NoConditionFailed",
      Resolved: "True AllStepsResolved",
      Connected: "True AllStepsConnected",
      ProducesListed: "True AllListed",
      Documented: "True TitleAndRolesWritten",
    });
    expect(cond(doc, "place-order")).toMatchObject({ Ready: "True NoConditionFailed" });
    expect(cond(doc, "refund-order")).toMatchObject({ Ready: "False ConditionsFailed", Resolved: "True PlannedStepsPending", Documented: "False TitleMissing" });
    expect(flowFindings(doc)).toEqual([]);
    expect(doc.unassigned).not.toContain("bff|POST /orders");
    expect(doc.unassigned).toContain("bff|GET /screens/home");
    expect(doc.provenance.resolvedDependencies.map((d) => `${d.name} ${d.uri}`)).toEqual(["code .", "config atlas.config.yaml", "flows flows/orders.flow.yaml"]);
  });

  it("reports what a flow states and the code does not show", () => {
    const out = mkdtempSync(join(tmpdir(), "atlas-flows-"));
    mkdirSync(join(out, "flows"));
    const head = "apiVersion: flow-atlas.dev/v1alpha1\nkind: Flow\n";
    writeFileSync(
      join(out, "flows", "broken.flow.yaml"),
      [
        `${head}metadata: { name: broken }`,
        "spec:",
        "  entry: { component: android }",
        "  steps:",
        '    - { stepId: home, surface: "bff|GET /screens/home" }',
        '    - { stepId: gone, surface: "orders|DELETE /orders/{id}" }',
        "  produces: [document:nothing]",
        "---",
        `${head}metadata: { name: detached }`,
        "spec:",
        "  steps:",
        '    - { stepId: home, surface: "bff|GET /screens/home" }',
        '    - { stepId: price, surface: "pricing|GET /quotes" }',
      ].join("\n"),
    );
    writeFileSync(join(out, "flows", "invalid.flow.yaml"), `${head}metadata: { name: Not_Valid }\nspec: { steps: [] }\n`);
    const doc = resolveFlows(graph, loadFlows(source, { ...config, flows: [] }, out), AS_OF);
    expect(flowFindings(doc).map((f) => f.key)).toEqual([
      "FA007|broken|gone|unresolved",
      "FA007|broken|produces|document:nothing",
      "FA007|broken|undocumented",
      "FA007|detached|home|disconnected",
      "FA007|detached|undocumented",
      "FA007|flows/invalid.flow.yaml|invalid",
    ]);
    expect(cond(doc, "detached")).toMatchObject({ Documented: "False TitleMissing" });
    expect(cond(doc, "detached")).toMatchObject({ Ready: "False ConditionsFailed", Connected: "False NoPathBetweenSteps" });
    expect(cond(doc, "broken")).toMatchObject({ Connected: "Unknown StepsUnresolved", ProducesListed: "False NotInRegistry" });
    // The second step is the unresolved one; the message names the pair it leaves unchecked, as the other Connected ones do.
    expect(flow(doc, "broken").status.conditions.find((c) => c.type === "Connected")!.message).toBe("not checked: home -> gone");
    expect(validate("flow-report", doc)).toEqual([]);
  });
});

describe("schemas", () => {
  const source = new WorktreeSource(root);
  const graph = scan(source, config, { root, requested: "WORKTREE" });

  it("accepts every document atlas writes", () => {
    expect(validate("graph", graph)).toEqual([]);
    expect(validate("subgraph", trace(graph, seedsFor(graph, "/screens/order/:orderId")))).toEqual([]);
    expect(validate("subgraph", query(graph, { path: "/orders" }))).toEqual([]);
    expect(validate("flow-report", resolveFlows(graph, loadFlows(source, config), AS_OF))).toEqual([]);
    expect(validate("diff", diffGraphs(graph, graph, [], evaluate(graph, config)))).toEqual([]);
  });

  it("records the tool, the parameters and every input with a digest, and nothing that varies between runs", () => {
    expect(graph.apiVersion).toBe("flow-atlas.dev/v1alpha1");
    expect(graph.provenance.buildType).toBe("flow-atlas/Graph@v1alpha1");
    expect(graph.provenance.externalParameters).toEqual({ ref: "WORKTREE" });
    expect(graph.provenance.resolvedDependencies[1]).toMatchObject({ name: "config", uri: "atlas.config.yaml", digest: { sha256: expect.stringMatching(/^[0-9a-f]{64}$/) as string } });
    expect(JSON.stringify(scan(source, config, { root, requested: "WORKTREE" }))).toBe(JSON.stringify(graph));
  });

  it("accepts the documents the commands print, in JSON and YAML", () => {
    const out = mkdtempSync(join(tmpdir(), "atlas-schema-"));
    const capture = (...args: string[]): string => {
      let text = "";
      const spy = vi.spyOn(process.stdout, "write").mockImplementation((chunk) => {
        text += String(chunk);
        return true;
      });
      try {
        expect(main([...args, "--root", root, "--out", out])).toBe(0);
      } finally {
        spy.mockRestore();
      }
      return text;
    };
    const runs: Array<[string[], "json" | "yaml"]> = [
      [["check"], "json"],
      [["inventory"], "json"],
      [["trace", "bff|POST /orders"], "json"],
      [["scan"], "json"],
      [["query", "--path", "/orders"], "yaml"],
      [["flows"], "yaml"],
    ];
    for (const [args, format] of runs) {
      {
        const text = capture(...args, "--format", format);
        const doc = (format === "json" ? JSON.parse(text) : parseYaml(text)) as { kind: string };
        expect(validate(schemaForKind(doc.kind)!, doc)).toEqual([]);
      }
    }
    expect(validate("findings", JSON.parse(readFileSync(join(out, "last-check.json"), "utf8")))).toEqual([]);
  });

  it("exports findings as SARIF 2.1.0 that the official schema accepts", () => {
    const out = mkdtempSync(join(tmpdir(), "atlas-sarif-"));
    writeFileSync(join(out, "exceptions.yaml"), '- rule: FA004\n  key: "FA004|document|coupon|no-consumer"\n  reason: kept for audit\n');
    let text = "";
    const spy = vi.spyOn(process.stdout, "write").mockImplementation((chunk) => {
      text += String(chunk);
      return true;
    });
    try {
      main(["check", "--root", root, "--out", out, "--format", "sarif"]);
    } finally {
      spy.mockRestore();
    }
    type Result = { ruleId: string; partialFingerprints: Record<string, string>; suppressions?: unknown };
    const sarif = JSON.parse(text) as { runs: Array<{ results: Result[]; tool: { driver: { rules: Array<{ id: string }> } } }> };
    expect(sarifErrors(sarif)).toEqual([]);
    const results = sarif.runs[0]!.results;
    expect(results).toHaveLength(8);
    const coupon = results.find((r) => r.partialFingerprints["flowAtlasKey/v1"] === "FA004|document|coupon|no-consumer")!;
    expect(coupon.suppressions).toEqual([{ kind: "external", status: "accepted", justification: "kept for audit" }]);
    const refund = results.find((r) => r.ruleId === "FA002")!;
    expect(refund).toMatchObject({ level: "error", baselineState: "new", locations: [{ physicalLocation: { artifactLocation: { uri: "services/bff/src/clients/orders.ts" } } }] });
    expect(sarif.runs[0]!.tool.driver.rules.map((r) => r.id)).toEqual(["FA001", "FA002", "FA003", "FA004", "FA007"]);
  });

  it("exports flows as Arazzo 1.0 that the official schema accepts", () => {
    const { document, limits } = toArazzo(graph, loadFlows(source, config), { ...config, openapi: { bff: "openapi/bff.json" } }, { title: "Shop flows" });
    expect(arazzoErrors(document)).toEqual([]);
    const workflows = document.workflows as Array<{ workflowId: string; steps: Array<Record<string, unknown>> }>;
    expect(workflows.map((w) => w.workflowId)).toEqual(["view-order", "place-order", "refund-order"]);
    expect(workflows[0]!.steps.map(({ stepId, operationId, operationPath }) => ({ stepId, operationId, operationPath }))).toEqual([
      { stepId: "screen", operationId: undefined, operationPath: "{$sourceDescriptions.bff.url}#/paths/~1screens~1order~1{orderId}/get" },
      { stepId: "read", operationId: "$sourceDescriptions.orders.OrdersController_get", operationPath: undefined },
    ]);
    expect(document.sourceDescriptions).toEqual([
      { name: "bff", url: "openapi/bff.json", type: "openapi" },
      { name: "orders", url: "/docs-json", type: "openapi" },
    ]);
    expect(limits).toEqual([
      "orders serves its OpenAPI document at /docs-json (services/orders/src/main.ts:8); set origins.orders to the server's base URL for the environment",
    ]);
    const withOrigin = toArazzo(graph, loadFlows(source, config), { ...config, origins: { orders: "http://localhost:3001/" } }, { title: "Shop flows" });
    expect(withOrigin.document.sourceDescriptions).toEqual([
      { name: "bff", url: "/openapi.json", type: "openapi" },
      { name: "orders", url: "http://localhost:3001/docs-json", type: "openapi" },
    ]);
  });

  it("refuses to export when the code cannot tell which description is a component's", () => {
    const twoServed = {
      ...graph,
      apiDescriptions: graph.apiDescriptions.map((d) =>
        d.component === "orders" ? { ...d, status: "ambiguous" as const, location: undefined, kind: undefined, reason: "SeveralServedDocuments", message: "candidates: /v1/docs-json, /v2/docs-json" } : d,
      ),
    };
    expect(() => toArazzo(twoServed, loadFlows(source, config), config, { title: "Shop flows" })).toThrow(
      "no OpenAPI description is decided for orders: SeveralServedDocuments (candidates: /v1/docs-json, /v2/docs-json); choose one and set openapi.orders",
    );
  });

  it("brings the flows a selected flow runs into the export", () => {
    const files = loadFlows(source, config);
    const parent = { ...files[0]!.flows[1]!.object, metadata: { name: "checkout" }, spec: { steps: [{ stepId: "place", flow: "place-order" }] } };
    files.push({ file: "flows/checkout.flow.yaml", text: "", errors: [], flows: [{ object: parent, line: 1, stepLine: () => 1 }] });
    const { document } = toArazzo(graph, files, { ...config, openapi: { bff: "openapi/bff.json" } }, { title: "t", flow: "checkout" });
    expect(arazzoErrors(document)).toEqual([]);
    const workflows = document.workflows as Array<{ workflowId: string; steps: Array<Record<string, unknown>> }>;
    expect(workflows.map((w) => w.workflowId)).toEqual(["place-order", "checkout"]);
    expect(workflows[1]!.steps[0]).toMatchObject({ stepId: "place", workflowId: "place-order" });
  });

  it("resolves an operation against the chosen description: its operationId, else the path key it writes", () => {
    const unnamed = { ...graph, surfaces: graph.surfaces.map((s) => ({ ...s, operationId: s.component === "orders" ? "CodeOnlyId" : undefined })) };
    const chosen = { ...config, openapi: { bff: "openapi/bff.json", orders: "services/orders/openapi.json" } };
    const step = (read: (p: string) => string | undefined) =>
      (toArazzo(unnamed, loadFlows(source, config), chosen, { title: "t", flow: "view-order", read }).document.workflows as Array<{ steps: Array<Record<string, unknown>> }>)[0]!.steps[1]!;
    // One or the other, never both: an Arazzo step names its operation exactly once.
    const target = ({ operationId, operationPath }: Record<string, unknown>) => ({ operationId, operationPath });
    expect(target(step((p) => source.read(p)))).toEqual({ operationId: "$sourceDescriptions.orders.OrdersController_get", operationPath: undefined });
    const withoutId = (p: string) => source.read(p)?.replace('"operationId": "OrdersController_get",', "");
    expect(target(step(withoutId))).toEqual({ operationId: undefined, operationPath: "{$sourceDescriptions.orders.url}#/paths/~1orders~1{orderId}/get" });
  });

  it("refuses an export with no workflow in it", () => {
    expect(() => toArazzo(graph, [], config, { title: "t" })).toThrow("nothing to export: no flow description is active");
    expect(() => toArazzo(graph, loadFlows(source, config), config, { title: "t", flow: "nope" })).toThrow("nothing to export: no active flow is named nope");
  });

  it("rejects a step that names neither a surface, a call nor a flow", () => {
    const errors = validate("flow", { apiVersion: "flow-atlas.dev/v1alpha1", kind: "Flow", metadata: { name: "a" }, spec: { steps: [{ stepId: "s" }] } });
    expect(errors.length).toBeGreaterThan(0);
  });
});

describe("inventory", () => {
  const inv = inventory(new WorktreeSource(root), DEFAULT_EXCLUDE);

  it("lists components, route styles, and client call files without deciding anything", () => {
    expect(inv.components.map((c) => c.name).sort()).toEqual(["android", "bff", "orders", "pricing", "web"]);
    expect(new Set(inv.routes.map((r) => r.style))).toEqual(new Set(["nest", "express", "registration registerRoute", "fastapi"]));
    expect(inv.calls.map((c) => c.component)).toContain("android");
  });
});
