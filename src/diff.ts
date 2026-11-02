import { API_VERSION, type ComponentEdge, type Finding, type Graph, type GraphDiff } from "./model.js";
import { provenance } from "./provenance.js";

function componentEdges(graph: Graph): Map<string, ComponentEdge> {
  const calls = new Map(graph.calls.map((c) => [c.id, c]));
  const edges = new Map<string, ComponentEdge>();
  for (const e of graph.edges) {
    if (e.kind !== "match") continue;
    const c = calls.get(e.from)!;
    edges.set(`${c.from}->${c.to}|call`, { from: c.from, to: c.to, via: "call" });
  }
  for (const d of graph.declared) edges.set(`${d.from}->${d.to}|${d.via}`, { from: d.from, to: d.to, via: d.via });
  return edges;
}

const minus = <T>(a: Map<string, T>, b: Map<string, T>): T[] =>
  [...a.keys()].filter((k) => !b.has(k)).sort().map((k) => a.get(k)!);

export function diffGraphs(base: Graph, head: Graph, baseFindings: Finding[], headFindings: Finding[]): GraphDiff {
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
  if (d.findings.new.length) lines.push("**New findings**", ...d.findings.new.map((f) => `- ${f.rule} ${f.message}`), "");
  if (d.findings.resolved.length) lines.push("**Resolved findings**", ...d.findings.resolved.map((f) => `- ${f.rule} ${f.message}`), "");
  if (lines.length === 2) lines.push("No flow changes.");
  return lines.join("\n");
}
