import type { ChainReport } from "./chains.js";
import { API_VERSION, isRedirect, type ComponentEdge, type Finding, type Graph, type GraphDiff } from "./model.js";
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

export function diffGraphs(
  base: Graph,
  head: Graph,
  baseFindings: Finding[],
  headFindings: Finding[],
  baseChains?: ChainReport,
  headChains?: ChainReport,
): GraphDiff {
  const bs = new Map(base.surfaces.map((s) => [s.id, s]));
  const hs = new Map(head.surfaces.map((s) => [s.id, s]));
  const be = componentEdges(base);
  const he = componentEdges(head);
  const bk = new Set(baseFindings.map((f) => f.key));
  const hk = new Set(headFindings.map((f) => f.key));
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
    chains: chainDiff(baseChains, headChains),
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
  if (d.findings.new.length) lines.push("**New findings**", ...d.findings.new.map((f) => `- ${f.rule} ${f.message}`), "");
  if (d.findings.resolved.length) lines.push("**Resolved findings**", ...d.findings.resolved.map((f) => `- ${f.rule} ${f.message}`), "");
  if (lines.length === 2) lines.push("No flow changes.");
  return lines.join("\n");
}
