// Asks Hono which routes the application serves. The application, grouped whole under a root (`route("/", app)`, which
// copies its route table as `app.route` does for any group), keeps every route in `routes`, the table its router is
// built from, with the documented `inspectRoutes` telling handlers from middleware. Each route is then requested
// through `app.request`, and a middleware registered first reads, once the request is answered, which matched route
// responded (`matchedRoutes(c)[c.req.routeIndex]`, as hono.dev/docs/helpers/route shows): only the route whose own
// handler answers counts, so what is written is what Hono dispatches.
import { Hono } from "hono";
import { inspectRoutes } from "hono/dev";
import { matchedRoutes } from "hono/route";
import { readFileSync } from "node:fs";
import app from "./src/app.js";

const root = new Hono();
root.use("*", async (c, next) => {
  await next();
  c.header("x-route", String(root.routes.indexOf(matchedRoutes(c)[c.req.routeIndex])));
});
root.route("/", app);

const inspected = inspectRoutes(root);
const routes = root.routes
  .map((route, id) => ({ id: String(id), method: route.method, pattern: route.path, middleware: inspected[id].isMiddleware }))
  .filter((r) => !r.middleware);

/** The patterns a route stands for: a last parameter marked optional (`:type?`) with and without it. */
const expand = (pattern) => {
  const optional = /^(.*)\/(:[^/]+)\?$/.exec(pattern);
  return optional ? [`${optional[1]}/${optional[2]}`, optional[1] || "/"] : [pattern];
};

const PARAM = /:[\w$]+(\{(?:[^{}\\]|\\.|\{[^{}]*\})*\})?/g;
/** Hono's syntax: `:name` and `:name{regexp}` a parameter, `*` one segment, and a last `*` the rest of the path. */
const canonical = (pattern) =>
  pattern.replace(PARAM, "{}").replace(/\/\*$/, "/{**}").replace(/\/\*(?=\/)/g, "/{}").replace(/\/+$/, "") || "/";
/** Requests for a pattern: each parameter tried with a few values, since a regexp may refuse one. */
function* samples(pattern) {
  const parts = pattern.replace(/\/\*$/, "/rest/of/it").replace(/\/\*(?=\/)/g, "/value1").split(PARAM);
  // `split` with the regexp's group interleaves the text with each parameter's regexp (or undefined).
  const texts = parts.filter((_, i) => i % 2 === 0);
  const holes = texts.length - 1;
  const values = ["value1", "12", "abc"];
  for (let n = 0; n < values.length ** holes; n++) {
    let path = texts[0];
    for (let h = 0; h < holes; h++) path += values[Math.floor(n / values.length ** h) % values.length] + texts[h + 1];
    yield path;
  }
}

/**
 * Whether Hono also dispatches a pattern ending in a wildcard when nothing follows its last `/`: asked of an
 * application holding that pattern alone, so another route cannot answer in its place.
 */
async function takesParent(pattern) {
  const alone = new Hono();
  alone.get(pattern, (c) => c.text("alone"));
  const response = await alone.request(pattern.replace(/\*$/, "").replace(PARAM, "value1"));
  return response.status === 200 && (await response.text()) === "alone";
}

const out = [];
for (const r of routes) {
  const method = r.method === "ALL" ? "*" : r.method;
  for (const pattern of expand(r.pattern)) {
    let answered;
    for (const path of samples(pattern)) {
      const response = await root.request(path, { method: method === "*" ? "PATCH" : method });
      answered = response.headers.get("x-route");
      if (answered === r.id) break;
    }
    if (answered !== r.id) throw new Error(`${method} ${pattern} is answered by route ${answered}, not by route ${r.id} that registers it`);
    out.push({ method, path: canonical(pattern), raw: pattern });
    // A route that also takes its parent path with a trailing `/` is written as two: the parent, and `/{**}`.
    if (canonical(pattern).endsWith("/{**}") && (await takesParent(pattern))) {
      out.push({ method, path: canonical(pattern).slice(0, -"/{**}".length) || "/", raw: pattern });
    }
  }
}

// hono exports no package.json.
const version = JSON.parse(readFileSync(new URL("node_modules/hono/package.json", import.meta.url), "utf8")).version;
console.log(JSON.stringify({ framework: "hono", version, routes: out }));
