// Asks React Router (framework mode) which routes the application serves. `react-router build` writes the server build
// `react-router-serve` runs: its `routes` export is the route manifest the request handler dispatches with, each route
// with its parent, its path or index flag and its compiled module (whose `default`, `loader` and `action` exports make it
// a page or a resource route). Each route's full pattern, optional segments spelled out, is matched with React Router's
// own `matchRoutes` against that manifest, and requested from `react-router-serve`: a path counts under the methods the
// request handler answers, not those it refuses (400 for a resource route without the loader or action, 405 for a page
// without an action) or finds nothing at (404), and the answer must agree with what the module exports (React Router,
// Resource Routes: GET goes to the `loader`, POST, PUT, PATCH and DELETE to the `action`). Files `react-router-serve`
// serves from the client build (`public/` copied there, the hashed `assets/`) and the route discovery endpoint
// (`/__manifest`) are listed and requested the same way. The single-fetch requests (`<path>.data`) a page answers for
// its own loaders and actions are the same routes by another spelling, and are not listed.
import { spawn, spawnSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { createServer } from "node:net";
import { join, relative, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { matchRoutes } from "react-router";

const dir = fileURLToPath(new URL(".", import.meta.url));
const env = { ...process.env, NODE_ENV: "production" };
const bin = (pkg, file) => join(dir, "node_modules", pkg, file);

const build = spawnSync(process.execPath, [bin("@react-router/dev", "bin.cjs"), "build"], { cwd: dir, env, stdio: ["ignore", process.stderr, "inherit"] });
if (build.status !== 0) throw new Error(`react-router build failed with ${build.status}`);

const serverBuild = await import(pathToFileURL(join(dir, "build", "server", "index.js")).href);
const manifest = serverBuild.routes;
const clientDir = join(dir, serverBuild.assetsBuildDirectory);

// The manifest as the tree `matchRoutes` takes, children under their parent.
const nodes = new Map(Object.values(manifest).map((r) => [r.id, { id: r.id, path: r.path, index: r.index, caseSensitive: r.caseSensitive, children: [] }]));
const tree = [];
for (const r of Object.values(manifest)) (r.parentId ? nodes.get(r.parentId).children : tree).push(nodes.get(r.id));

/** A route's full pattern: its ancestors' paths and its own, joined. */
function pattern(id) {
  const parts = [];
  for (let r = manifest[id]; r; r = r.parentId ? manifest[r.parentId] : undefined) if (r.path) parts.unshift(r.path);
  return `/${parts.join("/")}`.replace(/\/+/g, "/");
}

/**
 * A pattern's paths in the canonical form, each with a URL that stands for it: `:x` is a parameter, a segment ending in
 * `?` may be left out (Routing, Optional Segments), and a final `*` is the rest of the path (Routing, Splats).
 */
function expand(path) {
  let out = [{ path: "", sample: "" }];
  for (const seg of path.split("/").filter(Boolean)) {
    const optional = seg.endsWith("?");
    const name = optional ? seg.slice(0, -1) : seg;
    let next;
    if (name === "*") next = (p) => ({ path: `${p.path}/{**}`, sample: `${p.sample}/rest/of/it` });
    else if (name.startsWith(":")) next = (p) => ({ path: `${p.path}/{}`, sample: `${p.sample}/value1` });
    else next = (p) => ({ path: `${p.path}/${name}`, sample: `${p.sample}/${name}` });
    out = optional ? out.flatMap((p) => [p, next(p)]) : out.map(next);
  }
  return out.map((p) => ({ path: p.path || "/", sample: p.sample || "/" }));
}

/** The route `matchRoutes` gives a URL to: the deepest of its matches. */
const dispatched = (url) => matchRoutes(tree, url)?.at(-1)?.route.id;

const MUTATIONS = ["POST", "PUT", "PATCH", "DELETE"];
const PROBED = ["GET", ...MUTATIONS];

const port = await new Promise((resolve) => {
  const probe = createServer().listen(0, "127.0.0.1", () => {
    const { port } = probe.address();
    probe.close(() => resolve(port));
  });
});
const server = spawn(process.execPath, [bin("@react-router/serve", "bin.cjs"), "./build/server/index.js"], {
  cwd: dir,
  env: { ...env, PORT: String(port), HOST: "127.0.0.1" },
  stdio: ["ignore", "ignore", "pipe"],
});
// The server logs each request it refuses; shown only when the oracle fails.
let log = "";
server.stderr.on("data", (chunk) => (log += chunk));
const base = `http://127.0.0.1:${port}`;

async function request(method, path) {
  const response = await fetch(base + path, { method, redirect: "manual", body: method === "GET" ? undefined : "{}" });
  await response.arrayBuffer();
  return response.status;
}

/** The methods answered at a path; a status but an answer, a refusal (400, 405) or nothing there (404) fails. */
async function answered(path) {
  const methods = [];
  for (const method of PROBED) {
    const status = await request(method, path);
    if (status < 400) methods.push(method);
    else if (![400, 404, 405].includes(status)) throw new Error(`${method} ${path} answers ${status}`);
  }
  return methods;
}

const files = (root) => readdirSync(root).flatMap((name) => (statSync(join(root, name)).isDirectory() ? files(join(root, name)) : [join(root, name)]));

const out = [];
try {
  for (let i = 0; ; i++) {
    try {
      await request("GET", "/");
      break;
    } catch (error) {
      if (i > 300) throw error;
      await new Promise((r) => setTimeout(r, 100));
    }
  }

  // Each path of every route that matches by itself (one with a path or an index route), once, from the route it reaches.
  const paths = new Map();
  for (const r of Object.values(manifest)) {
    if (r.path === undefined && !r.index) continue;
    for (const p of expand(pattern(r.id))) if (!paths.has(p.path)) paths.set(p.path, p.sample);
  }
  for (const [path, sample] of [...paths].sort()) {
    const id = dispatched(sample);
    if (!id) throw new Error(`${sample} matches no route`);
    const raw = pattern(id);
    if (!expand(raw).some((p) => p.path === path)) throw new Error(`${sample} (${path}) reaches ${id} at ${raw}`);
    const route = manifest[id];
    const exported = route.module;
    // A submission to an index route without `?index` goes to its parent's action (Route Module, action; Form, index).
    const target = route.index ? manifest[route.parentId] : route;
    const page = typeof exported.default === "function";
    const expected = [...(page || exported.loader ? ["GET"] : []), ...(target.module.action ? MUTATIONS : [])];
    const urls = [sample];
    // A splat also takes the path with nothing after its last `/`: written as the parent and the parent `/{**}`.
    if (path.endsWith("/{**}")) {
      const parent = sample.slice(0, -"/rest/of/it".length) || "/";
      const parentPath = path.slice(0, -"/{**}".length) || "/";
      if (dispatched(parent) === id && dispatched(`${parent}/`) === id && !paths.has(parentPath)) urls.push(parent, `${parent}/`);
      else if (dispatched(parent) === id) throw new Error(`${parent} reaches ${id} but ${parentPath} is another route's`);
    }
    for (const url of urls) {
      const methods = await answered(url);
      if (methods.join() !== expected.join()) throw new Error(`${url} (${id}) answers ${methods.join(", ")}; its module gives ${expected.join(", ")}`);
      const at = url === sample ? path : path.slice(0, -"/{**}".length) || "/";
      for (const method of methods) out.push({ method, path: at, raw });
    }
  }

  // The route discovery endpoint the browser asks for the routes of a link (Lazy Route Discovery).
  const { mode, manifestPath } = serverBuild.routeDiscovery;
  if (mode === "lazy") {
    const methods = await answered(`${manifestPath}?paths=${encodeURIComponent("/about")}&version=${serverBuild.assets.version}`);
    for (const method of methods.length === PROBED.length ? ["*"] : methods) out.push({ method, path: manifestPath, raw: "routeDiscovery.manifestPath" });
  }

  // The client build: `public/` copied to its root, each file at its path; the hashed assets under /assets.
  let assetMethods;
  for (const file of files(clientDir)) {
    const path = `/${relative(clientDir, file).split(sep).map(encodeURIComponent).join("/")}`;
    const methods = await answered(path);
    if (!methods.length) throw new Error(`client build file ${path} is not served`);
    if (path.startsWith("/assets/")) {
      if (assetMethods !== undefined && methods.join() !== assetMethods.join()) throw new Error(`asset ${path} answers ${methods.join()}, others ${assetMethods.join()}`);
      assetMethods = methods;
    } else {
      const raw = existsSync(join(dir, "public", relative(clientDir, file))) ? `public${path}` : `build/client${path}`;
      for (const method of methods) out.push({ method, path, raw });
    }
  }
  for (const method of assetMethods ?? []) out.push({ method, path: "/assets/{**}", raw: "build/client/assets/*" });
} catch (error) {
  process.stderr.write(log);
  throw error;
} finally {
  server.kill();
}

const version = JSON.parse(readFileSync(join(dir, "node_modules", "react-router", "package.json"), "utf8")).version;
console.log(JSON.stringify({ framework: "react-router", version, routes: out }));
