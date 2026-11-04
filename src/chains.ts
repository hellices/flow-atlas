import { createHash } from "node:crypto";
import type { Config } from "./config.js";
import { FlowIndex } from "./flow.js";
import { API_VERSION, type Document, type Edge, type Graph } from "./model.js";
import { derived } from "./provenance.js";
import { surfacePattern } from "./rules.js";

/**
 * One request and everything the code does for it, as atlas derives it: the request an entry component makes (or a
 * client outside the repository, for a surface declared public), the surface that serves it, and every surface its
 * handler reaches in the same request, fan-out included. Nobody writes a chain; it is computed on every run.
 */
export interface Chain {
  /** `<entry>-><surface id>`; the entry is the calling component, or `outside` for a public surface. */
  id: string;
  entry: { component: string; callers: string[] };
  /** The surface the entry request reaches. */
  root: string;
  /** The root and every surface the request reaches synchronously, nearest first. */
  surfaces: string[];
  /** The reach and match edges between them. */
  edges: Edge[];
  /**
   * Requests that can follow, offered by what the request returns (a page whose template makes them): the next chains,
   * the edge that offers each, and the surface it starts from.
   */
  next: Array<{ chain: string; from: string; via: string }>;
  /** Edges joined only because a name agrees (evidence `name` or `text`), not because code was followed. */
  weak: number;
  /** Changes when the chain's surfaces or edges change; not when code only moves within a file. */
  digest: string;
}

export interface ChainReport extends Document<"Chains"> {
  chains: Chain[];
  /**
   * Surfaces no chain reaches: no path of calls leads to them from a call that starts a request, and they are not
   * declared public. A surface whose only callers are handlers no request reaches is one of them.
   */
  unchained: string[];
}

/** A reach edge to what a rendered page offers is a later request, not part of the one that rendered it. */
export const offersNext = (e: Edge): boolean => e.kind === "reach" && (e.via ?? "").startsWith("view ");

export const chainId = (entry: string, surface: string): string => `${entry}->${surface}`;

/** The surface a chain id starts from. */
export function chainRoot(id: string): string | undefined {
  const at = id.indexOf("->");
  return at > 0 ? id.slice(at + 2) : undefined;
}

export function deriveChains(graph: Graph, config: Pick<Config, "publicSurfaces">): ChainReport {
  const index = new FlowIndex(graph);
  const isPublic = surfacePattern(config.publicSurfaces);
  // A call that a handler makes in the same request belongs to that request; any other call starts one.
  const inRequest = new Set(graph.edges.filter((e) => e.kind === "reach" && !offersNext(e)).map((e) => e.to));
  const roots = new Map<string, { component: string; root: string; callers: string[] }>();
  for (const c of graph.calls) {
    if (inRequest.has(c.id)) continue;
    for (const e of index.out.get(c.id) ?? []) {
      if (e.kind !== "match") continue;
      const id = chainId(c.from, e.to);
      const r = roots.get(id) ?? roots.set(id, { component: c.from, root: e.to, callers: [] }).get(id)!;
      r.callers.push(c.id);
    }
  }
  // A client outside the repository is assumed only for a public surface nothing in the repository calls.
  const called = new Set(graph.edges.filter((e) => e.kind === "match" && index.calls.has(e.from)).map((e) => e.to));
  for (const s of graph.surfaces) {
    if (isPublic(s.id) && !called.has(s.id)) roots.set(chainId("outside", s.id), { component: "outside", root: s.id, callers: [] });
  }

  const chains: Chain[] = [];
  for (const [id, r] of [...roots.entries()].sort(([a], [b]) => a.localeCompare(b))) {
    const surfaces = [r.root];
    const edges: Edge[] = [];
    const next: Chain["next"] = [];
    const seen = new Set(surfaces);
    // `seen` stops cycles, so the walk ends without a depth limit and never cuts a chain short.
    let frontier = [r.root];
    while (frontier.length) {
      const following: string[] = [];
      for (const s of frontier) {
        for (const reach of index.out.get(s) ?? []) {
          if (reach.kind !== "reach") continue;
          const call = index.calls.get(reach.to);
          if (!call) continue;
          for (const m of index.out.get(call.id) ?? []) {
            if (m.kind !== "match") continue;
            if (offersNext(reach)) {
              next.push({ chain: chainId(call.from, m.to), from: s, via: reach.via! });
              continue;
            }
            edges.push(reach, m);
            if (!seen.has(m.to)) {
              seen.add(m.to);
              surfaces.push(m.to);
              following.push(m.to);
            }
          }
        }
      }
      frontier = following;
    }
    // Two edges between the same ends that differ in how they were found are both kept, in a stable order.
    const edgeKey = (e: Edge) => JSON.stringify([e.kind, e.from, e.to, e.via ?? "", e.evidence]);
    const unique = [...new Map(edges.map((e) => [edgeKey(e), e])).values()].sort((a, b) => edgeKey(a).localeCompare(edgeKey(b)));
    const offered = [...new Map(next.map((n) => [`${n.chain}|${n.from}|${n.via}`, n])).values()].sort(
      (a, b) => a.chain.localeCompare(b.chain) || a.from.localeCompare(b.from) || a.via.localeCompare(b.via),
    );
    // From surface to surface, so that code moving within a file (call ids hold lines) does not change the chain; every
    // other property of both edges counts.
    const links = unique
      .filter((e) => e.kind === "reach")
      .flatMap((r) => unique.filter((m) => m.kind === "match" && m.from === r.to).map((m) => JSON.stringify([r.from, m.to, r.via ?? "", r.evidence, m.via ?? "", m.evidence])));
    const digest = createHash("sha256")
      .update(JSON.stringify({ surfaces: [...surfaces].sort(), links: [...new Set(links)].sort() }))
      .digest("hex")
      .slice(0, 12);
    chains.push({
      id,
      entry: { component: r.component, callers: [...new Set(r.callers)].sort() },
      root: r.root,
      surfaces,
      edges: unique,
      next: offered,
      weak: unique.filter((e) => e.kind === "reach" && e.evidence !== "static" && e.evidence !== "declared").length,
      digest,
    });
  }
  const reached = new Set(chains.flatMap((c) => c.surfaces));
  return {
    apiVersion: API_VERSION,
    kind: "Chains",
    provenance: derived(graph.provenance, "Chains", {}),
    chains,
    unchained: graph.surfaces.filter((s) => !s.implicit && !reached.has(s.id)).map((s) => s.id),
  };
}

/** Renders a chain report; reads nothing but the document and the names of the flows that use each chain. */
export function chainsText(doc: ChainReport, total: number, usedBy: Map<string, string[]>, only?: "unnamed"): string {
  const shown = only === "unnamed" ? doc.chains.filter((c) => !usedBy.has(c.id)) : doc.chains;
  const covered = new Set(doc.chains.flatMap((c) => c.surfaces)).size;
  const lines = [`chains ${doc.chains.length}, surfaces in a chain ${covered} of ${total}${only ? `, shown ${shown.length} that no flow names` : ""}`];
  for (const c of shown) {
    const flows = usedBy.get(c.id);
    lines.push("", `${c.id}  ${c.surfaces.length} surface${c.surfaces.length === 1 ? "" : "s"}  digest ${c.digest}${c.weak ? `  ${c.weak} by name` : ""}  ${flows ? `flows: ${flows.join(", ")}` : "named by no flow"}`);
    for (const s of c.surfaces.slice(1)) lines.push(`  ~ ${s}`);
    for (const n of c.next) lines.push(`  next ${n.chain}  (${n.via})`);
  }
  if (doc.unchained.length) {
    lines.push("", `surfaces in no chain: ${doc.unchained.length} (no request atlas reads leads to them; declare one served outside the repository in publicSurfaces)`);
  }
  return `${lines.join("\n")}\n`;
}
