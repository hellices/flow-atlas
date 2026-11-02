import type { Coverage } from "../model.js";

export function addCoverage(coverage: Coverage[], source: string, files: number, items: number): void {
  const entry = coverage.find((c) => c.source === source);
  if (entry) {
    entry.files += files;
    entry.items += items;
  } else coverage.push({ source, files, items });
}
