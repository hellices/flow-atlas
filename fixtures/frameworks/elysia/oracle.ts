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

// Sample requests, and the route Elysia dispatches each to: every route's sample path (and its optional parts' paths,
// and a wildcard's parent), also with a trailing `/`, and a path no route takes, each with every method a route registers. A route is told by
// `context.route`, the path Elysia matched, with the method of the request (or `*` where that path takes any); its path
// is the one of the forms written above for it whose shape the request has. A request no route took is Elysia's 404.
const forms = new Map<string, string[]>();
for (const r of out) forms.set(r.raw, [...new Set([...(forms.get(r.raw) ?? []), r.path])]);
const escape = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const shape = (path: string) =>
  new RegExp(`^${path.split("/").map((s) => (s === "{}" ? "[^/]+" : s === "{**}" ? ".+" : escape(s))).join("/")}$`);
// HEAD and OPTIONS only where a route registers them on their own: the compared form leaves out the HEAD beside a GET
// and the OPTIONS beside another method of the same path, which the framework answers by itself.
const methodsAt = new Map<string, Set<string>>();
for (const r of out) methodsAt.set(r.path, new Set([...(methodsAt.get(r.path) ?? []), r.method]));
const own = (r: { method: string; path: string }) => r.method !== "*" && !(r.method === "HEAD" && methodsAt.get(r.path)!.has("GET")) && !(r.method === "OPTIONS" && methodsAt.get(r.path)!.size > 1);
const methods = [...new Set(out.filter(own).map((r) => r.method))].sort();
// A wildcard's parent (`/id/` for `/id/*`) is a sample path too.
const samples = [
  ...new Set(
    routes.flatMap((r) =>
      expand(r.path).flatMap((p) => [sample(p), ...(p.endsWith("/*") ? [sample(p).replace(/rest\/of\/it$/, "")] : [])]).map((p) => p.replace(/\/+$/, "") || "/"),
    ),
  ),
];
const probes = [...new Set([...samples, ...samples.map((s) => (s === "/" ? s : `${s}/`)), "/nowhere/value1"])].sort();
const requests: Array<{ method: string; path: string; route: string | null }> = [];
for (const path of probes) {
  for (const method of methods) {
    const { response, route } = await request(root, method, path);
    if (route === undefined) {
      if (response.status !== 404) throw new Error(`${method} ${path} is answered with ${response.status} by no route`);
      requests.push({ method, path, route: null });
      continue;
    }
    const any = routes.some((r) => r.path === route && r.method === "ALL");
    const takes = (m: string) => routes.some((r) => r.path === route && r.method === m);
    // A HEAD where the path registers none but a GET is Elysia's own, answered by that GET route.
    const as = method === "HEAD" && !takes("HEAD") && takes("GET") ? "GET" : method;
    if (!any && !takes(as)) throw new Error(`${method} ${path} is answered by ${route}, which takes no ${method}`);
    const form = (forms.get(route) ?? []).find((f) => shape(f).test(path.replace(/\/+$/, "") || "/"));
    if (form === undefined) throw new Error(`${method} ${path} is answered by ${route}, none of whose forms it has`);
    requests.push({ method, path, route: `${any ? "*" : as} ${form}` });
  }
}

const version = JSON.parse(readFileSync(new URL("node_modules/elysia/package.json", import.meta.url), "utf8")).version;
console.log(JSON.stringify({ framework: "elysia", version, routes: out, requests }));
