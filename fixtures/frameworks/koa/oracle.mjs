// Asks @koa/router which routes the application serves. Each router the Koa application uses (`router.routes()`) keeps
// its routes in `router.stack`, where `use` has already copied the routes of the routers nested in it, under their mount
// path and the router's prefix; each route is then requested through the running application, and only the route whose
// own handler answers counts, so what is written is what the routers dispatch.
import { METHODS, request } from "node:http";
import { readFileSync } from "node:fs";
import Koa from "koa";
import Router from "@koa/router";
import app from "./src/app.js";

const routes = [];
for (const middleware of app.middleware) {
  const router = middleware.router;
  if (!router) continue;
  const hosts = router.host === undefined ? [undefined] : [router.host].flat();
  if (hosts.some((h) => h !== undefined && typeof h !== "string")) throw new Error(`a router matches hosts by a pattern: ${router.host}`);
  for (const layer of router.stack) {
    if (layer.methods.length === 0) continue; // `router.use` middleware, not a route
    if (layer.opts.pathAsRegExp) throw new Error(`a route is a regular expression, which a path cannot write: ${layer.path}`);
    const id = String(routes.length);
    // The route's own handler is its last function; the ones before it are middleware (`router.param` among them).
    const handler = layer.stack.at(-1);
    layer.stack[layer.stack.length - 1] = function (ctx, next) {
      ctx.append("x-route", id);
      return handler.call(this, ctx, next);
    };
    // `all` registers every method Node knows; GET adds HEAD by itself.
    const every = METHODS.every((m) => layer.methods.includes(m));
    routes.push({ id, methods: every ? ["*"] : [...new Set(layer.methods)], pattern: layer.path, host: hosts[0] });
  }
}

/** The patterns an optional group `{...}` stands for: with it and without it (path-to-regexp 8). */
function expand(pattern) {
  const open = pattern.indexOf("{");
  if (open < 0) return [pattern];
  let depth = 0;
  let close = open;
  for (; close < pattern.length; close++) {
    if (pattern[close] === "{") depth++;
    else if (pattern[close] === "}" && --depth === 0) break;
  }
  const head = pattern.slice(0, open);
  const tail = pattern.slice(close + 1);
  return [...expand(head + pattern.slice(open + 1, close) + tail), ...expand(head + tail)];
}

const NAME = /[$_\p{ID_Start}][$\u200c\u200d\p{ID_Continue}]*/u;
const PARAM = new RegExp(`:${NAME.source}`, "gu");
const WILD = new RegExp(`\\*${NAME.source}`, "gu");
const canonical = (pattern) => pattern.replace(WILD, "{**}").replace(PARAM, "{}").replace(/\/+$/, "") || "/";
const sample = (pattern) => pattern.replace(WILD, "rest/of/it").replace(PARAM, "value1");

const server = app.listen(0);
await new Promise((resolve) => server.once("listening", resolve));
const { port } = server.address();
const send = (method, path, host) =>
  new Promise((resolve, reject) => {
    const req = request({ port, method, path, headers: host ? { host } : {} }, (res) => {
      res.resume();
      res.on("end", () => resolve(res.headers["x-route"]));
    });
    req.on("error", reject);
    req.end();
  });

/**
 * Whether @koa/router also dispatches a pattern ending in a wildcard when nothing follows its last `/`: asked of an
 * application whose one router holds that pattern alone, so another route cannot answer in its place.
 */
async function takesParent(pattern) {
  const alone = new Koa();
  const router = new Router();
  router.get(pattern, (ctx) => {
    ctx.body = "alone";
  });
  alone.use(router.routes());
  const server = alone.listen(0);
  await new Promise((resolve) => server.once("listening", resolve));
  const response = await fetch(`http://127.0.0.1:${server.address().port}${sample(pattern).replace(/rest\/of\/it$/, "")}`);
  const body = await response.text();
  server.close();
  return response.status === 200 && body === "alone";
}

const out = [];
for (const r of routes) {
  for (const pattern of expand(r.pattern)) {
    for (const method of r.methods) {
      const answered = (await send(method === "*" ? "PATCH" : method, sample(pattern), r.host)) ?? "";
      if (!answered.split(/,\s*/).includes(r.id)) throw new Error(`${method} ${pattern} is answered by route ${answered || "none"}, not by route ${r.id} that registers it`);
      out.push({ method, path: canonical(pattern), raw: pattern });
      // A route that also takes its parent path with a trailing `/` is written as two: the parent, and `/{**}`.
      if (canonical(pattern).endsWith("/{**}") && (await takesParent(pattern))) {
        out.push({ method, path: canonical(pattern).slice(0, -"/{**}".length) || "/", raw: pattern });
      }
    }
  }
}
server.close();

// @koa/router exports no package.json.
const version = JSON.parse(readFileSync(new URL("node_modules/@koa/router/package.json", import.meta.url), "utf8")).version;
console.log(JSON.stringify({ framework: "@koa/router", version, routes: out }));
