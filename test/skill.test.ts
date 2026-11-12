import { readdirSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";

const skills = new URL("../skills/", import.meta.url);

/** The Agent Skills specification (agentskills.io): what a host relies on when it loads a skill directory. */
describe("skills follow the Agent Skills specification", () => {
  for (const dir of readdirSync(skills)) {
    it(dir, () => {
      const text = readFileSync(new URL(`${dir}/SKILL.md`, skills), "utf8");
      const m = /^---\n([\s\S]*?)\n---\n/.exec(text);
      expect(m, "SKILL.md starts with YAML frontmatter").not.toBeNull();
      const fm = parse(m![1]!) as Record<string, unknown>;
      expect(Object.keys(fm).filter((k) => !["name", "description", "license", "compatibility", "metadata", "allowed-tools"].includes(k))).toEqual([]);
      expect(fm.name).toBe(dir);
      expect(fm.name).toMatch(/^[a-z0-9]+(-[a-z0-9]+)*$/);
      expect((fm.name as string).length).toBeLessThanOrEqual(64);
      expect(typeof fm.description).toBe("string");
      expect((fm.description as string).length).toBeGreaterThan(0);
      expect((fm.description as string).length).toBeLessThanOrEqual(1024);
      for (const key of ["license", "compatibility", "allowed-tools"]) if (fm[key] !== undefined) expect(typeof fm[key], `${key} is a string`).toBe("string");
      if (fm.compatibility !== undefined) expect((fm.compatibility as string).length).toBeLessThanOrEqual(500);
      if (fm.metadata !== undefined) {
        expect(fm.metadata !== null && typeof fm.metadata === "object" && !Array.isArray(fm.metadata), "metadata is a mapping").toBe(true);
        for (const v of Object.values(fm.metadata as object)) expect(typeof v).toBe("string");
      }
      for (const ref of text.matchAll(/`(references\/[^`]+\.md)`/g)) {
        expect(() => readFileSync(new URL(`${dir}/${ref[1]}`, skills)), `${ref[1]} exists`).not.toThrow();
      }
    });
  }
});

/**
 * The repository root is an Agent Plugin (agent-plugins.org, 1.0.0): plugin.json beside the skills/ it ships. Marketplaces
 * check the manifest against the schema and the version a listing names against it, so the plugin, the package and the
 * skill name one version.
 */
describe("the repository is an Agent Plugin", () => {
  const manifest = JSON.parse(readFileSync(new URL("../plugin.json", import.meta.url), "utf8")) as Record<string, unknown>;
  it("has a plugin.json that follows the Agent Plugins 1.0.0 schema", () => {
    expect(manifest.$schema).toBe("https://agent-plugins.org/schemas/1.0.0/plugin.schema.json");
    expect(Object.keys(manifest).filter((k) => !["$schema", "name", "version", "description", "author", "homepage", "repository", "license", "keywords", "extensions"].includes(k))).toEqual([]);
    expect(manifest.name).toMatch(/^(?!.*(?:--|\.\.))[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?$/);
    expect((manifest.name as string).length).toBeLessThanOrEqual(64);
    for (const key of ["version", "description", "homepage", "repository", "license"]) expect(typeof manifest[key], key).toBe("string");
    expect(Object.keys(manifest.author as object).filter((k) => !["name", "email", "url"].includes(k))).toEqual([]);
    for (const k of manifest.keywords as string[]) expect(k).toMatch(/^[a-z0-9]+(-[a-z0-9]+)*$/);
  });
  it("names the version the package and the skill name", () => {
    const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")) as { version: string; license: string };
    const skill = readFileSync(new URL("flow-atlas/SKILL.md", skills), "utf8");
    const fm = parse(/^---\n([\s\S]*?)\n---\n/.exec(skill)![1]!) as { license: string; metadata: { version: string } };
    expect([manifest.version, fm.metadata.version]).toEqual([pkg.version, pkg.version]);
    expect([manifest.license, fm.license]).toEqual([pkg.license, pkg.license]);
  });
});
