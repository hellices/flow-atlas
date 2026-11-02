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

export function flowName(seed: Surface): string {
  return slug(`${seed.component}-${seed.method === "*" ? "any" : seed.method}-${seed.path}`).slice(0, 63).replace(/-+$/, "");
}

const q = (s: string): string => JSON.stringify(s);

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

  const stepIds = new Map<string, number>();
  const stepId = (id: string): string => {
    const s = index.surfaces.get(id)!;
    const base = slug(`${s.component}-${s.path}`) || slug(s.component);
    const n = (stepIds.get(base) ?? 0) + 1;
    stepIds.set(base, n);
    return n === 1 ? base : `${base}-${n}`;
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
