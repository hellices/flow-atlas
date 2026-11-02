import { API_VERSION, type Call, type Edge, type Graph, type Subgraph, type Surface } from "./model.js";
import { derived } from "./provenance.js";
import { methodsMatch, pathsMatch, routeTemplate } from "./paths.js";

/** Lookups over a graph's nodes and edges; every reader of a graph or subgraph walks the same edges. */
export class FlowIndex {
  readonly surfaces = new Map<string, Surface>();
  readonly calls = new Map<string, Call>();
  readonly out = new Map<string, Edge[]>();
  readonly in = new Map<string, Edge[]>();

  constructor(doc: Pick<Graph, "surfaces" | "calls" | "edges">) {
    for (const s of doc.surfaces) this.surfaces.set(s.id, s);
    for (const c of doc.calls) this.calls.set(c.id, c);
    for (const e of doc.edges) {
      (this.out.get(e.from) ?? this.out.set(e.from, []).get(e.from)!).push(e);
      (this.in.get(e.to) ?? this.in.set(e.to, []).get(e.to)!).push(e);
    }
  }

  has(id: string): boolean {
    return this.surfaces.has(id) || this.calls.has(id);
  }

  /** Shortest chain of edges from one node to another, at most `limit` edges long. */
  path(from: string, to: string, limit = 6): Edge[] | undefined {
    if (from === to) return [];
    const back = new Map<string, Edge>();
    let frontier = [from];
    for (let depth = 0; depth < limit && frontier.length; depth++) {
      const next: string[] = [];
      for (const node of frontier) {
        for (const e of this.out.get(node) ?? []) {
          if (e.to === from || back.has(e.to)) continue;
          back.set(e.to, e);
          if (e.to === to) {
            const chain: Edge[] = [];
            for (let at = to; at !== from; at = back.get(at)!.from) chain.unshift(back.get(at)!);
            return chain;
          }
          next.push(e.to);
        }
      }
      frontier = next;
    }
    return undefined;
  }
}

const normalizeSeed = (seed: string): string => seed.replace(/(\s)(\/\S*)$/, (_, sp: string, p: string) => `${sp}${routeTemplate(p)}`);

/** Surfaces that a seed names: `component|METHOD /path`, `METHOD /path` or `/path`, matching route parameters. */
export function seedsFor(graph: Pick<Graph, "surfaces">, seed: string): Surface[] {
  const exact = graph.surfaces.find((s) => s.id === seed || s.id === normalizeSeed(seed));
  if (exact) return [exact];
  const [component, rest] = seed.includes("|") ? (seed.split("|", 2) as [string, string]) : [undefined, seed];
  const m = /^([A-Z*]+)\s+(\/.*)$/.exec(rest.trim());
  const method = m ? m[1]! : "*";
  const path = m ? m[2]! : rest.trim();
  return graph.surfaces.filter(
    (s) =>
      (!component || s.component === component) &&
      methodsMatch(s.method, method) &&
      (s.path === path || pathsMatch(s.path, path.replace(/:[^/]+|\{[^}]*\}/g, "{}"))),
  );
}

const MAX_DEPTH = 16;

/** The subgraph around the seeds: upstream along incoming edges, downstream along outgoing edges. */
export function trace(graph: Graph, seeds: Surface[]): Subgraph {
  const index = new FlowIndex(graph);
  const nodes = new Set(seeds.map((s) => s.id));
  const edges = new Map<string, Edge>();
  const walk = (start: string, dir: "in" | "out") => {
    const seen = new Set([start]);
    let frontier = [start];
    for (let depth = 0; depth < MAX_DEPTH && frontier.length; depth++) {
      const next: string[] = [];
      for (const node of frontier) {
        for (const e of (dir === "out" ? index.out : index.in).get(node) ?? []) {
          edges.set(`${e.kind}|${e.from}|${e.to}`, e);
          const other = dir === "out" ? e.to : e.from;
          nodes.add(other);
          if (!seen.has(other)) {
            seen.add(other);
            next.push(other);
          }
        }
      }
      frontier = next;
    }
  };
  for (const s of seeds) {
    walk(s.id, "in");
    walk(s.id, "out");
  }
  return {
    apiVersion: API_VERSION,
    kind: "Trace",
    provenance: derived(graph.provenance, "Trace", { seed: seeds.map((s) => s.id).join(", ") }),
    seeds: seeds.map((s) => s.id),
    surfaces: graph.surfaces.filter((s) => nodes.has(s.id)),
    calls: graph.calls.filter((c) => nodes.has(c.id)),
    edges: [...edges.values()],
  };
}

const where = (p: { file: string; line: number }): string => `${p.file}:${p.line}`;

/** Renders a trace document as an indented tree; reads nothing but the document. */
export function traceText(doc: Subgraph): string {
  const index = new FlowIndex(doc);
  const label = (id: string, repeated: boolean): string => {
    const s = index.surfaces.get(id);
    if (s) return `${s.id}  ${where(s.at)}${repeated ? "  (shown above)" : ""}`;
    const c = index.calls.get(id)!;
    return `${c.from} -> ${c.to}  ${c.method} ${c.path}${c.scope ? ` in ${c.scope}` : ""}  ${where(c.at)}${repeated ? "  (shown above)" : ""}`;
  };
  const lines: string[] = [];
  // Each node is expanded once per direction: a node reached again, by a cycle or another branch, is only named.
  const walk = (id: string, dir: "in" | "out", indent: string, expanded: Set<string>) => {
    for (const e of (dir === "out" ? index.out : index.in).get(id) ?? []) {
      const other = dir === "out" ? e.to : e.from;
      const repeated = expanded.has(other);
      lines.push(`${indent}${e.kind === "reach" ? "~" : "="} ${label(other, repeated)}`);
      if (!repeated) {
        expanded.add(other);
        walk(other, dir, `${indent}  `, expanded);
      }
    }
  };
  for (const seed of doc.seeds ?? []) {
    const s = index.surfaces.get(seed)!;
    lines.push(`trace ${s.id}  ${where(s.at)}`, "", "upstream (callers, then the surfaces that lead to them)");
    const before = lines.length;
    walk(seed, "in", "  ", new Set([seed]));
    if (lines.length === before) lines.push("  none found among the configured call sites");
    lines.push("", "downstream (calls the handler reaches, then the surfaces they match)");
    const after = lines.length;
    walk(seed, "out", "  ", new Set([seed]));
    if (lines.length === after) {
      lines.push(
        s.reaches === undefined
          ? "  not traced: the handler was not read as TypeScript"
          : "  none found: no configured call of this component sits in a method the handler reaches",
      );
    }
    lines.push("", "= matched by method and path   ~ joined through the handler's calls (by method name)", "");
  }
  return lines.join("\n");
}
