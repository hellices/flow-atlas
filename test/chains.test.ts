import { parseAllDocuments } from "yaml";
import { describe, expect, it } from "vitest";
import { deriveChains } from "../src/chains.js";
import { normalizeConfig } from "../src/config.js";
import { diffGraphs } from "../src/diff.js";
import { draftChainFlows } from "../src/draft.js";
import { flowFindings, resolveFlows, type FlowObject, type LoadedFile } from "../src/flows.js";
import { scan } from "../src/scan.js";
import { validate } from "../src/schema.js";
import type { Graph } from "../src/model.js";
import type { Source } from "../src/source.js";

const memory = (files: Record<string, string>): Source => ({
  ref: "WORKTREE",
  list: () => Object.keys(files),
  read: (p) => files[p],
  asOf: () => "2026-11-01T00:00:00Z",
});

const shop = {
  "web/src/api.ts": ['export const screen = () => fetch("/screen");', 'export const stop = () => fetch("/stop", { method: "POST" });'].join("\n"),
  "bff/src/routes.ts": [
    'app.get("/screen", async (req, res) => {',
    "  const orders = await fetch(`${BACKEND}/orders`);",
    "  const users = await fetch(`${BACKEND}/users`);",
    "  res.send({ orders, users });",
    "});",
    'app.post("/stop", async (req, res) => { res.send(await fetch(`${BACKEND}/stop`, { method: "POST" })); });',
  ].join("\n"),
  "backend/src/app.ts": [
    'app.get("/orders", (req, res) => res.send([]));',
    'app.get("/users", (req, res) => res.send([]));',
    'app.post("/stop", (req, res) => res.send({}));',
    'app.get("/admin/report", (req, res) => res.send({}));',
    'app.get("/orphan", (req, res) => res.send({}));',
  ].join("\n"),
};

const config = normalizeConfig({
  components: [
    { name: "web", path: "web" },
    { name: "bff", path: "bff" },
    { name: "backend", path: "backend" },
  ],
  routes: [
    { component: "bff", files: ["bff/src/**/*.ts"], styles: ["express"] },
    { component: "backend", files: ["backend/src/**/*.ts"], styles: ["express"] },
  ],
  calls: [
    { from: "web", to: "bff", files: ["web/src/**/*.ts"] },
    { from: "bff", to: "backend", files: ["bff/src/**/*.ts"] },
  ],
  publicSurfaces: ["backend|GET /admin/**"],
});

const flowFile = (...flows: FlowObject[]): LoadedFile => ({ file: "f.flow.yaml", text: "", errors: [], flows: flows.map((object) => ({ object, line: 1, stepLine: () => 1 })) });
const flow = (name: string, steps: FlowObject["spec"]["steps"], extra: Partial<FlowObject["spec"]> = {}): FlowObject => ({
  apiVersion: "flow-atlas.dev/v1alpha1",
  kind: "Flow",
  metadata: { name, title: name },
  spec: { steps, ...extra },
});

describe("chains", () => {
  const graph = scan(memory(shop), config);
  const report = deriveChains(graph, config);

  it("derives one chain per request with everything it reaches, fan-out included, and leaves uncalled routes out", () => {
    expect(report.chains.map((c) => `${c.id} [${c.surfaces.join(", ")}] weak ${c.weak}`)).toEqual([
      "outside->backend|GET /admin/report [backend|GET /admin/report] weak 0",
      "web->bff|GET /screen [bff|GET /screen, backend|GET /orders, backend|GET /users] weak 0",
      "web->bff|POST /stop [bff|POST /stop, backend|POST /stop] weak 0",
    ]);
    expect(report.unchained).toEqual(["backend|GET /orphan"]);
    expect(validate("chains", report)).toEqual([]);
    // A call written in an anonymous handler is reached through the handler itself.
    expect(validate("graph", graph)).toEqual([]);
  });

  it("gives a flow made of one chain its entry from the code and covers every surface the chain reaches", () => {
    const flows = resolveFlows(graph, [flowFile(flow("screen", [{ stepId: "read", chain: "web->bff|GET /screen", role: "reads the screen" }]))], "2026-11-01T00:00:00Z", report);
    const item = flows.items[0]!;
    expect(item.status.entry).toEqual({ component: "web", callers: report.chains[1]!.entry.callers });
    expect(item.status.conditions.map((c) => `${c.type}=${c.status}`)).toEqual([
      "Ready=True",
      "Resolved=True",
      "Connected=True",
      "ProducesListed=Unknown",
      "Documented=True",
    ]);
    expect(flows.unassigned).toEqual(expect.not.arrayContaining(["backend|GET /orders", "backend|GET /users"]));
    expect(validate("flow-report", flows)).toEqual([]);
  });

  it("leaves the order of two requests the code does not link to the author, whoever makes them", () => {
    const journey = flow("journey", [
      { stepId: "read", chain: "web->bff|GET /screen", role: "reads" },
      { stepId: "stop", chain: "web->bff|POST /stop", role: "stops" },
    ]);
    const handoff = flow("handoff", [
      { stepId: "read", chain: "web->bff|GET /screen", role: "reads" },
      { stepId: "admin", chain: "outside->backend|GET /admin/report", role: "reports" },
    ]);
    const flows = resolveFlows(graph, [flowFile(journey, handoff)], "2026-11-01T00:00:00Z", report);
    const connected = flows.items.map((i) => i.status.conditions.find((c) => c.type === "Connected")!);
    // A hand-off between components, such as one client queueing work another picks up, is no more a fault than one
    // component making both requests: the code neither shows nor contradicts the order.
    expect(connected.map((c) => `${c.status} ${c.reason}`)).toEqual(["Unknown OrderNotInCode", "Unknown OrderNotInCode"]);
    // An order only the flow states cannot make the flow ready.
    expect(flows.items[0]!.status.conditions[0]).toMatchObject({ type: "Ready", status: "Unknown", reason: "OrderNotInCode" });
    expect(flowFindings(flows)).toEqual([]);
  });

  it("reads the chains at a sub-flow's ends when it orders steps", () => {
    const child = flow("child", [{ stepId: "read", chain: "web->bff|GET /screen", role: "reads" }]);
    const journey = flow("journey", [
      { stepId: "open", flow: "child" },
      { stepId: "stop", chain: "web->bff|POST /stop", role: "stops" },
    ]);
    const flows = resolveFlows(graph, [flowFile(child, journey)], "2026-11-01T00:00:00Z", report);
    const item = flows.items.find((i) => i.metadata.name === "journey")!;
    expect(item.status.conditions.find((c) => c.type === "Connected")).toMatchObject({ status: "Unknown", reason: "OrderNotInCode" });
    expect(item.status.entry?.component).toBe("web");
    expect(flowFindings(flows)).toEqual([]);
  });

  it("starts no outside chain for a public surface the repository already calls", () => {
    const both = normalizeConfig({ ...config, publicSurfaces: ["backend|GET /users", "backend|GET /admin/**"] });
    expect(deriveChains(graph, both).chains.map((c) => c.id)).not.toContain("outside->backend|GET /users");
  });

  it("takes a public surface no component calls as served outside, and fails a chain that is gone", () => {
    const flows = resolveFlows(
      graph,
      [flowFile(flow("admin", [{ stepId: "report", chain: "outside->backend|GET /admin/report", role: "reports" }]), flow("gone", [{ stepId: "x", chain: "web->bff|GET /gone", role: "gone" }]))],
      "2026-11-01T00:00:00Z",
      report,
    );
    expect(flows.items[0]!.status.entry).toBeUndefined();
    expect(flowFindings(flows).map((f) => f.key)).toEqual(["FA007|gone|x|unresolved"]);
  });

  it("drafts flows whose structure is the chain's, leaving only the title, labels and role to the author", () => {
    const text = draftChainFlows(graph, report.chains);
    const docs = parseAllDocuments(text).map((d) => d.toJS() as FlowObject);
    expect(docs.map((d) => d.spec.steps)).toEqual([
      [{ stepId: "get-admin-report", chain: "outside->backend|GET /admin/report" }],
      [{ stepId: "get-screen", chain: "web->bff|GET /screen" }],
      [{ stepId: "post-stop", chain: "web->bff|POST /stop" }],
    ]);
    for (const d of docs) expect(validate("flow", d)).toEqual([]);
    const agentLines = text.split("\n").filter((l) => l.trim().startsWith("# agent:"));
    expect(new Set(agentLines.map((l) => /# agent: (\w+)/.exec(l)![1]))).toEqual(new Set(["title", "labels", "sources", "role"]));
  });

  it("names drafts by the whole chain, so separate drafts and saved flows never share a name", () => {
    const one = (id: string, taken: string[] = []) => (parseAllDocuments(draftChainFlows(graph, [report.chains.find((c) => c.id === id)!], taken))[0]!.toJS() as FlowObject).metadata.name;
    expect(one("web->bff|GET /screen")).toBe("web-bff-get-screen");
    expect(one("web->bff|GET /screen", ["web-bff-get-screen"])).toMatch(/^web-bff-get-screen-[0-9a-f]{6}$/);
  });

  it("reports a chain that reaches other surfaces after a change", () => {
    const after = scan(memory({ ...shop, "bff/src/routes.ts": shop["bff/src/routes.ts"].replace("  const users = await fetch(`${BACKEND}/users`);\n", "") }), config);
    const d = diffGraphs(graph, after, [], [], report, deriveChains(after, config));
    expect(d.chains).toEqual({ added: [], removed: [], changed: [{ id: "web->bff|GET /screen", added: [], removed: ["backend|GET /users"] }] });
    expect(validate("diff", d)).toEqual([]);
  });
});

describe("chains of a server-rendered app", () => {
  const files = {
    "src/main/java/app/MovieWebController.java": '@Controller\nclass MovieWebController {\n  @GetMapping("/movies/{tmdbId}") String detail(@PathVariable long tmdbId) { return "movies/detail"; }\n}',
    "src/main/java/app/ReviewApiController.java": '@RestController\n@RequestMapping("/api")\nclass ReviewApiController {\n  @GetMapping("/movies/{tmdbId}/reviews") Slice forMovie(@PathVariable long tmdbId) { return null; }\n}',
    "src/main/resources/templates/movies/detail.html": '<a th:href="@{/movies/{id}(id=${m})}">x</a><div th:attr="data-api-url=@{/api/movies/{id}/reviews(id=${m})}"></div>',
    "src/main/resources/templates/movies/index.html": '<a href="/movies/1">first</a>',
  };
  const spring = normalizeConfig({
    components: [
      { name: "server", path: "src/main/java" },
      { name: "web", path: "src/main/resources" },
    ],
    routes: [{ component: "server", files: ["src/main/java/**/*.java"], styles: ["spring"] }],
    calls: [{ from: "web", to: "server", files: ["src/main/resources/templates/**/*.html"], dataUrls: ["data-api-url"] }],
  });

  it("ends a chain at the page and offers the requests its template makes as next chains", () => {
    const graph = scan(memory(files), spring);
    const report = deriveChains(graph, spring);
    const page = report.chains.find((c) => c.id === "web->server|GET /movies/{tmdbId}")!;
    expect(page.surfaces).toEqual(["server|GET /movies/{tmdbId}"]);
    expect(page.next.map((n) => `${n.chain} ${n.via}`)).toEqual(["web->server|GET /api/movies/{tmdbId}/reviews view movies/detail", "web->server|GET /movies/{tmdbId} view movies/detail"]);
    const flows = resolveFlows(
      graph,
      [flowFile(flow("reviews", [{ stepId: "page", chain: page.id, role: "renders" }, { stepId: "more", chain: "web->server|GET /api/movies/{tmdbId}/reviews", role: "loads" }]))],
      "2026-11-01T00:00:00Z",
      report,
    );
    expect(flows.items[0]!.status.conditions.find((c) => c.type === "Connected")).toEqual({ type: "Connected", status: "True", reason: "AllStepsConnected" });
  });
});

describe("chains of a synthetic graph", () => {
  const base = scan(memory(shop), config);
  const surface = (i: number) => ({ id: `svc|GET /s${i}`, component: "svc", method: "GET", path: `/s${i}`, at: { file: "a.ts", line: i + 1 }, evidence: "static" as const });
  const call = (from: string, i: number, line = i + 1) => ({ id: `${from}->svc|GET /s${i}@a.ts#f${i}`, from, to: "svc", method: "GET", path: `/s${i}`, based: false, at: { file: "a.ts", line }, evidence: "static" as const });
  const graphOf = (hops: number, via = "handler"): Graph => {
    const surfaces = Array.from({ length: hops + 1 }, (_, i) => surface(i));
    const calls = [call("app", 0), ...Array.from({ length: hops }, (_, i) => call("svc", i + 1))];
    const edges: Graph["edges"] = [{ kind: "match", from: calls[0]!.id, to: surfaces[0]!.id, evidence: "static" }];
    for (let i = 0; i < hops; i++) {
      edges.push({ kind: "reach", from: surfaces[i]!.id, to: calls[i + 1]!.id, evidence: "static", via });
      edges.push({ kind: "match", from: calls[i + 1]!.id, to: surfaces[i + 1]!.id, evidence: "static" });
    }
    return { ...base, surfaces, calls, edges };
  };

  it("changes the digest when an edge changes, not when code moves", () => {
    const digest = (g: Graph) => deriveChains(g, normalizeConfig({})).chains[0]!.digest;
    const moved = graphOf(2);
    moved.calls = moved.calls.map((c) => ({ ...c, at: { ...c.at, line: c.at.line + 10 } }));
    expect(digest(moved)).toBe(digest(graphOf(2)));
    expect(digest(graphOf(2, "otherHandler"))).not.toBe(digest(graphOf(2)));
    // Two edges between the same ends found in different ways are both kept, whatever order they come in.
    const twice = graphOf(1);
    twice.edges.push({ ...twice.edges[1]!, evidence: "name" });
    const forward = deriveChains(twice, normalizeConfig({})).chains[0]!;
    const backward = deriveChains({ ...twice, edges: [...twice.edges].reverse() }, normalizeConfig({})).chains[0]!;
    expect(forward.edges.filter((e) => e.kind === "reach")).toHaveLength(2);
    expect([backward.weak, backward.digest]).toEqual([forward.weak, forward.digest]);
  });

  it("names long chains apart however they are drafted", () => {
    const long = "/" + "segment/".repeat(10);
    const g = graphOf(0);
    g.surfaces = [`${long}a`, `${long}b`].map((path, i) => ({ ...surface(i), id: `svc|GET ${path}`, path }));
    g.calls = g.surfaces.map((x, i) => ({ ...call("app", i), id: `app->svc|GET ${x.path}@a.ts#f${i}`, path: x.path }));
    g.edges = g.calls.map((c, i) => ({ kind: "match" as const, from: c.id, to: g.surfaces[i]!.id, evidence: "static" as const }));
    const chains = deriveChains(g, normalizeConfig({})).chains;
    const names = (cs: typeof chains) => parseAllDocuments(draftChainFlows(g, cs)).map((d) => (d.toJS() as FlowObject).metadata.name);
    const together = names(chains);
    expect(new Set(together).size).toBe(2);
    expect(together.every((n) => n.length <= 63)).toBe(true);
    expect([...names([chains[1]!]), ...names([chains[0]!])].sort()).toEqual([...together].sort());
  });
});
