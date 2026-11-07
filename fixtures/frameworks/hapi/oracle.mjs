// Asks hapi which routes the application serves: `server.table()`, the routing table hapi documents
// (hapi.dev/api/21.x.x#server.table()), plugins' routes under their prefixes included. Each path a route stands for is
// then requested through `server.inject`, and only the route whose own handler answers counts (an `onPostHandler`
// extension, which runs once a route's handler has, records the route), so what is written is what hapi dispatches.
import { readFileSync } from "node:fs";
import { create } from "./src/server.js";

const server = await create();
server.ext("onPostHandler", (request, h) => {
  request.app.handled = request.route;
  return h.continue;
});

/**
 * The paths a pattern stands for, each as its canonical form and the requests that must reach the route. hapi's syntax
 * (hapi.dev/api/21.x.x#path-parameters): `{name}` a parameter, whole segment or part of one; `{name?}` an optional one,
 * last or within a segment; `{name*n}` n segments; `{name*}` any number, last. A last segment that may be empty (`{name?}`,
 * `{name*}`) also takes the parent path, as hapi's router adds the route there too; both it and the parent with a `/`
 * are requested.
 */
function expand(pattern) {
  const segments = pattern.split("/").slice(1);
  const variants = segments.map((seg, i) => {
    const last = i === segments.length - 1;
    if (/^\{\w+\*\}$/.test(seg)) return [{ c: "{**}", s: ["rest/of/it"] }, null];
    const multi = /^\{\w+\*(\d+)\}$/.exec(seg);
    if (multi) return [{ c: Array(Number(multi[1])).fill("{}").join("/"), s: [Array(Number(multi[1])).fill("value1").join("/")] }];
    if (last && /^\{\w+\?\}$/.test(seg)) return [{ c: "{}", s: ["value1"] }, null];
    const plain = { c: seg.replace(/\{\w+\??\}/g, "{}"), s: [seg.replace(/\{\w+\??\}/g, "value1")] };
    // An optional parameter within a segment may be empty.
    return /\{\w+\?\}/.test(seg) ? [plain, { c: seg.replace(/\{\w+\?\}/g, ""), s: [seg.replace(/\{\w+\?\}/g, "")] }] : [plain];
  });
  let out = [{ c: [], s: [[]], parent: false }];
  for (const options of variants) {
    out = out.flatMap((p) =>
      options.map((o) =>
        o === null
          ? { ...p, parent: true }
          : { c: [...p.c, o.c], s: p.s.flatMap((prefix) => o.s.map((x) => [...prefix, x])), parent: p.parent },
      ),
    );
  }
  return out.map((p) => {
    const c = "/" + p.c.join("/");
    const samples = p.s.map((s) => "/" + s.join("/"));
    return { path: c, samples: p.parent ? [...new Set(samples.flatMap((s) => [s, s === "/" ? s : `${s}/`]))] : samples };
  });
}

const out = [];
for (const route of server.table()) {
  const method = route.method === "*" ? "*" : route.method.toUpperCase();
  for (const { path, samples } of expand(route.path)) {
    for (const sample of samples) {
      // A route for any method is asked with one no other route of the application takes.
      const response = await server.inject({ method: method === "*" ? "PATCH" : method, url: sample });
      const handled = response.request.app.handled;
      if (handled !== route.public) {
        throw new Error(`${method} ${sample} is answered by ${handled ? `${handled.method} ${handled.path}` : "no route"}, not by ${route.path} that registers it`);
      }
    }
    out.push({ method, path, raw: route.path });
  }
}

const version = JSON.parse(readFileSync(new URL("node_modules/@hapi/hapi/package.json", import.meta.url), "utf8")).version;
console.log(JSON.stringify({ framework: "hapi", version, routes: out }));
