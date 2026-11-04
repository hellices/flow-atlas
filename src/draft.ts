import { createHash } from "node:crypto";
import type { Chain } from "./chains.js";
import { FlowIndex } from "./flow.js";
import type { Graph, Surface } from "./model.js";

/**
 * A Flow draft from the code alone. Everything the graph settles is written: the name, the steps along the path the
 * code takes, the entry component when only one component calls the first step. What needs intent is left as marked
 * comments, with the candidates the graph offers: the title, each step's role, the owner, the lifecycle, the produced
 * entries, and the next step when the handler leads to more than one service.
 */
export interface Draft {
  yaml: string;
  /** Fields left for the author, by path. */
  open: string[];
}

const slug = (s: string): string =>
  s
    .toLowerCase()
    .replace(/\{[^}]*\}/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");

const MAX_NAME = 63;

const fit = (s: string, max: number): string => s.slice(0, max).replace(/-+$/, "");

/**
 * Gives each base back once, never longer than `max`; a base already given or reserved gets the next free `-<n>`,
 * cutting the base to leave room for it.
 */
export function uniqueIds(reserved: Iterable<string> = [], max = MAX_NAME): (base: string) => string {
  const used = new Set(reserved);
  return (base) => {
    let id = fit(base, max);
    for (let n = 2; used.has(id); n++) id = `${fit(base, max - `-${n}`.length)}-${n}`;
    used.add(id);
    return id;
  };
}

export function flowName(seed: Surface): string {
  return fit(slug(`${seed.component}-${seed.method === "*" ? "any" : seed.method}-${seed.path}`), MAX_NAME);
}

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

/** Surfaces one hop downstream of a surface: through its handler's outbound calls to the surfaces they reach. */
function nextSurfaces(index: FlowIndex, id: string): Array<{ surface: string; via: string }> {
  const out: Array<{ surface: string; via: string }> = [];
  for (const reach of index.out.get(id) ?? []) {
    for (const match of index.out.get(reach.to) ?? []) out.push({ surface: match.to, via: reach.via ?? "" });
  }
  return out.filter((x, i) => out.findIndex((y) => y.surface === x.surface) === i).sort((a, b) => a.surface.localeCompare(b.surface));
}

export function draftFlow(graph: Graph, seed: Surface, to?: Surface): Draft {
  const index = new FlowIndex(graph);
  const open: string[] = ["metadata.title", "spec.owner", "spec.lifecycle"];
  let chain: string[] = [seed.id];
  let branches: Array<{ surface: string; via: string }> = [];

  if (to) {
    const edges = index.path(seed.id, to.id, 16);
    if (!edges) throw new Error(`nothing in the code leads from ${seed.id} to ${to.id}`);
    chain = [seed.id, ...edges.map((e) => e.to).filter((id) => index.surfaces.has(id))];
  } else {
    for (;;) {
      const next = nextSurfaces(index, chain[chain.length - 1]!).filter((n) => !chain.includes(n.surface));
      if (next.length !== 1) {
        branches = next;
        break;
      }
      chain.push(next[0]!.surface);
    }
  }

  const callers = (index.in.get(seed.id) ?? []).filter((e) => e.kind === "match").map((e) => index.calls.get(e.from)!.from);
  const entryComponents = [...new Set(callers)].sort();

  const unique = uniqueIds();
  const stepId = (id: string): string => {
    const s = index.surfaces.get(id)!;
    return unique(slug(`${s.component}-${s.path}`) || slug(s.component) || "step");
  };

  const commit = graph.provenance.resolvedDependencies.find((d) => d.name === "code")?.digest?.gitCommit ?? "WORKTREE";
  const lines = [
    `# Draft from \`atlas draft flow\` at ${commit}.`,
    "# tool: values below without a marker come from the code; keep them unless the code is wrong.",
    "# agent: fill every 'agent:' comment, then run `atlas flows` until this flow is Ready=True.",
    "apiVersion: flow-atlas.dev/v1alpha1",
    "kind: Flow",
    "metadata:",
    `  name: ${flowName(seed)}`,
    "  # agent: title: what the customer or the system achieves through this flow",
    "  # agent: labels: { domain: ... } to group it with related flows",
    "  # agent: sources: [{ resource: <decision, design or issue>, title: ... }] behind the flow (OKF)",
    "  # agent: generated: { by: <tool>/<model>, at: <ISO 8601 with offset> } once you have written the intent (OKF)",
    "  # human: verified: { by: human:<id>, at: ... } after a person reviews the roles; never written by an agent (OKF)",
    "  # agent: stale_after: <ISO 8601> when the roles should be reviewed again (OKF)",
    "spec:",
    "  # agent: owner: the person or team who answers for the flow",
    "  # agent: lifecycle: planned if a step is not built yet (default active)",
  ];
  if (entryComponents.length === 1) {
    lines.push("  entry:", `    component: ${entryComponents[0]}`);
  } else if (entryComponents.length > 1) {
    open.push("spec.entry");
    lines.push(`  # agent: entry: { component: ... } one of ${entryComponents.join(", ")}, the ones that call the first step`);
  } else {
    lines.push("  # agent: entry: no component in the repository calls the first step; name the outside client, or leave it out");
  }
  open.push("spec.produces");
  lines.push("  # agent: produces: registry entries the flow issues, as registry:key", "  steps:");
  chain.forEach((id, i) => {
    const s = index.surfaces.get(id)!;
    lines.push(`    - stepId: ${stepId(id)}`, `      surface: ${q(id)}`);
    if (s.operationId) lines.push(`      # tool: operationId ${s.operationId}, ${s.at.file}:${s.at.line}`);
    else lines.push(`      # tool: ${s.at.file}:${s.at.line}`);
    lines.push("      # agent: role: what this component does in the flow, and what it leaves to the others");
    open.push(`spec.steps[${i}].role`);
  });
  if (branches.length) {
    open.push("spec.steps[next]");
    lines.push("    # agent: the last step's handler leads to several services; add the ones this flow passes through:");
    for (const b of branches) lines.push(`    #   ${q(b.surface)}  via ${b.via}`);
  }
  return { yaml: `${lines.join("\n")}\n`, open };
}
