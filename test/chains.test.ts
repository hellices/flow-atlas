import { parseAllDocuments } from "yaml";
import { describe, expect, it } from "vitest";
import { deriveChains } from "../src/chains.js";
import { normalizeConfig } from "../src/config.js";
import { flowsText, query, queryText } from "../src/commands.js";
import { diffGraphs, diffMarkdown } from "../src/diff.js";
import { draftChainFlows } from "../src/draft.js";
import { seedsFor, trace, traceText } from "../src/flow.js";
import { flowFindings, resolveFlows, type FlowObject, type LoadedFile } from "../src/flows.js";
import { evaluate } from "../src/rules.js";
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
    // Each flow's own block shows its pair as an order the flow states, between its two steps.
    const blocks = flowsText(flows, graph.surfaces.length).split("\n\n");
    for (const [name, second] of [["journey", "stop"], ["handoff", "admin"]] as const) {
      const lines = blocks.filter((b) => b.startsWith(`${name}  `)).flatMap((b) => b.split("\n").map((l) => l.trim()));
      const pair = lines.filter((l) => /^\d+\. |^->/.test(l)).map((l) => l.split("  ")[0]);
      expect(pair, name).toEqual(["1. read", "-> next in the order the flow states; the code shows no link", `2. ${second}`]);
    }
    expect(blocks.join("\n")).not.toContain("NOT CONNECTED");
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

  it("names the flows a change reaches: a step built or gone, a chain reaching other surfaces, a condition that moved", () => {
    const journey = flow("journey", [
      { stepId: "read", chain: "web->bff|GET /screen", role: "reads" },
      { stepId: "stop", chain: "web->bff|POST /stop", role: "stops" },
      { stepId: "export", chain: "web->bff|GET /export", role: "exports", lifecycle: "planned" },
    ]);
    const untouched = flow("untouched", [{ stepId: "stop", chain: "web->bff|POST /stop", role: "stops" }]);
    const before = { ...shop, "bff/src/routes.ts": `${shop["bff/src/routes.ts"]}\napp.get("/export", (req, res) => res.send({}));` };
    const after = {
      ...before,
      "web/src/api.ts": `${shop["web/src/api.ts"]}\nexport const exp = () => fetch("/export");`,
      "bff/src/routes.ts": before["bff/src/routes.ts"].replace("  const users = await fetch(`${BACKEND}/users`);\n", ""),
    };
    const run = (files: Record<string, string>) => {
      const g = scan(memory(files), config);
      const c = deriveChains(g, config);
      return { g, c, f: resolveFlows(g, [flowFile(journey, untouched)], "2026-11-01T00:00:00Z", c) };
    };
    const b = run(before);
    const h = run(after);
    const d = diffGraphs(b.g, h.g, [], [], b.c, h.c, b.f, h.f);
    expect(d.flows).toEqual({
      added: [],
      removed: [],
      changed: [
        {
          name: "journey",
          conditions: [
            { type: "Ready", was: { status: "Unknown", reason: "PlannedStepsPending" }, now: { status: "Unknown", reason: "OrderNotInCode" } },
            { type: "Resolved", was: { status: "True", reason: "PlannedStepsPending" }, now: { status: "True", reason: "AllStepsResolved" } },
            { type: "Connected", was: { status: "Unknown", reason: "PlannedStepsPending" }, now: { status: "Unknown", reason: "OrderNotInCode" } },
          ],
          steps: [
            { stepId: "read", target: "web->bff|GET /screen", change: "reaches", added: [], removed: ["backend|GET /users"] },
            { stepId: "export", target: "web->bff|GET /export", change: "built" },
          ],
        },
      ],
    });
    expect(validate("diff", d)).toEqual([]);
    const md = diffMarkdown(d);
    expect(md).toContain("**Flows the change reaches**");
    expect(md).toContain(
      "- `journey`: step `read` no longer reaches `backend|GET /users`; step `export` (`web->bff|GET /export`) is now in the code; Resolved True (PlannedStepsPending) → True (AllStepsResolved); Connected Unknown (PlannedStepsPending) → Unknown (OrderNotInCode)",
    );
    expect(md).not.toContain("`untouched`");
  });
});

describe("a flow step that names a registry entry", () => {
  const files = {
    ...shop,
    "agent/tools.json": JSON.stringify([{ name: "quote" }, { name: "refund" }, { name: "listed" }]),
    "backend/src/tools.ts": ['export const QUOTE = "quote";', 'export const REFUND = "refund";'].join("\n"),
  };
  const withTools = normalizeConfig({
    ...config,
    registries: [{ name: "tool", active: { files: "agent/tools.json", field: "name" }, producers: ["backend/src/**"], consumers: ["web/src/**"] }],
  });
  const graph = scan(memory(files), withTools);
  const chains = deriveChains(graph, withTools);

  it("resolves an entry a producer names, and leaves its order with the requests around it to the author", () => {
    const journey = flow("journey", [
      { stepId: "open", chain: "web->bff|GET /screen", role: "opens the screen" },
      { stepId: "quote", registry: "tool:quote", role: "the assistant quotes a price" },
      { stepId: "stop", chain: "web->bff|POST /stop", role: "stops" },
    ]);
    const flows = resolveFlows(graph, [flowFile(journey)], "2026-11-01T00:00:00Z", chains);
    const item = flows.items[0]!;
    expect(item.status.steps.map((s) => `${s.kind} ${s.resolved} ${s.at?.file ?? ""}:${s.at?.line ?? ""}`)).toEqual([
      "chain true bff/src/routes.ts:1",
      "registry true backend/src/tools.ts:1",
      "chain true bff/src/routes.ts:6",
    ]);
    expect(item.status.steps.slice(0, 2).map((s) => s.toNext?.order)).toEqual(["declared", "declared"]);
    expect(item.status.conditions.map((c) => `${c.type}=${c.status} ${c.reason}`)).toEqual([
      "Ready=Unknown OrderNotInCode",
      "Resolved=True AllStepsResolved",
      "Connected=Unknown OrderNotInCode",
      "ProducesListed=Unknown NotDeclared",
      "Documented=True TitleAndRolesWritten",
    ]);
    expect(flowFindings(flows)).toEqual([]);
    expect(validate("flow", journey)).toEqual([]);
    expect(validate("flow-report", flows)).toEqual([]);
  });

  it("lists the registry entries a step can name, each with where it is listed, produced and consumed", () => {
    const doc = query(graph, { kind: "registries", path: "quo" });
    expect(doc.registries?.map((r) => r.id)).toEqual(["tool:quote"]);
    expect(doc.surfaces).toEqual([]);
    expect(validate("subgraph", doc)).toEqual([]);
    expect(queryText(query(graph, { kind: "registries" }))).toBe(
      [
        "registry entries (3)",
        "  tool:quote  agent/tools.json:1  producers 1 (backend/src/tools.ts:1)  consumers 0",
        "  tool:refund  agent/tools.json:1  producers 1 (backend/src/tools.ts:2)  consumers 0",
        "  tool:listed  agent/tools.json:1  producers 0  consumers 0",
        "",
      ].join("\n"),
    );
  });

  it("counts an entry no producer names, or none lists, as not built: planned it is pending, active it is missing", () => {
    const journey = flow("journey", [
      { stepId: "listed", registry: "tool:listed", role: "listed, produced nowhere" },
      { stepId: "cancel", registry: "tool:cancel", role: "not listed yet", lifecycle: "planned" },
    ]);
    const flows = resolveFlows(graph, [flowFile(journey)], "2026-11-01T00:00:00Z", chains);
    expect(flows.items[0]!.status.steps.map((s) => s.resolved)).toEqual([false, false]);
    expect(flows.items[0]!.status.conditions.find((c) => c.type === "Resolved")).toMatchObject({ status: "False", reason: "StepNotFound", message: "not in the code: listed (tool:listed)" });
    expect(flowFindings(flows).map((f) => f.key)).toEqual(["FA007|journey|listed|unresolved"]);
    // Next to a step not built yet, the link is the plan's, not one the code fails to show.
    const plan = flow("plan", [
      { stepId: "quote", registry: "tool:quote", role: "quotes" },
      { stepId: "cancel", registry: "tool:cancel", role: "not listed yet", lifecycle: "planned" },
    ]);
    const planned = resolveFlows(graph, [flowFile(plan)], "2026-11-01T00:00:00Z", chains).items[0]!.status.conditions;
    expect(planned.find((c) => c.type === "Connected")).toMatchObject({ status: "Unknown", reason: "PlannedStepsPending", message: "planned: quote -> cancel" });
    // An active step missing beside a planned one is still a step the code lost, whatever its neighbour.
    const lost = flow("lost", [
      { stepId: "listed", registry: "tool:listed", role: "listed, produced nowhere" },
      { stepId: "cancel", registry: "tool:cancel", role: "not listed yet", lifecycle: "planned" },
    ]);
    const lostConditions = resolveFlows(graph, [flowFile(lost)], "2026-11-01T00:00:00Z", chains).items[0]!.status.conditions;
    expect(lostConditions.find((c) => c.type === "Connected")).toMatchObject({ status: "Unknown", reason: "StepsUnresolved", message: "not checked: listed -> cancel" });
  });

  it("reads a registry entry at a sub-flow's end as an order the author states", () => {
    const branch = flow("branch", [
      { stepId: "quote", registry: "tool:quote", role: "quotes" },
      { stepId: "refund", registry: "tool:refund", role: "refunds" },
    ]);
    const journey = flow("journey", [
      { stepId: "open", chain: "web->bff|GET /screen", role: "opens" },
      { stepId: "branch", flow: "branch" },
      { stepId: "stop", chain: "web->bff|POST /stop", role: "stops" },
    ]);
    const item = resolveFlows(graph, [flowFile(branch, journey)], "2026-11-01T00:00:00Z", chains).items.find((i) => i.metadata.name === "journey")!;
    expect(item.status.steps.slice(0, 2).map((s) => s.toNext?.order)).toEqual(["declared", "declared"]);
    expect(item.status.conditions.find((c) => c.type === "Connected")).toMatchObject({ status: "Unknown", reason: "OrderNotInCode" });
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

  it("offers the page a redirect leads to, and a form posting back to the URL of each page that shows it", () => {
    const pages = {
      "src/main/java/app/TeamController.java": [
        "@Controller",
        "class TeamController {",
        '  private static final String FORM = "teams/form";',
        '  @GetMapping("/teams/new") String create() { return FORM; }',
        "  @PostMapping(\"/teams/new\") String save(Team t) { if (bad) { return FORM; } return \"redirect:/teams/\" + t.getId(); }",
        '  @GetMapping("/teams/{teamId}") String show() { return "teams/detail"; }',
        '  @GetMapping("/teams") @ResponseBody List<Team> all() { return null; }',
        "}",
      ].join("\n"),
      "src/main/resources/templates/teams/form.html": '<form th:object="${team}" method="post"></form>',
      "src/main/resources/templates/teams/detail.html": '<a th:href="@{/teams/new}">new</a>',
    };
    const graph = scan(memory(pages), spring);
    const id = (callId: string) => callId.split("@")[0];
    expect(graph.edges.filter((e) => e.kind === "reach").map((e) => `${e.from} -> ${id(e.to)} ${e.evidence} ${e.via}`)).toEqual([
      "server|GET /teams/new -> web->server|POST /teams/new name view teams/form",
      "server|POST /teams/new -> web->server|POST /teams/new name view teams/form",
      "server|POST /teams/new -> server->server|GET /teams/{} text redirect",
      "server|GET /teams/{teamId} -> web->server|GET /teams/new name view teams/detail",
    ]);
    const report = deriveChains(graph, spring);
    // The redirect's path has a value where both GET routes have a segment, so it fits both, as a link would.
    expect(report.chains.map((c) => [c.id, c.entry.callers.length, ...c.next.map((n) => `${n.chain} (${n.via})`)])).toEqual([
      ["web->server|GET /teams/{teamId}", 0, "web->server|GET /teams/new (view teams/detail)"],
      ["web->server|GET /teams/new", 1, "web->server|POST /teams/new (view teams/form)"],
      ["web->server|POST /teams/new", 1, "web->server|GET /teams/{teamId} (redirect)", "web->server|GET /teams/new (redirect)", "web->server|POST /teams/new (view teams/form)"],
    ]);
    expect(report.unchained).toEqual(["server|GET /teams"]);
    expect(evaluate(graph, spring).map((f) => f.key)).toEqual(["FA001|server|GET /teams"]);
    expect(traceText(trace(graph, seedsFor(graph, "server|GET /teams")))).toContain(
      "not followed: a Spring handler is followed to the template its view renders and the URL it redirects to; atlas reads neither here",
    );
  });

  it("takes public routes that only redirect to each other as served outside, but not one a client's chain redirects to", () => {
    const pages = {
      "src/main/java/app/LoopController.java": [
        "@Controller",
        "class LoopController {",
        '  @GetMapping("/loop") String loop() { return "redirect:/loop"; }',
        '  @GetMapping("/ping") String ping() { return "redirect:/pong"; }',
        '  @GetMapping("/pong") String pong() { return "redirect:/ping"; }',
        '  @PostMapping("/save") String save() { return "redirect:/done"; }',
        '  @GetMapping("/done") String done() { return "done"; }',
        "}",
      ].join("\n"),
      "src/main/resources/templates/save.html": '<form action="/save" method="post"></form>',
    };
    const open = normalizeConfig({ ...spring, publicSurfaces: ["server|GET /**"] });
    const report = deriveChains(scan(memory(pages), open), open);
    expect(report.chains.map((c) => [c.id, ...c.next.map((n) => n.chain)])).toEqual([
      ["outside->server|GET /loop", "outside->server|GET /loop"],
      ["outside->server|GET /ping", "outside->server|GET /pong"],
      ["outside->server|GET /pong", "outside->server|GET /ping"],
      ["web->server|GET /done"],
      ["web->server|POST /save", "web->server|GET /done"],
    ]);
    expect(report.unchained).toEqual([]);
  });

  it("puts the configured prefix before a root-relative template URL, not before one resolved against a page's route", () => {
    const pages = {
      "src/main/java/app/TeamController.java": [
        "@Controller",
        '@RequestMapping("/api")',
        "class TeamController {",
        '  @GetMapping("/teams/new") String create() { return "teams/form"; }',
        '  @PostMapping("/teams/new") String save() { return "teams/form"; }',
        '  @GetMapping("/teams") String list() { return "teams/list"; }',
        "}",
      ].join("\n"),
      "src/main/resources/templates/teams/form.html": '<form method="post"></form><a th:href="@{/teams}">all</a>',
    };
    const prefixed = normalizeConfig({ ...spring, calls: [{ ...spring.calls[0]!, prefix: "/api" }] });
    const graph = scan(memory(pages), prefixed);
    expect(graph.calls.map((c) => `${c.method} ${c.path}`).sort()).toEqual(["GET /api/teams", "POST /api/teams/new"]);
  });

  it("follows the redirect a HEAD route answers with a HEAD request, which Spring serves with a HEAD mapping or else a GET one", () => {
    const pages = {
      "src/main/java/app/Moved.java": [
        "@Controller",
        "class Moved {",
        '  @RequestMapping(value = "/old", method = RequestMethod.HEAD) String old() { return "redirect:/new"; }',
        '  @RequestMapping(value = "/gone", method = RequestMethod.HEAD) String gone() { return "redirect:/both"; }',
        '  @GetMapping("/new") String fresh() { return "new"; }',
        '  @GetMapping("/both") String both() { return "both"; }',
        '  @RequestMapping(value = "/both", method = RequestMethod.HEAD) String bothHead() { return "both"; }',
        "}",
      ].join("\n"),
    };
    const graph = scan(memory(pages), spring);
    const calls = new Map(graph.calls.map((c) => [c.id, c]));
    expect(graph.edges.filter((e) => e.kind === "match").map((e) => `${calls.get(e.from)!.method} ${calls.get(e.from)!.path} -> ${e.to}`)).toEqual([
      "HEAD /new -> server|GET /new",
      "HEAD /both -> server|HEAD /both",
    ]);
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

  it("keeps the call of a method named redirect in its request; only a reply's redirect, read as text, starts another", () => {
    const chain = deriveChains(graphOf(1, "redirect"), normalizeConfig({})).chains;
    expect(chain.map((c) => [c.id, ...c.surfaces])).toEqual([["app->svc|GET /s0", "svc|GET /s0", "svc|GET /s1"]]);
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
