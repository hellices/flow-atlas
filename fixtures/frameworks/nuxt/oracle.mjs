// Asks Nuxt which routes the application serves. `nuxt build` resolves the pages into the route records vue-router
// matches with (handed over by its `pages:resolved` hook) and compiles Nitro's dispatch table, the `handlers` the built
// server registers on its h3 router: the server routes it scanned under server/api and server/routes, the
// `serverHandlers` of nuxt.config, Nuxt's own handlers and, last, the renderer at `/**` that serves the pages. The
// built server (`.output/server/index.mjs`) is then started and each route requested where h3, given the same table,
// and vue-router, given the same records, dispatch the request to that route: it counts under the methods the server
// answers, neither refusing them (405) nor finding nothing (404). Files of `public/` and the build's assets, which Nitro
// serves before any route, are listed from the build's output directory and requested the same way.
import { spawn } from "node:child_process";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { createRequire } from "node:module";
import { createServer } from "node:net";
import { join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";

const dir = fileURLToPath(new URL(".", import.meta.url));
const require = createRequire(import.meta.url);
const env = { ...process.env, NUXT_TELEMETRY_DISABLED: "1" };

if (process.argv[2] === "build") {
  // The build, in a child whose stdout goes to stderr: Nuxt and Vite log to stdout.
  const { build, loadNuxt } = await import("nuxt");
  let pages;
  const strip = (p) => ({ path: p.path, file: p.file, children: (p.children ?? []).map(strip) });
  const nuxt = await loadNuxt({ cwd: dir, dev: false, overrides: { hooks: { "pages:resolved": (resolved) => void (pages = resolved.map(strip)) } } });
  await build(nuxt);
  const app = { baseURL: nuxt.options.app.baseURL, buildAssetsDir: nuxt.options.app.buildAssetsDir };
  await nuxt.close();
  process.send({ pages, app }, () => process.exit(0));
} else {
  await main();
}

async function main() {
  const built = await new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [fileURLToPath(import.meta.url), "build"], { cwd: dir, env, stdio: ["ignore", 2, "inherit", "ipc"] });
    let message;
    child.on("message", (m) => (message = m));
    child.on("exit", (code) => (code === 0 && message ? resolve(message) : reject(new Error(`nuxt build failed with ${code}`))));
  });
  if (built.app.baseURL !== "/") throw new Error(`baseURL ${built.app.baseURL} is not handled`);

  // Nitro's dispatch table, as the build compiled it into the server (nitropack's `#nitro-internal-virtual/server-handlers`).
  const output = join(dir, ".output");
  const files = (root) => readdirSync(root).flatMap((name) => (statSync(join(root, name)).isDirectory() ? files(join(root, name)) : [join(root, name)]));
  const chunks = files(join(output, "server")).filter((f) => f.endsWith(".mjs") && !f.includes(`${sep}node_modules${sep}`));
  const chunk = chunks.find((f) => readFileSync(f, "utf8").includes("\nconst handlers = ["));
  if (!chunk) throw new Error("the built server holds no handlers table");
  const code = readFileSync(chunk, "utf8");
  const tableText = code.slice(code.indexOf("\nconst handlers = [") + 1, code.indexOf("\n];", code.indexOf("\nconst handlers = [")));
  const ENTRY = /^ {2}\{ route: '([^']*)', handler: ([\w$]+), lazy: (true|false), middleware: (true|false), method: (undefined|"[a-z]+") \},?$/;
  const lines = tableText.split("\n").slice(1);
  const table = lines.map((line) => {
    const m = ENTRY.exec(line);
    if (!m) throw new Error(`unreadable handler entry: ${line}`);
    const importOf = new RegExp(`const ${m[2].replace(/\$/g, "\\$")} = \\(\\) => import\\('([^']+)'\\)`).exec(code)?.[1];
    return { route: m[1], handler: m[2], importOf, middleware: m[4] === "true", method: m[5] === "undefined" ? undefined : JSON.parse(m[5]).toUpperCase() };
  });
  const isRenderer = (h) => h.importOf?.endsWith("/routes/renderer.mjs");

  // h3's router, given the same table as the built server registers it (nitropack's runtime app: every entry but the
  // middleware on one preemptive router), says which entry a request reaches.
  // The h3 nitropack bundles into the server, resolved as its build resolves it.
  const from = (req, name) => createRequire(req.resolve(`${name}/package.json`));
  const nitropack = from(from(require, "nuxt"), "@nuxt/nitro-server");
  const h3 = await import(from(nitropack, "nitropack").resolve("h3"));
  const app = h3.createApp();
  const router = h3.createRouter({ preemptive: true });
  table.forEach((h, i) => {
    if (!h.middleware && h.route) router.use(h.route, h3.eventHandler(() => String(i)), h.method?.toLowerCase());
  });
  app.use("/", router.handler);
  const web = h3.toWebHandler(app);
  const dispatched = async (method, path) => {
    const response = await web(new Request(`http://localhost${path}`, { method }));
    return response.status === 200 ? Number(await response.text()) : undefined;
  };

  // vue-router, given the records Nuxt resolved, says which page a path renders.
  const { createMemoryHistory, createRouter } = await import("vue-router");
  const records = (pages) => pages.map((p) => ({ path: p.path, component: {}, meta: { file: p.file }, children: records(p.children) }));
  const pageRouter = createRouter({ history: createMemoryHistory(), routes: records(built.pages) });
  const pageOf = (path) => {
    const matched = pageRouter.resolve(path).matched;
    return matched.length ? matched[matched.length - 1].meta.file : undefined;
  };

  const port = await new Promise((resolve) => {
    const probe = createServer().listen(0, "127.0.0.1", () => {
      const { port } = probe.address();
      probe.close(() => resolve(port));
    });
  });
  const server = spawn(process.execPath, [join(output, "server", "index.mjs")], {
    cwd: dir,
    env: { ...env, PORT: String(port), HOST: "127.0.0.1", NITRO_PORT: String(port), NITRO_HOST: "127.0.0.1" },
    stdio: ["ignore", "ignore", "inherit"],
  });
  const base = `http://127.0.0.1:${port}`;
  const request = async (method, path) => {
    const response = await fetch(base + path, { method, redirect: "manual", body: method === "GET" || method === "HEAD" ? undefined : "{}", headers: { "content-type": "application/json" } });
    await response.arrayBuffer();
    return response.status;
  };
  const PROBED = ["GET", "POST", "PUT", "PATCH", "DELETE"];
  /** The methods the server answers at a path: those it neither refuses (405) nor finds nothing at (404); `*` for every one. */
  const answered = async (path) => {
    const served = [];
    for (const method of PROBED) if (![404, 405].includes(await request(method, path))) served.push(method);
    return served.length === PROBED.length ? ["*"] : served;
  };

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
    if ((await request("GET", "/no/such/page")) !== 404) throw new Error("a path no route takes is answered");

    for (const [i, h] of table.entries()) {
      if (h.middleware || !h.route) continue;
      if (isRenderer(h) && h.route === "/**") {
        for (const route of await pageRoutes(i)) out.push(route);
        continue;
      }
      const paths = expandNitro(h.route);
      for (const { path, sample } of paths) {
        const methods = h.method ? [h.method] : PROBED;
        for (const method of methods) if ((await dispatched(method, sample)) !== i) throw new Error(`${method} ${sample} does not reach ${h.route}`);
        // The renderer at `/__nuxt_error` renders an error page for Nitro's error handler, and answers any request from
        // outside with a 404 (`Page Not Found: /__nuxt_error`): no route the app serves.
        if (isRenderer(h) && (await answered(sample)).length === 0) continue;
        for (const method of methods) if ([404, 405].includes(await request(method, sample))) throw new Error(`${method} ${sample} (${h.route}) is not served`);
        out.push({ method: h.method ?? "*", path, raw: h.route });
      }
      // `**` takes the path before it as well where h3 dispatches that path to the route, `/` after it or not.
      if (/\/\*\*(:\w+)?$/.test(h.route)) {
        const { path, sample } = paths[0];
        const parent = sample.slice(0, -"/rest/of/it".length) || "/";
        const method = h.method ?? "GET";
        const takes = (await dispatched(method, parent)) === i;
        if (takes !== ((await dispatched(method, `${parent}/`)) === i)) throw new Error(`${parent} and ${parent}/ reach different routes`);
        if (takes) {
          for (const p of [parent, `${parent}/`]) if ([404, 405].includes(await request(method, p))) throw new Error(`${method} ${p} (${h.route}) is not served`);
          out.push({ method: h.method ?? "*", path: path.slice(0, -"/{**}".length) || "/", raw: h.route });
        }
      }
    }

    // public/ and the build's assets, which Nitro's static handler serves from the output's public directory.
    const publicDir = join(output, "public");
    const assetsDir = built.app.buildAssetsDir.replace(/^\/|\/$/g, "");
    let assetMethods;
    for (const file of existsSync(publicDir) ? files(publicDir) : []) {
      const path = `/${relative(publicDir, file).split(sep).map(encodeURIComponent).join("/")}`;
      const methods = await answered(path);
      if (!methods.length) throw new Error(`public file ${path} is not served`);
      if (path.startsWith(`/${assetsDir}/`)) {
        if (assetMethods !== undefined && methods.join(",") !== assetMethods) throw new Error(`build asset ${path} answers ${methods}, others ${assetMethods}`);
        assetMethods = methods.join(",");
      } else for (const method of methods) out.push({ method, path, raw: `public${path}` });
    }
    for (const method of assetMethods ? assetMethods.split(",") : []) out.push({ method, path: `/${assetsDir}/{**}`, raw: `${built.app.buildAssetsDir}**` });
  } finally {
    server.kill();
  }

  /** The pages, at the paths vue-router matches them, each one the renderer at `/**` answers. */
  async function pageRoutes(renderer) {
    const routes = [];
    const walk = async (pages, prefix) => {
      for (const page of pages) {
        const full = page.path.startsWith("/") ? page.path : `${prefix.replace(/\/$/, "")}/${page.path}`.replace(/\/$/, "") || "/";
        // A parent whose child takes its own path renders that child there.
        if (!page.children.some((c) => c.path === "")) {
          const paths = expandPage(full);
          for (const { path, sample } of paths) {
            if (pageOf(sample) !== page.file) throw new Error(`${sample} renders ${pageOf(sample)}, not ${page.file}`);
            if ((await dispatched("GET", sample)) !== renderer) throw new Error(`${sample} does not reach the renderer`);
            const methods = await answered(sample);
            if (!methods.length) throw new Error(`page ${sample} (${full}) is not served`);
            for (const method of methods) routes.push({ method, path, raw: full });
          }
          // `{**}` is one segment or more: where the page does not also stand for the path before it, that path
          // must not render it.
          for (const { path, sample } of paths.filter((p) => p.path.endsWith("/{**}"))) {
            const parentPath = path.slice(0, -"/{**}".length) || "/";
            if (paths.some((p) => p.path === parentPath)) continue;
            const parent = sample.slice(0, -"/rest/of/it".length) || "/";
            if (pageOf(parent) === page.file) throw new Error(`${parent} renders ${page.file}, which takes one segment or more`);
          }
        }
        await walk(page.children, full);
      }
    };
    await walk(built.pages, "");
    return routes;
  }

  const version = require("nuxt/package.json").version;
  console.log(JSON.stringify({ framework: "nuxt", version, routes: out }));
}

/**
 * A page's paths, from vue-router's path syntax: `:name()` (a regex in the brackets, empty for Nuxt's `[name]`) is a
 * parameter; `?` after it makes the segment optional (`[[name]]`); `*` or `+` repeats it, the rest of the path, none
 * or more (`[...name]`, `:name(.*)*`) or one or more.
 */
function expandPage(page) {
  let out = [{ path: "", sample: "" }];
  for (const seg of page.split("/").filter(Boolean)) {
    const PARAM = /:(\w+)(\([^)]*\))?([?*+])?/g;
    const params = [...seg.matchAll(PARAM)];
    const modifier = params.find((p) => p[3])?.[3];
    for (const p of params) if (p[2] && p[2] !== "()" && !(p[2] === "(.*)" && (p[3] === "*" || p[3] === "+"))) throw new Error(`${page}: a parameter's regex ${p[2]} is not handled`);
    if (modifier && params.length !== 1) throw new Error(`${page}: a modifier beside another parameter is not handled`);
    if (modifier === "*" || modifier === "+") {
      if (seg !== params[0][0]) throw new Error(`${page}: a repeated parameter within a segment is not handled`);
      out = out.flatMap((p) => [...(modifier === "*" ? [p] : []), { path: `${p.path}/{**}`, sample: `${p.sample}/rest/of/it` }]);
    } else if (modifier === "?") {
      if (seg !== params[0][0]) throw new Error(`${page}: an optional parameter within a segment is not handled`);
      out = out.flatMap((p) => [p, { path: `${p.path}/{}`, sample: `${p.sample}/value1` }]);
    } else {
      out = out.map((p) => ({ path: `${p.path}/${seg.replace(PARAM, "{}")}`, sample: `${p.sample}/${seg.replace(PARAM, "value1")}` }));
    }
  }
  return out.map((p) => ({ path: p.path || "/", sample: p.sample || "/" }));
}

/** A Nitro route's path, from radix3's syntax: `:name` and `*` a segment, `**` (or `**:name`) the rest of the path. */
function expandNitro(route) {
  let path = "";
  let sample = "";
  for (const seg of route.split("/").filter(Boolean)) {
    if (/^\*\*(:\w+)?$/.test(seg)) [path, sample] = [`${path}/{**}`, `${sample}/rest/of/it`];
    else if (/^(:\w+|\*)$/.test(seg)) [path, sample] = [`${path}/{}`, `${sample}/value1`];
    else if (/[:*]/.test(seg)) throw new Error(`${route}: a segment ${seg} is not handled`);
    else [path, sample] = [`${path}/${seg}`, `${sample}/${seg}`];
  }
  return [{ path: path || "/", sample: sample || "/" }];
}
