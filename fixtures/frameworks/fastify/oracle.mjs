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
await fastify.close();

const version = createRequire(import.meta.url)("fastify/package.json").version;
console.log(JSON.stringify({ framework: "fastify", version, routes: out }));
