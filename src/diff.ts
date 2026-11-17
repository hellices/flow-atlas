import type { ChainReport } from "./chains.js";
import type { FlowReport } from "./flows.js";
import { API_VERSION, isRedirect, type ComponentEdge, type Finding, type FlowChange, type Graph, type GraphDiff } from "./model.js";
import { provenance } from "./provenance.js";

function componentEdges(graph: Graph): Map<string, ComponentEdge> {
  const calls = new Map(graph.calls.map((c) => [c.id, c]));
  const edges = new Map<string, ComponentEdge>();
  // A redirect's request is the client's that followed it, not one component calling another.
  const redirects = new Set(graph.edges.filter(isRedirect).map((e) => e.to));
  for (const e of graph.edges) {
    if (e.kind !== "match" || redirects.has(e.from)) continue;
    const c = calls.get(e.from)!;
    edges.set(`${c.from}->${c.to}|call`, { from: c.from, to: c.to, via: "call" });
  }
  for (const d of graph.declared) edges.set(`${d.from}->${d.to}|${d.via}`, { from: d.from, to: d.to, via: d.via });
  return edges;
}

const minus = <T>(a: Map<string, T>, b: Map<string, T>): T[] =>
  [...a.keys()].filter((k) => !b.has(k)).sort().map((k) => a.get(k)!);

function chainDiff(base: ChainReport | undefined, head: ChainReport | undefined): GraphDiff["chains"] {
  const b = new Map((base?.chains ?? []).map((c) => [c.id, c]));
  const h = new Map((head?.chains ?? []).map((c) => [c.id, c]));
  const changed: GraphDiff["chains"]["changed"] = [];
  for (const [id, c] of [...h.entries()].sort(([x], [y]) => x.localeCompare(y))) {
    const old = b.get(id);
    if (!old || old.digest === c.digest) continue;
    const was = new Set(old.surfaces);
    const now = new Set(c.surfaces);
    changed.push({ id, added: c.surfaces.filter((s) => !was.has(s)).sort(), removed: old.surfaces.filter((s) => !now.has(s)).sort() });
  }
  return {
    added: [...h.keys()].filter((id) => !b.has(id)).sort(),
    removed: [...b.keys()].filter((id) => !h.has(id)).sort(),
    changed,
  };
}

/**
 * The flows a change reaches, matched by name and their steps by stepId: what a reviewer of the change should read
 * against each flow's intent. Flow files in the repository are read at each revision, so a step the flow itself adds,
 * removes or points elsewhere is named apart from what the code does to the steps it keeps; flows kept outside the
 * repository are the same at both.
 */
function flowDiff(base: FlowReport, head: FlowReport, chains: GraphDiff["chains"]): NonNullable<GraphDiff["flows"]> {
  const first = (r: FlowReport) => {
    const m = new Map<string, FlowReport["items"][number]>();
    for (const i of r.items) if (!m.has(i.metadata.name)) m.set(i.metadata.name, i);
    return m;
  };
  const b = first(base);
  const h = first(head);
  const reach = new Map(chains.changed.map((c) => [c.id, c]));
  const changed: FlowChange[] = [];
  for (const [name, now] of [...h.entries()].sort(([x], [y]) => x.localeCompare(y))) {
    const was = b.get(name);
    if (!was) continue;
    const before = new Map(was.status.steps.map((s) => [s.stepId, s]));
    const after = new Set(now.status.steps.map((s) => s.stepId));
    const steps: FlowChange["steps"] = [];
    // What the flow's own text changed comes first: a step it adds, points elsewhere or removes.
    for (const s of now.status.steps) {
      const old = before.get(s.stepId);
      if (!old) steps.push({ stepId: s.stepId, target: s.target, change: "added" });
      else if (old.target !== s.target) steps.push({ stepId: s.stepId, target: s.target, change: "retargeted", was: old.target });
    }
    for (const s of was.status.steps) if (!after.has(s.stepId)) steps.push({ stepId: s.stepId, target: s.target, change: "removed" });
    // The order of the steps both revisions keep is the author's journey; a new order is a change of its own.
    const kept = { was: was.status.steps.map((s) => s.stepId).filter((id) => after.has(id)), now: now.status.steps.map((s) => s.stepId).filter((id) => before.has(id)) };
    const order = kept.was.join("\n") !== kept.now.join("\n") ? kept : undefined;
    for (const s of now.status.steps) {
      const old = before.get(s.stepId);
      if (!old || old.target !== s.target) continue;
      if (s.resolved !== old.resolved) steps.push({ stepId: s.stepId, target: s.target, change: s.resolved ? "built" : "gone" });
      else if (s.kind === "chain" && reach.has(s.target)) {
        const c = reach.get(s.target)!;
        steps.push({ stepId: s.stepId, target: s.target, change: "reaches", added: c.added, removed: c.removed });
      }
    }
    const conditions: FlowChange["conditions"] = [];
    for (const c of now.status.conditions) {
      const o = was.status.conditions.find((x) => x.type === c.type);
      if (o && (o.status !== c.status || o.reason !== c.reason))
        conditions.push({ type: c.type, was: { status: o.status, reason: o.reason }, now: { status: c.status, reason: c.reason } });
    }
    if (steps.length || conditions.length || order) changed.push({ name, conditions, steps, ...(order ? { order } : {}) });
  }
  // A flow that runs a flow the change reaches is reached through it, at every level; each step is named once.
  const touched = new Map(changed.map((c) => [c.name, c]));
  for (let grew = true; grew; ) {
    grew = false;
    for (const [name, now] of h) {
      if (!b.has(name)) continue;
      for (const s of now.status.steps) {
        if (s.kind !== "flow" || !touched.has(s.target)) continue;
        const entry = touched.get(name) ?? { name, conditions: [], steps: [] };
        if (entry.steps.some((x) => x.stepId === s.stepId)) continue;
        if (!touched.has(name)) {
          touched.set(name, entry);
          changed.push(entry);
        }
        entry.steps.push({ stepId: s.stepId, target: s.target, change: "runs" });
        grew = true;
      }
    }
  }
  changed.sort((x, y) => x.name.localeCompare(y.name));
  return {
    added: [...h.keys()].filter((n) => !b.has(n)).sort(),
    removed: [...b.keys()].filter((n) => !h.has(n)).sort(),
    changed,
  };
}

export function diffGraphs(
  base: Graph,
  head: Graph,
  baseFindings: Finding[],
  headFindings: Finding[],
  baseChains?: ChainReport,
  headChains?: ChainReport,
  baseFlows?: FlowReport,
  headFlows?: FlowReport,
): GraphDiff {
  const bs = new Map(base.surfaces.map((s) => [s.id, s]));
  const hs = new Map(head.surfaces.map((s) => [s.id, s]));
  const be = componentEdges(base);
  const he = componentEdges(head);
  const bk = new Set(baseFindings.map((f) => f.key));
  const hk = new Set(headFindings.map((f) => f.key));
  const chains = chainDiff(baseChains, headChains);
  return {
    apiVersion: API_VERSION,
    kind: "Diff",
    provenance: provenance(
      "Diff",
      { base: base.provenance.externalParameters.ref ?? "", head: head.provenance.externalParameters.ref ?? "" },
      [
        ...base.provenance.resolvedDependencies.map((d) => ({ ...d, name: `base ${d.name}` })),
        ...head.provenance.resolvedDependencies.map((d) => ({ ...d, name: `head ${d.name}` })),
      ],
    ),
    surfaces: { added: minus(hs, bs), removed: minus(bs, hs) },
    componentEdges: { added: minus(he, be), removed: minus(be, he) },
    findings: { new: headFindings.filter((f) => !bk.has(f.key)), resolved: baseFindings.filter((f) => !hk.has(f.key)) },
    chains,
    ...(baseFlows && headFlows ? { flows: flowDiff(baseFlows, headFlows, chains) } : {}),
  };
}

const edgeText = (e: ComponentEdge): string => (e.via === "call" ? `${e.from} -> ${e.to}` : `${e.from} -> ${e.to} (declared via ${e.via})`);

/** Renders a diff document as Markdown for a PR description; reads nothing but the document. */
const commitOf = (d: GraphDiff, side: "base" | "head"): string =>
  d.provenance.resolvedDependencies.find((r) => r.name === `${side} code`)?.digest?.gitCommit ?? d.provenance.externalParameters[side] ?? side;

export function diffMarkdown(d: GraphDiff): string {
  const lines = [`### Flow changes (${commitOf(d, "base").slice(0, 10)} → ${commitOf(d, "head").slice(0, 10)})`, ""];
  const section = (title: string, items: string[]) => {
    if (items.length === 0) return;
    lines.push(`**${title}**`, ...items.map((i) => `- \`${i}\``), "");
  };
  section("Surfaces added", d.surfaces.added.map((s) => s.id));
  section("Surfaces removed", d.surfaces.removed.map((s) => s.id));
  section("Component edges added", d.componentEdges.added.map(edgeText));
  section("Component edges removed", d.componentEdges.removed.map(edgeText));
  section("Chains added", d.chains.added);
  section("Chains removed", d.chains.removed);
  if (d.chains.changed.length) {
    lines.push("**Chains that changed**");
    for (const c of d.chains.changed) {
      const reach = [
        c.added.length ? `now reaches ${c.added.map((s) => `\`${s}\``).join(", ")}` : "",
        c.removed.length ? `no longer reaches ${c.removed.map((s) => `\`${s}\``).join(", ")}` : "",
      ].filter(Boolean);
      lines.push(`- \`${c.id}\`: ${reach.length ? reach.join("; ") : "same surfaces, edges between them changed"}`);
    }
    lines.push("");
  }
  const flows = d.flows;
  if (flows && (flows.changed.length || flows.added.length || flows.removed.length)) {
    lines.push("**Flows the change reaches**");
    const surfaces = (ids: string[]) => ids.map((s) => `\`${s}\``).join(", ");
    for (const f of flows.changed) {
      const ids = (xs: string[]) => xs.map((x) => `\`${x}\``).join(", ");
      const parts = f.order ? [`the flow's steps are in another order: ${ids(f.order.was)} → ${ids(f.order.now)}`] : [];
      parts.push(...f.steps.map((s) => {
        if (s.change === "added") return `the flow's step \`${s.stepId}\` (\`${s.target}\`) is added`;
        if (s.change === "removed") return `the flow's step \`${s.stepId}\` (\`${s.target}\`) is removed`;
        if (s.change === "retargeted") return `the flow's step \`${s.stepId}\` now names \`${s.target}\` (was \`${s.was}\`)`;
        if (s.change === "runs") return `step \`${s.stepId}\` runs \`${s.target}\`, which the change reaches`;
        if (s.change === "built") return `step \`${s.stepId}\` (\`${s.target}\`) is now in the code`;
        if (s.change === "gone") return `step \`${s.stepId}\` (\`${s.target}\`) is no longer in the code`;
        const reach = [s.added?.length ? `now reaches ${surfaces(s.added)}` : "", s.removed?.length ? `no longer reaches ${surfaces(s.removed)}` : ""].filter(Boolean);
        return `step \`${s.stepId}\` ${reach.length ? reach.join(" and ") : "reaches the same surfaces by other edges"}`;
      }));
      // Ready follows from the others; it is named only when nothing else says why it moved.
      const moved = f.conditions.filter((c) => c.type !== "Ready" || f.conditions.length === 1);
      parts.push(...moved.map((c) => `${c.type} ${c.was.status} (${c.was.reason}) → ${c.now.status} (${c.now.reason})`));
      lines.push(`- \`${f.name}\`: ${parts.join("; ")}`);
    }
    for (const n of flows.added) lines.push(`- \`${n}\`: added`);
    for (const n of flows.removed) lines.push(`- \`${n}\`: removed`);
    lines.push("");
  }
  if (d.findings.new.length) lines.push("**New findings**", ...d.findings.new.map((f) => `- ${f.rule} ${f.message}`), "");
  if (d.findings.resolved.length) lines.push("**Resolved findings**", ...d.findings.resolved.map((f) => `- ${f.rule} ${f.message}`), "");
  if (lines.length === 2) lines.push("No flow changes.");
  return lines.join("\n");
}
