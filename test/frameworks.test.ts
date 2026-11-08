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

/** The hosts of public package registries and the code hosts lock files point at. */
const PUBLIC_HOSTS = new Set([
  "registry.npmjs.org",
  "registry.yarnpkg.com",
  "jsr.io",
  "deno.land",
  "pypi.org",
  "files.pythonhosted.org",
  "index.crates.io",
  "static.crates.io",
  "crates.io",
  "rubygems.org",
  "repo.packagist.org",
  "packagist.org",
  "hex.pm",
  "repo.hex.pm",
  "pub.dev",
  "pub.dartlang.org",
  "proxy.golang.org",
  "repo.maven.apache.org",
  "repo1.maven.org",
  "plugins.gradle.org",
  "api.nuget.org",
  "github.com",
  "api.github.com",
  "codeload.github.com",
]);

/** Directories a fixture's install or build writes, not committed. */
const INSTALLED = new Set(["node_modules", ".venv", "target", "bin", "obj", ".next", "vendor", "deps", "_build", ".build", ".dart_tool", "__pycache__", "dist"]);

/** Lock files and registry settings under a fixture. */
function lockFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) {
      if (!INSTALLED.has(entry.name)) out.push(...lockFiles(path));
    } else if (/(^|[.-])lock(\.json|\.yaml)?$|^requirements.*\.txt$|^Package\.resolved$|^\.npmrc$|^\.yarnrc(\.yml)?$|^bunfig\.toml$|^nuget\.config$|^pip\.conf$|^uv\.toml$|^config\.toml$/i.test(entry.name)) {
      out.push(path);
    }
  }
  return out;
}

/**
 * The host a fetch URL names: a URL's (`https://`, `ssh://`, `git://`, `git+ssh://`, ...) or an scp-like one's
 * (`git@host:org/repo.git`). A URL it cannot read is returned whole, which is no public host, so the check fails on it
 * rather than passing it over.
 */
function fetchHost(url: string): string {
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(url)) {
    try {
      const host = new URL(url).hostname.toLowerCase();
      if (host) return host;
    } catch {
      return url;
    }
  }
  const scp = /^(?:[^@/\s]+@)?([^:/\s]+):(?!\/)/.exec(url);
  return scp ? scp[1]!.toLowerCase() : url;
}

/** The hosts a composer.lock fetches its packages from: each package's `dist` and `source` URL. */
function composerHosts(text: string): string[] {
  const lock = JSON.parse(text) as Record<string, Array<{ dist?: { url?: string }; source?: { url?: string } }> | undefined>;
  return [...(lock.packages ?? []), ...(lock["packages-dev"] ?? [])]
    .flatMap((p) => [p.dist?.url, p.source?.url])
    .flatMap((url) => (url ? [fetchHost(url)] : []));
}

/** The hosts a lock file installs from: where each package is fetched, not the projects' home pages. */
function lockHosts(file: string): string[] {
  const text = readFileSync(file, "utf8");
  if (file.endsWith("composer.lock")) return composerHosts(text);
  const pattern = file.endsWith("package-lock.json") ? /"resolved":\s*"https?:\/\/([^/":]+)/g : /https?:\/\/([^/"'\s\]:,)]+)/g;
  // A comment a tool writes at the top of its lock (pub's links to its docs) installs nothing.
  const installs = text.replace(/^\s*#.*$/gm, "");
  return [...installs.matchAll(pattern)].map((m) => m[1]!.toLowerCase());
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
    // A lock written through a registry mirror would send everyone's installs to its hosts. Only the file is named, so a
    // host that must stay private does not reach a public log either.
    // Every fixture, recorded or not yet: a lock is pushed before CI hands back the routes it reports.
    const all = readdirSync(root, { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => d.name);
    const named = all.flatMap((name) => lockFiles(join(root, name)).filter((file) => !lockHosts(file).every((h) => PUBLIC_HOSTS.has(h))));
    expect(named.map((file) => file.slice(root.length + 1))).toEqual([]);
  });
  it("reads the host of each URL a composer.lock fetches from", () => {
    const lock = (...urls: string[]) => JSON.stringify({ packages: urls.map((url) => ({ source: { url } })), "packages-dev": [] });
    expect(composerHosts(lock("https://api.github.com/repos/a/b/zipball/1", "git@gitlab.example.com:org/repo.git"))).toEqual([
      "api.github.com",
      "gitlab.example.com",
    ]);
    expect(composerHosts(lock("ssh://git@gitlab.example.com/org/repo.git", "git://gitlab.example.com/org/repo.git"))).toEqual([
      "gitlab.example.com",
      "gitlab.example.com",
    ]);
    // Read or not, a URL that names no public host fails the check.
    expect(composerHosts(lock("../packages/local")).every((h) => PUBLIC_HOSTS.has(h))).toBe(false);
  });
  it.runIf(fixtures.length > 0)("prints the board", () => {
    console.log(["routes read per framework:", ...board.map((b) => `  ${b}`)].join("\n"));
  });
});
