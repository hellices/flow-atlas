// Asks Elysia which routes the application serves: `app.routes`, the table of every route the application registers
// (groups, prefixed plugins and mounts expanded, a deduplicated plugin once), which its router is built from. Each
// route is then requested through `handle`, Elysia's own dispatch of a `Request` (elysiajs.com/essential/route#handle),
// on an instance using the application whose global `onAfterHandle` hook, run once a route's handler has, records the
// route Elysia matched (`context.route`): only the route whose own handler answers counts, so what is written is what
// Elysia dispatches.
import { Elysia } from "elysia";
import { readFileSync } from "node:fs";
import { app } from "./src/app";

const answered = new WeakMap<Request, string>();
const root = new Elysia()
  .onAfterHandle({ as: "global" }, ({ request, route }) => {
    answered.set(request, route);
  })
  .use(app);

const routes = app.routes.map((r) => ({ method: r.method, path: r.path }));
if (root.routes.length !== routes.length || root.routes.some((r, i) => r.method !== routes[i].method || r.path !== routes[i].path)) {
  throw new Error("the instance asked holds other routes than the application");
}
// `context.route` names the path matched; a path that takes any method beside a route of one method would not tell
// which of the two answered.
for (const r of routes) {
  if (r.method === "ALL" && routes.some((o) => o.path === r.path && o.method !== "ALL")) throw new Error(`${r.path} takes any method beside one method`);
}

/** The patterns a route stands for: a last parameter marked optional (`:id?`) with and without it. */
const expand = (pattern: string) => {
  const optional = /^(.*)\/(:[^/]+)\?$/.exec(pattern);
  return optional ? [`${optional[1]}/${optional[2]}`, optional[1] || "/"] : [pattern];
};
/** Elysia's syntax: `:name` a parameter (a whole segment), and a last `*` the rest of the path. */
const canonical = (pattern: string) =>
  pattern.replace(/:[^/]+/g, "{}").replace(/\/\*$/, "/{**}").replace(/\/+$/, "") || "/";
const sample = (pattern: string) => pattern.replace(/:[^/]+/g, "value1").replace(/\/\*$/, "/rest/of/it");

async function request(router: Elysia<any>, method: string, path: string) {
  const body = method === "GET" || method === "HEAD" ? {} : { body: JSON.stringify({ name: "value1" }), headers: { "content-type": "application/json" } };
  const req = new Request(`http://localhost${path}`, { method, ...body });
  const response = await router.handle(req);
  return { response, route: answered.get(req) };
}

/**
 * Whether Elysia also dispatches a pattern ending in a wildcard when nothing follows its last `/`: asked of an instance
 * holding that pattern alone, so another route cannot answer in its place.
 */
async function takesParent(method: string, pattern: string) {
  const alone = method === "*" ? new Elysia().all(pattern, () => "alone") : new Elysia().route(method, pattern, () => "alone");
  const { response } = await request(alone, method === "*" ? "PATCH" : method, sample(pattern).replace(/rest\/of\/it$/, ""));
  return response.status === 200 && (await response.text()) === "alone";
}

const out: Array<{ method: string; path: string; raw: string }> = [];
for (const r of routes) {
  const method = r.method === "ALL" ? "*" : r.method;
  for (const pattern of expand(r.path)) {
    // A route for any method is asked with one no route of the application registers at its path.
    const { route } = await request(root, method === "*" ? "PATCH" : method, sample(pattern));
    if (route !== r.path) throw new Error(`${method} ${pattern} is answered by ${route ?? "no route"}, not by ${r.path} that registers it`);
    out.push({ method, path: canonical(pattern), raw: r.path });
    // A route that also takes its parent path with a trailing `/` is written as two: the parent, and `/{**}`.
    if (canonical(pattern).endsWith("/{**}") && (await takesParent(method, pattern))) {
      out.push({ method, path: canonical(pattern).slice(0, -"/{**}".length) || "/", raw: r.path });
    }
  }
}

const version = JSON.parse(readFileSync(new URL("node_modules/elysia/package.json", import.meta.url), "utf8")).version;
console.log(JSON.stringify({ framework: "elysia", version, routes: out }));
