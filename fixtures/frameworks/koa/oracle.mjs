// Asks @koa/router which routes the application serves. Each router the Koa application uses (`router.routes()`) keeps
// its routes in `router.stack`, where `use` has already copied the routes of the routers nested in it, under their mount
// path and the router's prefix; each route is then requested through the running application, and only the route whose
// own handler answers counts, so what is written is what the routers dispatch.
import { METHODS, request } from "node:http";
import { readFileSync } from "node:fs";
import Koa from "koa";
import Router from "@koa/router";
import { createRequire } from "node:module";
import app from "./src/app.js";

// The path-to-regexp @koa/router itself matches with.
const { match } = createRequire(createRequire(import.meta.url).resolve("@koa/router"))("path-to-regexp");

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
    // The layers of an array of paths share one stack: each gets its own, so the tag tells them apart.
    layer.stack = [...layer.stack];
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
// Sample requests, and the route the routers dispatch each to: every route's sample path, also with a trailing `/`, and
// a path no route takes, each with every method a route registers. A route is told by the handler that answered; its
// path is the one of its (expanded) patterns that matches the request, with path-to-regexp, which @koa/router matches
// with (not `strict`, so a trailing `/` is taken). `router.redirect` registers a route of its own, whose handler
// answers with the redirect: such a request is that route's. `allowedMethods()` answers a method no route at the path
// takes (405, 501) by itself: no route.
const methods = [...new Set(routes.flatMap((r) => r.methods).filter((m) => m !== "*" && m !== "HEAD"))].sort();
const samples = [...new Set(routes.flatMap((r) => expand(r.pattern).map((p) => sample(p).replace(/\/+$/, "") || "/")))];
const probes = [...new Set([...samples, ...samples.map((s) => (s === "/" ? s : `${s}/`)), "/nowhere/value1"])].sort();
const requests = [];
for (const path of probes) {
  for (const method of methods) {
    const answered = (await send(method, path)) ?? "";
    if (answered === "") {
      requests.push({ method, path, route: null });
      continue;
    }
    // A route whose handler hands the request on (`next`) leaves the answer to the next one; none here does.
    const ids = answered.split(/,\s*/);
    if (ids.length > 1) throw new Error(`${method} ${path} is answered by routes ${answered}`);
    const r = routes[Number(ids[0])];
    const pattern = expand(r.pattern).find((p) => match(p.replace(/\/+$/, "") || "/", { decode: false })(path));
    if (pattern === undefined) throw new Error(`${method} ${path} is answered by route ${r.id}, none of whose patterns matches it`);
    requests.push({ method, path, route: `${r.methods[0] === "*" ? "*" : method} ${canonical(pattern)}` });
  }
}
server.close();

// @koa/router exports no package.json.
const version = JSON.parse(readFileSync(new URL("node_modules/@koa/router/package.json", import.meta.url), "utf8")).version;
console.log(JSON.stringify({ framework: "@koa/router", version, routes: out, requests }));
