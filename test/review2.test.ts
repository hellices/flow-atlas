import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";
import { describe, expect, it } from "vitest";
import { loadConfig, normalizeConfig, type Config } from "../src/config.js";
import { resolveApiDescriptions } from "../src/extract/apidocs.js";
import { callsFromText } from "../src/extract/calls.js";
import { Reach } from "../src/extract/reach.js";
import { extractRegistries } from "../src/extract/registries.js";
import { routesFromPython, routesFromTypeScript } from "../src/extract/routes.js";
import { traceText } from "../src/flow.js";
import { flowFindings, resolveFlows, type FlowObject } from "../src/flows.js";
import { inventory } from "../src/inventory.js";
import type { Subgraph, Surface } from "../src/model.js";
import { holeMatches, pathsMatch } from "../src/paths.js";
import { configDependency } from "../src/provenance.js";
import { scan } from "../src/scan.js";
import { validate } from "../src/schema.js";
import { GitRefSource, WorktreeSource, type Source } from "../src/source.js";
import { pastReview } from "../src/state.js";

const memory = (files: Record<string, string>): Source => ({
  ref: "WORKTREE",
  list: () => Object.keys(files),
  read: (p) => files[p],
  asOf: () => "2026-11-01T00:00:00Z",
});
const shop = fileURLToPath(new URL("../fixtures/shop", import.meta.url));

describe("lockfile filter", () => {
  it("drops registry tarballs and keeps a direct URL dependency's", () => {
    const lock = [
      "lockfileVersion: '9.0'",
      "packages:",
      "  '@scope/a@1.2.3':",
      "    resolution: {integrity: sha512-x, tarball: https://mirror.example/npm/@scope/a/-/a-1.2.3.tgz}",
      "  b@https://host.example/x/-/b-1.0.0.tgz:",
      "    resolution: {integrity: sha512-y, tarball: https://host.example/x/-/b-1.0.0.tgz}",
      "  c@2.0.0(peer@1.0.0):",
      "    resolution: {integrity: sha512-z, tarball: https://mirror.example/npm/c/-/c-2.0.0.tgz}",
      "",
    ].join("\n");
    const script = fileURLToPath(new URL("../scripts/public-registry.mjs", import.meta.url));
    const out = execFileSync(process.execPath, [script], { input: lock, encoding: "utf8" });
    expect(out).toContain("resolution: {integrity: sha512-x}");
    expect(out).toContain("resolution: {integrity: sha512-y, tarball: https://host.example/x/-/b-1.0.0.tgz}");
    expect(out).toContain("resolution: {integrity: sha512-z}");
  });
});

describe("API descriptions", () => {
  it("reports a component with routes and no description as NoneFound", () => {
    const surface = { id: "svc|GET /x", component: "svc", method: "GET", path: "/x", at: { file: "a.ts", line: 1 }, evidence: "static" } as Surface;
    expect(resolveApiDescriptions([], [surface], normalizeConfig({}))).toEqual([{ component: "svc", status: "none", reason: "NoneFound", candidates: [] }]);
  });
});

describe("text calls", () => {
  const spec = { from: "a", to: "b", files: [] };
  it("skips paths in comments and keeps those in strings", () => {
    const kt = ['// TODO: call "/users"', "/* see \"/admin\" */", 'val r = http.get("/orders") // not "/x"', 'val s = "// \\"/keep\\""'].join("\n");
    expect(callsFromText("A.kt", kt, spec).map((c) => c.path)).toEqual(["/orders"]);
    const py = ['# "/users"', 'r = http.get("/orders")  # "/x"', "s = '/hash#kept'"].join("\n");
    expect(callsFromText("a.py", py, spec).map((c) => c.path)).toEqual(["/orders", "/hash"]);
  });
});

describe("Reach", () => {
  const reachFrom = (files: Record<string, string>, file: string, statement: number) => {
    const reach = new Reach(memory(files));
    const sf = reach.parse(file)!.sf;
    return reach.from(file, (sf.statements[statement] as ts.ExpressionStatement).expression);
  };

  it("sees a var hoisted from a nested block shadow an import", () => {
    const text = 'import { helper } from "./h.js";\nregister(() => { if (cond) { var helper = () => local.port(); } helper(); });';
    expect(reachFrom({ "src/a.ts": text, "src/h.ts": "export function helper() { return remote.call(); }" }, "src/a.ts", 1)).toEqual(["port"]);
  });

  it("follows a function called through a namespace import", () => {
    const files = { "src/a.ts": 'import * as helpers from "./helpers.js";\nregister(() => helpers.run());', "src/helpers.ts": "export function run() { return client.send(); }" };
    expect(reachFrom(files, "src/a.ts", 1)).toEqual(["send"]);
  });

  it("follows a re-export chain of any depth and stops at a cycle", () => {
    const files: Record<string, string> = { "src/a.ts": 'import { run } from "./m0.js";\nregister(() => run());' };
    for (let i = 0; i < 9; i++) files[`src/m${i}.ts`] = `export { run } from "./m${i + 1}.js";`;
    files["src/m9.ts"] = "export function run() { return client.deep(); }";
    expect(reachFrom(files, "src/a.ts", 1)).toEqual(["deep"]);
    const cyclic = { "src/a.ts": 'import { run } from "./x.js";\nregister(() => run());', "src/x.ts": 'export { run } from "./y.js";', "src/y.ts": 'export { run } from "./x.js";' };
    expect(reachFrom(cyclic, "src/a.ts", 1)).toEqual([]);
  });
});

describe("registry locations", () => {
  it("places each active value on its own line", () => {
    const active = '{\n  "notes": "mentions invoice-v1 first",\n  "items": [\n    "invoice-v1",\n    "a\\u002fb-v1"\n  ]\n}\n';
    const config = normalizeConfig({ registries: [{ name: "doc", active: { file: "active.json", pattern: "(.+)-v\\d+" }, producers: [], consumers: [] }] });
    const entries = extractRegistries(memory({ "active.json": active }), config as Config);
    expect(entries.map((e) => `${e.key}:${e.at.line}`)).toEqual(["mentions invoice:2", "invoice:4", "a/b:5"]);
  });
});

describe("routes", () => {
  it("reads a quoted path key in Nest options", () => {
    const text = '@Controller({ "path": "users" })\nclass C {\n  @Get(":id") a() {}\n}';
    expect(routesFromTypeScript("a.ts", text, { component: "c", files: [], styles: ["nest"] }).map((s) => s.path)).toEqual(["/users/{id}"]);
  });
  it("reads raw and unicode FastAPI paths, and the methods api_route lists", () => {
    const text = [
      '@app.get(r"/users/{id}")',
      '@app.get(u"/teams")',
      '@app.get(f"/dyn/{x}")',
      '@app.api_route("/jobs", methods=["POST", "put"])',
      '@app.api_route("/ping")',
      "@app.api_route(\"/any\", methods=METHODS)",
    ].join("\n");
    expect(routesFromPython("a.py", text, { component: "c", files: [] }).map((s) => `${s.method} ${s.path}`)).toEqual([
      "GET /users/{id}",
      "GET /teams",
      "POST /jobs",
      "PUT /jobs",
      "GET /ping",
    ]);
  });
});

describe("trace text", () => {
  it("expands a node once even when several branches reach it", () => {
    const surface = (id: string): Surface => ({ id, component: id.split("|")[0]!, method: "GET", path: id.split(" ")[1]!, at: { file: "s.ts", line: 1 }, evidence: "static", reaches: [] });
    const call = (id: string) => ({ id, from: "a", to: "b", method: "GET", path: "/t", at: { file: "c.ts", line: 1 }, evidence: "static" as const, scope: id, based: true });
    const doc = {
      apiVersion: "flow-atlas.dev/v1alpha1",
      kind: "Trace",
      seeds: ["a|GET /s"],
      surfaces: [surface("a|GET /s"), surface("b|GET /t")],
      calls: [call("c1"), call("c2"), call("c3")],
      edges: [
        { kind: "reach", from: "a|GET /s", to: "c1", evidence: "name" },
        { kind: "reach", from: "a|GET /s", to: "c2", evidence: "name" },
        { kind: "match", from: "c1", to: "b|GET /t", evidence: "static" },
        { kind: "match", from: "c2", to: "b|GET /t", evidence: "static" },
        { kind: "reach", from: "b|GET /t", to: "c3", evidence: "name" },
      ],
    } as unknown as Subgraph;
    const text = traceText(doc);
    expect(text.split("\n").filter((l) => l.includes(" in c3 ")).length).toBe(1);
    expect(text).toContain("b|GET /t  s.ts:1  (shown above)");
  });
});

describe("planned steps", () => {
  it("leaves a gap next to a planned step pending, not a finding", () => {
    const config = loadConfig(join(shop, "atlas.config.yaml"));
    const graph = scan(new WorktreeSource(shop), config);
    const object: FlowObject = {
      apiVersion: "flow-atlas.dev/v1alpha1",
      kind: "Flow",
      metadata: { name: "partly", title: "t" },
      spec: {
        steps: [
          { stepId: "a", surface: "pricing|GET /quotes", role: "r" },
          { stepId: "b", surface: "orders|POST /orders", role: "r", lifecycle: "planned" },
        ],
      },
    };
    const report = resolveFlows(graph, [{ file: "f.flow.yaml", text: "", errors: [], flows: [{ object, line: 1, stepLine: () => 1 }] }], "2026-11-01T00:00:00Z");
    const conditions = Object.fromEntries(report.items[0]!.status.conditions.map((c) => [c.type, `${c.status} ${c.reason}`]));
    expect(conditions.Connected).toBe("Unknown PlannedStepsPending");
    expect(conditions.Ready).toBe("Unknown PlannedStepsPending");
    expect(flowFindings(report).filter((f) => f.key.includes("disconnected"))).toEqual([]);
    expect(validate("flow-report", report)).toEqual([]);
  });
});

describe("inventory", () => {
  it("takes a root manifest as a component, but not a workspace root", () => {
    const service = { "go.mod": "module example.com/app\n", "main.go": "package main\n", "web/package.json": '{"name":"web"}' };
    expect(inventory(memory(service), []).components.map((c) => `${c.name}:${c.path}`)).toEqual([":", "web:web"].map((x) => (x === ":" ? "root:" : x)));
    const workspace = { "package.json": '{"name":"mono","workspaces":["web"]}', "web/package.json": '{"name":"web"}' };
    expect(inventory(memory(workspace), []).components.map((c) => c.name)).toEqual(["web"]);
  });
  it("finds an active list for a top-level versioned directory", () => {
    const files = { "schemas/active.json": '["invoice-v1.json","invoice-v2.json"]', "schemas/invoice-v1.json": "{}", "schemas/invoice-v2.json": "{}" };
    expect(inventory(memory(files), []).activeLists).toEqual([{ file: "schemas/active.json", names: 2, dir: "schemas" }]);
  });
});

describe("hole matching", () => {
  it("agrees with the pattern meaning and does not backtrack", () => {
    expect(holeMatches("support-options{}", "support-options")).toBe(true);
    expect(holeMatches("v{}-orders", "v2-orders")).toBe(true);
    expect(holeMatches("a{}a", "a")).toBe(false);
    expect(pathsMatch("/devices/:id/status", "/devices/{}/support-options{}")).toBe(false);
    const pattern = `${"{}a".repeat(30)}{}b`;
    const started = performance.now();
    expect(holeMatches(pattern, "a".repeat(5000))).toBe(false);
    expect(performance.now() - started).toBeLessThan(200);
  });
});

describe("config provenance", () => {
  it("keeps a repository file whose name starts with two dots", () => {
    const config = { file: { path: join("/repo", "..config", "settings.yaml"), sha256: "a".repeat(64) } } as Config;
    expect(configDependency(config, "/repo")[0]!.uri).toBe("..config/settings.yaml");
    const outside = { file: { path: "/elsewhere/atlas.config.yaml", sha256: "a".repeat(64) } } as Config;
    expect(configDependency(outside, "/repo")[0]!.uri).toBe("atlas.config.yaml");
  });
});

describe("git source", () => {
  it("reads files whose names hold a newline", () => {
    const repo = mkdtempSync(join(tmpdir(), "atlas-nl-"));
    const git = (...args: string[]) => execFileSync("git", ["-C", repo, "-c", "user.email=t@example.com", "-c", "user.name=t", ...args], { encoding: "utf8" }).trim();
    git("init", "-q");
    writeFileSync(join(repo, "a\nb.txt"), "first\n");
    writeFileSync(join(repo, "b.txt"), "second\n");
    git("add", "-A");
    git("commit", "-qm", "x");
    const source = new GitRefSource(repo, git("rev-parse", "HEAD"));
    expect(source.list().sort()).toEqual(["a\nb.txt", "b.txt"]);
    source.preload(source.list());
    expect(source.read("a\nb.txt")).toBe("first\n");
    expect(source.read("b.txt")).toBe("second\n");
    expect(source.read("missing.txt")).toBeUndefined();
  });
});

describe("review dates", () => {
  it("keeps a date-only review date valid through that day", () => {
    expect(pastReview("2026-11-02", new Date("2026-11-02T23:00:00Z"))).toBe(false);
    expect(pastReview("2026-11-02", new Date("2026-11-03T00:00:00Z"))).toBe(true);
    expect(pastReview("2026-11-02T12:00:00Z", new Date("2026-11-02T13:00:00Z"))).toBe(true);
  });
});
