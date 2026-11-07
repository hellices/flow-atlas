// Asks AdonisJS which routes the application serves: `node ace list:routes --json`, the route list AdonisJS documents
// (docs.adonisjs.com/guides/basics/routing#viewing-registered-routes), read from the router once the application has
// registered its routes (groups' prefixes, resources and their filters expanded). The application is then booted as
// `bin/server.ts` boots it, and each path a route stands for requested from it: a router middleware added before the
// router commits its routes, so it runs for every route as the application's own do, records once the route's handler
// has answered which route that was (`ctx.route`, docs.adonisjs.com/guides/basics/routing#accessing-the-current-route).
// Only the route whose own handler answers counts, so what is written is what AdonisJS dispatches.
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { createServer, request as httpRequest } from "node:http";

const listed = JSON.parse(execFileSync(process.execPath, ["ace", "list:routes", "--json"], { cwd: new URL(".", import.meta.url), encoding: "utf8" }));
const others = listed.filter((d) => d.domain !== "root");
if (others.length) throw new Error(`routes for a domain (${others.map((d) => d.domain).join(", ")}) are not in the form compared`);
const routes = listed.flatMap((d) => d.routes);
const seen = new Set();
for (const r of routes) {
  for (const m of r.methods) {
    if (seen.has(`${m} ${r.pattern}`)) throw new Error(`${m} ${r.pattern} is listed twice`);
    seen.add(`${m} ${r.pattern}`);
  }
}

process.env.LOG_LEVEL = "silent";
await import("@poppinss/ts-exec");
await import("reflect-metadata");
const { Ignitor } = await import("@adonisjs/core/ignitor");
const APP_ROOT = new URL("./", import.meta.url);
const importer = (filePath) => import(filePath.startsWith("./") || filePath.startsWith("../") ? new URL(filePath, APP_ROOT).href : filePath);

class Answered {
  async handle(ctx, next) {
    await next();
    ctx.response.header("x-route", ctx.route.pattern);
    ctx.response.header("x-route-methods", ctx.route.methods.join(","));
  }
}

const app = new Ignitor(APP_ROOT, { importer })
  .tap((app) => app.booting(async () => void (await import("#start/env"))))
  .createApp("web");
await app.init();
await app.boot();
let origin;
await app.start(async () => {
  const router = await app.container.make("router");
  const server = await app.container.make("server");
  router.use([async () => ({ default: Answered })]);
  await server.boot();
  const nodeServer = createServer(server.handle.bind(server));
  server.setNodeServer(nodeServer);
  await new Promise((resolve) => nodeServer.listen(0, "127.0.0.1", resolve));
  origin = { host: "127.0.0.1", port: nodeServer.address().port };
});

/** One request, any method (fetch refuses TRACE); the route that answered it, if one did. */
const ask = (method, path) =>
  new Promise((resolve, reject) => {
    const req = httpRequest({ ...origin, method, path }, (res) => {
      res.resume();
      res.on("end", () => resolve(res.headers["x-route"] ? { pattern: res.headers["x-route"], methods: res.headers["x-route-methods"].split(",") } : undefined));
    });
    req.on("error", reject);
    req.end();
  });

/** The patterns a route stands for: a last param marked optional (`:id?`) with and without it. */
const expand = (pattern) => {
  const optional = /^(.*)\/(:[^/]+)\?$/.exec(pattern);
  return optional ? [`${optional[1]}/${optional[2]}`, optional[1] || "/"] : [pattern];
};
/** AdonisJS's syntax: `:name` a param, and a last `*` a wildcard taking the remaining segments. */
const PARAM = /:[^/]+/g;
const canonical = (pattern) => pattern.replace(PARAM, "{}").replace(/\/\*$/, "/{**}").replace(/\/+$/, "") || "/";
/** Requests for a pattern: each param tried with a few values, since a matcher may refuse one. */
function* samples(pattern) {
  const texts = pattern.replace(/\/\*$/, "/rest/of/it").split(PARAM);
  const values = ["value1", "12", "550e8400-e29b-41d4-a716-446655440000"];
  const holes = texts.length - 1;
  for (let n = 0; n < values.length ** holes; n++) {
    let path = texts[0];
    for (let h = 0; h < holes; h++) path += values[Math.floor(n / values.length ** h) % values.length] + texts[h + 1];
    yield path;
  }
}
const answeredBy = (answer, route, method) => answer?.pattern === route.pattern && answer.methods.includes(method);

const out = [];
for (const route of routes) {
  for (const method of route.methods) {
    for (const pattern of expand(route.pattern)) {
      let answer;
      for (const path of samples(pattern)) {
        answer = await ask(method, path);
        if (answeredBy(answer, route, method)) break;
      }
      if (!answeredBy(answer, route, method)) {
        throw new Error(`${method} ${pattern} is answered by ${answer ? answer.pattern : "no route"}, not by ${route.pattern} that registers it`);
      }
      out.push({ method, path: canonical(pattern), raw: route.pattern });
      // A wildcard that also takes its parent path with a trailing `/` is written as two: the parent, and `/{**}`.
      if (pattern.endsWith("/*")) {
        const parent = samples(pattern).next().value.replace(/rest\/of\/it$/, "");
        if (answeredBy(await ask(method, parent), route, method)) out.push({ method, path: canonical(pattern).slice(0, -"/{**}".length) || "/", raw: route.pattern });
      }
    }
  }
}

const version = JSON.parse(readFileSync(new URL("node_modules/@adonisjs/core/package.json", import.meta.url), "utf8")).version;
console.log(JSON.stringify({ framework: "adonisjs", version, routes: out }));
process.exit(0);
