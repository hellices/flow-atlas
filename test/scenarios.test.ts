import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";
import { deriveChains } from "../src/chains.js";
import { loadConfig, ruleEnabled } from "../src/config.js";
import { flowFindings, loadFlows, resolveFlows } from "../src/flows.js";
import { inventory } from "../src/inventory.js";
import { evaluate } from "../src/rules.js";
import { scan } from "../src/scan.js";
import { WorktreeSource } from "../src/source.js";

/**
 * Each scenario is a small repository in the shape of one atlas was run on, with what that run showed once the
 * reading was right: every surface (implicit ones marked), every finding, every chain, and the flows' Ready. A change
 * that moves any of them shows here as a difference in a case someone met, not in a constructed one.
 */
interface Expected {
  case: string;
  surfaces: string[];
  findings: string[];
  chains: string[];
  /** Every call read, `from->to|METHOD path @ file:line` (`based` after the path when the URL joins a base); compared when given. */
  calls?: string[];
  /** Fragments of the limits atlas reports, one per limit, in order. */
  limits?: string[];
  /** Each flow's Ready; none when the scenario has no flow descriptions. */
  flows?: Record<string, string>;
  /** What `atlas inventory` offers: route files with their style and count, client-call files with their count. */
  inventory: { routes: string[]; calls: string[] };
}

const root = fileURLToPath(new URL("../fixtures/scenarios", import.meta.url));
const AS_OF = "2026-11-01T00:00:00Z";

function run(dir: string) {
  const config = loadConfig(join(dir, "atlas.config.yaml"));
  const source = new WorktreeSource(dir);
  const graph = scan(source, config, { root: dir, requested: "WORKTREE" });
  const chains = deriveChains(graph, config);
  const flows = resolveFlows(graph, loadFlows(source, config), AS_OF, chains);
  const offered = inventory(source, config.exclude);
  const findings = evaluate(graph, config, graph.limits);
  if (ruleEnabled(config, "FA007")) findings.push(...flowFindings(flows));
  return {
    surfaces: graph.surfaces.map((s) => `${s.id}${s.implicit ? " (implicit)" : ""}`).sort(),
    findings: findings.map((f) => f.key).sort(),
    // A chain by its id, then every other surface it reaches.
    chains: chains.chains.map((c) => [c.id, ...c.surfaces.filter((s) => s !== c.root).sort()].join(" + ")).sort(),
    calls: graph.calls.map((c) => `${c.from}->${c.to}|${c.method} ${c.path}${c.based ? " based" : ""} @ ${c.at.file}:${c.at.line}`).sort(),
    limits: graph.limits,
    inventory: {
      routes: offered.routes.map((r) => `${r.file} ${r.style} ${r.count}`).sort(),
      calls: offered.calls.map((c) => `${c.file} ${c.count}`).sort(),
    },
    flows: Object.fromEntries(flows.items.map((i) => [i.metadata.name, i.status.conditions.map((c) => `${c.type}=${c.status}`).find((c) => c.startsWith("Ready="))!])),
  };
}

describe("scenarios from real repositories", () => {
  for (const name of readdirSync(root).sort()) {
    const dir = join(root, name);
    if (!existsSync(join(dir, "expected.yaml"))) continue;
    const expected = parse(readFileSync(join(dir, "expected.yaml"), "utf8")) as Expected;
    it(`${name}: ${expected.case.split("\n")[0]}`, () => {
      const actual = run(dir);
      expect(actual.surfaces).toEqual([...expected.surfaces].sort());
      expect(actual.findings).toEqual([...expected.findings].sort());
      expect(actual.chains).toEqual([...expected.chains].sort());
      if (expected.calls) expect(actual.calls).toEqual([...expected.calls].sort());
      expect(actual.limits.length).toBe((expected.limits ?? []).length);
      (expected.limits ?? []).forEach((fragment, i) => expect(actual.limits[i]).toContain(fragment));
      expect(actual.flows).toEqual(expected.flows ?? {});
      expect(actual.inventory).toEqual({ routes: [...expected.inventory.routes].sort(), calls: [...expected.inventory.calls].sort() });
    });
  }
});

