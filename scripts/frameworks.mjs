#!/usr/bin/env node
// Asks each framework under fixtures/frameworks for the routes its application serves and writes them to routes.json.
//
//   node scripts/frameworks.mjs [name ...] [--check [--keep]] [--latest]
//   node scripts/frameworks.mjs --matrix [name ...]
//
// --check   compare with the committed routes.json instead of writing it; exit 1 on a difference (a route's raw included)
// --keep    with --check, write what the framework reports to routes.json all the same, for CI to hand back
// --latest  install the framework's latest release first (the fixture's `latest` command) instead of its locked one
// --matrix  print each fixture (or each named one present) with its toolchain as a GitHub Actions matrix and exit
import { execSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { parse } from "yaml";

const root = fileURLToPath(new URL("../fixtures/frameworks", import.meta.url));
const args = process.argv.slice(2);
const check = args.includes("--check");
const latest = args.includes("--latest");
const keep = args.includes("--keep");
const names = args.filter((a) => !a.startsWith("--"));
const all = readdirSync(root, { withFileTypes: true })
  .filter((d) => d.isDirectory() && existsSync(join(root, d.name, "framework.yaml")))
  .map((d) => d.name);
if (args.includes("--matrix")) {
  const include = (names.length ? all.filter((n) => names.includes(n)) : all).map((fixture) => ({ fixture, toolchain: parse(readFileSync(join(root, fixture, "framework.yaml"), "utf8")).toolchain }));
  const missing = include.filter((i) => typeof i.toolchain !== "string");
  if (missing.length) {
    console.error(`framework.yaml names no toolchain in ${missing.map((i) => i.fixture).join(", ")}`);
    process.exit(2);
  }
  console.log(JSON.stringify({ include }));
  process.exit(0);
}
const unknown = names.filter((n) => !all.includes(n));
if (unknown.length) {
  console.error(`no framework fixture named ${unknown.join(", ")}; there are ${all.join(", ")}`);
  process.exit(2);
}

/** Routes in a fixed order, each once, so the file changes only when a route does. */
function settled(routes) {
  const seen = new Map();
  for (const r of routes) {
    if (typeof r.method !== "string" || typeof r.path !== "string") throw new Error(`a route needs a method and a path: ${JSON.stringify(r)}`);
    const key = `${r.method} ${r.path}`;
    if (!seen.has(key)) seen.set(key, { method: r.method, path: r.path, ...(r.raw !== undefined && r.raw !== r.path ? { raw: r.raw } : {}) });
  }
  return [...seen.values()].sort((a, b) => (a.path === b.path ? a.method.localeCompare(b.method) : a.path.localeCompare(b.path)));
}

let failed = false;
for (const name of names.length ? names : all) {
  const dir = join(root, name);
  const spec = parse(readFileSync(join(dir, "framework.yaml"), "utf8"));
  const run = (command) => execSync(command, { cwd: dir, encoding: "utf8", stdio: ["ignore", "pipe", "inherit"], maxBuffer: 64 << 20 });
  console.error(`== ${name}`);
  run(latest ? spec.latest : spec.setup);
  const out = JSON.parse(run(spec.oracle));
  const result = { framework: out.framework, version: out.version, routes: settled(out.routes) };
  const file = join(dir, "routes.json");
  // One route a line, so a change shows as the lines of the routes it moves.
  const lines = result.routes.map((r) => `    ${JSON.stringify(r)}`).join(",\n");
  const text = `{\n  "framework": ${JSON.stringify(result.framework)},\n  "version": ${JSON.stringify(result.version)},\n  "routes": [\n${lines}\n  ]\n}\n`;
  const committed = existsSync(file) ? JSON.parse(readFileSync(file, "utf8")) : { routes: [] };
  if (!check || keep) writeFileSync(file, text);
  if (!check) {
    console.error(`   ${result.routes.length} routes, ${result.framework} ${result.version}`);
    continue;
  }
  // The framework's own spelling counts too: routes.json records it.
  const key = (r) => `${r.method} ${r.path}${r.raw !== undefined && r.raw !== r.path ? ` (${r.raw})` : ""}`;
  const before = new Set(committed.routes.map(key));
  const now = new Set(result.routes.map(key));
  const gone = [...before].filter((k) => !now.has(k));
  const added = [...now].filter((k) => !before.has(k));
  if (gone.length || added.length) {
    failed = true;
    console.error(`   ${result.framework} ${result.version} serves other routes than routes.json (${committed.version}) records:`);
    for (const k of gone) console.error(`   - ${k}`);
    for (const k of added) console.error(`   + ${k}`);
  } else console.error(`   ${result.routes.length} routes as recorded (${result.framework} ${result.version})`);
}
process.exit(failed ? 1 : 0);
