// Asks Astro which routes the application serves. The build is run through Astro's own `build()` with one integration
// added: `astro:routes:resolved` hands it the route table Astro builds and dispatches with (each route's pattern, its
// segments, whether it is a page, an endpoint or a redirect, and whether it is prerendered), and `astro:build:done` the
// files the build wrote for each prerendered route. The built server (@astrojs/node, standalone) is then started and
// each route requested: a route counts under the methods its answer is not a refusal (4xx) for, `*` when it answers
// any method; the answer must come from that route, which the middleware the integration adds tells (`routePattern`),
// or, for a prerendered route, the file the build wrote for it, or, for a redirect, its destination. Files the server
// sends as they are (`public/`, the build's assets under `/_astro`) are listed from the client output and requested
// the same way.
import { spawn } from "node:child_process";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { createServer } from "node:net";
import { join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "astro";

const dir = fileURLToPath(new URL(".", import.meta.url));
let table;
let done;
const oracle = {
  name: "oracle",
  hooks: {
    "astro:config:setup": ({ addMiddleware }) => addMiddleware({ entrypoint: new URL("./oracle-middleware.mjs", import.meta.url), order: "post" }),
    "astro:routes:resolved": ({ routes }) => {
      table = routes;
    },
    "astro:build:done": ({ dir, assets }) => {
      done = { dir, assets };
    },
  },
};
// Astro's logger writes to stdout, which carries the routes: keep the build to warnings, on stderr where it can.
const log = console.log;
console.log = (...args) => console.error(...args);
await build({ root: dir, logLevel: "warn", integrations: [oracle] });
console.log = log;
if (!table || !done) throw new Error("the build reported no routes");
const clientDir = fileURLToPath(done.dir);

const MUTATIONS = ["POST", "PUT", "PATCH", "DELETE"];
const PROBED = ["GET", ...MUTATIONS];
// A method no route of the application names: answered only by a route that takes any method.
const OTHER = "PURGE";

/**
 * A pattern's paths in the canonical form, each with a URL that stands for it and the params that URL gives: a dynamic
 * part is a parameter, a segment that is a rest parameter alone (`[...x]`) the rest of the path.
 */
function expand(route) {
  let path = "";
  let sample = "";
  const params = {};
  let n = 0;
  for (const segment of route.segments) {
    if (segment.length === 1 && segment[0].spread) {
      path += "/{**}";
      sample += "/rest/of/it";
      params[segment[0].content.slice(3)] = "rest/of/it";
      continue;
    }
    if (segment.some((part) => part.spread)) throw new Error(`${route.pattern}: a rest parameter beside other parts of a segment`);
    path += `/${segment.map((part) => (part.dynamic ? "{}" : part.content)).join("")}`;
    sample += `/${segment
      .map((part) => {
        if (!part.dynamic) return part.content;
        params[part.content] = `value${++n}`;
        return params[part.content];
      })
      .join("")}`;
  }
  return { path: path || "/", sample: sample || "/", params };
}

const port = await new Promise((resolve) => {
  const probe = createServer().listen(0, "127.0.0.1", () => {
    const { port } = probe.address();
    probe.close(() => resolve(port));
  });
});
const server = spawn(process.execPath, [join(dir, "dist", "server", "entry.mjs")], {
  cwd: dir,
  env: { ...process.env, NODE_ENV: "production", HOST: "127.0.0.1", PORT: String(port) },
  stdio: ["ignore", "ignore", "pipe"],
});
// The server warns of each method an endpoint does not take; shown only when the oracle fails.
let serverLog = "";
server.stderr.on("data", (chunk) => (serverLog += chunk));
const base = `http://127.0.0.1:${port}`;

async function request(method, path) {
  const response = await fetch(base + path, { method, redirect: "manual", body: method === "GET" ? undefined : "{}" });
  const body = Buffer.from(await response.arrayBuffer());
  return { status: response.status, route: response.headers.get("x-oracle-route"), location: response.headers.get("location"), body };
}

/** The methods a path is answered for, each answer checked by `from`; `*` when a method no route names is answered too. */
async function answered(path, from) {
  const methods = [];
  for (const method of [...PROBED, OTHER]) {
    const response = await request(method, path);
    if (response.status >= 400) continue;
    const wrong = from(response);
    if (wrong) throw new Error(`${method} ${path}: ${wrong}`);
    methods.push(method);
  }
  if (methods.length === PROBED.length + 1) return ["*"];
  if (methods.includes(OTHER)) throw new Error(`${path} answers ${OTHER} but not all of ${PROBED.join(", ")}`);
  return methods;
}

const files = (root) => readdirSync(root).flatMap((name) => (statSync(join(root, name)).isDirectory() ? files(join(root, name)) : [join(root, name)]));
const urlOf = (file) => `/${relative(clientDir, file).split(sep).map(encodeURIComponent).join("/")}`;

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

  const written = new Set();
  for (const route of table) {
    const raw = route.pattern;
    if (route.type === "redirect") {
      // A configured redirect answers every request at its path with its destination, its parameters filled in.
      const { path, sample, params } = expand(route);
      const destination = (p) => (route.redirectRoute ? route.redirectRoute.generate(p) : typeof route.redirect === "string" ? route.redirect : route.redirect.destination);
      const at = [{ path, sample, params }];
      if (path.endsWith("/{**}")) at.push({ path: path.slice(0, -"/{**}".length) || "/", sample: sample.slice(0, -"/rest/of/it".length) || "/", params: {} });
      for (const p of at) {
        const methods = await answered(p.sample, (r) => (r.location === destination(p.params) ? undefined : `redirects to ${r.location}, not ${destination(p.params)}`));
        for (const method of methods) out.push({ method, path: p.path, raw });
      }
      continue;
    }
    if (route.isPrerendered) {
      // A prerendered route is the files the build wrote for it, sent as they are.
      for (const url of done.assets.get(raw) ?? []) {
        const file = fileURLToPath(url);
        written.add(file);
        const content = readFileSync(file);
        const path = urlOf(file).replace(/\/index\.html$/, "").replace(/\.html$/, "") || "/";
        const methods = await answered(path, (r) => (r.body.equals(content) ? undefined : `is not the file ${relative(dir, file)} the build wrote for ${raw}`));
        if (!methods.length) throw new Error(`${path}, written for ${raw}, is not served`);
        for (const method of methods) out.push({ method, path, raw });
      }
      continue;
    }
    // Astro's custom 404 page is what it answers, with a 404, where no route matches; no island is deferred
    // (`server:defer`), so the server islands' route has no island to answer for.
    if (raw === "/404" || raw === "/_server-islands/[name]") continue;
    const { path, sample } = expand(route);
    const reached = (r) => (r.route === raw ? undefined : `answered by ${r.route}, not ${raw}`);
    // The image endpoint answers a request that names an image (Images, `getImage()`).
    const query = raw === "/_image" ? `?href=${encodeURIComponent("/favicon.svg")}&w=16&h=16&f=svg` : "";
    const methods = await answered(sample + query, reached);
    if (!methods.length) throw new Error(`${sample} (${raw}) is not served`);
    for (const method of methods) out.push({ method, path, raw });
    // A rest parameter also takes the path with nothing after its last `/`: written as the parent and the parent `/{**}`.
    if (path.endsWith("/{**}")) {
      const parent = sample.slice(0, -"/rest/of/it".length) || "/";
      const parentMethods = await answered(parent, reached);
      const slashed = await answered(`${parent}/`, reached);
      if (parentMethods.join() !== methods.join() || slashed.join() !== methods.join()) {
        throw new Error(`${parent} answers ${parentMethods.join(", ")} and ${parent}/ ${slashed.join(", ")}; ${sample} ${methods.join(", ")}`);
      }
      for (const method of methods) out.push({ method, path: path.slice(0, -"/{**}".length) || "/", raw });
    }
  }

  // The client output beside the routes' files: `public/` copied to its root, the build's assets under /_astro.
  let assetMethods;
  for (const file of files(clientDir).filter((f) => !written.has(f))) {
    const path = urlOf(file);
    const content = readFileSync(file);
    const methods = await answered(path, (r) => (r.body.equals(content) ? undefined : `is not the file ${relative(dir, file)}`));
    if (!methods.length) throw new Error(`client output ${path} is not served`);
    if (path.startsWith("/_astro/")) {
      if (assetMethods !== undefined && methods.join() !== assetMethods.join()) throw new Error(`asset ${path} answers ${methods.join()}, others ${assetMethods.join()}`);
      assetMethods = methods;
    } else {
      const raw = existsSync(join(dir, "public", relative(clientDir, file))) ? `public${path}` : `dist/client${path}`;
      for (const method of methods) out.push({ method, path, raw });
    }
  }
  for (const method of assetMethods ?? []) out.push({ method, path: "/_astro/{**}", raw: "dist/client/_astro/*" });
} catch (error) {
  process.stderr.write(serverLog);
  throw error;
} finally {
  server.kill();
}

const version = JSON.parse(readFileSync(join(dir, "node_modules", "astro", "package.json"), "utf8")).version;
console.log(JSON.stringify({ framework: "astro", version, routes: out }));
