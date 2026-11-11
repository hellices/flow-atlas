import { describe, expect, it } from "vitest";
import { normalizeConfig } from "../src/config.js";
import { extractRoutes } from "../src/extract/routes.js";
import type { Source } from "../src/source.js";

/** The ways a framework documents to register a route, beyond `router.get(path, handler)` (#47). */
const memory = (files: Record<string, string>): Source => ({
  ref: "WORKTREE",
  list: () => Object.keys(files),
  read: (p) => files[p],
  asOf: () => "2026-11-01T00:00:00Z",
});

const routes = (files: Record<string, string>, entry: Record<string, unknown> = { styles: ["express"] }) => {
  const limits: string[] = [];
  const config = normalizeConfig({ components: [{ name: "api", path: "api" }], routes: [{ component: "api", files: ["api/**/*.{js,ts}"], ...entry }] });
  const surfaces = extractRoutes(memory(files), config, undefined, [], limits);
  return { ids: surfaces.map((s) => `${s.method} ${s.path}`).sort(), limits };
};
const lines = (...l: string[]) => l.join("\n");
const pkg = (deps: Record<string, string>) => JSON.stringify({ dependencies: deps });

describe("Express: route(path) and arrays of paths", () => {
  it("reads the methods chained on route(path), under the router's mount and in its syntax", () => {
    const files = {
      "api/package.json": pkg({ express: "^5.1.0" }),
      "api/app.js": lines(
        'import express from "express";',
        'import users from "./users.js";',
        "const app = express();",
        'app.route("/book").get(h).post(h).put(h);',
        'app.route("/files/*path").all(h);',
        'app.use("/users", users);',
      ),
      "api/users.js": lines('import { Router } from "express";', "const router = Router();", "router", '  .route("/:id")', "  .get(h)", "  .delete(h);", "export default router;"),
    };
    expect(routes(files)).toEqual({ ids: ["* /files/{path}/**", "DELETE /users/{id}", "GET /book", "GET /users/{id}", "POST /book", "PUT /book"], limits: [] });
  });

  it("places each method chained on route(path) where it is named", () => {
    const files = { "api/app.js": lines('const app = require("express")();', "app", '  .route("/book")', "  .get(h)", "  .post(h);") };
    const config = normalizeConfig({ components: [{ name: "api", path: "api" }], routes: [{ component: "api", files: ["api/**"], styles: ["express"] }] });
    const lines_ = extractRoutes(memory(files), config).map((s) => `${s.method} ${s.at.line}`);
    expect(lines_.sort()).toEqual(["GET 4", "POST 5"]);
  });

  it("reads every path of an array on Express and @koa/router, and says where an array is not read", () => {
    const files = {
      "api/package.json": pkg({ express: "^5.1.0", "@koa/router": "^15.0.0" }),
      "api/app.js": lines(
        'import express from "express";',
        'import Router from "@koa/router";',
        "const app = express();",
        'app.get(["/help", "/faq"], h);',
        'app.route(["/a", "/b"]).post(h);',
        'app.get(["/x", HELP], h);',
        "const router = new Router();",
        'router.get(["/people", "/persons"], h);',
        "export { router };",
        'server.get(["/u", "/v"], h);',
      ),
    };
    expect(routes(files, { styles: ["express"], mounts: { "api/app.js": "/" } })).toEqual({
      ids: ["GET /faq", "GET /help", "GET /people", "GET /persons", "POST /a", "POST /b"],
      limits: [
        'routes api: api/app.js:10 registers an array of paths (["/u", "/v"]) on server, which atlas reads only on a router traced to Express or @koa/router; its routes are not read',
        'routes api: api/app.js:6 registers a path the file does not spell out (["/x", HELP]); its routes are not read',
      ],
    });
  });
});

describe("@koa/router: chains, named routes, redirects and every method", () => {
  it("reads verbs chained on the router, after param, named routes, redirect, del and other methods", () => {
    const files = {
      "api/package.json": pkg({ "@koa/router": "^15.7.0", koa: "^3.0.0" }),
      "api/app.js": lines(
        'import Koa from "koa";',
        'import Router from "@koa/router";',
        'const router = new Router({ prefix: "/api" });',
        'router.get("/users", h).post("/users", h).all("/users/:id", h);',
        'router.param("article", load).get("/articles/:article", h);',
        'router.get("user", "/user/:id", h);',
        'router.redirect("/login", "sign-in");',
        'router.del("/sessions/:id", h);',
        'router.purge("/cache/:key", h);',
        "const app = new Koa();",
        "app.use(router.routes());",
      ),
    };
    expect(routes(files)).toEqual({
      ids: [
        "* /api/login",
        "* /api/users/{id}",
        "DELETE /api/sessions/{id}",
        "GET /api/articles/{article}",
        "GET /api/user/{id}",
        "GET /api/users",
        "POST /api/users",
        "PURGE /api/cache/{key}",
      ],
      limits: [],
    });
  });

  it("says where a redirect's source names a route, and where a path does not start with `/`", () => {
    const files = {
      "api/package.json": pkg({ "@koa/router": "^15.7.0" }),
      "api/app.js": lines('import Router from "@koa/router";', "const router = new Router();", 'router.redirect("old", "/new");', 'router.get("items", h);', "export default router;"),
    };
    expect(routes(files, { styles: ["express"], mounts: { "api/app.js": "/" } })).toEqual({
      ids: [],
      limits: [
        'routes api: api/app.js:3 redirects from the route named "old" on router, at the path @koa/router builds from it; its route is not read',
        'routes api: api/app.js:4 registers "items" on router, a path that does not start with `/`; its routes are not read',
      ],
    });
  });
});

describe("Fastify: route(options) and the QUERY method", () => {
  const files = (body: string[]) => ({
    "api/package.json": pkg({ fastify: "^5.12.0" }),
    "api/app.js": lines('import Fastify from "fastify";', "const fastify = Fastify();", ...body),
  });

  it("reads the method or methods and the url, or the path where no url is given, of a full declaration", () => {
    const body = [
      'fastify.route({ method: "GET", url: "/hello", schema: {}, handler: h });',
      'fastify.route({ method: ["POST", "put"], path: "/items", handler: h });',
      'fastify.route({ method: "GET", url: "/versioned", constraints: { version: "1.2.0" }, handler: h });',
      'fastify.route({ method: "DELETE", url: "", path: "/both", handler: h });',
      'fastify.route({ ["method"]: "PATCH", ["url"]: "/computed", handler: h }).get("/chained", h);',
      'fastify.query("/search", h);',
    ];
    expect(routes(files(body))).toEqual({
      ids: ["DELETE /both", "GET /chained", "GET /hello", "GET /versioned", "PATCH /computed", "POST /items", "PUT /items", "QUERY /search"],
      limits: [],
    });
  });

  it("says where a declaration's method, url or options are not spelled out", () => {
    const body = [
      'fastify.route({ method: METHOD, url: "/a", handler: h });',
      'fastify.route({ method: "GET", url: URL, handler: h });',
      'fastify.route({ ...base, url: "/c", handler: h });',
      'fastify.route({ method: "GET", [key]: "/d", handler: h });',
      'fastify.route({ method: "GET", url: "e", handler: h });',
    ];
    expect(routes(files(body))).toEqual({
      ids: [],
      limits: [
        "routes api: api/app.js:3 declares a route with a method the file does not spell out (METHOD); its routes are not read",
        "routes api: api/app.js:5 declares a route with options the file does not spell out (...base); its routes are not read",
        'routes api: api/app.js:6 declares a route with options the file does not spell out ([key]: "/d"); its routes are not read',
        'routes api: api/app.js:7 registers "e" on fastify, a path that does not start with `/`; its routes are not read',
        "routes api: api/app.js:4 registers a path the file does not spell out (URL); its routes are not read",
      ],
    });
  });
});

describe("Hono: on, a method with no path, and paths without a leading `/`", () => {
  const files = (body: string[]) => ({
    "api/package.json": pkg({ hono: "^4.13.0" }),
    "api/app.ts": lines('import { Hono } from "hono";', "const app = new Hono();", ...body),
  });

  it("reads each method of on at each of its paths, custom methods and all included", () => {
    const body = ['app.on("PURGE", "/cache", h);', 'app.on(["PUT", "DELETE"], "/post", h);', 'app.on("GET", ["/greet", "/ja/greet"], h);', 'app.on("all", "/any", h);', 'app.on("GET", "/set");'];
    expect(routes(files(body))).toEqual({ ids: ["* /any", "DELETE /post", "GET /greet", "GET /ja/greet", "PURGE /cache", "PUT /post"], limits: [] });
  });

  it("reads a method with no path at the path the call before it in the chain set", () => {
    const body = [
      "const h = (c) => c.text('ok');",
      'app.get("/endpoint", h).post((c) => c.text("post")).delete(h);',
      'app.get("/only").put(h);',
      'app.on("GET", ["/a", "/b"], h).patch(h);',
      'new Hono().basePath("/v").post(h);',
      "app.query(h);",
      "app.options(handler);",
    ];
    expect(routes(files(body))).toEqual({
      ids: ["DELETE /endpoint", "GET /a", "GET /b", "GET /endpoint", "PATCH /b", "POST /endpoint", "POST /v", "PUT /only"],
      limits: [
        "routes api: api/app.ts:8 registers QUERY on app with no path, at the one the last registration on it set; its route is not read",
        "routes api: api/app.ts:9 registers OPTIONS on app with handler, a path or a handler the file does not settle; its route is not read",
      ],
    });
  });

  it("joins a path without a leading `/` as Hono does, the fallback `*` included, and leaves an empty one unread", () => {
    const body = ['app.get("*", h);', 'app.get("users", h);', 'app.query("/search", h);', 'app.get("", h);'];
    expect(routes(files(body))).toEqual({
      ids: ["GET /**", "GET /users", "QUERY /search"],
      limits: ['routes api: api/app.ts:6 registers "" on app, a path that does not start with `/`; its routes are not read'],
    });
  });
});

describe("routes chained on a receiver no router is traced to", () => {
  it("reads the first registration, and says the ones chained after it are not read", () => {
    const files = { "api/app.js": lines("group((app) =>", '  app.post("/sign-in", h)', '    .post("/sign-up", h));') };
    expect(routes(files)).toEqual({
      ids: ["POST /sign-in"],
      limits: ["routes api: api/app.js:3 registers a route chained on app, which atlas does not trace to Express, @koa/router, Fastify or Hono; its route is not read"],
    });
  });
});
