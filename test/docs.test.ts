import { mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
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

/** What a placeholder in a documented command stands for, on the shop fixture. */
const placeholders: Record<string, string> = {
  repo: shop,
  base: "HEAD",
  "revision you started from": "HEAD",
  key: "FA002",
  path: "/orders",
  fragment: "/orders",
  "path or fragment": "/orders",
  name: "bff",
  c: "bff",
  surface: "bff|GET /screens/order/{id}",
  "closest surface": "bff|GET /screens/order/{id}",
  chain: "web->bff",
};

/**
 * Splits a documented command into its arguments the way a shell would: quotes group, and an unquoted redirection,
 * pipe or comment ends the command. A placeholder in angle brackets becomes the fixture value it stands for.
 */
function argv(command: string): string[] {
  const args: string[] = [];
  let word: string | undefined;
  for (let i = 0; i < command.length; i++) {
    const ch = command[i]!;
    if (ch === '"' || ch === "'") {
      const close = command.indexOf(ch, i + 1);
      if (close < 0) throw new Error(`unbalanced quote in ${command}`);
      word = (word ?? "") + command.slice(i + 1, close);
      i = close;
    } else if (ch === "<" && command.indexOf(">", i) > i) {
      const close = command.indexOf(">", i);
      const name = command.slice(i + 1, close);
      if (!(name in placeholders)) throw new Error(`no fixture value for <${name}> in ${command}`);
      word = (word ?? "") + placeholders[name];
      i = close;
    } else if (ch === ">" || ch === "|" || ch === "<" || (ch === "#" && word === undefined)) break;
    else if (/\s/.test(ch)) {
      if (word !== undefined) args.push(word);
      word = undefined;
    } else word = (word ?? "") + ch;
  }
  if (word !== undefined) args.push(word);
  return args;
}

/** Every `atlas ...` the documents write as a command: in inline code, or on a line of a shell block. */
function documented(): Array<{ file: string; command: string }> {
  const out: Array<{ file: string; command: string }> = [];
  for (const file of documents) {
    const text = readFileSync(join(root, file), "utf8");
    const take = (raw: string) => {
      const command = raw.replace(/\s+/g, " ").trim();
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

  // Each command runs against the shop fixture, with its output in a fresh directory and its placeholders filled
  // with fixture values: what is checked is that the CLI takes the command and every argument the document gives it,
  // not what it prints. A command that reads a previous check (explain) gets one first, in the same directory.
  const unique = [...new Map(commands.map((c) => [c.command, c])).values()];
  for (const { file, command } of unique) {
    it(`${command}  (${file})`, () => {
      // A revision the documents name (main) may be missing from a shallow checkout; HEAD is always there.
      const args = argv(command)
        .slice(1)
        .map((a, i, all) => (all[i - 1] === "--since" ? "HEAD" : all[0] === "diff" && i === 1 ? a.replace(/^[^.]*\.\./, "HEAD..") : a));
      const out = mkdtempSync(join(tmpdir(), "atlas-docs-"));
      try {
        // The fixture options go right after the command name, so a documented option left without its value at the
        // end still fails instead of taking one of them.
        const documentedArgs = args.slice(1).map((a, i, all) => (all[i - 1] === "--root" ? shop : a));
        const fixture = args.includes("--root") ? ["--out", out] : ["--root", shop, "--out", out];
        if (args[0] === "explain") expect(run(["check", "--root", shop, "--out", out]).status).toBe(0);
        const r = run([args[0]!, ...fixture, ...documentedArgs]);
        // A command named alone, as prose does (`atlas explain`), is checked by name; otherwise 2 is a usage or
        // argument error: an unknown command, option or value, or a missing argument.
        if (args.length === 1) expect(r.stderr, r.stderr).not.toMatch(/unknown command/);
        else expect(r.status, r.stderr).not.toBe(2);
      } finally {
        rmSync(out, { recursive: true, force: true });
      }
    });
  }
});
