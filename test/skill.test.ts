import { readdirSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";
import { agentPluginErrors } from "./standards.js";

const skills = new URL("../skills/", import.meta.url);

/**
 * The destinations of a Markdown body's inline links and reference definitions, read as CommonMark reads them: in
 * angle brackets (spaces allowed), or bare up to whitespace or the parenthesis that closes the link, with balanced
 * parentheses and backslash escapes inside.
 */
function linkDestinations(markdown: string): string[] {
  const out: string[] = [];
  // Code is not Markdown: blank out fenced blocks and code spans (keeping line breaks) before looking for links.
  const body = markdown
    .replace(/^ {0,3}(`{3,}|~{3,})[^\n]*\n[\s\S]*?(?:^ {0,3}\1[ \t]*$|(?![\s\S]))/gm, (m) => m.replace(/[^\n]/g, " "))
    .replace(/(`+)(?!`)[\s\S]*?[^`]\1(?!`)/g, (m) => m.replace(/[^\n]/g, " "));
  for (let i = body.indexOf("]("); i >= 0; i = body.indexOf("](", i + 2)) {
    let j = i + 2;
    // Spaces, tabs and at most one line ending may come before the destination.
    while (body[j] === " " || body[j] === "\t") j++;
    if (body[j] === "\n") for (j++; body[j] === " " || body[j] === "\t"; ) j++;
    if (body[j] === "<") {
      const close = body.indexOf(">", j);
      if (close > j && !body.slice(j, close).includes("\n")) out.push(body.slice(j + 1, close));
      continue;
    }
    let depth = 0;
    let destination = "";
    for (; j < body.length; j++) {
      const ch = body[j]!;
      if (ch === "\\" && j + 1 < body.length) destination += body[++j];
      else if (/\s/.test(ch)) break;
      else if (ch === ")" && depth === 0) break;
      else {
        if (ch === "(") depth++;
        if (ch === ")") depth--;
        destination += ch;
      }
    }
    if (destination) out.push(destination);
  }
  for (const m of body.matchAll(/^ {0,3}\[[^\]\n]+\]:[ \t]*(?:\n[ \t]*)?(?:<([^>\n]+)>|(\S+))/gm)) out.push(m[1] ?? m[2]!);
  return out;
}

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
      // A relative Markdown link a host follows from the skill's directory, in SKILL.md or a reference.
      for (const file of [`${dir}/SKILL.md`, ...readdirSync(new URL(`${dir}/references/`, skills)).map((f) => `${dir}/references/${f}`)]) {
        const body = readFileSync(new URL(file, skills), "utf8");
        for (const link of linkDestinations(body)) {
          const target = link.replace(/#.*$/, "");
          if (!target || /^[A-Za-z][A-Za-z0-9+.-]*:/.test(target) || target.startsWith("//")) continue;
          expect(() => readFileSync(new URL(target, new URL(file, skills))), `${file} links ${target}`).not.toThrow();
        }
      }
      // The specification asks to keep SKILL.md under 500 lines, with details in references a host loads on demand.
      expect(text.replace(/\n$/, "").split("\n").length, "SKILL.md lines").toBeLessThan(500);
      // The description sits in every turn's context, and the body in every run's: keep both to what every run needs
      // and disclose the rest in references, each of which SKILL.md points to so an agent has a reason to read it.
      expect((fm.description as string).split(/\s+/).length, "description words").toBeLessThan(80);
      expect(text.slice(m![0].length).split(/\s+/).filter(Boolean).length, "SKILL.md body words").toBeLessThan(1500);
      for (const f of readdirSync(new URL(`${dir}/references/`, skills))) expect(text, `SKILL.md points to references/${f}`).toContain(`references/${f}`);
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
    expect(agentPluginErrors(manifest)).toEqual([]);
    expect(manifest.$schema).toBe("https://agent-plugins.org/schemas/1.0.0/plugin.schema.json");
    // Beyond the schema, the awesome-copilot listing requires these, with keywords lowercase and hyphenated.
    for (const key of ["version", "description", "repository", "license"]) expect(manifest[key], key).toBeTruthy();
    for (const k of manifest.keywords as string[]) expect(k).toMatch(/^[a-z0-9]+(-[a-z0-9]+)*$/);
  });
  it("is told apart from what the schema refuses", () => {
    expect(agentPluginErrors({ ...manifest, extensions: null })).not.toEqual([]);
    expect(agentPluginErrors({ ...manifest, skills: ["skills/flow-atlas"] })).not.toEqual([]);
    expect(agentPluginErrors({ ...manifest, name: "Flow Atlas" })).not.toEqual([]);
  });
  it("names the version the package and the skill name", () => {
    const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")) as { version: string; license: string };
    const skill = readFileSync(new URL("flow-atlas/SKILL.md", skills), "utf8");
    const fm = parse(/^---\n([\s\S]*?)\n---\n/.exec(skill)![1]!) as { license: string; metadata: { version: string } };
    expect([manifest.version, fm.metadata.version]).toEqual([pkg.version, pkg.version]);
    expect([manifest.license, fm.license]).toEqual([pkg.license, pkg.license]);
  });
});
