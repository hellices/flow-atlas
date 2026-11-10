// Asks Fastify which routes the application serves. Fastify passes every route it registers, under the prefixes of the
// plugins it is registered in, to the `onRoute` hook (fastify.dev/docs/latest/Reference/Hooks/#onroute); each one is
// then requested through `inject`, and only the route whose own handler answers counts, so what is written is what
// Fastify's router dispatches.
import Fastify from "fastify";
import { createRequire } from "node:module";
import app from "./src/app.js";

const fastify = Fastify();
const registered = [];
fastify.addHook("onRoute", (route) => {
  const id = String(registered.length);
  registered.push({ id, method: route.method, url: route.url, constraints: route.constraints ?? {} });
  const handler = route.handler;
  route.handler = function (request, reply) {
    reply.header("x-route", id);
    reply.header("x-params", JSON.stringify(request.params ?? {}));
    return handler.call(this, request, reply);
  };
});
fastify.register(app);
await fastify.ready();

/**
 * The patterns a URL stands for: a last parameter marked optional (`:id?`) with and without it, as find-my-way
 * registers it.
 */
const expand = (url) => {
  const optional = /^(.*)\/:([^/?]+)\?$/.exec(url);
  return optional ? [`${optional[1]}/:${optional[2]}`, optional[1] || "/"] : [url];
};

/**
 * find-my-way's syntax, segment by segment: `::` is a colon, `:name` and `:name(regexp)` a parameter, a last `*` the
 * rest. `param` is what a parameter becomes, or a function of its regexp (undefined for none) giving that.
 */
function read(pattern, param, rest) {
  let out = "";
  for (let i = 0; i < pattern.length; i++) {
    const c = pattern[i];
    if (c === ":" && pattern[i + 1] === ":") {
      out += ":";
      i++;
    } else if (c === ":") {
      i++;
      while (i < pattern.length && /[\w$]/.test(pattern[i])) i++;
      let regexp;
      if (pattern[i] === "(") {
        const start = i + 1;
        for (let depth = 0; i < pattern.length; i++) {
          if (pattern[i] === "\\") i++;
          else if (pattern[i] === "(") depth++;
          else if (pattern[i] === ")" && --depth === 0) break;
        }
        regexp = pattern.slice(start, i);
      } else i--;
      out += typeof param === "function" ? param(regexp) : param;
    } else if (c === "*" && i === pattern.length - 1) out += rest;
    else out += c;
  }
  return out;
}
const VALUES = ["12", "abc", "value1", "a-b", "00000000-0000-0000-0000-000000000001"];
/** A value for a parameter: one its regexp takes whole, when it has one. */
const value = (regexp) => {
  if (regexp === undefined) return VALUES[0];
  const found = VALUES.find((v) => new RegExp(`^(?:${regexp})$`).test(v));
  if (found === undefined) throw new Error(`none of ${VALUES.join(", ")} is a value of the parameter (${regexp})`);
  return found;
};
const canonical = (pattern) => read(pattern, "{}", "{**}").replace(/\/+$/, "") || "/";
const sample = (pattern) => read(pattern, value, "rest/of/it");

/**
 * Whether find-my-way also dispatches a pattern ending in a wildcard when nothing follows its last `/`: asked of an
 * instance holding that pattern alone, so another route of the application cannot answer in its place.
 */
async function takesParent(pattern) {
  const alone = Fastify();
  alone.get(pattern, async () => "alone");
  const response = await alone.inject({ method: "GET", url: sample(pattern).replace(/rest\/of\/it$/, "") });
  await alone.close();
  return response.statusCode === 200 && response.body === "alone";
}

const out = [];
for (const r of registered) {
  const methods = [r.method].flat();
  const every = fastify.supportedMethods.every((m) => methods.includes(m));
  const headers = {};
  if (r.constraints.version) headers["accept-version"] = r.constraints.version;
  if (r.constraints.host) headers.host = r.constraints.host;
  for (const pattern of expand(r.url)) {
    for (const method of every ? ["*"] : methods) {
      const sent = method === "*" ? "PATCH" : method;
      // A body for the methods that take one: Fastify answers a QUERY with no Content-Type itself (415).
      const body = sent === "GET" || sent === "HEAD" ? {} : { payload: "{}", headers: { ...headers, "content-type": "application/json" } };
      const response = await fastify.inject({ method: sent, url: sample(pattern), headers, ...body });
      const answered = response.headers["x-route"];
      if (answered !== r.id) throw new Error(`${method} ${pattern} is answered by route ${answered}, not by route ${r.id} that registers it`);
      out.push({ method, path: canonical(pattern), raw: pattern });
      // A route that also takes its parent path with a trailing `/` is written as two: the parent, and `/{**}`.
      if (canonical(pattern).endsWith("/{**}") && (await takesParent(pattern))) {
        out.push({ method, path: canonical(pattern).slice(0, -"/{**}".length) || "/", raw: pattern });
      }
    }
  }
}

/** A request as a client sends it, with a JSON body for the methods that take one (see above). */
const injected = (method, url) =>
  method === "GET" || method === "HEAD" ? { method, url } : { method, url, payload: "{}", headers: { "content-type": "application/json" } };

/**
 * The route key a request reached, from Fastify's own report of the route that answered (its `url`) and the parameters
 * find-my-way matched: an optional last parameter left out is the path without it, and a wildcard that took nothing
 * is its parent path.
 */
function keyOf(r, method, params) {
  const optional = /^(.*)\/:([^/?]+)\?$/.exec(r.url);
  const pattern = optional ? (params[optional[2]] === undefined ? optional[1] || "/" : `${optional[1]}/:${optional[2]}`) : r.url;
  const key = canonical(pattern);
  const every = fastify.supportedMethods.every((m) => [r.method].flat().includes(m));
  return `${every ? "*" : method} ${params["*"] === "" && key.endsWith("/{**}") ? key.slice(0, -"/{**}".length) || "/" : key}`;
}

// Sample requests, and the route Fastify dispatches each to: every route's sample path, also with a trailing `/`, and
// a path no route takes, each with every method a route registers. A route is told by the handler that answered. The
// requests carry no `Accept-Version`, so the version-constrained `/versioned` routes take none of them. Fastify
// redirects no request: a path with a trailing `/` is a 404 unless a route takes it, as a prefixed plugin's `/` route
// does (registered as both `/api` and `/api/`, the documented `prefixTrailingSlash: "both"`, one route).
// HEAD and OPTIONS only where a route registers them on their own: the compared form leaves out the HEAD beside a GET
// and the OPTIONS beside another method of the same path, which the framework answers by itself.
const methodsAt = new Map();
for (const r of out) methodsAt.set(r.path, new Set([...(methodsAt.get(r.path) ?? []), r.method]));
const own = (r) => r.method !== "*" && !(r.method === "HEAD" && methodsAt.get(r.path).has("GET")) && !(r.method === "OPTIONS" && methodsAt.get(r.path).size > 1);
const methods = [...new Set(out.filter(own).map((r) => r.method))].sort();
// A wildcard's parent path (written without its `/{**}`) is sampled without the rest.
const parent = (r) => r.raw?.endsWith("*") && !r.path.endsWith("/{**}");
const samples = [...new Set(out.map((r) => (parent(r) ? sample(r.raw).slice(0, -"rest/of/it".length) : sample(r.raw ?? r.path)).replace(/\/+$/, "") || "/"))];
const probes = [...new Set([...samples, ...samples.map((s) => (s === "/" ? s : `${s}/`)), "/nowhere/value1"])].sort();
const requests = [];
for (const path of probes) {
  for (const method of methods) {
    const response = await fastify.inject(injected(method, path));
    const id = response.headers["x-route"];
    if (id === undefined) {
      requests.push({ method, path, route: null });
      continue;
    }
    requests.push({ method, path, route: keyOf(registered[Number(id)], method, JSON.parse(response.headers["x-params"])) });
  }
}
await fastify.close();

const version = createRequire(import.meta.url)("fastify/package.json").version;
console.log(JSON.stringify({ framework: "fastify", version, routes: out, requests }));
