import { createHash } from "node:crypto";
import type { Chain } from "./chains.js";
import { FlowIndex } from "./flow.js";
import type { Graph, Surface } from "./model.js";

const slug = (s: string): string =>
  s
    .toLowerCase()
    .replace(/\{[^}]*\}/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");

const MAX_NAME = 63;

const fit = (s: string, max: number): string => s.slice(0, max).replace(/-+$/, "");

/**
 * A chain's flow name, decided by the chain alone: every part of its id, path parameters included. A name longer than
 * 63 characters is cut and ends in a hash of the chain id, so two chains that share a long prefix keep apart.
 */
function chainName(c: Chain, root: Surface): string {
  const full = slug(`${c.entry.component}-${root.component}-${root.method === "*" ? "any" : root.method}-${root.path.replace(/[{}]/g, "")}`) || "flow";
  return full.length <= MAX_NAME ? full : `${fit(full, MAX_NAME - 7)}-${chainHash(c)}`;
}

const chainHash = (c: Chain): string => createHash("sha256").update(c.id).digest("hex").slice(0, 6);

const q = (s: string): string => JSON.stringify(s);

const OKF = [
  "  # agent: sources: [{ resource: <decision, design or issue>, title: ... }] behind the flow (OKF)",
  "  # agent: generated: { by: <tool>/<model>, at: <ISO 8601 with offset> } once you have written the intent (OKF)",
  "  # human: verified: { by: human:<id>, at: ... } after a person reviews the roles; never written by an agent (OKF)",
  "  # agent: stale_after: <ISO 8601> when the roles should be reviewed again (OKF)",
];

/**
 * Flow drafts for chains, one YAML document each. The structure is the code's: each flow is one chain step, its entry
 * comes from the chain, and the requests the result offers next are listed for the author to pick from. The author
 * writes only the marked comments: the title, the labels and the step's role. A name is decided by its chain, so
 * drafting one chain at a time gives the same names as drafting all. Only when the name is already held, by a flow in
 * `taken` or by another chain of the batch whose id slugs to the same text, does it end in its chain id's hash instead
 * of a number that would depend on the order of drafting.
 */
export function draftChainFlows(graph: Graph, chains: Chain[], taken: Iterable<string> = []): string {
  const index = new FlowIndex(graph);
  const commit = graph.provenance.resolvedDependencies.find((d) => d.name === "code")?.digest?.gitCommit ?? "WORKTREE";
  const used = new Set(taken);
  const docs = chains.map((c) => {
    const root = index.surfaces.get(c.root)!;
    const own = chainName(c, root);
    const name = used.has(own) ? `${fit(own, MAX_NAME - 7)}-${chainHash(c)}` : own;
    used.add(name);
    const callers = c.entry.callers.map((id) => index.calls.get(id)!).map((x) => `${x.at.file}:${x.at.line}`);
    const lines = [
      `# Draft from \`atlas draft flows\` at ${commit}.`,
      "# tool: the step, its chain and the entry come from the code; keep them. Write only the 'agent:' lines.",
      "apiVersion: flow-atlas.dev/v1alpha1",
      "kind: Flow",
      "metadata:",
      `  name: ${name}`,
      "  # agent: title: what the customer or the system achieves through this request",
      "  # agent: labels: { domain: ... } to group it with related flows",
      ...OKF,
      "spec:",
      c.entry.component === "outside"
        ? "  # tool: entry: a client outside the repository (the surface is declared in publicSurfaces); taken from the chain"
        : `  # tool: entry: ${c.entry.component}, from ${callers.length} call site${callers.length === 1 ? "" : "s"} (${callers.slice(0, 3).join(", ")}); taken from the chain`,
      "  steps:",
      `    - stepId: ${slug(`${root.method}-${root.path}`) || "request"}`,
      `      chain: ${q(c.id)}`,
      `      # tool: reaches ${c.surfaces.length} surface${c.surfaces.length === 1 ? "" : "s"}: ${c.surfaces.join(", ")}`,
    ];
    if (c.weak) lines.push(`      # tool: ${c.weak} of its edges are joined by a name only; read those handlers before relying on them`);
    lines.push("      # agent: role: what this request does in the flow, and what each component in it owns");
    if (c.next.length) {
      lines.push("  # tool: requests the result offers next; to follow one, add it as a further step with its chain:");
      for (const n of c.next) lines.push(`  #   chain: ${q(n.chain)}  (${n.via})`);
    }
    return `${lines.join("\n")}\n`;
  });
  return docs.join("---\n");
}
