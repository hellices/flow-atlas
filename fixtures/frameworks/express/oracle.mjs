// Asks Express which routes the application serves. Express 5 keeps no path a router was mounted at, so the paths are
// recorded as the application registers them; each route is then requested through the running application, and only
// the route whose own handler answers counts, so what is written is what Express dispatches.
import express from "express";
import { METHODS } from "node:http";
import { createRequire } from "node:module";

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
    // The mark stays only on a response the handler sends: passing the request on takes it off again.
    const mark = (res, next) => {
      res.setHeader("x-route", id);
      return (...args) => {
        if (!res.headersSent && res.getHeader("x-route") === id) res.removeHeader("x-route");
        return next(...args);
      };
    };
    // Express tells an error handler by its four parameters, so one keeps them.
    const tagged = handlers.flat(Infinity).map((fn) =>
      fn.length === 4
        ? function (err, req, res, next) {
            return fn.call(this, err, req, res, mark(res, next));
          }
        : function (req, res, next) {
            return fn.call(this, req, res, mark(res, next));
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

// The path-to-regexp Express's router matches with: its own reading of a pattern's parameters, wildcards and groups.
const require = createRequire(import.meta.url);
const { parse, stringify, TokenData } = createRequire(createRequire(require.resolve("express")).resolve("router"))("path-to-regexp");

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
const base = `http://127.0.0.1:${server.address().port}`;
const out = [];
for (const r of walk(app.router, "", [])) {
  for (const tokens of expand(parse(r.pattern).tokens)) {
    const pattern = stringify(new TokenData(tokens));
    const response = await fetch(base + sample(tokens), { method: r.method === "*" ? "PATCH" : r.method, redirect: "manual" });
    const answered = response.headers.get("x-route");
    if (answered !== r.id) throw new Error(`${r.method} ${pattern} is answered by route ${answered}, not by route ${r.id} that registers it`);
    out.push({ method: r.method, path: canonical(tokens), raw: pattern });
  }
}
server.close();

const version = createRequire(import.meta.url)("express/package.json").version;
console.log(JSON.stringify({ framework: "express", version, routes: out }));
