// Asks Next.js which routes the application serves. `next build` writes the table its server dispatches with
// (.next/routes-manifest.json: the static and dynamic routes of both routers, each with the regex Next matches a request
// against); app-path-routes-manifest and pages-manifest tell which file each route is, and a route handler's compiled
// module which methods it exports. `next start` then serves the build, and each route is requested where the
// manifest's own regexes give the request to that route: it counts under the methods Next answers, neither refusing
// them (405) nor finding nothing (404). Files of `public/`, the build's assets and the image optimizer, which Next serves without a route of the
// app's, are listed from the directory and the manifests that name them, and requested the same way. Sample requests
// are then sent to every route's path, and each recorded with the route Next's own routing matched it to (matched.cjs).
import { spawn, spawnSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { createRequire } from "node:module";
import { createServer } from "node:net";
import { join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";

const dir = fileURLToPath(new URL(".", import.meta.url));
const require = createRequire(import.meta.url);
const next = join(dir, "node_modules", "next", "dist", "bin", "next");
const env = { ...process.env, NEXT_TELEMETRY_DISABLED: "1" };

const build = spawnSync(process.execPath, [next, "build"], { cwd: dir, env, stdio: ["ignore", process.stderr, "inherit"] });
if (build.status !== 0) throw new Error(`next build failed with ${build.status}`);

const dist = join(dir, ".next");
const json = (file) => JSON.parse(readFileSync(join(dist, file), "utf8"));
const manifest = json("routes-manifest.json");
const appPaths = json("app-path-routes-manifest.json");
const pagesManifest = json("server/pages-manifest.json");
const images = json("images-manifest.json").images;

// Next's order: a static route first, then the dynamic ones as the manifest sorts them.
const table = [...manifest.staticRoutes, ...manifest.dynamicRoutes];
const dispatched = (path) => (manifest.staticRoutes.find((r) => new RegExp(r.regex).test(path)) ?? manifest.dynamicRoutes.find((r) => new RegExp(r.regex).test(path)))?.page;

const METHODS = ["GET", "HEAD", "POST", "PUT", "DELETE", "PATCH", "OPTIONS"];
const PROBED = ["GET", "POST", "PUT", "PATCH", "DELETE"];

// The globals Next's server sets up before it loads a compiled route (AsyncLocalStorage and the like).
require("next/dist/server/node-environment");

/**
 * What a route is: an App Router route handler (`app-path-routes-manifest` names its file `route`), with the methods
 * its compiled module exports; an App Router page (`page`); a Pages Router API route, a file under `pages/api` (Next.js,
 * API Routes); or a Pages Router page.
 */
function describe(page) {
  const app = Object.entries(appPaths).find(([, p]) => p === page)?.[0];
  if (app?.endsWith("/route")) {
    const { routeModule } = require(join(dist, "server", "app", `${app}.js`));
    if (routeModule?.definition?.kind !== "APP_ROUTE") throw new Error(`${app} is not compiled as a route handler`);
    return { kind: "APP_ROUTE", exported: METHODS.filter((m) => typeof routeModule.userland[m] === "function") };
  }
  if (app) return { kind: "APP_PAGE" };
  if (!(page in pagesManifest)) throw new Error(`${page} is in neither app-path-routes-manifest nor pages-manifest`);
  return { kind: page === "/api" || page.startsWith("/api/") ? "PAGES_API" : "PAGES" };
}

const NAME = "[^\\]]+";
const segmentsOf = (page) => page.split("/").filter(Boolean);
/** A route's paths: `[x]` is a parameter, `[...x]` the rest of the path, `[[...x]]` none or the rest of the path. */
function expand(page) {
  let out = [{ path: "", sample: "" }];
  for (const seg of segmentsOf(page)) {
    if (new RegExp(`^\\[\\[\\.\\.\\.${NAME}\\]\\]$`).test(seg)) {
      out = out.flatMap((p) => [p, { path: `${p.path}/{**}`, sample: `${p.sample}/rest/of/it` }]);
    } else if (new RegExp(`^\\[\\.\\.\\.${NAME}\\]$`).test(seg)) {
      out = out.map((p) => ({ path: `${p.path}/{**}`, sample: `${p.sample}/rest/of/it` }));
    } else if (new RegExp(`^\\[${NAME}\\]$`).test(seg)) {
      out = out.map((p) => ({ path: `${p.path}/{}`, sample: `${p.sample}/value1` }));
    } else {
      out = out.map((p) => ({ path: `${p.path}/${seg}`, sample: `${p.sample}/${seg}` }));
    }
  }
  return out.map((p) => ({ path: p.path || "/", sample: p.sample || "/" }));
}

// A route Next reaches only through a rewrite on the `next-url` header: an intercepting route, served at the path it
// intercepts (the rewrite's source, a route of its own), in the layout of the page the navigation starts from.
const intercepting = (page) =>
  manifest.rewrites.beforeFiles.some(
    (r) => r.has?.some((h) => h.type === "header" && h.key === "next-url") && dispatched(r.destination.replace(/:nxtP\w+[*+?]?/g, "value1")) === page,
  );

const port = await new Promise((resolve) => {
  const probe = createServer().listen(0, "127.0.0.1", () => {
    const { port } = probe.address();
    probe.close(() => resolve(port));
  });
});
const server = spawn(process.execPath, ["--require", join(dir, "matched.cjs"), next, "start", "-p", String(port), "-H", "127.0.0.1"], { cwd: dir, env, stdio: ["ignore", "ignore", "inherit"] });
const base = `http://127.0.0.1:${port}`;

async function request(method, path) {
  const response = await fetch(base + path, { method, redirect: "manual", body: method === "GET" || method === "HEAD" ? undefined : "{}" });
  await response.arrayBuffer();
  return response.status;
}

/** The methods Next answers at a path: those it neither refuses (405) nor finds nothing at (404); `*` for every one. */
async function answered(path) {
  const served = [];
  for (const method of PROBED) if (![404, 405].includes(await request(method, path))) served.push(method);
  return served.length === PROBED.length ? ["*"] : served;
}

const out = [];
const requests = [];
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

  for (const { page } of table) {
    if (intercepting(page)) continue;
    const { kind, exported } = describe(page);
    const paths = expand(page);
    // `{**}` is one segment or more: where the route does not also stand for the path before it (`[...x]`), that path
    // must not reach the route.
    for (const { path, sample } of paths.filter((p) => p.path.endsWith("/{**}"))) {
      const parentPath = path.slice(0, -"/{**}".length) || "/";
      if (paths.some((p) => p.path === parentPath)) continue;
      const parent = sample.slice(0, -"/rest/of/it".length) || "/";
      const by = dispatched(parent);
      if (by === page || (by === undefined && (await request("GET", parent)) !== 404)) throw new Error(`${parent} reaches ${page}, which takes one segment or more`);
    }
    for (const { path, sample } of paths) {
      const by = dispatched(sample);
      if (by !== page) throw new Error(`${sample} is dispatched to ${by}, not to ${page} that it stands for`);
      let methods;
      if (kind === "APP_ROUTE") {
        // A route handler answers the methods it exports, and Next HEAD with its GET and OPTIONS by itself, except for a
        // handler it prerendered at build time (a metadata file), whose output it serves to GET and HEAD alone.
        methods = [];
        for (const method of METHODS) if (![404, 405].includes(await request(method, sample))) methods.push(method);
        const unanswered = exported.filter((m) => !methods.includes(m));
        const unexported = methods.filter((m) => !exported.includes(m) && m !== "HEAD" && m !== "OPTIONS");
        if (unanswered.length || unexported.length) {
          throw new Error(`${sample} (${page}) exports ${exported.join(", ")} and answers ${methods.join(", ")}`);
        }
      } else if (kind === "PAGES_API") {
        // An API route's handler takes every method (Next.js, API Routes: "req.method").
        methods = ["*"];
        if ((await request("PATCH", sample)) === 404) throw new Error(`PATCH ${sample} (${page}) is not served`);
      } else {
        methods = await answered(sample);
      }
      // Next's own not-found page answers 404 at the path it is built for: not a route the app serves.
      if (methods.length === 0) continue;
      for (const method of methods) out.push({ method, path, raw: page });
    }
  }

  // public/: each file at its path from the base URL (Next.js, public Folder).
  const files = (root) =>
    readdirSync(root).flatMap((name) => (statSync(join(root, name)).isDirectory() ? files(join(root, name)) : [join(root, name)]));
  const publicDir = join(dir, "public");
  for (const file of existsSync(publicDir) ? files(publicDir) : []) {
    const path = `/${relative(publicDir, file).split(sep).map(encodeURIComponent).join("/")}`;
    const methods = await answered(path);
    if (!methods.length) throw new Error(`public file ${path} is not served`);
    for (const method of methods) out.push({ method, path, raw: `public${path}` });
  }

  // The build's assets: the files of .next/static, under /_next/static.
  const assets = files(join(dist, "static")).map((f) => `/_next/${relative(dist, f).split(sep).join("/")}`);
  let assetMethods;
  for (const path of assets) {
    const methods = (await answered(path)).join(",");
    if (!methods) throw new Error(`build asset ${path} is not served`);
    if (assetMethods !== undefined && methods !== assetMethods) throw new Error(`build asset ${path} answers ${methods}, others ${assetMethods}`);
    assetMethods = methods;
  }
  for (const method of assetMethods ? assetMethods.split(",") : []) out.push({ method, path: "/_next/static/{**}", raw: "/_next/static/*" });

  // The image optimizer of next/image, at the path images-manifest gives.
  const optimizer = `${images.path}?url=${encodeURIComponent("/apple-icon.png")}&w=${images.imageSizes[0]}&q=75`;
  for (const method of await answered(optimizer)) out.push({ method, path: images.path, raw: images.path });

  // Sample requests, and the route Next dispatches each to: every route's sample path, also with a trailing `/`, and a
  // path no route takes, each with every method a route registers. A route is told by what Next's router matched the
  // request to (matched.cjs: a route's page, a public file, a build asset, the image optimizer); it took the request if
  // it answers that method, and Next refused it otherwise (404, 405). Its path is the one of its paths that fits.
  // HEAD and OPTIONS only where a route registers them on their own: the compared form leaves out the HEAD beside a GET
  // and the OPTIONS beside another method of the same path, which the framework answers by itself.
  const methodsAt = new Map();
  for (const r of out) methodsAt.set(r.path, new Set([...(methodsAt.get(r.path) ?? []), r.method]));
  const own = (r) => r.method !== "*" && !(r.method === "HEAD" && methodsAt.get(r.path).has("GET")) && !(r.method === "OPTIONS" && methodsAt.get(r.path).size > 1);
  const methods = [...new Set(out.filter(own).map((r) => r.method))].sort();
  const samples = [...new Set(out.map((r) => r.path.replace(/\{\*\*\}/g, "rest/of/it").replace(/\{\}/g, "value1")))];
  const probes = [...new Set([...samples, ...samples.map((s) => (s === "/" ? s : `${s}/`)), "/nowhere/value1"])].sort();
  const fits = (pattern, path) => {
    const want = segmentsOf(pattern);
    const have = segmentsOf(path);
    if (want.at(-1) === "{**}") return have.length >= want.length && want.slice(0, -1).every((s, i) => s === "{}" || s === have[i]);
    return have.length === want.length && want.every((s, i) => s === "{}" || s === have[i]);
  };
  const rawOf = ({ type, itemPath }) => {
    if (type === "appFile" || type === "pageFile") return itemPath;
    if (type === "publicFolder") return `public${itemPath}`;
    if (type === "nextStaticFolder") return "/_next/static/*";
    if (type === "nextImage") return images.path;
    throw new Error(`Next matched a request to ${type} ${itemPath}, which is not a route the oracle lists`);
  };
  for (const path of probes) {
    for (const method of methods) {
      const response = await fetch(base + path, { method, redirect: "manual", body: method === "GET" ? undefined : "{}" });
      await response.arrayBuffer();
      const { status, headers } = response;
      const at = `${method} ${path} (${status})`;
      if (status >= 300 && status < 400) {
        // Next redirects a path with a trailing slash to the one without (next.config.js, trailingSlash: "By default
        // Next.js will redirect URLs with trailing slashes to their counterpart without a trailing slash"): its router
        // answers before any route, and the docs name the target as another URL, not the same route.
        if (headers.get("location") !== path.replace(/\/+$/, "")) throw new Error(`${at} redirects to ${headers.get("location")}`);
        requests.push({ method, path, route: null });
        continue;
      }
      const matched = headers.get("x-oracle-matched-output");
      if (matched === null) {
        if (status !== 404) throw new Error(`${at} is answered without a route Next matched`);
        requests.push({ method, path, route: null });
        continue;
      }
      const output = JSON.parse(matched);
      const raw = rawOf(output);
      const refused = status === 404 || status === 405;
      const rendered = headers.get("x-oracle-matched-route");
      if (!refused && rendered !== null && rendered !== output.itemPath) throw new Error(`${at} is matched to ${output.itemPath} and rendered by ${rendered}`);
      const candidates = out.filter((r) => r.raw === raw);
      const pattern = candidates.map((r) => r.path).find((p) => fits(p, path));
      if (pattern === undefined) throw new Error(`${at} is matched to ${raw}, none of whose paths fits it`);
      const route = candidates.find((r) => r.path === pattern && (r.method === method || r.method === "*"));
      if (route === undefined) {
        if (!refused) throw new Error(`${at} is answered by ${raw}, which does not take ${method}`);
        requests.push({ method, path, route: null });
        continue;
      }
      // An API route's handler takes every method and may refuse one itself.
      if (refused && !(["appFile", "pageFile"].includes(output.type) && describe(raw).kind === "PAGES_API")) throw new Error(`${at} is refused by ${raw}, which takes ${method}`);
      requests.push({ method, path, route: `${route.method} ${pattern}` });
    }
  }
} finally {
  server.kill();
}

const version = require("next/package.json").version;
console.log(JSON.stringify({ framework: "next", version, routes: out, requests }));
