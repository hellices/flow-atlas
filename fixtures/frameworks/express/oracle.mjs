// Asks Express which routes the application serves. Express 5 keeps no path a router was mounted at, so the paths are
// recorded as the application registers them; each route is then requested through the running application, and only
// the route whose own handler answers counts, so what is written is what Express dispatches.
import express from "express";
import { METHODS } from "node:http";
import { createRequire } from "node:module";
import { match } from "path-to-regexp";

const { Route, Router } = express;
const routes = [];

const use = Router.prototype.use;
Router.prototype.use = function (...args) {
  const before = this.stack.length;
  const first = Array.isArray(args[0]) ? args[0].flat(Infinity)[0] : args[0];
  const path = typeof first === "function" ? "/" : args[0];
  const out = use.apply(this, args);
  for (const layer of this.stack.slice(before)) layer.mountedAt = path;
  return out;
};

const appUse = express.application.use;
express.application.use = function (...args) {
  const before = this.router.stack.length;
  const apps = args.flat(Infinity).filter((fn) => typeof fn === "function" && fn.handle && fn.set);
  const out = appUse.apply(this, args);
  const mounted = this.router.stack.slice(before).filter((layer) => layer.handle.name === "mounted_app");
  mounted.forEach((layer, i) => (layer.app = apps[i]));
  return out;
};

const route = Router.prototype.route;
Router.prototype.route = function (path) {
  const r = route.call(this, path);
  r.id = String(routes.length);
  routes.push(r);
  return r;
};

for (const method of ["all", ...METHODS.map((m) => m.toLowerCase())]) {
  if (typeof Route.prototype[method] !== "function") continue;
  const register = Route.prototype[method];
  Route.prototype[method] = function (...handlers) {
    const id = this.id;
    const tagged = handlers.flat(Infinity).map(
      (fn) =>
        function (req, res, next) {
          res.setHeader("x-route", id);
          return fn.call(this, req, res, next);
        },
    );
    return register.apply(this, tagged);
  };
}

const { default: app } = await import("./src/app.js");

const join = (a, b) => `${a.replace(/\/+$/, "")}/${b.replace(/^\/+/, "")}`;
const paths = (p) => (Array.isArray(p) ? p.flat(Infinity) : [p]);

/** Each route under its mount paths: `{ id, method, pattern }` in Express's syntax. */
function walk(router, prefix, out) {
  for (const layer of router.stack) {
    if (layer.route) {
      // `app.all` registers the route for every method Node knows.
      const own = Object.keys(layer.route.methods).filter((m) => m !== "_all");
      const every = layer.route.methods._all || METHODS.every((m) => own.includes(m.toLowerCase()));
      const methods = every ? ["*"] : own.map((m) => m.toUpperCase());
      for (const p of paths(layer.route.path)) for (const method of methods) out.push({ id: layer.route.id, method, pattern: join(prefix, p) });
    } else if (layer.app) {
      for (const p of paths(layer.mountedAt)) walk(layer.app.router, join(prefix, p), out);
    } else if (Array.isArray(layer.handle.stack)) {
      for (const p of paths(layer.mountedAt)) walk(layer.handle, join(prefix, p), out);
    }
  }
  return out;
}

/** The patterns an optional group `{...}` stands for: with it and without it. */
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

const canonical = (pattern) => {
  const path = pattern.replace(WILD, "{**}").replace(PARAM, "{}").replace(/\/+$/, "");
  return path || "/";
};
const sample = (pattern) => pattern.replace(WILD, "rest/of/it").replace(PARAM, "value1");

const server = app.listen(0);
await new Promise((resolve) => server.once("listening", resolve));
const base = `http://127.0.0.1:${server.address().port}`;
const out = [];
for (const r of walk(app.router, "", [])) {
  for (const pattern of expand(r.pattern)) {
    const response = await fetch(base + sample(pattern), { method: r.method === "*" ? "PATCH" : r.method });
    const answered = response.headers.get("x-route");
    if (answered !== r.id) throw new Error(`${r.method} ${pattern} is answered by route ${answered}, not by route ${r.id} that registers it`);
    out.push({ method: r.method, path: canonical(pattern), raw: pattern });
  }
}
// Sample requests, and the route Express dispatches each to: every route's sample path, also with a trailing `/`, and
// a path no route takes, each with every method a route registers. A route is told by the handler that answered; its
// path is the one of its (expanded) patterns that matches the request.
const registered = walk(app.router, "", []);
const methods = [...new Set(registered.map((r) => r.method).filter((m) => m !== "*"))].sort();
const samples = [...new Set(registered.flatMap((r) => expand(r.pattern).map((p) => sample(p).replace(/\/+$/, "") || "/")))];
const probes = [...new Set([...samples, ...samples.map((s) => (s === "/" ? s : `${s}/`)), "/nowhere/value1"])].sort();
const requests = [];
for (const path of probes) {
  for (const method of methods) {
    const response = await fetch(base + path, { method });
    const id = response.headers.get("x-route");
    if (id === null) {
      requests.push({ method, path, route: null });
      continue;
    }
    const routes = registered.filter((r) => r.id === id);
    const pattern = routes.flatMap((r) => expand(r.pattern)).find((p) => match(p.replace(/\/+$/, "") || "/", { decode: false })(path));
    if (pattern === undefined) throw new Error(`${method} ${path} is answered by route ${id}, none of whose patterns matches it`);
    requests.push({ method, path, route: `${routes[0].method === "*" ? "*" : method} ${canonical(pattern)}` });
  }
}
server.close();

const version = createRequire(import.meta.url)("express/package.json").version;
console.log(JSON.stringify({ framework: "express", version, routes: out, requests }));
