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
import { callOutcomes, evaluate } from "../src/rules.js";
import { routesFromPython, routesFromTypeScript } from "../src/extract/routes.js";
import { traceText, trace, seedsFor } from "../src/flow.js";
import { flowFindings, resolveFlows, type FlowObject } from "../src/flows.js";
import { inventory, inventoryText } from "../src/inventory.js";
import { API_VERSION, type Subgraph, type Surface } from "../src/model.js";
import { holeMatches, pathsMatch } from "../src/paths.js";
import { codeDependency, configDependency, provenance } from "../src/provenance.js";
import { coverageDrops, main } from "../src/commands.js";
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
    const entries = extractRegistries(memory({ "active.json": active }), config);
    expect(entries.map((e) => `${e.key}:${e.at.line}`)).toEqual(["mentions invoice:2", "invoice:4", "a/b:5"]);
  });
  it("places a key read by a pattern from a text file on the line of the key, not where the match starts", () => {
    const enumFile = "public enum Kind {\n    ALPHA,\n    BETA\n}\n";
    const config = normalizeConfig({ registries: [{ name: "kind", active: { file: "Kind.java", pattern: "\\n    ([A-Z_]+)[,\\n]" }, producers: [], consumers: [] }] });
    const entries = extractRegistries(memory({ "Kind.java": enumFile }), config);
    expect(entries.map((e) => `${e.key}:${e.at.line}`)).toEqual(["ALPHA:2", "BETA:3"]);
  });
});

describe("registry coverage", () => {
  const registry = (name: string, active: Record<string, string>) => ({ name, active, producers: ["src/**"], consumers: ["web/**"] });
  const config = normalizeConfig({
    registries: [
      registry("kind", { file: "Kind.java", pattern: "\\n    ([A-Z_]+)[,\\n]" }),
      registry("renamed", { file: "Kind.java", pattern: "\\n  ([a-z]+)," }),
      registry("moved", { file: "gone/active.json" }),
      registry("tool", { files: "tools/*.json", field: "name" }),
    ],
  });
  const files = {
    "Kind.java": "public enum Kind {\n    ALPHA,\n    BETA\n}\n",
    "tools/a.json": '{ "name": "search" }',
    "tools/b.json": '{ "name": "search" }',
  };
  const graph = scan(memory(files), config);

  it("says per registry how many files its active list read and how many entries it found", () => {
    expect(graph.coverage).toEqual([
      { source: "registries kind", files: 1, items: 2 },
      { source: "registries renamed", files: 1, items: 0 },
      { source: "registries moved", files: 0, items: 0 },
      { source: "registries tool", files: 2, items: 1 },
    ]);
    expect(validate("graph", graph)).toEqual([]);
  });
  it("gives a limit for an active list that yields no entries", () => {
    expect(graph.limits).toEqual([
      "registries renamed: 1 file read, nothing extracted",
      "registries moved: the configured files match nothing",
    ]);
  });
  it("does not warn against a baseline recorded before registries had coverage", () => {
    expect(coverageDrops(graph, {})).toEqual([]);
  });
});

describe("routes coverage", () => {
  it("counts a document's file and the routes only it gives apart from the code's", () => {
    const files = {
      "api/app.ts": 'app.get("/orders", h);',
      "api/openapi.json": JSON.stringify({ openapi: "3.1.0", info: { title: "a", version: "1" }, paths: { "/orders": { get: {} }, "/refunds": { post: {} } } }),
    };
    const config = normalizeConfig({ components: [{ name: "api", path: "api" }], routes: [{ component: "api", files: ["api/**/*.ts"], styles: ["express"], openapi: "api/openapi.json" }] });
    const graph = scan(memory(files), config);
    expect(graph.coverage).toEqual([{ source: "routes api", files: 2, items: 2, documents: 1, documented: 1 }]);
    expect(validate("graph", graph)).toEqual([]);
  });
});

describe("calls to a component whose routes are not read", () => {
  it("says the calls are matched to nothing and not checked, until its routes or its description are configured", () => {
    const files = { "web/a.ts": 'fetch("/v1/sessions", { method: "POST" }); fetch("/orders");', "api/app.ts": 'app.get("/orders", h);' };
    const stray = { ...files, "web/a.ts": `${files["web/a.ts"]} fetch("/v1/runs", { method: "POST" });` };
    const both = [
      { from: "web", to: "agent", files: ["web/**"] },
      { from: "web", to: "api", files: ["web/**"] },
    ];
    const components = [
      { name: "web", path: "web" },
      { name: "api", path: "api" },
      { name: "agent", path: "agent" },
    ];
    const graph = scan(memory(files), normalizeConfig({ components, routes: [{ component: "api", files: ["api/**"], styles: ["express"] }], calls: both }));
    const limit = "calls web->agent: agent has no route source, so its 2 calls match nothing and FA002 does not check them; configure its routes (routes[] with files, or routes[].openapi for a generated document)";
    expect(graph.limits).toEqual([limit]);
    expect(graph.edges.filter((e) => e.kind === "match" && e.to.startsWith("agent|"))).toEqual([]);
    // As the limit says: FA002 leaves the calls to agent alone, and still checks the ones to api.
    const fa002 = (g: typeof graph, c: Config) => evaluate(g, c, g.limits).filter((f) => f.rule === "FA002").map((f) => f.key);
    const withStray = scan(memory({ ...files, "web/a.ts": `${files["web/a.ts"]} fetch("/orders/stray");` }), normalizeConfig({ components, routes: [{ component: "api", files: ["api/**"], styles: ["express"] }], calls: both }));
    expect(fa002(withStray, normalizeConfig({ components, routes: [{ component: "api", files: ["api/**"], styles: ["express"] }], calls: both }))).toEqual(["FA002|web->api|GET /orders/stray"]);
    // The top-level openapi entry chooses a description for export and reads no routes: FA002 still checks nothing there.
    const routes = [{ component: "api", files: ["api/**"], styles: ["express"] }];
    const exported = normalizeConfig({ components, routes, calls: both, openapi: { agent: "agent/openapi.json" } });
    const exportedGraph = scan(memory(files), exported);
    expect(exportedGraph.limits).toEqual([limit]);
    expect(fa002(exportedGraph, exported).filter((k) => k.includes("->agent|"))).toEqual([]);
    // A route source from a generated document is a route source.
    const documented = { ...files, "agent/openapi.json": JSON.stringify({ openapi: "3.1.0", info: { title: "a", version: "1" }, paths: { "/v1/sessions": { post: {} } } }) };
    const readConfig = normalizeConfig({ components, routes: [...routes, { component: "agent", openapi: "agent/openapi.json" }], calls: both });
    const read = scan(memory(documented), readConfig);
    expect(read.limits.filter((l) => l.includes("no route source"))).toEqual([]);
    // Its route is read and the call to it is matched. GET /orders, which the same call files send to api, is not
    // reported against agent: FA002 reports only a request clearly on the target (a first segment it serves).
    const matched = read.edges.filter((e) => e.kind === "match" && e.to.startsWith("agent|")).map((e) => `${e.from.split("@")[0]} = ${e.to}`);
    expect(matched).toEqual(["web->agent|POST /v1/sessions = agent|POST /v1/sessions"]);
    expect(fa002(read, readConfig).filter((k) => k.includes("->agent|"))).toEqual([]);
    // A request on a path agent serves and no route of agent takes is now reported.
    const strayGraph = scan(memory({ ...stray, "agent/openapi.json": documented["agent/openapi.json"] }), readConfig);
    expect(fa002(strayGraph, readConfig).filter((k) => k.includes("->agent|"))).toEqual(["FA002|web->agent|POST /v1/runs"]);
  });

  it("checks the calls to a component whose route sources yield no route, and says so next to each finding", () => {
    const files = { "web/a.ts": 'fetch("http://localhost:3000/thing");', "agent/app.ts": "export const x = 1;" };
    const components = [
      { name: "web", path: "web" },
      { name: "agent", path: "agent" },
    ];
    const config = normalizeConfig({ components, routes: [{ component: "agent", files: ["agent/**"], styles: ["express"] }], calls: [{ from: "web", to: "agent", files: ["web/**"] }] });
    const graph = scan(memory(files), config);
    expect(graph.limits).toEqual([
      "routes agent: 1 file read, nothing extracted",
      "calls web->agent: agent's route sources yielded no route, so its call matches nothing; FA002 still checks it, as after a change that takes every route away, and the routes agent limits say what was not read",
    ]);
    expect(evaluate(graph, config, []).filter((f) => f.rule === "FA002").map((f) => f.message)).toEqual([
      "web calls GET /thing on agent, which serves no matching route. No route of agent is read: its route sources yielded none (a limit says what they left out).",
    ]);
    expect(callOutcomes(graph, config)).toEqual(["unserved"]);
  });
});

describe("Python handlers", () => {
  const components = [
    { name: "py", path: "py" },
    { name: "api", path: "api" },
  ];
  const routes = [
    { component: "api", files: ["api/**"], styles: ["express"] },
    { component: "py", files: ["py/**"], styles: ["fastapi"] },
  ];
  const main = [
    "from fastapi import FastAPI",
    "from .svc import load_orders",
    "app = FastAPI()",
    "",
    '@app.get("/items")',
    "@limiter.limit(",
    '    "5/minute",',
    ")",
    "async def items():",
    '    async with httpx.AsyncClient(base_url="http://localhost:3000") as c:',
    '        return (await c.get("/api/items")).json()',
    "",
    '@app.get("/orders")',
    "def orders():",
    "    return load_orders()",
    "",
    "def other():",
    '    return httpx.get("http://localhost:3000/api/other")',
    "",
    'app.add_api_route("/other", other)',
    'httpx.get("http://localhost:3000/api/other")',
    "",
    "from . import svc as s",
    '@app.get("/defaults")',
    'def defaults(v=httpx.get("http://localhost:3000/api/items")):',
    "    return v",
    "",
    '@app.get("/params")',
    "def params(q: dict):",
    "    def never_called():",
    '        return httpx.get("http://localhost:3000/api/items")',
    '    return q.get("a")',
    "",
    '@app.get("/refunds")',
    "def refunds():",
    "    return s.load_orders()",
  ].join("\n");
  const files = {
    "api/app.ts": 'app.get("/api/items", h); app.post("/api/orders", h); app.get("/api/other", h); app.get("/api/client", h);',
    "py/main.py": main,
    "py/svc.py": 'def load_orders():\n    return httpx.post("http://localhost:3000/api/orders").json()\n',
    "py/client.py": 'class Client:\n    def get(self, key):\n        return httpx.get("http://localhost:3000/api/client")\n',
  };
  const config = normalizeConfig({ components, routes, origins: { api: "http://localhost:3000" }, calls: [{ from: "py", to: "api", files: ["py/**"] }] });
  const graph = scan(memory(files), config);
  const downstream = (seed: string) => traceText(trace(graph, seedsFor(graph, seed))).split("downstream")[1]!.split("\n\n")[0]!;

  it("links a decorated def to the calls in it and in the functions it calls by name, one call deep", () => {
    expect(downstream("py|GET /items")).toContain("~ py -> api  GET /api/items in items  py/main.py:11\n    = api|GET /api/items");
    expect(downstream("py|GET /orders")).toContain("~ py -> api  POST /api/orders in load_orders  py/svc.py:2\n    = api|POST /api/orders");
    expect(downstream("py|GET /refunds")).toContain("~ py -> api  POST /api/orders in load_orders  py/svc.py:2");
    expect(graph.limits.filter((l) => l.startsWith("routes py:"))).toEqual([]);
  });

  it("takes no method of another value for a function of the component's (`q.get` is no Client.get)", () => {
    expect(downstream("py|GET /params")).not.toContain("/api/client");
    expect(graph.surfaces.find((s) => s.id === "py|GET /params")?.reaches).toEqual(["params"]);
  });

  it("follows no function the handler declares and does not call, and no request after a function's body", () => {
    expect(downstream("py|GET /params")).not.toContain("/api/items");
    // The module-level request after `def other():` belongs to no function, so no handler named other reaches it.
    const call = graph.calls.find((c) => c.path === "/api/other" && c.at.line === 21);
    expect(call?.scope).toBeUndefined();
    // A default argument runs when Python defines the function, not when the route is requested.
    expect(graph.calls.find((c) => c.at.line === 25)?.scope).toBeUndefined();
    expect(downstream("py|GET /defaults")).not.toContain("/api/items");
  });

  it("says where a handler registered without a decorator stops", () => {
    expect(downstream("py|GET /other")).toContain("not traced: a Python handler is read where a decorator registers its def; this route is registered another way");
  });

  it("names a component none of whose handlers is followed into its calls, once", () => {
    const go = normalizeConfig({
      components: [{ name: "go", path: "go" }, components[1]!],
      routes: [routes[0]!, { component: "go", files: ["go/**"], styles: ["go"] }],
      origins: { api: "http://localhost:3000" },
      calls: [
        { from: "go", to: "api", files: ["go/a.go"] },
        { from: "go", to: "api", files: ["go/b.go"] },
      ],
    });
    const goFiles = {
      "api/app.ts": files["api/app.ts"],
      "go/go.mod": "module x\n\ngo 1.22\n",
      "go/a.go": 'package main\nimport "net/http"\nfunc main() { http.HandleFunc("/g", h); http.ListenAndServe(":8080", nil) }\n',
      "go/b.go": 'package main\nimport "net/http"\nfunc h(w http.ResponseWriter, r *http.Request) { http.Get("http://localhost:3000/api/items") }\n',
    };
    const read = scan(memory(goFiles), go);
    expect(read.limits.filter((l) => l.startsWith("routes go:"))).toEqual([
      "routes go: atlas follows none of its handlers (in .go) into the calls they make, so its 1 configured call is reached from no surface and chains stop at its surfaces",
    ]);
  });
});

describe("a call that fits a route only by the value of an interpolated segment", () => {
  const components = [
    { name: "web", path: "web" },
    { name: "api", path: "api" },
  ];
  const config = normalizeConfig({ components, routes: [{ component: "api", files: ["api/**"], styles: ["express"] }], calls: [{ from: "web", to: "api", files: ["web/**"] }] });
  const api = 'app.get("/api/x/summary", h);\napp.get("/api/x/:name", h);\napp.get("/api/y/a", h);\napp.get("/api/y/b", h);';
  const fa001 = (web: string) => {
    const graph = scan(memory({ "api/app.ts": api, "web/a.ts": web }), config);
    return evaluate(graph, config, []).filter((f) => f.rule === "FA001");
  };

  it("does not count as a caller of a literal route where another route takes every value, and the finding names it", () => {
    const found = fa001("export const f = (id: string) => fetch(`/api/x/${id}`);");
    expect(found.map((f) => f.key)).toEqual(["FA001|api|GET /api/x/summary", "FA001|api|GET /api/y/a", "FA001|api|GET /api/y/b"]);
    expect(found[0]!.message).toBe(
      "GET /api/x/summary (api) has no caller among the configured call sites that names its path. Only calls with an interpolated segment fit it, and another route takes every value of that segment: web calls GET /api/x/{} (web/a.ts:1); whether one sends this path is not in the code.",
    );
  });

  it("still counts where no route takes every value, and a call that names the path", () => {
    const found = fa001("export const f = (id: string) => fetch(`/api/y/${id}`);\nexport const g = () => fetch('/api/x/summary');\nexport const h = (n: string) => fetch(`/api/x/${n}`);");
    expect(found.map((f) => f.key)).toEqual([]);
    // A call that writes the path's text, a value only after it (a query string), names it.
    expect(fa001("export const f = (q: string) => fetch(`/api/x/summary${q}`);\nexport const h = (n: string) => fetch(`/api/x/${n}`);\nexport const g = (id: string) => fetch(`/api/y/${id}`);").map((f) => f.key)).toEqual([]);
    // A catch-all takes every path there is, which says nothing of which one the call means.
    const withFallback = scan(memory({ "api/app.ts": 'app.get("/api/z/a", h);\napp.get("/api/*rest", h);', "web/a.ts": "export const f = (id: string) => fetch(`/api/z/${id}`);" }), config);
    expect(evaluate(withFallback, config, []).filter((f) => f.rule === "FA001").map((f) => f.key)).toEqual([]);
    // Nor does a route taken only with headers the call may not send (Fastify's constraints).
    const fastify = 'import Fastify from "fastify";\nconst app = Fastify();\napp.get("/api/z/a", h);\napp.get("/api/z/:name", { constraints: { version: "1.0.0" } }, h);';
    const constrained = scan(memory({ "api/app.ts": fastify, "web/a.ts": "export const f = (id: string) => fetch(`/api/z/${id}`);" }), config);
    expect(constrained.surfaces.find((s) => s.path === "/api/z/{name}")?.dispatch?.constrained).toBe(true);
    expect(evaluate(constrained, config, []).filter((f) => f.rule === "FA001" && f.key.includes("/api/z/a"))).toEqual([]);
  });
});

describe("what the output leaves out", () => {
  it("says how many call candidate files inventory does not list", () => {
    const calls = Array.from({ length: 10 }, (_, i) => ({ component: "web", file: `web/f${i}.ts`, count: i + 1, example: `web/f${i}.ts:1` }));
    const text = inventoryText({ components: [], routes: [], calls, apiDocuments: [] });
    expect(text).toContain("  web: 55 in 10 files (the 8 with the most below, 2 more not listed)\n    10  web/f9.ts:1\n");
    expect(text).not.toContain("web/f1.ts:1");
  });

  it("answers --help after a command with the help", () => {
    const out: string[] = [];
    const write = process.stdout.write.bind(process.stdout);
    process.stdout.write = (s: string) => (out.push(s), true);
    try {
      expect(main(["query", "--help"])).toBe(0);
    } finally {
      process.stdout.write = write;
    }
    expect(out.join("")).toContain("Usage: atlas <command> [options]");
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
  it("takes no component from the platform folders a cross-platform app builds", () => {
    const files = {
      "app/pubspec.yaml": "name: app\ndependencies:\n  flutter:\n    sdk: flutter\n",
      "app/android/settings.gradle.kts": 'include(":app")\n',
      "app/android/build.gradle.kts": "",
      "app/android/app/build.gradle.kts": "",
      "app/ios/Podfile": "",
      "tool/pubspec.yaml": "name: tool\n",
      "tool/android/build.gradle": "",
      "mobile/package.json": '{"name":"mobile","dependencies":{"react-native":"0.80.0"}}',
      "mobile/android/build.gradle": "",
      "mobile/android/app/build.gradle": "",
      "mobile/modules/blur/expo-module.config.json": "{}",
      "mobile/modules/blur/android/build.gradle": "",
      "backend/build.gradle": "",
    };
    expect(inventory(memory(files), []).components.map((c) => `${c.name}:${c.path}`)).toEqual(["app:app", "backend:backend", "mobile:mobile", "tool:tool", "android:tool/android"]);
  });
  it("takes react-native from any dependency list of a package", () => {
    for (const list of ["dependencies", "devDependencies", "peerDependencies", "optionalDependencies"]) {
      const files = { "mobile/package.json": JSON.stringify({ name: "mobile", [list]: { "react-native": "0.80.0" } }), "mobile/android/build.gradle": "" };
      expect(inventory(memory(files), []).components.map((c) => `${c.name}:${c.path}`), list).toEqual(["mobile:mobile"]);
    }
  });
  it("reads the Flutter SDK dependency in any YAML spelling, and only under dependencies", () => {
    const app = (pubspec: string) => ({ "app/pubspec.yaml": pubspec, "app/android/app/build.gradle.kts": "" });
    const names = (files: Record<string, string>) => inventory(memory(files), []).components.map((c) => `${c.name}:${c.path}`);
    expect(names(app('name: app\ndependencies:\n  flutter:\n    sdk: "flutter"\n'))).toEqual(["app:app"]);
    expect(names(app("name: app\ndependencies:\n  flutter: { sdk: 'flutter' }   # the SDK\n"))).toEqual(["app:app"]);
    expect(names(app("name: app\ndependencies:\n  flutter:\n    sdk: flutter # Flutter SDK\n"))).toEqual(["app:app"]);
    expect(names(app("name: app\ndev_dependencies:\n  flutter:\n    sdk: flutter\n"))).toEqual(["app:app", "android-app:app/android/app"]);
  });
  it("names components that share a directory name by their paths, and says so", () => {
    const files = {
      "deploy/mobile/app/build.gradle.kts": "",
      "deploy/catalog/app/build.gradle.kts": "",
      "packages/a/python/pyproject.toml": "",
      "packages/b/python/pyproject.toml": "",
      "packages/b/package.json": '{"name":"b"}',
      "web/package.json": '{"name":"site"}',
    };
    const inv = inventory(memory(files), []);
    expect(inv.components.map((c) => `${c.name}:${c.path}${c.note ? ` (${c.note})` : ""}`)).toEqual([
      "catalog-app:deploy/catalog/app (named by its path: 2 components would be named app)",
      "mobile-app:deploy/mobile/app (named by its path: 2 components would be named app)",
      "a-python:packages/a/python (named by its path: 2 components would be named python)",
      "b:packages/b",
      "b-python:packages/b/python (named by its path: 2 components would be named python)",
      "site:web",
    ]);
    const doc = { apiVersion: API_VERSION, kind: "Inventory", provenance: provenance("Inventory", { ref: "WORKTREE" }, [codeDependency("code", "WORKTREE")]), ...inv };
    expect(validate("inventory", doc)).toEqual([]);
  });
  it("keeps every name unique when the paths do not tell components apart", () => {
    const names = (files: Record<string, string>) => inventory(memory(files), []).components.map((c) => `${c.name}:${c.path}`);
    // A root package that is no workspace, and a directory named as it.
    expect(names({ "package.json": '{"name":"app"}', "app/build.gradle": "" })).toEqual(["app:", "app-2:app"]);
    // A generated name that another component already has, with no more path to add.
    const taken = names({ "mobile/app/build.gradle": "", "other/app/build.gradle": "", "x/package.json": '{"name":"mobile-app"}' });
    expect(taken).toEqual(["mobile-app-2:mobile/app", "other-app:other/app", "mobile-app:x"]);
    expect(new Set(taken.map((n) => n.split(":")[0])).size).toBe(taken.length);
    const notes = inventory(memory({ "package.json": '{"name":"app"}', "app/build.gradle": "" }), []).components.map((c) => c.note);
    expect(notes).toEqual([
      "named by its path: 2 components would be named app, and their paths do not tell them apart, so they are numbered",
      "named by its path: 2 components would be named app, and their paths do not tell them apart, so they are numbered",
    ]);
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
