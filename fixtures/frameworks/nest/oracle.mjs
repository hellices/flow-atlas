// Asks Nest which routes the application serves. Nest, on its default Express platform, registers each controller
// route on the Express application, at the path it builds from the global prefix and its exclusions, the URI version,
// the RouterModule paths and the controller and method paths, under a handler it names `Controller.method`. The
// application is created as `src/app.ts` builds it (after `npm run build`); the routes are read from the Express
// router Nest registered them on, kept when a controller of the application's modules handles them, checked against
// the routes Nest logs as mapped, and each is then requested through the running application: only the route whose
// own handler answers counts, so what is written is what Nest dispatches.
import { ModulesContainer } from "@nestjs/core";
import { METHODS } from "node:http";
import { createRequire } from "node:module";
import { createApp } from "./dist/app.js";

const logged = [];
const logger = {
  log: (message, context) => context === "RouterExplorer" && logged.push(String(message)),
  error: (...args) => console.error(...args),
  warn: () => {},
  debug: () => {},
  verbose: () => {},
  fatal: (...args) => console.error(...args),
};

const app = await createApp({ logger });
await app.init();

const controllers = new Set();
for (const module of app.get(ModulesContainer).values())
  for (const wrapper of module.controllers.values()) controllers.add(wrapper.name);

const NAME = /[$_\p{ID_Start}][$\u200c\u200d\p{ID_Continue}]*/u;
const PARAM = new RegExp(`:${NAME.source}`, "gu");
const WILD = new RegExp(`\\*${NAME.source}`, "gu");

/**
 * The patterns an optional group `{...}` stands for: with it and without it. Nest serves `abcd/*` as `abcd/{*path}`,
 * which also takes `abcd/` with nothing after it; both patterns are requested below, so that route is written as two.
 */
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

const canonical = (pattern) => pattern.replace(WILD, "{**}").replace(PARAM, "{}").replace(/\/+$/, "") || "/";
const sample = (pattern) => pattern.replace(WILD, "rest/of/it").replace(PARAM, "value1");

const routes = [];
const stack = app.getHttpAdapter().getInstance().router.stack;
stack.forEach((layer, id) => {
  if (!layer.route) return;
  const handlers = layer.route.stack.map((s) => s.handle);
  const own = handlers.filter((fn) => controllers.has(fn.name.split(".")[0]));
  if (own.length === 0) return;
  const methods = Object.keys(layer.route.methods).filter((m) => m !== "_all");
  const every = layer.route.methods._all || METHODS.every((m) => methods.includes(m.toLowerCase()));
  for (const s of layer.route.stack) {
    const handle = s.handle;
    s.handle = function (req, res, next) {
      res.setHeader("x-route", String(id));
      return handle.call(this, req, res, next);
    };
  }
  for (const method of every ? ["*"] : methods.map((m) => m.toUpperCase()))
    routes.push({ id: String(id), method, pattern: layer.route.path, handler: own[0].name });
});

// Nest logs each route it maps once, without the version segment and with each of a list of versions.
if (logged.filter((l) => l.startsWith("Mapped ")).length !== new Set(routes.map((r) => `${r.handler} ${r.method}`)).size)
  throw new Error(`Nest logs other routes than the Express router holds:\n${logged.join("\n")}`);

await app.listen(0, "127.0.0.1");
const base = await app.getUrl();
const out = [];
for (const r of routes) {
  for (const pattern of expand(r.pattern)) {
    const response = await fetch(base.replace("[::1]", "127.0.0.1") + sample(pattern), { method: r.method === "*" ? "PATCH" : r.method });
    const answered = response.headers.get("x-route");
    if (answered !== r.id || !response.ok)
      throw new Error(`${r.method} ${pattern} is answered by route ${answered} with ${response.status}, not by route ${r.id} (${r.handler})`);
    out.push({ method: r.method, path: canonical(pattern), raw: pattern });
  }
}
await app.close();

const version = createRequire(import.meta.url)("@nestjs/core/package.json").version;
console.log(JSON.stringify({ framework: "nestjs", version, routes: out }));
