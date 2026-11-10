import { execFileSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";
import { loadConfig } from "../src/config.js";
import { evaluate } from "../src/rules.js";
import { scan } from "../src/scan.js";
import { WorktreeSource } from "../src/source.js";

/**
 * Each directory under fixtures/repositories pins a public repository at a commit (`repository.yaml`), with the
 * configuration a user would write for it and what atlas read there (`snapshot.json`). `node scripts/repositories.mjs`
 * fetches each into .repos/<name>; a repository not fetched is skipped. Any change to what atlas reads in real code
 * shows here as a difference; `ATLAS_UPDATE_SNAPSHOTS=1` writes the snapshots again, for a change that is meant.
 */
interface Snapshot {
  surfaces: string[];
  calls: string[];
  edges: string[];
  findings: string[];
  limits: string[];
}

const root = fileURLToPath(new URL("..", import.meta.url));
const fixtures = join(root, "fixtures", "repositories");
const names = existsSync(fixtures)
  ? readdirSync(fixtures, { withFileTypes: true })
      .filter((d) => d.isDirectory() && existsSync(join(fixtures, d.name, "repository.yaml")))
      .map((d) => d.name)
  : [];
const update = process.env.ATLAS_UPDATE_SNAPSHOTS === "1";

function snapshotOf(dir: string, configFile: string): Snapshot {
  const config = loadConfig(configFile);
  const graph = scan(new WorktreeSource(dir), config, { root: dir, requested: "WORKTREE" });
  const findings = evaluate(graph, config, graph.limits);
  return {
    surfaces: graph.surfaces.map((s) => `${s.id}${s.implicit ? " (implicit)" : ""}`).sort(),
    calls: graph.calls.map((c) => `${c.from}->${c.to}|${c.method} ${c.path}${c.based ? " based" : ""} @ ${c.at.file}:${c.at.line}`).sort(),
    edges: graph.edges.map((e) => `${e.kind} ${e.from} -> ${e.to} (${e.evidence}${e.via ? `, ${e.via}` : ""})`).sort(),
    findings: findings.map((f) => f.key).sort(),
    limits: [...graph.limits].sort(),
  };
}

/** One entry a line, so a change shows as the lines it moves. */
function written(snapshot: Snapshot): string {
  const lists = Object.entries(snapshot).map(([key, list]: [string, string[]]) =>
    list.length ? `  ${JSON.stringify(key)}: [\n${list.map((x) => `    ${JSON.stringify(x)}`).join(",\n")}\n  ]` : `  ${JSON.stringify(key)}: []`,
  );
  return `{\n${lists.join(",\n")}\n}\n`;
}

describe("what atlas reads in pinned public repositories", () => {
  for (const name of names) {
    const dir = join(root, ".repos", name);
    it.runIf(existsSync(join(dir, ".git")))(name, () => {
      const { commit } = parse(readFileSync(join(fixtures, name, "repository.yaml"), "utf8")) as { commit: string };
      const env = Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith("GIT_")));
      const head = execFileSync("git", ["-C", dir, "rev-parse", "HEAD"], { encoding: "utf8", env }).trim();
      expect(head, `.repos/${name} is not at the pinned commit; run node scripts/repositories.mjs`).toBe(commit);
      // atlas reads the working tree: a file changed or added there would be read with the commit's.
      const changed = execFileSync("git", ["-C", dir, "status", "--porcelain", "--untracked-files=all"], { encoding: "utf8", env }).trim();
      expect(changed, `.repos/${name} has changes of its own; run node scripts/repositories.mjs`).toBe("");
      const actual = snapshotOf(dir, join(fixtures, name, "atlas.config.yaml"));
      const file = join(fixtures, name, "snapshot.json");
      if (update) writeFileSync(file, written(actual));
      expect(existsSync(file), `fixtures/repositories/${name} has no snapshot.json; run with ATLAS_UPDATE_SNAPSHOTS=1`).toBe(true);
      expect(actual).toEqual(JSON.parse(readFileSync(file, "utf8")) as Snapshot);
    });
  }
});
