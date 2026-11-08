#!/usr/bin/env node
// Fetches each public repository under fixtures/repositories at the commit its repository.yaml pins, into
// .repos/<name> (not committed), for test/repositories.test.ts to scan.
//
//   node scripts/repositories.mjs [name ...]
//
// Only that commit is fetched (depth 1). A checkout already at the commit is kept, with any change in it dropped.
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { parse } from "yaml";

const root = fileURLToPath(new URL("..", import.meta.url));
const fixtures = join(root, "fixtures", "repositories");
const names = process.argv.slice(2);
const all = readdirSync(fixtures, { withFileTypes: true })
  .filter((d) => d.isDirectory() && existsSync(join(fixtures, d.name, "repository.yaml")))
  .map((d) => d.name);
const unknown = names.filter((n) => !all.includes(n));
if (unknown.length) {
  console.error(`no repository fixture named ${unknown.join(", ")}; there are ${all.join(", ")}`);
  process.exit(2);
}

// The checkout is a repository of its own: git must not take its settings from the environment a hook runs in.
const env = Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith("GIT_")));
const git = (dir, ...args) => execFileSync("git", ["-C", dir, ...args], { encoding: "utf8", env, stdio: ["ignore", "pipe", "inherit"] }).trim();

for (const name of names.length ? names : all) {
  const { url, commit } = parse(readFileSync(join(fixtures, name, "repository.yaml"), "utf8"));
  if (!/^https:\/\/github\.com\/[\w.-]+\/[\w.-]+(\.git)?$/.test(url) || !/^[0-9a-f]{40}$/.test(commit)) {
    console.error(`${name}: repository.yaml needs a GitHub https url and a full commit`);
    process.exit(2);
  }
  const dir = join(root, ".repos", name);
  if (existsSync(join(dir, ".git")) && git(dir, "rev-parse", "HEAD") === commit) {
    // A file changed or added in the checkout would be scanned with the commit's: put it back as committed.
    if (git(dir, "status", "--porcelain", "--untracked-files=all")) {
      git(dir, "reset", "-q", "--hard");
      git(dir, "clean", "-q", "-fdx");
      console.error(`${name}: at ${commit.slice(0, 7)}, local changes dropped`);
    } else console.error(`${name}: at ${commit.slice(0, 7)}`);
    continue;
  }
  mkdirSync(dir, { recursive: true });
  if (!existsSync(join(dir, ".git"))) git(dir, "init", "-q");
  git(dir, "fetch", "-q", "--depth", "1", url, commit);
  git(dir, "checkout", "-q", "--force", "FETCH_HEAD");
  git(dir, "clean", "-q", "-fdx");
  console.error(`${name}: checked out ${commit.slice(0, 7)}`);
}
