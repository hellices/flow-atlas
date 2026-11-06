import { existsSync, readFileSync } from "node:fs";
import { basename, isAbsolute, join, resolve } from "node:path";
import { stringify } from "yaml";
import { DEFAULT_EXCLUDE, loadConfig, ruleEnabled, type Config } from "./config.js";
import { toArazzo } from "./arazzo.js";
import { chainsText, deriveChains, type ChainReport } from "./chains.js";
import { draftChainFlows } from "./draft.js";
import { diffGraphs, diffMarkdown } from "./diff.js";
import { FlowIndex, seedsFor, trace, traceText } from "./flow.js";
import { flowFindings, loadFlows, LOCATION, resolveFlows, type FlowReport } from "./flows.js";
import { inventory, inventoryText } from "./inventory.js";
import { API_VERSION, type Finding, type Findings, type Graph, type Subgraph } from "./model.js";
import { nearby } from "./nearby.js";
import { methodsMatch, pathsMatch } from "./paths.js";
import { markdownReport, textReport, type Classified } from "./report.js";
import { evaluate, RULES } from "./rules.js";
import { toSarif } from "./sarif.js";
import { scan } from "./scan.js";
import { openSource } from "./source.js";
import {
  exceptionFor,
  readBaseline,
  readExceptions,
  readGraph,
  readLastCheck,
  writeBaseline,
  writeGraph,
  writeLastCheck,
} from "./state.js";
import { codeDependency, configDependency, derived, provenance } from "./provenance.js";

const HELP = `atlas: find cross-component flow problems in a monorepo

Usage: atlas <command> [options]

Commands
  inventory                 list where components, routes and client calls appear to be
  scan                      build the flow graph and print what each configured source yielded
  query                     list surfaces and calls, filtered by --component, --path, --method, --kind
  trace <surface>           follow a surface back to its callers and forward to what it calls
  chains                    list the requests the code makes and every surface each reaches (--unnamed: no flow names it)
  draft flows               print a Flow draft for every chain no flow names (--component to narrow); fill 'agent:' lines
  draft flow <chain>        print a Flow draft for one chain
  flows                     hold the flow descriptions against the code: resolution, connections, uncovered surfaces
  check                     run the rules and show findings new since the baseline or --since
  diff <base>..<head>       compare the flow graph and findings of two revisions (head may be WORKTREE)
  export arazzo             write the flows as an Arazzo 1.0 description (YAML; --format json), --flow for one
  explain <key>             show one finding from the last check with nearby calls or surfaces
  baseline update           record the current findings as the accepted baseline

Options
  --root <dir>        repository to read (default: current directory)
  --config <file>     configuration (default: <root>/atlas.config.yaml, then <out>/atlas.config.yaml)
  --out <dir>         where atlas writes (default: <root>/.atlas); use a directory outside a repository you must not change
  --ref <rev>         read this commit instead of the working tree, without checking it out
  --since <rev>       show only findings that are not present at <rev>
  --exceptions <file> exceptions file (default: <root>/flows/atlas-exceptions.yaml, then <out>/exceptions.yaml)
  --format <f>        text (default), json, yaml; markdown for check and diff; sarif (SARIF 2.1.0) for check
  --all               also show baseline and excepted findings
  --fail-on-new       exit 1 when there are new findings
  --component <name>  query: only this component
  --path <path>       query: surfaces whose route matches the path, or whose path contains it
  --method <m>        query: only this method
  --kind <k>          query: surfaces, calls or both (default)
  --flow <name>       export: only this flow
  --unnamed           chains: only the chains no flow names
`;

interface Options {
  root: string;
  out: string;
  config?: string;
  ref?: string;
  since?: string;
  exceptions?: string;
  format: "text" | "json" | "yaml" | "markdown" | "sarif";
  all: boolean;
  failOnNew: boolean;
  component?: string;
  path?: string;
  method?: string;
  kind?: "surfaces" | "calls" | "both";
  flow?: string;
  unnamed?: boolean;
  args: string[];
}

function parseArgs(argv: string[]): Options {
  const args: string[] = [];
  const o: Partial<Options> = { format: "text", all: false, failOnNew: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    const value = () => {
      const v = argv[++i];
      if (v === undefined) throw new Error(`${a} needs a value`);
      return v;
    };
    if (a === "--root") o.root = value();
    else if (a === "--out") o.out = value();
    else if (a === "--config") o.config = value();
    else if (a === "--ref") o.ref = value();
    else if (a === "--since") o.since = value();
    else if (a === "--exceptions") o.exceptions = value();
    else if (a === "--format") o.format = value() as Options["format"];
    else if (a === "--component") o.component = value();
    else if (a === "--path") o.path = value();
    else if (a === "--method") o.method = value().toUpperCase();
    else if (a === "--kind") {
      const kind = value();
      if (kind !== "surfaces" && kind !== "calls" && kind !== "both") throw new Error(`--kind is surfaces, calls or both, not ${kind}`);
      o.kind = kind;
    }
    else if (a === "--flow") o.flow = value();
    else if (a === "--all") o.all = true;
    else if (a === "--unnamed") o.unnamed = true;
    else if (a === "--fail-on-new") o.failOnNew = true;
    else if (a.startsWith("--")) throw new Error(`unknown option ${a}`);
    else args.push(a);
  }
  if (!["text", "json", "yaml", "markdown", "sarif"].includes(o.format!)) throw new Error(`unknown format ${o.format}`);
  const root = resolve(o.root ?? process.cwd());
  return { ...(o as Options), root, out: resolve(o.out ?? join(root, ".atlas")), args };
}

function configCandidates(o: Options): string[] {
  return o.config ? [resolve(o.config)] : [join(o.root, "atlas.config.yaml"), join(o.out, "atlas.config.yaml")];
}

function configFor(o: Options): Config {
  const candidates = configCandidates(o);
  const found = candidates.find((c) => existsSync(c));
  if (!found) throw new Error(`no configuration found; looked for ${candidates.join(", ")}. Run \`atlas inventory\` and write one; see the skill's references/config.md.`);
  return loadConfig(found);
}

function exceptionsFile(o: Options): string | undefined {
  if (o.exceptions) return resolve(o.exceptions);
  return [join(o.root, "flows", "atlas-exceptions.yaml"), join(o.out, "exceptions.yaml")].find((p) => existsSync(p));
}

/** Writes a schema document as JSON or YAML; returns false for the text formats, which each command renders itself. */
function emit(o: Options, doc: unknown): boolean {
  if (o.format === "json") process.stdout.write(`${JSON.stringify(doc, null, 2)}\n`);
  else if (o.format === "yaml") process.stdout.write(stringify(doc, { lineWidth: 0 }));
  else return false;
  return true;
}

interface Analysis {
  graph: Graph;
  chains: ChainReport;
  flows: FlowReport;
  findings: Finding[];
}

function analyze(o: Options, config: Config, ref: string | undefined): Analysis {
  const source = openSource(o.root, ref);
  const graph = scan(source, config, { root: o.root, requested: ref ?? "WORKTREE" });
  const chains = deriveChains(graph, config);
  const flows = resolveFlows(graph, loadFlows(source, config, o.out), source.asOf(), chains);
  const findings = evaluate(graph, config, graph.limits);
  if (ruleEnabled(config, "FA007")) findings.push(...flowFindings(flows));
  return { graph, chains, flows, findings: findings.sort((a, b) => a.key.localeCompare(b.key)) };
}

function classify(findings: Finding[], o: Options, sinceKeys: Set<string> | undefined): Classified[] {
  const baseline = new Set(readBaseline(o.out)?.keys ?? []);
  const exceptions = readExceptions(exceptionsFile(o));
  return findings.map((finding): Classified => {
    const { exception, expired } = exceptionFor(finding, exceptions);
    if (exception) return { finding, status: "excepted", note: `exception: ${exception.reason}` };
    if (expired) return { finding, status: "expired-exception", note: `exception expired on ${expired.reviewBy}: ${expired.reason}` };
    if (baseline.has(finding.key) || sinceKeys?.has(finding.key)) return { finding, status: "baseline" };
    return { finding, status: "new" };
  });
}

function cmdScan(o: Options): number {
  const config = configFor(o);
  const { graph } = analyze(o, config, o.ref);
  writeGraph(o.out, graph);
  if (emit(o, graph)) return 0;
  const byComponent = new Map<string, number>();
  for (const s of graph.surfaces) byComponent.set(s.component, (byComponent.get(s.component) ?? 0) + 1);
  console.log(`ref ${graph.provenance.resolvedDependencies.find((d) => d.name === "code")?.digest?.gitCommit ?? "WORKTREE"}`);
  console.log(`components ${graph.components.length}, declared edges ${graph.declared.length}`);
  console.log(`surfaces ${graph.surfaces.length} (${[...byComponent].map(([c, n]) => `${c} ${n}`).join(", ")})`);
  console.log(`call sites ${graph.calls.length}, edges ${graph.edges.length}, registry entries ${graph.registries.length}`);
  console.log("");
  console.log(coverageText(graph));
  if (graph.apiDescriptions.length) {
    console.log("", "api descriptions");
    for (const d of graph.apiDescriptions) {
      const head = d.status === "chosen" ? `${d.location} (${d.kind}, ${d.reason})` : `${d.status.toUpperCase()} ${d.reason}`;
      console.log(`  ${d.component}: ${head}${d.message ? `; ${d.message}` : ""}`);
    }
  }
  for (const l of graph.limits) console.log(`limit: ${l}`);
  console.log(`graph written to ${join(o.out, "graph.json")}`);
  return 0;
}

function cmdCheck(o: Options): number {
  const config = configFor(o);
  const { graph, flows, findings } = analyze(o, config, o.ref);
  const sinceKeys = o.since ? new Set(analyze(o, config, o.since).findings.map((f) => f.key)) : undefined;
  const flowFiles = flows.provenance.resolvedDependencies.filter((d) => d.name === "flows");
  const doc: Findings = {
    apiVersion: API_VERSION,
    kind: "Findings",
    provenance: derived(graph.provenance, "Findings", o.since ? { since: o.since } : {}, flowFiles),
    ...(o.since ? { since: o.since } : {}),
    items: classify(findings, o, sinceKeys),
  };
  writeGraph(o.out, graph);
  writeLastCheck(o.out, doc);
  const baseline = new Set(readBaseline(o.out)?.keys ?? []);
  if (o.format === "sarif") process.stdout.write(`${JSON.stringify(toSarif(doc, (f) => baseline.has(f.key) || !!sinceKeys?.has(f.key)), null, 2)}\n`);
  else if (!emit(o, doc)) process.stdout.write(o.format === "markdown" ? markdownReport(doc.items) : textReport(doc.items, o.all));
  for (const l of [...graph.limits, ...coverageDrops(graph, readBaseline(o.out)?.coverage)]) process.stderr.write(`limit: ${l}\n`);
  const fresh = doc.items.filter((i) => i.status === "new" || i.status === "expired-exception").length;
  return o.failOnNew && fresh > 0 ? 1 : 0;
}

function coverageText(graph: Graph): string {
  const rows = graph.coverage.map((c) => {
    const parts = [`${c.files} files`, `${c.items} items`];
    if (c.matched !== undefined) parts.push(`${c.matched} matched`);
    if (c.linked !== undefined) parts.push(`${c.linked} reached from a surface`);
    return `  ${c.source}: ${parts.join(", ")}`;
  });
  return ["coverage", ...rows].join("\n");
}

/** Sources that now yield less than half of what they yielded at the baseline: the configuration has fallen behind the code. */
export function coverageDrops(graph: Pick<Graph, "coverage">, before: Record<string, number> | undefined): string[] {
  if (!before) return [];
  const out: string[] = [];
  for (const [source, was] of Object.entries(before)) {
    const now = graph.coverage.find((c) => c.source === source)?.items ?? 0;
    if (was > 0 && now * 2 < was) out.push(`${source} yields ${now} items, ${was} at the baseline; check the configuration`);
  }
  return out;
}

function cmdDiff(o: Options): number {
  const range = o.args[0];
  const parts = range?.split("..") ?? [];
  // Exactly two revisions; a ref name never starts or ends with a dot, so `a...b` and `a..b..c` are refused too.
  if (parts.length !== 2 || !parts[0] || parts[0].endsWith(".") || parts[1]!.startsWith("."))
    throw new Error(`diff needs <base>..<head> (head may be empty for the working tree), not ${range ?? "nothing"}`);
  const [base, head] = parts as [string, string];
  const config = configFor(o);
  const b = analyze(o, config, base);
  const h = analyze(o, config, head || "WORKTREE");
  const d = diffGraphs(b.graph, h.graph, b.findings, h.findings, b.chains, h.chains);
  if (!emit(o, d)) process.stdout.write(`${diffMarkdown(d)}\n`);
  return 0;
}

function cmdExplain(o: Options): number {
  const key = o.args[0];
  if (!key) throw new Error("explain needs a finding key");
  const last = readLastCheck(o.out);
  if (!last) throw new Error("no previous check; run `atlas check` first");
  const findings = last.items.map((i) => i.finding);
  const f = findings.find((x) => x.key === key) ?? findings.find((x) => x.key.includes(key));
  if (!f) throw new Error(`no finding matches ${key}`);
  console.log(`${f.rule} ${f.title}\n\n${f.message}\n`);
  for (const p of f.at) console.log(`  ${p.file}:${p.line}`);
  const graph = readGraph<Graph>(o.out);
  const near = graph ? nearby(graph, f) : [];
  if (near.length) {
    console.log(`\n${f.rule === "FA001" ? "Calls to this component with a similar path" : "Surfaces of the target with a similar path"}:`);
    for (const c of near) console.log(`  ${c.what}  ${c.at.file}:${c.at.line}`);
  }
  console.log(`\nWhat the rule means and the usual resolutions: references/rules.md (${f.rule}) of the flow-atlas skill.`);
  console.log(`An exception entry for this finding:\n\n- rule: ${f.rule}\n  key: "${f.key}"\n  reason: "<why, and the decision that allows it>"\n  decidedBy: "<document or issue>"\n  reviewBy: "<YYYY-MM-DD>"`);
  return 0;
}

function cmdBaseline(o: Options): number {
  if (o.args[0] !== "update") throw new Error("usage: atlas baseline update");
  const config = configFor(o);
  const { graph, findings } = analyze(o, config, o.ref);
  const before = new Set(readBaseline(o.out)?.keys ?? []);
  const keys = findings.map((f) => f.key);
  writeBaseline(o.out, { ref: graph.provenance.externalParameters.ref ?? "WORKTREE", keys, coverage: Object.fromEntries(graph.coverage.map((c) => [c.source, c.items])) });
  const after = new Set(keys);
  const added = keys.filter((k) => !before.has(k));
  const removed = [...before].filter((k) => !after.has(k));
  console.log(`baseline: ${keys.length} findings (${added.length} added, ${removed.length} removed)`);
  for (const k of added) console.log(`  + ${k}`);
  for (const k of removed) console.log(`  - ${k}`);
  return 0;
}

function cmdInventory(o: Options): number {
  const config = o.config || configCandidates(o).some((c) => existsSync(c)) ? configFor(o) : undefined;
  const source = openSource(o.root, o.ref);
  const inv = inventory(source, config?.exclude ?? DEFAULT_EXCLUDE);
  const doc = {
    apiVersion: API_VERSION,
    kind: "Inventory" as const,
    provenance: provenance("Inventory", { ref: o.ref ?? "WORKTREE" }, [codeDependency("code", source.ref), ...(config ? configDependency(config, o.root) : [])]),
    ...inv,
  };
  if (!emit(o, doc)) process.stdout.write(inventoryText(inv));
  return 0;
}

type QueryFilter = { component?: string; path?: string; method?: string; kind?: string };

function matchesFilter(n: Graph["surfaces"][number] | Graph["calls"][number], f: QueryFilter): boolean {
  const isSurface = "component" in n;
  if ((f.kind === "calls" && isSurface) || (f.kind === "surfaces" && !isSurface)) return false;
  const component = !f.component || (isSurface ? n.component === f.component : n.from === f.component || n.to === f.component);
  const path = !f.path || n.path.includes(f.path) || pathsMatch(n.path, f.path.replace(/:[^/]+|\{[^}]*\}/g, "{}"));
  return component && path && (!f.method || methodsMatch(n.method, f.method));
}

/** The surfaces and calls matching the filter, with their neighbours one edge away and the edges that join them. */
export function query(graph: Graph, filter: QueryFilter): Subgraph {
  const picked = new Set([...graph.surfaces, ...graph.calls].filter((n) => matchesFilter(n, filter)).map((n) => n.id));
  const edges = graph.edges.filter((e) => picked.has(e.from) || picked.has(e.to));
  const nodes = new Set([...picked, ...edges.flatMap((e) => [e.from, e.to])]);
  return {
    apiVersion: API_VERSION,
    kind: "Query",
    provenance: derived(graph.provenance, "Query", Object.fromEntries(Object.entries(filter).filter(([, v]) => v !== undefined))),
    filter: Object.fromEntries(Object.entries(filter).filter(([, v]) => v !== undefined)),
    surfaces: graph.surfaces.filter((s) => nodes.has(s.id)),
    calls: graph.calls.filter((c) => nodes.has(c.id)),
    edges,
  };
}

/** Renders a query document: the nodes that match its filter, each with what it connects to. Reads nothing but the document. */
export function queryText(doc: Subgraph): string {
  const filter = doc.filter ?? {};
  const index = new FlowIndex(doc);
  const lines: string[] = [];
  const surfaces = doc.surfaces.filter((s) => matchesFilter(s, filter));
  const calls = doc.calls.filter((c) => matchesFilter(c, filter));
  if (filter.kind !== "calls") lines.push(`surfaces (${surfaces.length})`);
  for (const s of surfaces) {
    const callers = (index.in.get(s.id) ?? []).map((e) => index.calls.get(e.from)!);
    const leads = (index.out.get(s.id) ?? []).map((e) => index.calls.get(e.to)!);
    lines.push(`  ${s.id}  ${s.at.file}:${s.at.line}  callers ${callers.length}  leads to ${leads.length}`);
    for (const c of callers) lines.push(`    <- ${c.from} ${c.method} ${c.path}  ${c.at.file}:${c.at.line}`);
    for (const c of leads) lines.push(`    -> ${c.to} ${c.method} ${c.path}${c.scope ? ` in ${c.scope}` : ""}  ${c.at.file}:${c.at.line}`);
  }
  if (filter.kind !== "surfaces") lines.push(`calls (${calls.length})`);
  for (const c of calls) {
    const targets = (index.out.get(c.id) ?? []).map((e) => e.to);
    lines.push(`  ${c.from} -> ${c.to}  ${c.method} ${c.path}${c.scope ? ` in ${c.scope}` : ""}  ${c.at.file}:${c.at.line}  ${targets.length ? `serves ${targets.join(", ")}` : "no surface"}`);
  }
  return `${lines.join("\n")}\n`;
}

function cmdQuery(o: Options): number {
  const config = configFor(o);
  const { graph } = analyze(o, config, o.ref);
  const doc = query(graph, { component: o.component, path: o.path, method: o.method, kind: o.kind });
  if (!emit(o, doc)) process.stdout.write(queryText(doc));
  return 0;
}

function cmdTrace(o: Options): number {
  const seed = o.args.join(" ");
  if (!seed) throw new Error("trace needs a surface: component|METHOD /path, METHOD /path or /path");
  const config = configFor(o);
  const { graph } = analyze(o, config, o.ref);
  const seeds = seedsFor(graph, seed);
  if (seeds.length === 0) throw new Error(`no surface matches ${seed}; use \`atlas query --path\` to find one`);
  const doc = trace(graph, seeds);
  if (!emit(o, doc)) process.stdout.write(traceText(doc));
  return 0;
}

/** Renders a flow report; reads nothing but the document. */
export function flowsText(doc: FlowReport, total: number): string {
  const lines = [`flow files ${doc.files.length}, flows ${doc.items.length}`];
  for (const f of doc.files) for (const e of f.errors) lines.push(`  invalid ${f.file}: ${e}`);
  for (const item of doc.items) {
    const { metadata, status } = item;
    const ready = status.conditions.find((c) => c.type === "Ready")!;
    lines.push("", `${metadata.name}  ${status.lifecycle}  Ready=${ready.status}  ${metadata.annotations?.[LOCATION] ?? ""}${metadata.title ? `  ${metadata.title}` : ""}`);
    for (const c of status.conditions.slice(1)) if (c.status !== "Unknown" || c.reason !== "NotDeclared") lines.push(`  ${c.type}=${c.status} ${c.reason}${c.message ? `: ${c.message}` : ""}`);
    status.steps.forEach((s, i) => {
      const where = s.resolved ? (s.at ? `${s.at.file}:${s.at.line}` : "resolved") : s.lifecycle === "planned" || status.lifecycle === "planned" ? "planned" : "NOT FOUND";
      lines.push(`  ${i + 1}. ${s.stepId}  ${s.target}  ${where}`);
      if (s.toNext) {
        const via = s.toNext.edges.filter((e) => e.via).map((e) => e.via);
        lines.push(
          `       ${
            s.toNext.connected
              ? `-> connected in ${s.toNext.edges.length} edges${via.length ? ` via ${via.join(", ")}` : ""}`
              : s.toNext.order === "declared"
                ? "-> next in the order the flow states; the code shows no link"
                : "-> NOT CONNECTED to the next step"
          }`,
        );
      }
    });
  }
  lines.push("", `surfaces no flow covers: ${doc.unassigned.length} of ${total}`);
  return `${lines.join("\n")}\n`;
}

function cmdFlows(o: Options): number {
  const config = configFor(o);
  const { graph, flows } = analyze(o, config, o.ref);
  if (!emit(o, flows)) process.stdout.write(flowsText(flows, written(graph)));
  return 0;
}

/** The surfaces a handler is written for; the ones a framework answers by itself are no one's to cover. */
const written = (graph: Graph): number => graph.surfaces.filter((s) => !s.implicit).length;

/** Which flows name each chain. */
function chainUsers(flows: FlowReport): Map<string, string[]> {
  const out = new Map<string, string[]>();
  for (const item of flows.items) {
    if (item.status.lifecycle === "deprecated") continue;
    for (const s of item.status.steps) if (s.kind === "chain") (out.get(s.target) ?? out.set(s.target, []).get(s.target)!).push(item.metadata.name);
  }
  return out;
}

const touches = (c: ChainReport["chains"][number], component: string | undefined): boolean =>
  !component || c.entry.component === component || c.surfaces.some((s) => s.startsWith(`${component}|`));

function cmdChains(o: Options): number {
  const config = configFor(o);
  const { graph, chains, flows } = analyze(o, config, o.ref);
  const users = chainUsers(flows);
  const mine = { ...chains, chains: chains.chains.filter((c) => touches(c, o.component)) };
  const doc = o.unnamed ? { ...mine, chains: mine.chains.filter((c) => !users.has(c.id)) } : mine;
  if (!emit(o, doc)) process.stdout.write(chainsText(mine, written(graph), users, o.unnamed ? "unnamed" : undefined));
  return 0;
}

function cmdDraft(o: Options): number {
  const [what, ...rest] = o.args;
  const seedText = rest.join(" ");
  if (what === "flows") {
    if (rest.length) throw new Error(`usage: atlas draft flows [--component <c>]; unexpected ${rest.join(" ")}`);
    const config = configFor(o);
    const { graph, chains, flows } = analyze(o, config, o.ref);
    const users = chainUsers(flows);
    const open = chains.chains.filter((c) => !users.has(c.id) && touches(c, o.component));
    if (open.length === 0) {
      process.stderr.write("every chain is named by a flow\n");
      return 0;
    }
    process.stdout.write(draftChainFlows(graph, open, flows.items.map((i) => i.metadata.name)));
    process.stderr.write(`${open.length} drafts; left for the author: metadata.title, metadata.labels, spec.steps[0].role\n`);
    return 0;
  }
  if (what !== "flow" || !seedText) throw new Error("usage: atlas draft flows | atlas draft flow <chain>");
  if (!seedText.includes("->")) throw new Error(`${seedText} is not a chain id; take one from \`atlas chains\``);
  const config = configFor(o);
  const { graph, chains, flows } = analyze(o, config, o.ref);
  const chain = chains.chains.find((c) => c.id === seedText);
  if (!chain) throw new Error(`no chain ${seedText}; see \`atlas chains\``);
  process.stdout.write(draftChainFlows(graph, [chain], flows.items.map((i) => i.metadata.name)));
  process.stderr.write("left for the author: metadata.title, metadata.labels, spec.steps[0].role\n");
  return 0;
}

function cmdExport(o: Options): number {
  if (o.args[0] !== "arazzo") throw new Error("usage: atlas export arazzo [--flow <name>]");
  const config = configFor(o);
  const source = openSource(o.root, o.ref);
  const graph = scan(source, config, { root: o.root, requested: o.ref ?? "WORKTREE" });
  const { document, limits } = toArazzo(graph, loadFlows(source, config, o.out), config, {
    flow: o.flow,
    title: `Flows of ${basename(o.root)}`,
    // A description outside the repository, given by absolute path, is read from disk as route extraction reads it.
    read: (path) => (isAbsolute(path) ? (existsSync(path) ? readFileSync(path, "utf8") : undefined) : source.read(path)),
  });
  process.stdout.write(o.format === "json" ? `${JSON.stringify(document, null, 2)}\n` : stringify(document, { lineWidth: 0 }));
  for (const l of limits) process.stderr.write(`limit: ${l}\n`);
  return 0;
}

const COMMANDS: Record<string, (o: Options) => number> = {
  inventory: cmdInventory,
  scan: cmdScan,
  query: cmdQuery,
  trace: cmdTrace,
  chains: cmdChains,
  flows: cmdFlows,
  check: cmdCheck,
  diff: cmdDiff,
  export: cmdExport,
  draft: cmdDraft,
  explain: cmdExplain,
  baseline: cmdBaseline,
};

export function main(argv: string[]): number {
  const [command, ...rest] = argv;
  if (!command || command === "help" || command === "--help" || command === "-h") {
    process.stdout.write(HELP);
    return 0;
  }
  const run = COMMANDS[command];
  if (!run) {
    process.stderr.write(`unknown command ${command}\n\n${HELP}`);
    return 2;
  }
  try {
    return run(parseArgs(rest));
  } catch (e) {
    process.stderr.write(`atlas ${command}: ${(e as Error).message}\n`);
    return 2;
  }
}

export { RULES };
