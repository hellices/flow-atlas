import { execFileSync } from "node:child_process";
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { main } from "../src/commands.js";
import { loadConfig } from "../src/config.js";
import { evaluate } from "../src/rules.js";
import { scan } from "../src/scan.js";
import { openSource } from "../src/source.js";

const fixture = fileURLToPath(new URL("../fixtures/shop", import.meta.url));
const repo = mkdtempSync(join(tmpdir(), "atlas-repo-"));
const out = mkdtempSync(join(tmpdir(), "atlas-out-"));
const git = (...args: string[]) => execFileSync("git", ["-C", repo, ...args], { encoding: "utf8" }).trim();

cpSync(fixture, repo, { recursive: true });
git("init", "-q", "-b", "main");
git("-c", "user.email=t@example.com", "-c", "user.name=t", "add", "-A");
git("-c", "user.email=t@example.com", "-c", "user.name=t", "commit", "-qm", "base");
const base = git("rev-parse", "HEAD");
writeFileSync(
  join(repo, "services/bff/src/clients/history.ts"),
  "export const history = (baseUrl: string, id: string) => fetch(`${baseUrl}/orders/${id}/history`);\nexport const audit = (baseUrl: string) => fetch(`${baseUrl}/orders/audit`, { method: 'DELETE' });\n",
);
writeFileSync(join(repo, "atlas.config.yaml"), `${readFileSync(join(fixture, "atlas.config.yaml"), "utf8").replace('files: ["services/bff/src/clients/orders.ts"]', 'files: ["services/bff/src/clients/orders.ts", "services/bff/src/clients/history.ts"]')}`);
git("-c", "user.email=t@example.com", "-c", "user.name=t", "add", "-A");
git("-c", "user.email=t@example.com", "-c", "user.name=t", "commit", "-qm", "head");
const head = git("rev-parse", "HEAD");

afterAll(() => {
  rmSync(repo, { recursive: true, force: true });
  rmSync(out, { recursive: true, force: true });
});

describe("reading commits without a checkout", () => {
  const config = loadConfig(join(repo, "atlas.config.yaml"));

  it("reads a past commit the same way as the working tree", () => {
    const fromCommit = evaluate(scan(openSource(repo, head), config), config).map((f) => f.key);
    const fromTree = evaluate(scan(openSource(repo, undefined), config), config).map((f) => f.key);
    expect(fromCommit).toEqual(fromTree);
  });

  it("sees the history route gain a caller and a new unserved call between commits", () => {
    const before = evaluate(scan(openSource(repo, base), config), config).map((f) => f.key);
    const after = evaluate(scan(openSource(repo, head), config), config).map((f) => f.key);
    expect(before).toContain("FA001|orders|GET /orders/{id}/history");
    expect(after).not.toContain("FA001|orders|GET /orders/{id}/history");
    expect(after).toContain("FA002|bff->orders|DELETE /orders/audit");
  });

  it("check --since shows only what the change introduced", () => {
    expect(main(["check", "--root", repo, "--out", out, "--since", base, "--fail-on-new"])).toBe(1);
    const { items } = JSON.parse(readFileSync(join(out, "last-check.json"), "utf8")) as { items: Array<{ status: string; finding: { key: string } }> };
    expect(items.filter((i) => i.status === "new").map((i) => i.finding.key)).toEqual(["FA002|bff->orders|DELETE /orders/audit"]);
  });

  it("diff reports the change in markdown", () => {
    const write = process.stdout.write.bind(process.stdout);
    let text = "";
    process.stdout.write = ((chunk: string) => {
      text += chunk;
      return true;
    });
    try {
      expect(main(["diff", `${base}..${head}`, "--root", repo, "--out", out])).toBe(0);
    } finally {
      process.stdout.write = write;
    }
    expect(text).toContain("New findings");
    expect(text).toContain("DELETE /orders/audit");
    expect(text).toContain("Resolved findings");
  });

  it("cases run expectations against commits", () => {
    const cases = join(out, "cases.yaml");
    writeFileSync(
      cases,
      [
        `- name: history has no caller at base`,
        `  ref: ${base}`,
        `  include: ["FA001|orders|GET /orders/{id}/history"]`,
        `- name: history is called at head`,
        `  ref: ${head}`,
        `  exclude: ["FA001|orders|GET /orders/{id}/history"]`,
        `  count: { FA002: 2 }`,
      ].join("\n"),
    );
    expect(main(["cases", cases, "--root", repo, "--out", out])).toBe(0);
  });
});
