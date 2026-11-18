import { mkdtempSync, readdirSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it, vi } from "vitest";
import { main } from "../src/commands.js";

const root = fileURLToPath(new URL("..", import.meta.url));
const shop = join(root, "fixtures/shop");
const skill = join(root, "skills/flow-atlas");

/** The documents that tell a person or an agent which atlas commands to run. */
const documents = [
  "README.md",
  "skills/flow-atlas/SKILL.md",
  ...readdirSync(join(skill, "references")).map((f) => `skills/flow-atlas/references/${f}`),
  "docs/responsibilities.md",
  "docs/traces.md",
  "CONTRIBUTING.md",
];

/**
 * Every `atlas ...` the documents write as a command: in inline code, or on a line of a shell block. A
 * placeholder in angle brackets (`<key>`, `<base>`) or a shell redirection ends the command where it starts.
 */
function documented(): Array<{ file: string; command: string }> {
  const out: Array<{ file: string; command: string }> = [];
  for (const file of documents) {
    const text = readFileSync(join(root, file), "utf8");
    const take = (raw: string) => {
      const command = raw.replace(/\s+#.*$/, "").replace(/\s*[<>|].*$/, "").trim();
      if (/^atlas( |$)/.test(command)) out.push({ file, command });
    };
    for (const m of text.matchAll(/`(atlas [^`]+)`/g)) take(m[1]!);
    for (const block of text.matchAll(/```(?:bash|sh|shell)\n([\s\S]*?)```/g)) for (const line of block[1]!.split("\n")) take(line);
  }
  return out;
}

/** Runs the CLI in-process and returns its exit status and what it wrote to stderr. */
function run(argv: string[]): { status: number; stderr: string } {
  let stderr = "";
  const err = vi.spyOn(process.stderr, "write").mockImplementation((chunk) => ((stderr += String(chunk)), true));
  const out = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
  try {
    return { status: main(argv), stderr };
  } finally {
    err.mockRestore();
    out.mockRestore();
  }
}

describe("the commands the documents name are the CLI's", () => {
  const commands = documented();

  it("finds the commands the skill tells an agent to run", () => {
    const skillCommands = new Set(commands.filter((c) => c.file.startsWith("skills/")).map((c) => c.command.split(" ")[1]));
    for (const c of ["inventory", "scan", "query", "trace", "chains", "draft", "flows", "check", "diff", "explain", "export", "baseline"])
      expect(skillCommands, c).toContain(c);
  });

  // Each command runs against the shop fixture, with its output in a fresh directory: what is checked is that the CLI
  // knows the command and every option the document gives it, not what it prints. `baseline update` is checked by
  // name only, since it records a baseline.
  const unique = [...new Map(commands.map((c) => [c.command, c])).values()];
  for (const { file, command } of unique) {
    it(`${command}  (${file})`, () => {
      const argv = (command.match(/"[^"]*"|\S+/g) ?? []).slice(1).map((a) => a.replace(/^"(.*)"$/, "$1"));
      if (argv[0] === "baseline") return expect(argv).toEqual(["baseline", "update"]);
      // A placeholder root is the fixture; every run writes to its own directory.
      const rooted = argv.includes("--root") ? argv.map((a, i) => (argv[i - 1] === "--root" ? shop : a)) : [...argv, "--root", shop];
      const r = run([...rooted, "--out", mkdtempSync(join(tmpdir(), "atlas-docs-"))]);
      expect(r.stderr, r.stderr).not.toMatch(/unknown (command|option)|needs a value|usage:/);
    });
  }
});
