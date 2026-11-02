import type { Finding, Findings } from "./model.js";

export type Classified = Findings["items"][number];

const place = (f: Finding): string => f.at.map((p) => `${p.file}:${p.line}`).join(", ");

export function textReport(items: Classified[], showAll: boolean): string {
  const shown = items.filter((i) => showAll || i.status === "new" || i.status === "expired-exception");
  const counts = {
    new: items.filter((i) => i.status === "new").length,
    baseline: items.filter((i) => i.status === "baseline").length,
    excepted: items.filter((i) => i.status === "excepted").length,
    expired: items.filter((i) => i.status === "expired-exception").length,
  };
  const head = `${counts.new} new, ${counts.expired} with an expired exception, ${counts.baseline} in the baseline, ${counts.excepted} excepted`;
  if (shown.length === 0) return `${head}\n`;
  const lines = [head, ""];
  for (const i of shown) {
    lines.push(`${i.finding.rule} ${i.finding.title}${i.status === "new" ? "" : ` [${i.status}]`}`);
    lines.push(`  ${i.finding.message}`);
    if (i.finding.at.length) lines.push(`  at ${place(i.finding)}`);
    if (i.note) lines.push(`  ${i.note}`);
    lines.push(`  key ${i.finding.key}`, "");
  }
  return lines.join("\n");
}

export function markdownReport(items: Classified[]): string {
  const shown = items.filter((i) => i.status === "new" || i.status === "expired-exception");
  if (shown.length === 0) return "No new flow findings.\n";
  const cell = (text: string) => text.replace(/\\/g, "\\\\").replace(/\|/g, "\\|").replace(/\r\n|\r|\n/g, "<br>");
  const rows = shown.map((i) => `| ${cell(i.finding.rule)} | ${cell(i.finding.message)} | ${cell(place(i.finding))} |`);
  return ["| Rule | Finding | Where |", "|---|---|---|", ...rows, ""].join("\n");
}
