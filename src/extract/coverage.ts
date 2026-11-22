import type { Coverage } from "../model.js";

/** Adds what a source read to its entry; a document's files and items are also counted apart (`documents`, `documented`). */
export function addCoverage(coverage: Coverage[], source: string, files: number, items: number, document = false): void {
  const entry = coverage.find((c) => c.source === source) ?? coverage[coverage.push({ source, files: 0, items: 0 }) - 1]!;
  entry.files += files;
  entry.items += items;
  if (document) {
    entry.documents = (entry.documents ?? 0) + files;
    entry.documented = (entry.documented ?? 0) + items;
  }
}
