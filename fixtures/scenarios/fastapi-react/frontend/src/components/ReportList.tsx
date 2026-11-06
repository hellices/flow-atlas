import { authFetch } from "../lib/auth";

export function ReportList({ selected }: { selected: string }) {
  const load = () => authFetch("/api/reports");
  const open = (filename: string) => authFetch(`/api/reports/${encodeURIComponent(filename)}`);
  const run = (body: unknown) => authFetch("/api/reports/run", { method: "POST", body: JSON.stringify(body) });
  return <a href={`/api/downloads/${encodeURIComponent(selected)}/report.pdf`}>download</a>;
}
