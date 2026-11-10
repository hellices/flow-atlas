// Asks @koa/router which routes the application serves. Each router the Koa application uses (`router.routes()`) keeps
// its routes in `router.stack`, where `use` has already copied the routes of the routers nested in it, under their mount
// path and the router's prefix; each route is then requested through the running application, and only the route whose
// own handler answers counts, so what is written is what the routers dispatch.
import { METHODS, request } from "node:http";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
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

// The path-to-regexp @koa/router matches with: its own reading of a pattern's parameters, wildcards and groups.
const require = createRequire(import.meta.url);
const { match, parse, stringify, TokenData } = createRequire(require.resolve("@koa/router"))("path-to-regexp");

/** The patterns a pattern stands for, each a list of tokens: an optional group `{...}` with it and without it. */
function expand(tokens) {
  let out = [[]];
  for (const token of tokens) {
    if (token.type === "group") {
      const inner = expand(token.tokens);
      out = out.flatMap((head) => [...inner.map((tail) => [...head, ...tail]), head]);
    } else out = out.map((head) => [...head, token]);
  }
  return out;
}

const write = (tokens, param, wildcard) => tokens.map((t) => (t.type === "param" ? param : t.type === "wildcard" ? wildcard : t.value)).join("");
const canonical = (tokens) => write(tokens, "{}", "{**}").replace(/\/+$/, "") || "/";
const sample = (tokens) => write(tokens, "value1", "rest/of/it");

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
async function takesParent(tokens) {
  const alone = new Koa();
  const router = new Router();
  router.get(stringify(new TokenData(tokens)), (ctx) => {
    ctx.body = "alone";
  });
  alone.use(router.routes());
  const server = alone.listen(0);
  await new Promise((resolve) => server.once("listening", resolve));
  const response = await fetch(`http://127.0.0.1:${server.address().port}${sample(tokens).replace(/rest\/of\/it$/, "")}`);
  const body = await response.text();
  server.close();
  return response.status === 200 && body === "alone";
}

const out = [];
for (const r of routes) {
  for (const tokens of expand(parse(r.pattern).tokens)) {
    const pattern = stringify(new TokenData(tokens));
    for (const method of r.methods) {
      const answered = (await send(method === "*" ? "PATCH" : method, sample(tokens), r.host)) ?? "";
      if (!answered.split(/,\s*/).includes(r.id)) throw new Error(`${method} ${pattern} is answered by route ${answered || "none"}, not by route ${r.id} that registers it`);
      out.push({ method, path: canonical(tokens), raw: pattern });
      // A route that also takes its parent path with a trailing `/` is written as two: the parent, and `/{**}`.
      if (canonical(tokens).endsWith("/{**}") && (await takesParent(tokens))) {
        out.push({ method, path: canonical(tokens).slice(0, -"/{**}".length) || "/", raw: pattern });
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
// HEAD and OPTIONS only where a route registers them on their own: the compared form leaves out the HEAD beside a GET
// and the OPTIONS beside another method of the same path, which the framework answers by itself.
const methodsAt = new Map();
for (const r of out) methodsAt.set(r.path, new Set([...(methodsAt.get(r.path) ?? []), r.method]));
const own = (r) => r.method !== "*" && !(r.method === "HEAD" && methodsAt.get(r.path).has("GET")) && !(r.method === "OPTIONS" && methodsAt.get(r.path).size > 1);
const methods = [...new Set(out.filter(own).map((r) => r.method))].sort();
const samples = [...new Set(routes.flatMap((r) => expand(parse(r.pattern).tokens).map((t) => sample(t).replace(/\/+$/, "") || "/")))];
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
    const pattern = expand(parse(r.pattern).tokens).find((t) => match(stringify(new TokenData(t)).replace(/\/+$/, "") || "/", { decode: false })(path));
    if (pattern === undefined) throw new Error(`${method} ${path} is answered by route ${r.id}, none of whose patterns matches it`);
    requests.push({ method, path, route: `${r.methods[0] === "*" ? "*" : method} ${canonical(pattern)}` });
  }
}
server.close();

// @koa/router exports no package.json.
const version = JSON.parse(readFileSync(new URL("node_modules/@koa/router/package.json", import.meta.url), "utf8")).version;
console.log(JSON.stringify({ framework: "@koa/router", version, routes: out, requests }));
