import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";
import { loadConfig } from "../src/config.js";
import { scan } from "../src/scan.js";
import { WorktreeSource } from "../src/source.js";

/**
 * Each directory under fixtures/clients is code that makes requests with one client library, with the requests it
 * sends when run (`calls.json`, recorded by `scripts/frameworks.mjs` at a server that answers every request). atlas
 * reads the code as its `atlas.config.yaml` says; every request sent must be a call atlas reads, by method and path,
 * and every call a request, except the differences `gaps.yaml` lists. A listed difference that no longer occurs fails as
 * well, so the list only shrinks.
 */
interface Calls {
  library: string;
  version: string;
  calls: Array<{ method: string; path: string; raw?: string }>;
}

interface Gaps {
  /** atlas does not read the library: every request is missing, with this reason. */
  unread?: string;
  /** Requests the code sends that atlas does not read. */
  missing?: Array<{ call: string; reason: string }>;
  /** Calls atlas reads that the code does not send. */
  extra?: Array<{ call: string; reason: string }>;
}

const root = fileURLToPath(new URL("../fixtures/clients", import.meta.url));
const fixtures = existsSync(root)
  ? readdirSync(root, { withFileTypes: true })
      .filter((d) => d.isDirectory())
      .map((d) => d.name)
  : [];

/** A path in the form `calls.json` is written in: each value `{}`, no trailing `/` but on the root. */
function canonicalPath(path: string): string {
  const written = path.replace(/\{[^{}]*\}/g, "{}").replace(/\/+$/, "");
  return written || "/";
}

const keys = (calls: Array<{ method: string; path: string }>): string[] =>
  [...new Set(calls.map((c) => `${c.method.toUpperCase()} ${canonicalPath(c.path)}`))].sort();

describe("calls as each client library sends them", () => {
  const board: string[] = [];
  for (const name of fixtures) {
    it(name, () => {
      const dir = join(root, name);
      expect(existsSync(join(dir, "calls.json")), `${name} has no calls.json; run node scripts/frameworks.mjs ${name}`).toBe(true);
      const sent = JSON.parse(readFileSync(join(dir, "calls.json"), "utf8")) as Calls;
      const gaps = (existsSync(join(dir, "gaps.yaml")) ? parse(readFileSync(join(dir, "gaps.yaml"), "utf8")) : {}) as Gaps;
      const config = loadConfig(join(dir, "atlas.config.yaml"));
      const graph = scan(new WorktreeSource(dir), config, { root: dir, requested: "WORKTREE" });
      const oracle = keys(sent.calls);
      const read = keys(graph.calls);
      const missing = oracle.filter((k) => !read.includes(k));
      const extra = read.filter((k) => !oracle.includes(k));
      board.push(`${name} (${sent.library} ${sent.version}): ${oracle.length - missing.length}/${oracle.length} requests read, ${extra.length} extra`);
      const listedMissing = gaps.unread !== undefined ? oracle : (gaps.missing ?? []).map((g) => g.call).sort();
      const listedExtra = (gaps.extra ?? []).map((g) => g.call).sort();
      expect({ missing, extra }).toEqual({ missing: listedMissing, extra: listedExtra });
    });
  }
  it.runIf(fixtures.length > 0)("prints the board", () => {
    console.log(["requests read per client library:", ...board.map((b) => `  ${b}`)].join("\n"));
  });
});
