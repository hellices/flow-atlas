import { plausibleRequest } from "./match.js";
import type { CallSummary, Finding, Findings, Graph } from "./model.js";

export type Classified = Findings["items"][number];

const place = (f: Finding): string => f.at.map((p) => `${p.file}:${p.line}`).join(", ");

/** How far the calls were checked, from the graph: which reach a route, which only a document's, which go unchecked. */
export function callSummary(graph: Graph, routed: Set<string>, findings: Finding[]): CallSummary {
  const surfaces = new Map(graph.surfaces.map((s) => [s.id, s]));
  const targets = new Map<string, string[]>();
  for (const e of graph.edges) if (e.kind === "match") targets.set(e.from, [...(targets.get(e.from) ?? []), e.to]);
  const checked = graph.calls.filter((c) => routed.has(c.to));
  const documentOnly: CallSummary["documentOnly"] = [];
  for (const c of checked) {
    const reached = (targets.get(c.id) ?? []).map((id) => surfaces.get(id)).filter((s) => s !== undefined);
    if (reached.length && reached.every((s) => s.unhandled && s.described))
      documentOnly.push({ call: c.id, at: c.at, surface: reached[0]!.id, described: reached[0]!.described! });
  }
  const reported = new Set(findings.filter((f) => f.rule === "FA002").map((f) => f.key));
  const matched = checked.filter((c) => targets.has(c.id)).length;
  const open = checked.filter((c) => !targets.has(c.id) && !reported.has(`FA002|${c.from}->${c.to}|${c.method} ${c.path}`));
  const notRequests = open.filter((c) => !plausibleRequest(graph, c)).length;
  const unserved = checked.length - matched - open.length;
  return {
    read: graph.calls.length,
    checked: checked.length,
    matched,
    unserved,
    undecided: open.length - notRequests,
    notRequests,
    unchecked: graph.calls.length - checked.length,
    documentOnly,
  };
}

const callWhat = (id: string): string => {
  const [edge, request] = id.replace(/@.*$/, "").split("|") as [string, string];
  const [from, to] = edge.split("->") as [string, string];
  return `${from} calls ${request} on ${to}`;
};

function documentOnlyLines(calls: CallSummary): string[] {
  if (!calls.documentOnly.length) return [];
  const lines = ["Calls that reach a route only an OpenAPI document declares; no handler for it was found in the route files:"];
  for (const d of calls.documentOnly) lines.push(`  ${callWhat(d.call)}  ${d.at.file}:${d.at.line}`, `    -> ${d.surface}  ${d.described.file}:${d.described.line}`);
  return [...lines, ""];
}

function callsLine(calls: CallSummary, limits: number): string {
  const only = calls.documentOnly.length ? ` (${calls.documentOnly.length} only by a document)` : "";
  const unchecked = calls.unchecked ? `, ${calls.unchecked} to components with no route source, not checked` : "";
  const notes = limits ? `; ${limits} limit line${limits === 1 ? "" : "s"} on stderr` : "";
  const unserved = calls.unserved ? `, ${calls.unserved} unserved (FA002)` : "";
  const undecided = calls.undecided ? `, ${calls.undecided} not decided (the limit lines say why)` : "";
  const strings = calls.notRequests ? `, ${calls.notRequests} not taken for requests (no base address, a first segment the target does not serve)` : "";
  return `calls: ${calls.read} read, ${calls.checked} checked against routes: ${calls.matched} matched${only}${unserved}${undecided}${strings}${unchecked}${notes}`;
}

export function textReport(items: Classified[], showAll: boolean, calls?: CallSummary, limits = 0): string {
  const shown = items.filter((i) => showAll || i.status === "new" || i.status === "expired-exception");
  const counts = {
    new: items.filter((i) => i.status === "new").length,
    baseline: items.filter((i) => i.status === "baseline").length,
    excepted: items.filter((i) => i.status === "excepted").length,
    expired: items.filter((i) => i.status === "expired-exception").length,
  };
  const head = `${counts.new} new, ${counts.expired} with an expired exception, ${counts.baseline} in the baseline, ${counts.excepted} excepted`;
  // Read through head or tail, the output starts and ends with the counts.
  const only = calls ? documentOnlyLines(calls) : [];
  const next = calls && shown.length ? ["Before deciding what to change: atlas explain <key> shows a finding with the calls or surfaces of a similar path.", ""] : [];
  const tail = calls ? [...only, ...next, ...(shown.length || only.length ? [head] : []), callsLine(calls, limits)] : [];
  if (shown.length === 0) return [head, ...(only.length ? [""] : []), ...tail, ""].join("\n");
  const lines = [head, ""];
  for (const i of shown) {
    lines.push(`${i.finding.rule} ${i.finding.title}${i.status === "new" ? "" : ` [${i.status}]`}`);
    lines.push(`  ${i.finding.message}`);
    if (i.finding.at.length) lines.push(`  at ${place(i.finding)}`);
    if (i.note) lines.push(`  ${i.note}`);
    lines.push(`  key ${i.finding.key}`, "");
  }
  return [...lines, ...tail, ...(tail.length ? [""] : [])].join("\n");
}

export function markdownReport(items: Classified[], calls?: CallSummary): string {
  const shown = items.filter((i) => i.status === "new" || i.status === "expired-exception");
  const only = calls?.documentOnly.length
    ? [
        "",
        "Calls that reach a route only an OpenAPI document declares (no handler in the route files):",
        "",
        ...calls.documentOnly.map((d) => `- ${callWhat(d.call)} (${d.at.file}:${d.at.line}) → ${d.surface} (${d.described.file}:${d.described.line})`),
        "",
      ]
    : [];
  if (shown.length === 0) return ["No new flow findings.", ...only].join("\n") + (only.length ? "" : "\n");
  const cell = (text: string) => text.replace(/\\/g, "\\\\").replace(/\|/g, "\\|").replace(/\r\n|\r|\n/g, "<br>");
  const rows = shown.map((i) => `| ${cell(i.finding.rule)} | ${cell(i.finding.message)} | ${cell(place(i.finding))} |`);
  return ["| Rule | Finding | Where |", "|---|---|---|", ...rows, ...(only.length ? only : [""])].join("\n");
}
