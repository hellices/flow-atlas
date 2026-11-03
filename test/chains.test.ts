import { parseAllDocuments } from "yaml";
import { describe, expect, it } from "vitest";
import { deriveChains } from "../src/chains.js";
import { normalizeConfig } from "../src/config.js";
import { diffGraphs } from "../src/diff.js";
import { draftChainFlows } from "../src/draft.js";
import { flowFindings, resolveFlows, type FlowObject, type LoadedFile } from "../src/flows.js";
import { scan } from "../src/scan.js";
import { validate } from "../src/schema.js";
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
      "EntryCalled=True",
      "ProducesListed=Unknown",
      "Documented=True",
      "Fresh=Unknown",
    ]);
    expect(flows.unassigned).toEqual(expect.not.arrayContaining(["backend|GET /orders", "backend|GET /users"]));
    expect(validate("flow-report", flows)).toEqual([]);
  });

  it("leaves the order of two requests one component makes to the author, and fails a pair the code contradicts", () => {
    const journey = flow("journey", [
      { stepId: "read", chain: "web->bff|GET /screen", role: "reads" },
      { stepId: "stop", chain: "web->bff|POST /stop", role: "stops" },
    ]);
    const wrong = flow("wrong", [
      { stepId: "read", chain: "web->bff|GET /screen", role: "reads" },
      { stepId: "admin", chain: "outside->backend|GET /admin/report", role: "reports" },
    ]);
    const flows = resolveFlows(graph, [flowFile(journey, wrong)], "2026-11-01T00:00:00Z", report);
    const connected = flows.items.map((i) => i.status.conditions.find((c) => c.type === "Connected")!);
    expect(connected.map((c) => `${c.status} ${c.reason}`)).toEqual(["Unknown OrderNotInCode", "False NoPathBetweenSteps"]);
    expect(flows.items[0]!.status.conditions[0]!.status).toBe("True");
    expect(flowFindings(flows).map((f) => f.key)).toEqual(["FA007|wrong|read|disconnected"]);
  });

  it("takes a public surface no component calls as served outside, and fails a chain that is gone", () => {
    const flows = resolveFlows(
      graph,
      [flowFile(flow("admin", [{ stepId: "report", chain: "outside->backend|GET /admin/report", role: "reports" }]), flow("gone", [{ stepId: "x", chain: "web->bff|GET /gone", role: "gone" }]))],
      "2026-11-01T00:00:00Z",
      report,
    );
    expect(flows.items[0]!.status.conditions.find((c) => c.type === "EntryCalled")).toEqual({ type: "EntryCalled", status: "True", reason: "ServedOutside" });
    expect(flowFindings(flows).map((f) => f.key)).toEqual(["FA007|gone|x|unresolved"]);
  });

  it("drafts flows whose structure is the chain's, leaving only the title, labels and role to the author", () => {
    const text = draftChainFlows(graph, report.chains);
    const docs = parseAllDocuments(text).map((d) => d.toJS());
    expect(docs.map((d) => d.spec.steps)).toEqual([
      [{ stepId: "get-admin-report", chain: "outside->backend|GET /admin/report" }],
      [{ stepId: "get-screen", chain: "web->bff|GET /screen" }],
      [{ stepId: "post-stop", chain: "web->bff|POST /stop" }],
    ]);
    for (const d of docs) expect(validate("flow", d)).toEqual([]);
    const agentLines = text.split("\n").filter((l) => l.trim().startsWith("# agent:"));
    expect(new Set(agentLines.map((l) => /# agent: (\w+)/.exec(l)![1]))).toEqual(new Set(["title", "labels", "sources", "generated", "stale_after", "role"]));
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
    calls: [{ from: "web", to: "server", files: ["src/main/resources/templates/**/*.html"] }],
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
