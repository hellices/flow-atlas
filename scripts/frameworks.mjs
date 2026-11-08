#!/usr/bin/env node
// Asks each framework under fixtures/frameworks for the routes its application serves (routes.json), and records the
// requests each client library under fixtures/clients sends (calls.json).
//
//   node scripts/frameworks.mjs [name ...] [--check [--keep]] [--latest]
//   node scripts/frameworks.mjs --matrix [name ...]
//
// --check   compare with the committed file instead of writing it; exit 1 on a difference (an entry's raw included)
// --keep    with --check, write what was reported to the file all the same, for CI to hand back
// --latest  install the latest release first (the fixture's `latest` command) instead of the locked one
// --matrix  print each fixture (or each named one present) with its toolchain as a GitHub Actions matrix and exit
//
// A framework fixture's oracle prints {framework, version, routes}, and may add `requests`: sample requests, each
// {method, path} with a concrete path and the route the framework dispatched it to (`route`, "METHOD /path" in the form
// of routes.json, or null where none took it), written to dispatch.json. A client fixture's oracle makes every request its
// code makes once, against the recording server whose base URL it gets as RECORD_URL, with the value ARG (or the
// number ARG_NUMBER) for each path argument, and prints {library, version}; the requests the server receives are the
// calls, each argument written `{}`.
import { exec as execCallback, execSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { parse } from "yaml";

const exec = promisify(execCallback);
const KINDS = {
  framework: { root: "../fixtures/frameworks", spec: "framework.yaml", file: "routes.json", list: "routes", by: "framework", does: "serves other routes than" },
  client: { root: "../fixtures/clients", spec: "client.yaml", file: "calls.json", list: "calls", by: "library", does: "sends other requests than" },
};
/** What a client passes for each path argument, so the harness can tell an argument from the path around it. */
const ARG = "zzparamzz";
const ARG_NUMBER = 7777777;

const args = process.argv.slice(2);
const check = args.includes("--check");
const latest = args.includes("--latest");
const keep = args.includes("--keep");
const names = args.filter((a) => !a.startsWith("--"));
const all = Object.entries(KINDS).flatMap(([kind, k]) => {
  const root = fileURLToPath(new URL(k.root, import.meta.url));
  return existsSync(root)
    ? readdirSync(root, { withFileTypes: true })
        .filter((d) => d.isDirectory() && existsSync(join(root, d.name, k.spec)))
        .map((d) => ({ name: d.name, kind, dir: join(root, d.name) }))
    : [];
});
const twice = all.filter((f, i) => all.findIndex((g) => g.name === f.name) !== i);
if (twice.length) {
  console.error(`a framework fixture and a client fixture share the name ${twice.map((f) => f.name).join(", ")}`);
  process.exit(2);
}
const specOf = (f) => parse(readFileSync(join(f.dir, KINDS[f.kind].spec), "utf8"));
if (args.includes("--matrix")) {
  const include = (names.length ? all.filter((f) => names.includes(f.name)) : all).map((f) => ({ fixture: f.name, toolchain: specOf(f).toolchain }));
  const missing = include.filter((i) => typeof i.toolchain !== "string");
  if (missing.length) {
    console.error(`the fixture's yaml names no toolchain in ${missing.map((i) => i.fixture).join(", ")}`);
    process.exit(2);
  }
  console.log(JSON.stringify({ include }));
  process.exit(0);
}
const unknown = names.filter((n) => !all.some((f) => f.name === n));
if (unknown.length) {
  console.error(`no fixture named ${unknown.join(", ")}; there are ${all.map((f) => f.name).join(", ")}`);
  process.exit(2);
}

/** Entries in a fixed order, each once, so the file changes only when one does. */
function settled(entries) {
  const seen = new Map();
  for (const r of entries) {
    if (typeof r.method !== "string" || typeof r.path !== "string") throw new Error(`an entry needs a method and a path: ${JSON.stringify(r)}`);
    const key = `${r.method} ${r.path}`;
    if (!seen.has(key)) seen.set(key, { method: r.method, path: r.path, ...(r.raw !== undefined && r.raw !== r.path ? { raw: r.raw } : {}) });
  }
  return [...seen.values()].sort((a, b) => (a.path === b.path ? a.method.localeCompare(b.method) : a.path.localeCompare(b.path)));
}

/** A request's path with each argument written `{}`, without its query and without a trailing `/` but on the root. */
function callPathOf(raw) {
  const path = raw.split("?")[0].split("#")[0];
  const written = path
    .split("/")
    .map((seg) => {
      let s = seg;
      try {
        s = decodeURIComponent(seg);
      } catch {
        // A segment that is not valid percent-encoding is kept as sent.
      }
      return s.split(ARG).join("{}").split(String(ARG_NUMBER)).join("{}");
    })
    .join("/")
    .replace(/\/+$/, "");
  return written || "/";
}

/** Runs a client fixture's oracle against a server that records each request and answers it with an empty JSON object. */
async function recordCalls(f, command) {
  const requests = [];
  const server = createServer((req, res) => {
    requests.push({ method: req.method, raw: req.url });
    req.resume();
    req.on("end", () => {
      res.writeHead(200, { "content-type": "application/json" });
      res.end("{}");
    });
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const url = `http://127.0.0.1:${server.address().port}`;
  try {
    const { stdout } = await exec(command, {
      cwd: f.dir,
      encoding: "utf8",
      maxBuffer: 64 << 20,
      env: { ...process.env, RECORD_URL: url, ARG, ARG_NUMBER: String(ARG_NUMBER) },
    });
    const out = JSON.parse(stdout);
    if (!requests.length) throw new Error(`${f.name}: the oracle made no request to ${url}`);
    return { library: out.library, version: out.version, calls: requests.map((r) => ({ method: r.method, path: callPathOf(r.raw), raw: r.raw.split("?")[0] })) };
  } finally {
    server.close();
  }
}

/**
 * Writes dispatch.json from an oracle's sample requests, or compares with it under --check; whether it differs. Each
 * request once by method and path, its route a key of routes.json or null.
 */
function writeDispatch(f, out) {
  const seen = new Map();
  for (const r of out.requests) {
    if (typeof r.method !== "string" || typeof r.path !== "string" || !(r.route === null || typeof r.route === "string")) {
      throw new Error(`a request needs a method, a path and a route or null: ${JSON.stringify(r)}`);
    }
    const key = `${r.method} ${r.path}`;
    const known = seen.get(key);
    if (known && known.route !== r.route) throw new Error(`${key} is dispatched to ${known.route} and to ${r.route}`);
    seen.set(key, { method: r.method, path: r.path, route: r.route });
  }
  const entries = [...seen.values()].sort((a, b) => (a.path === b.path ? a.method.localeCompare(b.method) : a.path.localeCompare(b.path)));
  const file = join(f.dir, "dispatch.json");
  const text = `{\n  "framework": ${JSON.stringify(out.framework)},\n  "version": ${JSON.stringify(out.version)},\n  "requests": [\n${entries.map((r) => `    ${JSON.stringify(r)}`).join(",\n")}\n  ]\n}\n`;
  const committed = existsSync(file) ? readFileSync(file, "utf8") : "";
  if (!check || keep) writeFileSync(file, text);
  if (!check) {
    console.error(`   ${entries.length} sample requests`);
    return false;
  }
  const key = (r) => `${r.method} ${r.path} -> ${r.route}`;
  const before = new Set(committed ? JSON.parse(committed).requests.map(key) : []);
  const now = new Set(entries.map(key));
  const gone = [...before].filter((x) => !now.has(x));
  const added = [...now].filter((x) => !before.has(x));
  if (!gone.length && !added.length) return false;
  console.error(`   ${out.framework} ${out.version} dispatches requests otherwise than dispatch.json records:`);
  for (const x of gone) console.error(`   - ${x}`);
  for (const x of added) console.error(`   + ${x}`);
  return true;
}

let failed = false;
for (const f of names.length ? all.filter((g) => names.includes(g.name)) : all) {
  const k = KINDS[f.kind];
  const spec = specOf(f);
  console.error(`== ${f.name}`);
  execSync(latest ? spec.latest : spec.setup, { cwd: f.dir, stdio: ["ignore", "inherit", "inherit"] });
  const out =
    f.kind === "client"
      ? await recordCalls(f, spec.oracle)
      : JSON.parse(execSync(spec.oracle, { cwd: f.dir, encoding: "utf8", stdio: ["ignore", "pipe", "inherit"], maxBuffer: 64 << 20 }));
  const result = { by: out[k.by], version: out.version, entries: settled(out[k.list]) };
  if (f.kind === "framework" && out.requests !== undefined) {
    failed = writeDispatch(f, out) || failed;
  }
  const file = join(f.dir, k.file);
  // One entry a line, so a change shows as the lines of the entries it moves.
  const lines = result.entries.map((r) => `    ${JSON.stringify(r)}`).join(",\n");
  const text = `{\n  ${JSON.stringify(k.by)}: ${JSON.stringify(result.by)},\n  "version": ${JSON.stringify(result.version)},\n  ${JSON.stringify(k.list)}: [\n${lines}\n  ]\n}\n`;
  const committed = existsSync(file) ? JSON.parse(readFileSync(file, "utf8")) : { [k.list]: [] };
  if (!check || keep) writeFileSync(file, text);
  if (!check) {
    console.error(`   ${result.entries.length} ${k.list}, ${result.by} ${result.version}`);
    continue;
  }
  // The fixture's own spelling counts too: the file records it.
  const key = (r) => `${r.method} ${r.path}${r.raw !== undefined && r.raw !== r.path ? ` (${r.raw})` : ""}`;
  const before = new Set(committed[k.list].map(key));
  const now = new Set(result.entries.map(key));
  const gone = [...before].filter((x) => !now.has(x));
  const added = [...now].filter((x) => !before.has(x));
  if (gone.length || added.length) {
    failed = true;
    console.error(`   ${result.by} ${result.version} ${k.does} ${k.file} (${committed.version}) records:`);
    for (const x of gone) console.error(`   - ${x}`);
    for (const x of added) console.error(`   + ${x}`);
  } else console.error(`   ${result.entries.length} ${k.list} as recorded (${result.by} ${result.version})`);
}
process.exit(failed ? 1 : 0);
