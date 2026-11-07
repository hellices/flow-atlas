import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";
import { loadConfig } from "../src/config.js";
import { scan } from "../src/scan.js";
import { WorktreeSource } from "../src/source.js";

/**
 * Each directory under fixtures/frameworks is an application on a framework's own library, with the routes that
 * framework reports it serves (`routes.json`, written by `scripts/frameworks.mjs`). atlas reads the application as its
 * `atlas.config.yaml` says; every route the framework serves must be a surface and every surface a route, except the
 * differences `gaps.yaml` lists. A listed difference that no longer occurs fails as well, so the list only shrinks.
 */
interface Routes {
  framework: string;
  version: string;
  routes: Array<{ method: string; path: string; raw?: string }>;
}

interface Gaps {
  /** atlas does not read the framework: every route is missing, with this reason. */
  unread?: string;
  /** Routes the framework serves that atlas does not read. */
  missing?: Array<{ route: string; reason: string }>;
  /** Surfaces atlas reads that the framework does not serve. */
  extra?: Array<{ route: string; reason: string }>;
}

const root = fileURLToPath(new URL("../fixtures/frameworks", import.meta.url));
const fixtures = existsSync(root)
  ? readdirSync(root, { withFileTypes: true })
      .filter((d) => d.isDirectory() && existsSync(join(root, d.name, "routes.json")))
      .map((d) => d.name)
  : [];

/**
 * The paths a surface's path stands for in the form `routes.json` is written in: a parameter is `{}` wherever it stands
 * in a segment (a lone `*` too), and `{**}` is one segment or more. atlas writes a final segment that takes none or more (`**`, Spring's
 * `{*rest}`, Starlette's `{name:path}`) as one path, which is two here: the path before it, and that path with `{**}`.
 */
function canonicalPaths(path: string): string[] {
  const segments = path.split("/").map((seg) => {
    if (seg === "**" || /^\{\*[^{}]*\}$/.test(seg) || /^\{[^{}:]+:path\}$/.test(seg)) return "{**}";
    // A lone `*` is a segment parameter where atlas reads one (Hono's `/wild/*/card`).
    return seg === "*" ? "{}" : seg.replace(/\{[^{}]*\}/g, "{}");
  });
  while (segments.length > 1 && segments[segments.length - 1] === "") segments.pop();
  const head = (list: string[]) => (list.join("/").startsWith("/") ? list.join("/") || "/" : `/${list.join("/")}`);
  if (segments[segments.length - 1] !== "{**}") return [head(segments)];
  return [head(segments.slice(0, -1)), head(segments)];
}

/**
 * `METHOD path` keys, leaving out the HEAD a framework answers beside a GET and the OPTIONS beside any other method. A
 * parameter segment beside the same path with `{**}` after it is one segment or more: `{**}`.
 */
function routeKeys(routes: Array<{ method: string; path: string }>, paths: (path: string) => string[]): string[] {
  const byPath = new Map<string, Set<string>>();
  for (const r of routes) {
    for (const path of paths(r.path)) (byPath.get(path) ?? byPath.set(path, new Set()).get(path)!).add(r.method.toUpperCase());
  }
  for (const [path, methods] of [...byPath]) {
    if (!path.endsWith("/{}")) continue;
    const rest = byPath.get(`${path}/{**}`);
    for (const m of methods) {
      if (!rest?.has(m)) continue;
      const parent = path.slice(0, -"{}".length) + "{**}";
      (byPath.get(parent) ?? byPath.set(parent, new Set()).get(parent)!).add(m);
      methods.delete(m);
      rest.delete(m);
    }
  }
  const keys: string[] = [];
  for (const [path, methods] of byPath) {
    for (const m of methods) {
      if (m === "HEAD" && methods.has("GET")) continue;
      if (m === "OPTIONS" && methods.size > 1) continue;
      keys.push(`${m} ${path}`);
    }
  }
  return [...new Set(keys)].sort();
}

describe("routes as each framework serves them", () => {
  const board: string[] = [];
  for (const name of fixtures) {
    it(name, () => {
      const dir = join(root, name);
      const served = JSON.parse(readFileSync(join(dir, "routes.json"), "utf8")) as Routes;
      const gaps = (existsSync(join(dir, "gaps.yaml")) ? parse(readFileSync(join(dir, "gaps.yaml"), "utf8")) : {}) as Gaps;
      const config = loadConfig(join(dir, "atlas.config.yaml"));
      const graph = scan(new WorktreeSource(dir), config, { root: dir, requested: "WORKTREE" });
      const oracle = routeKeys(served.routes, (path) => [path]);
      const read = routeKeys(graph.surfaces, canonicalPaths);
      const missing = oracle.filter((k) => !read.includes(k));
      const extra = read.filter((k) => !oracle.includes(k));
      board.push(`${name} (${served.framework} ${served.version}): ${oracle.length - missing.length}/${oracle.length} routes read, ${extra.length} extra`);
      const listedMissing = gaps.unread !== undefined ? oracle : (gaps.missing ?? []).map((g) => g.route).sort();
      const listedExtra = (gaps.extra ?? []).map((g) => g.route).sort();
      expect({ missing, extra }).toEqual({ missing: listedMissing, extra: listedExtra });
    });
  }
  it("lock files name no registry but the public ones", () => {
    // A lock written through a registry mirror would send installs elsewhere to its hosts; each machine uses its own.
    const hosts = new Set<string>();
    for (const name of fixtures) {
      const lock = join(root, name, "package-lock.json");
      if (existsSync(lock)) for (const m of readFileSync(lock, "utf8").matchAll(/"resolved": "https?:\/\/([^/"]+)/g)) hosts.add(m[1]!);
      const requirements = join(root, name, "requirements.txt");
      if (existsSync(requirements)) for (const m of readFileSync(requirements, "utf8").matchAll(/https?:\/\/([^/\s]+)/g)) hosts.add(m[1]!);
    }
    expect([...hosts].filter((h) => h !== "registry.npmjs.org")).toEqual([]);
  });
  it.runIf(fixtures.length > 0)("prints the board", () => {
    console.log(["routes read per framework:", ...board.map((b) => `  ${b}`)].join("\n"));
  });
});
