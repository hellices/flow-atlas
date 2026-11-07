// Asks SvelteKit which routes the application serves. `vite build` with adapter-node writes the server's manifest
// (build/server/manifest.js): the routes in the order the server tries them, each with the pattern and parameters
// (matchers included) it is matched by, its page nodes and its `+server` endpoint. The server dispatches a request to
// the first route `find_route` (SvelteKit's own, from @sveltejs/kit/src/utils/routing.js) finds for its path, so each
// route's paths are checked with that function on that manifest. A route's methods are those its `+server` module
// exports (`fallback` takes every one), and for a page GET, with POST where its `+page.server` exports form actions.
// The built server (`node build`) is then started and each route requested: it must answer exactly those methods,
// neither refusing the others (405) nor finding nothing (404) for them. Files of `static/` and the build's assets,
// which adapter-node serves before SvelteKit, are listed from build/client and requested the same way, and so is
// `/_app/env.js`, which SvelteKit serves by itself. The `__data.json` and `__route.js` suffixes the client router
// requests a page's data and route with are left out: the page's own route, not one of the app's.
import { spawn, spawnSync } from "node:child_process";
import { existsSync, readdirSync, statSync } from "node:fs";
import { createRequire } from "node:module";
import { createServer } from "node:net";
import { join, relative, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const dir = fileURLToPath(new URL(".", import.meta.url));
const require = createRequire(import.meta.url);
const kit = join(dir, "node_modules", "@sveltejs", "kit");
const vite = join(dir, "node_modules", "vite", "bin", "vite.js");

const build = spawnSync(process.execPath, [vite, "build"], { cwd: dir, stdio: ["ignore", process.stderr, "inherit"] });
if (build.status !== 0) throw new Error(`vite build failed with ${build.status}`);

const out = join(dir, "build");
const { manifest } = await import(pathToFileURL(join(out, "server", "manifest.js")).href);
const { find_route, get_route_segments } = await import(pathToFileURL(join(kit, "src", "utils", "routing.js")).href);
const routes = manifest.routes ?? manifest._.routes;
const nodes = manifest.nodes ?? manifest._.nodes;
const matchers = await (manifest.matchers ?? manifest._.matchers)();
const dispatched = (path) => find_route(path, routes, matchers)?.route.id;

// A value each of the app's matchers (src/params.js) takes, for the requests.
const SAMPLES = { integer: "1", locale: "en" };
const PROBED = ["GET", "POST", "PUT", "PATCH", "DELETE"];
const ENDPOINT_METHODS = ["GET", "HEAD", "POST", "PUT", "PATCH", "DELETE", "OPTIONS", "QUERY"];

/**
 * A route's paths, from its id: groups `(name)` are left out, `[name]` is a parameter, `[[name]]` an optional segment,
 * `[...name]` the rest of the path, none or more segments; `=matcher` after a name restricts it.
 */
function expand(id) {
  let paths = [{ path: "", sample: "" }];
  const segments = get_route_segments(id);
  segments.forEach((seg, i) => {
    const sample = (name, matcher) => (matcher ? SAMPLES[matcher] : "value1") ?? (() => { throw new Error(`${id}: no sample for the matcher ${matcher}`); })();
    const rest = /^\[\.\.\.([\w-]+)(?:=([\w-]+))?\]$/.exec(seg);
    const optional = /^\[\[([\w-]+)(?:=([\w-]+))?\]\]$/.exec(seg);
    if (rest) {
      if (i !== segments.length - 1) throw new Error(`${id}: a rest parameter before the last segment is not handled`);
      paths = paths.flatMap((p) => [p, { path: `${p.path}/{**}`, sample: `${p.sample}/${rest[2] ? sample(rest[1], rest[2]) : "rest/of/it"}` }]);
    } else if (optional) {
      paths = paths.flatMap((p) => [p, { path: `${p.path}/{}`, sample: `${p.sample}/${sample(optional[1], optional[2])}` }]);
    } else {
      if (/\[\.\.\.|\[\[/.test(seg)) throw new Error(`${id}: a segment ${seg} is not handled`);
      const literal = (s) => s.replace(/\[([ux])\+([0-9a-f]+)\]/gi, (_, kind, code) => (kind === "x" ? String.fromCharCode(parseInt(code, 16)) : String.fromCodePoint(parseInt(code, 16))));
      const PARAM = /^\[([\w-]+)(?:=([\w-]+))?\]$/;
      const parts = literal(seg).split(/(\[[\w-]+(?:=[\w-]+)?\])/);
      const path = parts.map((part) => (PARAM.test(part) ? "{}" : part)).join("");
      const value = parts.map((part) => (PARAM.test(part) ? sample(...PARAM.exec(part).slice(1)) : encodeURIComponent(part))).join("");
      paths = paths.map((p) => ({ path: `${p.path}/${path}`, sample: `${p.sample}/${value}` }));
    }
  });
  return paths.map((p) => ({ path: p.path || "/", sample: p.sample || "/" }));
}

/**
 * The methods a route serves: its endpoint's exports, `*` for a `fallback`; GET for a page, and POST with actions;
 * with the query a form posts to an action by.
 */
async function methodsOf(route) {
  const methods = new Set();
  let action = "";
  if (route.endpoint) {
    const endpoint = await route.endpoint();
    if (typeof endpoint.fallback === "function") return { methods: ["*"], action };
    for (const m of ENDPOINT_METHODS) if (typeof endpoint[m] === "function") methods.add(m);
  }
  if (route.page) {
    methods.add("GET");
    const leaf = await nodes[route.page.leaf]();
    if (leaf.server?.actions) methods.add("POST");
    const names = Object.keys(leaf.server?.actions ?? {});
    if (names.length && !names.includes("default")) action = `?/${names[0]}`;
  }
  return { methods: [...methods].filter((m) => m !== "HEAD" && m !== "OPTIONS"), action };
}

const port = await new Promise((resolve) => {
  const probe = createServer().listen(0, "127.0.0.1", () => {
    const { port } = probe.address();
    probe.close(() => resolve(port));
  });
});
const server = spawn(process.execPath, [out], { cwd: dir, env: { ...process.env, PORT: String(port), HOST: "127.0.0.1" }, stdio: ["ignore", "ignore", "inherit"] });
const base = `http://127.0.0.1:${port}`;

/**
 * A request as a browser sends it: a page's HTML asked for, a form posted from the app's own origin (adapter-node
 * takes a request's protocol for https unless a header says otherwise, and SvelteKit refuses a form from elsewhere).
 */
async function request(method, path, page = false) {
  const response = await fetch(base + path, {
    method,
    redirect: "manual",
    headers: { accept: page ? "text/html" : "*/*", origin: `https://127.0.0.1:${port}`, ...(method === "GET" || method === "HEAD" ? {} : { "content-type": "application/x-www-form-urlencoded" }) },
    body: method === "GET" || method === "HEAD" ? undefined : "value=1",
  });
  await response.arrayBuffer();
  return response.status;
}

/**
 * The methods the server answers at a path: those it neither refuses (405) nor finds nothing at (404); `*` for every
 * one. A page's form is posted to its action: `?/name` where it names its actions.
 */
async function answered(path, page = false, action = "") {
  const served = [];
  for (const method of PROBED) {
    const status = await request(method, method === "POST" ? path + action : path, page && (method === "GET" || method === "POST"));
    if (![404, 405].includes(status)) served.push(method);
  }
  return served.length === PROBED.length ? ["*"] : served;
}

const found = [];
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
  if ((await request("GET", "/no/such/page", true)) !== 404) throw new Error("a path no route takes is answered");

  for (const route of routes) {
    const { methods, action } = await methodsOf(route);
    const paths = expand(route.id);
    for (const { path, sample } of paths) {
      if (dispatched(sample) !== route.id) throw new Error(`${sample} is dispatched to ${dispatched(sample)}, not to ${route.id} that it stands for`);
      const served = await answered(sample, !!route.page, action);
      if (served.join(",") !== [...methods].sort((a, b) => PROBED.indexOf(a) - PROBED.indexOf(b)).join(",")) {
        throw new Error(`${sample} (${route.id}) serves ${methods.join(", ")} and answers ${served.join(", ")}`);
      }
      for (const method of methods) found.push({ method, path, raw: route.id });
    }
    // `{**}` is one segment or more: where the route does not also stand for the path before it, that path must not
    // reach it.
    for (const { path, sample } of paths.filter((p) => p.path.endsWith("/{**}"))) {
      const parentPath = path.slice(0, -"/{**}".length) || "/";
      if (paths.some((p) => p.path === parentPath)) continue;
      const parent = sample.slice(0, sample.lastIndexOf("/")) || "/";
      if (dispatched(parent) === route.id) throw new Error(`${parent} reaches ${route.id}, which takes one segment or more`);
    }
  }

  // static/ and the build's assets: the files of build/client, as adapter-node serves them (a precompressed `.gz` or
  // `.br` beside a file is that file's encoding, not a path of its own).
  const client = join(out, "client");
  const files = (root) => readdirSync(root).flatMap((name) => (statSync(join(root, name)).isDirectory() ? files(join(root, name)) : [join(root, name)]));
  const appDir = manifest.app_path ?? manifest.appPath ?? "_app";
  let assetMethods;
  for (const file of existsSync(client) ? files(client) : []) {
    if (/\.(gz|br)$/.test(file) && existsSync(file.replace(/\.(gz|br)$/, ""))) continue;
    const path = `/${relative(client, file).split(sep).map(encodeURIComponent).join("/")}`;
    const methods = await answered(path);
    if (!methods.length) throw new Error(`${path} is not served`);
    if (path.startsWith(`/${appDir}/immutable/`)) {
      if (assetMethods !== undefined && methods.join(",") !== assetMethods) throw new Error(`build asset ${path} answers ${methods}, others ${assetMethods}`);
      assetMethods = methods.join(",");
    } else for (const method of methods) found.push({ method, path, raw: relative(out, file).split(sep).join("/") });
  }
  for (const method of assetMethods ? assetMethods.split(",") : []) found.push({ method, path: `/${appDir}/immutable/{**}`, raw: `/${appDir}/immutable/*` });

  // The public environment module SvelteKit serves itself at /_app/env.js.
  for (const method of await answered(`/${appDir}/env.js`)) found.push({ method, path: `/${appDir}/env.js` });
} finally {
  server.kill();
}

const version = require("@sveltejs/kit/package.json").version;
console.log(JSON.stringify({ framework: "@sveltejs/kit", version, routes: found }));
