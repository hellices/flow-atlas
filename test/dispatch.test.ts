import { describe, expect, it } from "vitest";
import { normalizeConfig } from "../src/config.js";
import { extractRoutes } from "../src/extract/routes.js";
import { readFindMyWay, readPathToRegexp01 } from "../src/extract/syntax.js";
import { constrainedLimits, matchCalls, rankedComponents, redirectedLimits, shadowedRoutes } from "../src/match.js";
import type { Call, Graph } from "../src/model.js";
import { evaluate } from "../src/rules.js";
import { scan } from "../src/scan.js";
import type { Source } from "../src/source.js";

const memory = (files: Record<string, string>): Source => ({
  ref: "WORKTREE",
  list: () => Object.keys(files),
  read: (p) => files[p],
  asOf: () => "2026-11-01T00:00:00Z",
});
const lines = (...l: string[]) => l.join("\n");
const pkg = (deps: Record<string, string>) => JSON.stringify({ dependencies: deps });

/** A call to `api` as a sample request is written: `METHOD /path`, a `/` at its end kept as the call's `slash`. */
const call = (request: string, i = 0): Call => {
  const [method, raw] = request.split(" ") as [string, string];
  return {
    id: `web->api|${request}@x:${i + 1}`,
    from: "web",
    to: "api",
    method,
    path: raw.replace(/\/+$/, "") || "/",
    based: false,
    ...(raw.length > 1 && raw.endsWith("/") ? { slash: true as const } : {}),
    at: { file: "x", line: i + 1 },
    evidence: "text",
  };
};

/**
 * What each request reaches among the routes the files register: `METHOD /path` of each target, `redirect: ...` where
 * its router answers with a redirect, `constrained: ...` where the routes it fits take only some headers; with the
 * limits the routes' reading gave and the limits matching gave.
 */
const reach = (files: Record<string, string>, entry: Record<string, unknown>, requests: string[]) => {
  const limits: string[] = [];
  const config = normalizeConfig({ components: [{ name: "api", path: "api" }], routes: [{ component: "api", files: ["api/**"], ...entry }] });
  const surfaces = extractRoutes(memory(files), config, undefined, [], limits);
  const calls = requests.map(call);
  const m = matchCalls({ surfaces, calls }, rankedComponents(config));
  const out: Record<string, string[]> = {};
  requests.forEach((r, i) => {
    const targets = (m.targetsOf.get(i) ?? []).map((s) => `${s.method} ${s.path}`).sort();
    const redirected = m.redirected.get(i);
    const held = m.constrained.get(i);
    out[r] = [
      ...targets,
      ...(redirected ? [`redirect ${redirected.path}${redirected.slash ? "/" : ""}: ${redirected.surfaces.map((s) => `${s.method} ${s.path}`).join(", ")}`] : []),
      ...(held ? [`constrained: ${held.map((s) => `${s.method} ${s.path}`).join(", ")}`] : []),
    ];
  });
  return { reached: out, limits, matched: [...redirectedLimits({ calls }, m.redirected), ...constrainedLimits({ calls }, m.constrained)] };
};

const express = { styles: ["express"] };
const express5 = { "api/package.json": pkg({ express: "^5.1.0" }) };

describe("registration order", () => {
  it("answers a request with the first Express route registered that takes it, and every value a call may hold with each that may", () => {
    const files = {
      ...express5,
      "api/app.js": lines(
        'import express from "express";',
        "const app = express();",
        'app.get("/users/me", (req, res) => res.send("me"));',
        'app.get("/users/:id", (req, res) => res.send("user"));',
        'app.delete("/users/:id", (req, res) => res.send("gone"));',
      ),
    };
    expect(reach(files, express, ["* /users/me", "DELETE /users/me", "GET /users/me", "GET /users/{}"]).reached).toEqual({
      "GET /users/me": ["GET /users/me"],
      // `/users/me` takes only the value `me`, so a call with a value in its place may reach either.
      "GET /users/{}": ["GET /users/me", "GET /users/{id}"],
      "DELETE /users/me": ["DELETE /users/{id}"],
      // Its method may be GET or DELETE, which reach different routes: it is left unsettled.
      "* /users/me": [],
    });
  });

  it("keeps a later route where the first passes the request on with next, or where its handler is not seen", () => {
    const files = {
      ...express5,
      "api/app.js": lines(
        'import express from "express";',
        'import { me } from "./handlers.js";',
        "const app = express();",
        'app.get("/a/me", (req, res, next) => next());',
        'app.get("/a/:id", (req, res) => res.send("a"));',
        'app.get("/b/me", (req, res, next) => { try { res.send("me"); } catch (e) { next(e); } });',
        'app.get("/b/:id", (req, res) => res.send("b"));',
        'app.get("/c/me", (req, res, next) => next("route"));',
        'app.get("/c/:id", (req, res) => res.send("c"));',
        'app.get("/d/me", me);',
        'app.get("/d/:id", (req, res) => res.send("d"));',
      ),
    };
    expect(reach(files, express, ["GET /a/me", "GET /b/me", "GET /c/me", "GET /d/me"]).reached).toEqual({
      "GET /a/me": ["GET /a/me", "GET /a/{id}"],
      // `next(err)` goes to the error handlers, not to another route.
      // `next(e)` with a value that may be falsy is no error to Express (router 2's `next`): it may move on.
      "GET /b/me": ["GET /b/me", "GET /b/{id}"],
      "GET /c/me": ["GET /c/me", "GET /c/{id}"],
      "GET /d/me": ["GET /d/me", "GET /d/{id}"],
    });
  });

  it("keeps a later route where an earlier callback of the route may leave it with next('route'), or is not seen", () => {
    const files = {
      ...express5,
      "api/app.js": lines(
        'import express from "express";',
        'import { auth } from "./auth.js";',
        "const app = express();",
        'app.get("/a/:id", (req, res, next) => (req.params.id === "me" ? next("route") : next()), (req, res) => res.send("a"));',
        'app.get("/a/me", (req, res) => res.send("me"));',
        'app.get("/b/:id", auth, (req, res) => res.send("b"));',
        'app.get("/b/me", (req, res) => res.send("me"));',
        'app.get("/c/:id", (req, res, next) => next(), (req, res) => res.send("c"));',
        'app.get("/c/me", (req, res) => res.send("me"));',
      ),
    };
    expect(reach(files, express, ["GET /a/me", "GET /b/me", "GET /c/me"]).reached).toEqual({
      "GET /a/me": ["GET /a/me", "GET /a/{id}"],
      "GET /b/me": ["GET /b/me", "GET /b/{id}"],
      // A callback's `next()` moves on to the route's next callback, which answers.
      "GET /c/me": ["GET /c/{id}"],
    });
  });

  it("orders a mounted router's routes where the mount is, and leaves routes of another file or a function body unordered", () => {
    const files = {
      ...express5,
      "api/app.js": lines(
        'import express from "express";',
        'import users from "./users.js";',
        "const app = express();",
        'app.get("/users/:id", (req, res) => res.send("user"));',
        'app.use("/users", users);',
        'app.get("/files/:name", (req, res) => res.send("file"));',
        "export default app;",
      ),
      "api/users.js": lines('import express from "express";', "const users = express.Router();", 'users.get("/me", (req, res) => res.send("me"));', "export default users;"),
      "api/more.js": lines('import app from "./app.js";', 'app.get("/files/readme", (req, res) => res.send("readme"));'),
      "api/later.js": lines(
        'import express from "express";',
        "const app = express();",
        "function late() {",
        '  app.get("/x/:id", (req, res) => res.send("x"));',
        "}",
        'app.get("/x/me", (req, res) => res.send("me"));',
        "late();",
      ),
    };
    expect(reach(files, express, ["GET /files/readme", "GET /users/me", "GET /x/me"]).reached).toEqual({
      // `/users/:id` is registered before the mount that serves `/users/me`.
      "GET /users/me": ["GET /users/{id}"],
      "GET /files/readme": ["GET /files/readme", "GET /files/{name}"],
      "GET /x/me": ["GET /x/me", "GET /x/{id}"],
    });
  });

  it("lets a @koa/router route that calls next hand the request to the next route a request fits", () => {
    const files = {
      "api/package.json": pkg({ "@koa/router": "^15.0.0" }),
      "api/app.js": lines(
        'import Koa from "koa";',
        'import Router from "@koa/router";',
        "const app = new Koa();",
        "const router = new Router();",
        "const log = async (ctx, next) => { await next(); };",
        'router.all("/x/:id", log).get("/x/:id", (ctx) => { ctx.body = "x"; });',
        'router.delete("/y/:id", (ctx) => { ctx.status = 204; }).all("/y/:id", log);',
        "app.use(router.routes());",
      ),
    };
    expect(reach(files, express, ["GET /x/1", "DELETE /y/1"]).reached).toEqual({ "GET /x/1": ["* /x/{id}", "GET /x/{id}"], "DELETE /y/1": ["DELETE /y/{id}"] });
  });

  it("leaves a router mounted twice, @koa/router's exclusive routers and Express's strict routing out of order or trailing-slash rules", () => {
    const files = {
      "api/package.json": pkg({ express: "^5.1.0", "@koa/router": "^15.0.0" }),
      "api/app.js": lines(
        'import express from "express";',
        "const app = express();",
        "const r = express.Router();",
        'r.get("/me", (req, res) => res.send("me"));',
        'r.get("/:id", (req, res) => res.send("id"));',
        'app.use("/a", r);',
        'app.use("/b", r);',
        'app.set("strict routing", flag);',
        'app.get("/s", (req, res) => res.send("s"));',
      ),
      "api/koa.js": lines(
        'import Koa from "koa";',
        'import Router from "@koa/router";',
        "const app = new Koa();",
        "const k = new Router({ exclusive: true });",
        'k.get("/k/me", (ctx) => { ctx.body = "me"; });',
        'k.get("/k/:id", (ctx) => { ctx.body = "id"; });',
        "app.use(k.routes());",
      ),
    };
    const { reached } = reach(files, express, ["GET /a/me", "GET /k/me", "GET /s/"]);
    expect(reached).toEqual({
      "GET /a/me": ["GET /a/me", "GET /a/{id}"],
      "GET /k/me": ["GET /k/me", "GET /k/{id}"],
      "GET /s/": ["GET /s"],
    });
  });

  it("reads Hono's fallback after the routes before it, and its strict paths unless strict is false", () => {
    const files = {
      "api/package.json": pkg({ hono: "^4.6.0" }),
      "api/app.js": lines(
        'import { Hono } from "hono";',
        'import book from "./book.js";',
        "const app = new Hono();",
        'app.get("/hello", (c) => c.text("hi"));',
        'app.route("/book", book);',
        'app.get("*", (c) => c.text("fallback"));',
      ),
      "api/book.js": lines('import { Hono } from "hono";', "const book = new Hono();", 'book.get("/", (c) => c.text("books"));', "export default book;"),
      "api/loose.js": lines('import { Hono } from "hono";', "const loose = new Hono({ strict: false });", 'loose.get("/loose", (c) => c.text("loose"));'),
      "api/unread.js": lines('import { Hono } from "hono";', "const other = new Hono(options);", 'other.get("/other", (c) => c.text("other"));'),
      "api/flag.js": lines('import { Hono } from "hono";', 'const flagged = new Hono({ strict: process.env.S === "1" });', 'flagged.get("/flagged", (c) => c.text("flagged"));'),
    };
    expect(reach(files, express, ["GET /book", "GET /book/", "GET /hello", "GET /hello/", "GET /loose/", "GET /other/", "GET /flagged/"]).reached).toEqual({
      "GET /hello": ["GET /hello"],
      "GET /book": ["GET /book"],
      // `/book/` is no path of the group's `/`; the fallback takes it.
      "GET /book/": ["GET /**"],
      "GET /hello/": ["GET /**"],
      "GET /loose/": ["GET /**", "GET /loose"],
      // Options atlas does not read leave the `/` matched either way.
      "GET /other/": ["GET /**", "GET /other"],
      "GET /flagged/": ["GET /**", "GET /flagged"],
    });
  });

  it("reads Nest's declaration order on Express, but not under another routeResolutionStrategy", () => {
    const controller = lines(
      "import { Controller, Get } from '@nestjs/common';",
      "@Controller('users')",
      "export class UsersController {",
      "  @Get(':id') one() {}",
      "  @Get('me') me() {}",
      "}",
    );
    const nest = (main: string, core = "^12.0.0") => ({
      "api/package.json": pkg({ "@nestjs/core": core, "@nestjs/platform-express": core }),
      "api/users.controller.ts": controller,
      "api/main.ts": lines("import { NestFactory } from '@nestjs/core';", main),
    });
    const run = (main: string, core?: string) => reach(nest(main, core), { styles: ["nest"] }, ["GET /users/me"]).reached["GET /users/me"];
    expect(run("const app = await NestFactory.create(AppModule);")).toEqual(["GET /users/{id}"]);
    expect(run("const app = await NestFactory.create(AppModule, { routeResolutionStrategy: 'declaration' });")).toEqual(["GET /users/{id}"]);
    // The literal segment ranks before the parameter, whatever the declaration order.
    expect(run("const app = await NestFactory.create(AppModule, { routeResolutionStrategy: 'specificity' });")).toEqual(["GET /users/me"]);
    // Nest 11 has no such option: it registers in declaration order.
    expect(run("const app = await NestFactory.create(AppModule, { routeResolutionStrategy: 'specificity' });", "^11.0.0")).toEqual(["GET /users/{id}"]);
    expect(run("const app = await NestFactory.create(AppModule, options);")).toEqual(["GET /users/me", "GET /users/{id}"]);
    expect(run("const app = await NestFactory.create(AppModule, { routeResolutionStrategy: strategy });")).toEqual(["GET /users/me", "GET /users/{id}"]);
    // A NestFactory imported under another name is Nest's; one named so but not imported from @nestjs/core is not.
    const aliased = (main: string) => ({ ...nest(""), "api/main.ts": main });
    const via = (main: string) => reach(aliased(main), { styles: ["nest"] }, ["GET /users/me"]).reached["GET /users/me"];
    expect(via("import { NestFactory as Factory } from '@nestjs/core';\nconst app = await Factory.create(AppModule);")).toEqual(["GET /users/{id}"]);
    expect(via("import { NestFactory } from './factory';\nconst app = await NestFactory.create(AppModule);")).toEqual(["GET /users/me", "GET /users/{id}"]);
    // Options a function is given are those of each call of it in the files read, its default where one gives none.
    const factory = (calls: string) =>
      lines("export async function createApp(options = {}) {", "  return NestFactory.create(AppModule, options);", "}", calls);
    expect(run(factory("await createApp();"))).toEqual(["GET /users/{id}"]);
    expect(run(factory("await createApp(undefined);"))).toEqual(["GET /users/{id}"]);
    expect(run(factory("await createApp({ routeResolutionStrategy: 'specificity' });"))).toEqual(["GET /users/me"]);
    expect(run(factory(""))).toEqual(["GET /users/me", "GET /users/{id}"]);
    expect(run(factory("const make = createApp;"))).toEqual(["GET /users/me", "GET /users/{id}"]);
  });

  it("lets a Nest route whose version a header gives pass a request of another version on", () => {
    const files = {
      "api/package.json": pkg({ "@nestjs/core": "^12.0.0", "@nestjs/platform-express": "^12.0.0" }),
      "api/users.controller.ts": lines(
        "import { Controller, Get, Version } from '@nestjs/common';",
        "@Controller('users')",
        "export class UsersController {",
        "  @Version('1') @Get(':id') one() {}",
        "  @Version('2') @Get('me') me() {}",
        "}",
      ),
      "api/main.ts": lines("import { NestFactory } from '@nestjs/core';", "const app = await NestFactory.create(AppModule);", "app.enableVersioning({ type: VersioningType.HEADER, header: 'X-V' });"),
    };
    expect(reach(files, { styles: ["nest"] }, ["GET /users/me"]).reached).toEqual({ "GET /users/me": ["GET /users/me", "GET /users/{id}"] });
  });

  it("names, in a route's FA001, the route registered before it that takes every request it fits", () => {
    const files = {
      ...express5,
      "api/app.js": lines(
        'import express from "express";',
        "const app = express();",
        'app.get("/users/:id", (req, res) => res.send("user"));',
        'app.get("/users/me", (req, res) => res.send("me"));',
        'app.get("/users/:id/posts", (req, res) => res.send("posts"));',
      ),
      "web/client.js": lines('fetch("/users/me");', 'fetch("/users/1/posts");'),
    };
    const config = normalizeConfig({
      components: [
        { name: "api", path: "api" },
        { name: "web", path: "web" },
      ],
      routes: [{ component: "api", files: ["api/**"], styles: ["express"] }],
      calls: [{ from: "web", to: "api", files: ["web/**"] }],
    });
    const graph = scan(memory(files), config);
    expect([...shadowedRoutes(graph.surfaces)].map(([i, by]) => `${graph.surfaces[i]!.path} by ${by.path}`)).toEqual(["/users/me by /users/{id}"]);
    const findings = evaluate(graph, config).filter((f) => f.rule === "FA001");
    expect(findings.map((f) => ({ key: f.key, message: f.message, at: f.at }))).toEqual([
      {
        key: "FA001|api|GET /users/me",
        message: "GET /users/me (api) has no caller among the configured call sites. No request reaches it: GET /users/{id} (api/app.js:3), registered before it, takes every request it fits.",
        at: [
          { file: "api/app.js", line: 4 },
          { file: "api/app.js", line: 3 },
        ],
      },
    ]);
  });
});

describe("find-my-way's precedence", () => {
  const fastify = (routes: string[], options = "") => ({
    "api/package.json": pkg({ fastify: "^5.0.0" }),
    "api/app.js": lines('import Fastify from "fastify";', `const app = Fastify(${options});`, ...routes),
  });

  it("tries a static segment, then a parameter with a regexp, then one without, then the wildcard, whatever the order", () => {
    const files = fastify([
      'app.get("/x/*", h);',
      'app.get("/x/:id", h);',
      'app.get("/x/:file(^\\\\d+).png", h);',
      'app.get("/x/static", h);',
      'app.get("/x/:a/:b", h);',
    ]);
    expect(reach(files, express, ["GET /x/12.png", "GET /x/a/b", "GET /x/a/b/c", "GET /x/abc", "GET /x/static", "GET /x/{}"]).reached).toEqual({
      "GET /x/static": ["GET /x/static"],
      "GET /x/12.png": ["GET /x/{file}.png"],
      "GET /x/abc": ["GET /x/{id}"],
      "GET /x/a/b": ["GET /x/{a}/{b}"],
      "GET /x/a/b/c": ["GET /x/**"],
      // A value may be `static` or one `{file}.png` takes, which come before `:id`; the wildcard comes after it.
      "GET /x/{}": ["GET /x/static", "GET /x/{file}.png", "GET /x/{id}"],
    });
  });

  it("tells a trailing / apart, gives a last parameter the empty text after it, and serves a plugin's / at its prefix with and without it", () => {
    const files = {
      ...fastify([
        'import plugin from "./plugin.js";',
        'import bare from "./bare.js";',
        'app.get("/a", h);',
        'app.get("/u/:id", h);',
        'app.get("/w/*", h);',
        'app.register(plugin, { prefix: "/p" });',
        'app.register(bare, { prefix: "/q" });',
      ]),
      "api/plugin.js": lines("export default async function plugin(app) {", '  app.get("/", h);', "}"),
      "api/bare.js": lines("export default async function bare(app) {", '  app.get("/", { prefixTrailingSlash: "no-slash" }, h);', "}"),
    };
    expect(reach(files, express, ["GET /a", "GET /a/", "GET /p", "GET /p/", "GET /q", "GET /q/", "GET /u/", "GET /w", "GET /w/"]).reached).toEqual({
      "GET /a": ["GET /a"],
      "GET /a/": [],
      "GET /u/": ["GET /u/{id}"],
      "GET /w": [],
      "GET /w/": ["GET /w/**"],
      "GET /p": ["GET /p"],
      "GET /p/": ["GET /p"],
      "GET /q": ["GET /q"],
      "GET /q/": [],
    });
  });

  it("reads ignoreTrailingSlash at the top of the options or in routerOptions, and nothing from options not spelled out", () => {
    const run = (options: string) => reach(fastify(['app.get("/a", h);'], options), express, ["GET /a/"]).reached["GET /a/"];
    expect(run("{ ignoreTrailingSlash: true }")).toEqual(["GET /a"]);
    expect(run("{ routerOptions: { ignoreTrailingSlash: true } }")).toEqual(["GET /a"]);
    expect(run("{ logger: true }")).toEqual([]);
    expect(run("{ ...base }")).toEqual(["GET /a"]);
    expect(run("{ ['ignoreTrailingSlash']: true }")).toEqual(["GET /a"]);
  });

  it("matches a request to a route with constraints to none, and says so", () => {
    const files = fastify([
      'app.route({ method: "GET", url: "/v", constraints: { version: "1.0.0" }, handler: h });',
      'app.get("/w", { constraints: { host: "a.example.com" } }, h);',
      "const plain = { schema: {} };",
      'app.get("/x", plain, h);',
      'app.get("/y", options, h);',
    ]);
    const { reached, matched } = reach(files, express, ["GET /v", "GET /w", "GET /x", "GET /y"]);
    expect(reached).toEqual({ "GET /v": ["constrained: GET /v"], "GET /w": ["constrained: GET /w"], "GET /x": ["GET /x"], "GET /y": ["constrained: GET /y"] });
    const fits = (request: string, line: number, route: string) =>
      `calls web->api: ${request} at x:${line} fits ${route}, which its router takes only where the request's headers meet the constraints the route's options give (or may give, where they are not spelled out); the call's headers are not read, so it is not matched to them`;
    expect(matched).toEqual([fits("GET /v", 1, "GET /v (api/app.js:3)"), fits("GET /w", 2, "GET /w (api/app.js:4)"), fits("GET /y", 4, "GET /y (api/app.js:7)")]);
  });
});

describe("Starlette's order and its trailing-slash redirect", () => {
  const app = (options = "") =>
    lines(
      "from fastapi import FastAPI",
      `app = FastAPI(${options})`,
      '@app.get("/users/me")',
      "def me(): ...",
      '@app.get("/users/{name}")',
      "def user(name): ...",
      '@app.post("/items/")',
      "def create(): ...",
    );

  it("answers with the first route, and redirects a path no route takes to the one with the / added or removed", () => {
    const { reached, matched } = reach({ "api/main.py": app() }, { styles: ["fastapi"] }, ["GET /items", "GET /users/me", "GET /users/me/", "POST /items", "POST /items/"]);
    expect(reached).toEqual({
      "GET /users/me": ["GET /users/me"],
      "GET /users/me/": ["redirect /users/me: GET /users/me"],
      "POST /items": ["redirect /items/: POST /items"],
      "POST /items/": ["POST /items"],
      // The redirected request is answered 405: no GET route takes it.
      "GET /items": [],
    });
    expect(matched[0]).toBe(
      "calls web->api: GET /users/me/ at x:3 is answered with a redirect to /users/me, which GET /users/me serves; it reaches that route only as its client follows the redirect, so it is matched to none",
    );
  });

  it("does not redirect with redirect_slashes=False, and reads nothing from a value not spelled out", () => {
    expect(reach({ "api/main.py": app("redirect_slashes=False") }, { styles: ["fastapi"] }, ["POST /items"]).reached).toEqual({ "POST /items": [] });
    expect(reach({ "api/main.py": app("redirect_slashes=flag") }, { styles: ["fastapi"] }, ["GET /users/me", "POST /items"]).reached).toEqual({
      "POST /items": ["POST /items"],
      "GET /users/me": ["GET /users/me"],
    });
  });

  it("serves a path registered with and without its / at both, as one route", () => {
    const files = { "api/main.py": lines("from fastapi import FastAPI", "app = FastAPI()", '@app.get("/a")', "def a(): ...", '@app.get("/a/")', "def a_slash(): ...") };
    expect(reach(files, { styles: ["fastapi"] }, ["GET /a", "GET /a/"]).reached).toEqual({ "GET /a": ["GET /a"], "GET /a/": ["GET /a"] });
  });

  it("orders the routes of one function body, and not across function bodies", () => {
    const files = {
      "api/main.py": lines(
        "from fastapi import FastAPI",
        "def create():",
        "    app = FastAPI()",
        '    @app.get("/b/me")',
        "    def me(): ...",
        '    @app.get("/b/{name}")',
        "    def name(): ...",
        "    return app",
      ),
    };
    expect(reach(files, { styles: ["fastapi"] }, ["GET /b/me"]).reached).toEqual({ "GET /b/me": ["GET /b/me"] });
  });

  it("orders an included router's routes where the include is, and none of a router included twice", () => {
    const files = {
      "api/main.py": lines(
        "from fastapi import FastAPI",
        "from .users import router",
        "from .other import other",
        "app = FastAPI()",
        '@app.get("/u/{name}")',
        "def name(): ...",
        'app.include_router(router, prefix="/u")',
        'app.include_router(other, prefix="/a")',
        'app.include_router(other, prefix="/b")',
        '@app.get("/a/{name}")',
        "def a(): ...",
      ),
      "api/users.py": lines("from fastapi import APIRouter", "router = APIRouter()", '@router.get("/me")', "def me(): ..."),
      "api/other.py": lines("from fastapi import APIRouter", "other = APIRouter()", '@other.get("/me")', "def me(): ..."),
    };
    expect(reach(files, { styles: ["fastapi"] }, ["GET /a/me", "GET /u/me"]).reached).toEqual({
      "GET /u/me": ["GET /u/{name}"],
      "GET /a/me": ["GET /a/me", "GET /a/{name}"],
    });
  });
});

describe("Next.js's trailingSlash", () => {
  const app = (config?: string) => ({
    "api/app/about/route.js": "export function GET() {}",
    "api/app/robots.txt/route.js": "export function GET() {}",
    ...(config === undefined ? {} : { "api/next.config.mjs": config }),
  });
  const next = { styles: ["next"] };

  it("redirects a path with a trailing / to the one without by default, and the other way with trailingSlash: true", () => {
    expect(reach(app(), next, ["GET /about", "GET /about/"]).reached).toEqual({ "GET /about": ["GET /about"], "GET /about/": ["redirect /about: GET /about"] });
    const added = reach(app("const config = { trailingSlash: true };\nexport default config;"), next, ["GET /about", "GET /about/", "GET /robots.txt"]);
    expect(added.reached).toEqual({ "GET /about": ["redirect /about/: GET /about"], "GET /about/": ["GET /about"], "GET /robots.txt": ["GET /robots.txt"] });
  });

  it("matches either way where the configuration is not read, and says why", () => {
    const wrapped = reach(app("export default withPlugin({ trailingSlash: true });"), next, ["GET /about/"]);
    expect(wrapped.reached).toEqual({ "GET /about/": ["GET /about"] });
    expect(wrapped.limits).toEqual([
      "routes api: api/next.config.mjs exports withPlugin({ trailingSlash: true }), not an object it spells out; whether Next.js redirects a request with or without a trailing / is not read, so a call is matched to its route either way",
    ]);
    expect(reach(app("export default { skipTrailingSlashRedirect: true };"), next, ["GET /about/"]).limits).toEqual([
      "routes api: api/next.config.mjs turns off Next.js's trailing slash redirects (skipTrailingSlashRedirect); whether Next.js redirects a request with or without a trailing / is not read, so a call is matched to its route either way",
    ]);
  });
});

describe("Spring's trailing slash", () => {
  const controller = lines(
    "@RestController",
    '@RequestMapping("/owners")',
    "class Owners {",
    '  @GetMapping("/") List<String> list() { return null; }',
    '  @PostMapping("/{id}") void save() {}',
    "}",
  );
  const pom = (version: string, group = "org.springframework.boot") =>
    `<project>\n<parent>\n<groupId>${group}</groupId>\n<artifactId>spring-boot-starter-parent</artifactId>\n<version>${version}</version>\n</parent>\n</project>\n`;
  const spring = { styles: ["spring"] };

  it("matches a / only to a pattern that has it from Spring 6 on, as the build's Spring Boot gives it", () => {
    const files = (version: string, extra: Record<string, string> = {}) => ({ "api/pom.xml": pom(version), "api/Owners.java": controller, ...extra });
    expect(reach(files("3.5.0"), spring, ["GET /owners", "GET /owners/", "POST /owners/1", "POST /owners/1/"]).reached).toEqual({
      "GET /owners": [],
      "GET /owners/": ["GET /owners"],
      "POST /owners/1": ["POST /owners/{id}"],
      "POST /owners/1/": [],
    });
    expect(reach(files("2.7.18"), spring, ["GET /owners", "POST /owners/1/"]).reached).toEqual({ "GET /owners": ["GET /owners"], "POST /owners/1/": ["POST /owners/{id}"] });
    const lenient = { "api/Web.java": "class Web implements WebMvcConfigurer {\n  void configurePathMatch(PathMatchConfigurer c) { c.setUseTrailingSlashMatch(true); }\n}\n" };
    expect(reach(files("3.5.0", lenient), spring, ["POST /owners/1/"]).reached).toEqual({ "POST /owners/1/": ["POST /owners/{id}"] });
    const strict = { "api/Web.java": "class Web implements WebMvcConfigurer {\n  void configurePathMatch(PathMatchConfigurer c) { c.setUseTrailingSlashMatch(false); }\n}\n" };
    expect(reach(files("2.7.18", strict), spring, ["POST /owners/1/"]).reached).toEqual({ "POST /owners/1/": [] });
    const unread = { "api/Web.java": "class Web implements WebMvcConfigurer {\n  void configurePathMatch(PathMatchConfigurer c) { c.setUseTrailingSlashMatch(flag); }\n}\n" };
    const either = reach(files("3.5.0", unread), spring, ["POST /owners/1/"]);
    expect(either.reached).toEqual({ "POST /owners/1/": ["POST /owners/{id}"] });
    expect(either.limits).toEqual(["routes api: api/Web.java:2 calls setUseTrailingSlashMatch with a value the file does not spell out (flag); whether a mapped route takes a trailing / it lacks is not read"]);
  });

  it("reads the version from a property of the pom or the Gradle plugin, and says where the build names Spring with no version it reads", () => {
    const property = "<project>\n<properties><boot.version>3.4.1</boot.version></properties>\n<dependencyManagement><dependencies><dependency>\n<groupId>org.springframework.boot</groupId><artifactId>spring-boot-dependencies</artifactId>\n<version>${boot.version}</version>\n</dependency></dependencies></dependencyManagement>\n</project>\n";
    expect(reach({ "api/pom.xml": property, "api/Owners.java": controller }, spring, ["POST /owners/1/"]).reached).toEqual({ "POST /owners/1/": [] });
    const gradle = "plugins {\n  id 'org.springframework.boot' version '3.3.0'\n}\n";
    expect(reach({ "api/build.gradle": gradle, "api/Owners.java": controller }, spring, ["POST /owners/1/"]).reached).toEqual({ "POST /owners/1/": [] });
    const unread = reach({ "api/build.gradle": "plugins {\n  id 'org.springframework.boot' version \"$boot\"\n}\n", "api/Owners.java": controller }, spring, ["POST /owners/1/"]);
    expect(unread.reached).toEqual({ "POST /owners/1/": ["POST /owners/{id}"] });
    expect(unread.limits).toEqual([
      "routes api: api/build.gradle names the version of Spring in a way atlas does not read, so whether Spring matches a request with a trailing / to a route without one is not read; a call is matched to its route either way",
    ]);
    const none = reach({ "api/pom.xml": "<project><dependencies><dependency><groupId>org.springframework.boot</groupId><artifactId>spring-boot-starter-web</artifactId></dependency></dependencies></project>", "api/Owners.java": controller }, spring, []);
    expect(none.limits).toEqual([
      "routes api: no build file above api/Owners.java names the version of Spring Boot or Spring Framework, so whether Spring matches a request with a trailing / to a route without one is not read; a call is matched to its route either way",
      "routes api: api/pom.xml:1 brings in Spring Boot's web stack, in a version the build files do not spell out; the routes Spring Boot serves by itself (its error page, static resources, WebJars and actuator) are not read",
    ]);
    expect(reach({ "api/Owners.java": controller }, spring, []).limits).toEqual([]);
  });
});

describe("AdonisJS's matchers", () => {
  it("takes only the values a route's matcher or the router's takes, and any where the matcher is not spelled out", () => {
    const files = {
      "api/start/routes.ts": lines(
        "import router from '@adonisjs/core/services/router'",
        "router.where('slug', /^[a-z]+$/)",
        "router.get('/n/:id', () => 'n').where('id', router.matchers.number())",
        "router.get('/u/:id', () => 'u').as('u').where('id', router.matchers.uuid()).where('id', /^x$/)",
        "router.get('/r/:id', () => 'r').where('id', { match: /^[0-9]{2}$/, cast: Number })",
        "router.get('/s/:slug', () => 's')",
        "router.get('/v/:id', () => 'v').where('id', matcher)",
        "router.get('/c/:constructor', () => 'c').where('constructor', '^[0-9]+$')",
      ),
    };
    const requests = ["GET /c/1", "GET /c/x", "GET /n/12", "GET /n/x", "GET /r/12", "GET /r/123", "GET /s/ABC", "GET /s/abc", "GET /u/7d3e1c2a-1b2c-4d5e-8f90-123456789abc", "GET /u/x", "GET /v/x"];
    expect(reach(files, express, requests).reached).toEqual({
      "GET /n/12": ["GET /n/{id}"],
      "GET /n/x": [],
      "GET /u/7d3e1c2a-1b2c-4d5e-8f90-123456789abc": ["GET /u/{id}"],
      // The first matcher a route gives a parameter is the one it keeps.
      "GET /u/x": [],
      "GET /r/12": ["GET /r/{id}"],
      "GET /r/123": [],
      "GET /s/abc": ["GET /s/{slug}"],
      "GET /s/ABC": [],
      "GET /v/x": ["GET /v/{id}"],
      "GET /c/1": ["GET /c/{constructor}"],
      "GET /c/x": [],
    });
  });
});

describe("Elysia's groups", () => {
  it("leaves a route on the instance a group's callback is handed unread, and says so", () => {
    const files = { "api/app.ts": lines('import { Elysia } from "elysia";', "export const app = new Elysia()", '  .get("/", "hi")', '  .group("/user", (app) => app.post("/sign-in", "in"));') };
    const { limits } = reach(files, express, []);
    expect(limits).toEqual([
      "routes api: api/app.ts:4 registers a route on app, the instance a group(...) callback is handed, under the group's path, which atlas does not read; its route is not read",
    ]);
  });
});

describe("paths whose wildcard comes after a written /", () => {
  it("serves the path before the wildcard only with the /", () => {
    expect(readFindMyWay("/x/*")).toEqual({ paths: [{ path: "/x/**", trailing: "slash" }] });
    expect(readPathToRegexp01("/x/*")).toEqual({ paths: [{ path: "/x/**", trailing: "slash" }] });
  });
});

describe("findings for calls a router redirects or that no route takes", () => {
  it("reports a call no route takes as its framework dispatches, and neither a redirected call nor the route it is redirected to", () => {
    const files = {
      "api/package.json": pkg({ fastify: "^5.0.0" }),
      "api/app.js": lines('import Fastify from "fastify";', "const app = Fastify();", 'app.get("/a", h);'),
      "web/app/about/route.js": "export function GET() {}",
      "client/x.js": lines('fetch("/a/");', 'fetch("/about/");'),
    };
    const config = normalizeConfig({
      components: [
        { name: "api", path: "api" },
        { name: "web", path: "web" },
        { name: "client", path: "client" },
      ],
      routes: [
        { component: "api", files: ["api/**"], styles: ["express"] },
        { component: "web", files: ["web/**"], styles: ["next"] },
      ],
      calls: [
        { from: "client", to: "api", files: ["client/**"] },
        { from: "client", to: "web", files: ["client/**"] },
      ],
    });
    const graph: Graph = scan(memory(files), config);
    const findings = evaluate(graph, config).map((f) => f.key);
    expect(findings).toContain("FA002|client->api|GET /a");
    expect(findings).toContain("FA001|api|GET /a");
    expect(findings.filter((k) => k.includes("web"))).toEqual([]);
    expect(graph.limits.filter((l) => l.includes("redirect"))).toEqual([
      "calls client->web: GET /about/ at client/x.js:2 is answered with a redirect to /about, which GET /about serves; it reaches that route only as its client follows the redirect, so it is matched to none",
    ]);
  });
});

describe("review of #78", () => {
  it("places stacked Python decorators as Python applies them, the nearest the definition first", () => {
    const files = {
      "api/main.py": lines("from fastapi import FastAPI", "app = FastAPI()", '@app.get("/u/{name}")', '@app.get("/u/me")', "def user(): ...", '@app.get("/v/{name}")', "def v(): ...", '@app.get("/v/me")', "def me(): ..."),
    };
    expect(reach(files, { styles: ["fastapi"] }, ["GET /u/me", "GET /v/me"]).reached).toEqual({ "GET /u/me": ["GET /u/me"], "GET /v/me": ["GET /v/{name}"] });
  });

  it("lets a mounted APIRouter redirect by its own redirect_slashes, and an included one by its application's", () => {
    const files = {
      "api/main.py": lines(
        "from fastapi import FastAPI, APIRouter",
        "app = FastAPI()",
        "inner = APIRouter(redirect_slashes=False)",
        '@inner.post("/items/")',
        "def items(): ...",
        'app.mount("/m", inner)',
        "other = APIRouter(redirect_slashes=False)",
        '@other.post("/things/")',
        "def things(): ...",
        'app.include_router(other, prefix="/i")',
      ),
    };
    expect(reach(files, { styles: ["fastapi"] }, ["POST /m/items", "POST /i/things"]).reached).toEqual({ "POST /m/items": [], "POST /i/things": ["redirect /i/things/: POST /i/things"] });
  });

  it("records the redirect a call with a value may get besides the routes that take some values as written", () => {
    const files = { "api/main.py": lines("from fastapi import FastAPI", "app = FastAPI()", '@app.get("/items/me/")', "def me(): ...", '@app.get("/items/{id}")', "def item(id): ...") };
    expect(reach(files, { styles: ["fastapi"] }, ["GET /items/{}/", "GET /items/me/"]).reached).toEqual({
      "GET /items/{}/": ["GET /items/me", "redirect /items/{}: GET /items/{id}"],
      "GET /items/me/": ["GET /items/me"],
    });
  });

  it("takes a matcher's regexp anywhere in the text, its own anchors kept, alternatives included", () => {
    const files = { "api/start/routes.ts": lines("import router from '@adonisjs/core/services/router'", "router.get('/a/:id', () => 'a').where('id', /^foo|bar$/)") };
    expect(reach(files, express, ["GET /a/foobar", "GET /a/xbar", "GET /a/barx"]).reached).toEqual({ "GET /a/foobar": ["GET /a/{id}"], "GET /a/xbar": ["GET /a/{id}"], "GET /a/barx": [] });
  });

  it("reads Express's next with a falsy or unknown value as moving on, and only a surely truthy one as an error", () => {
    const files = {
      ...express5,
      "api/app.js": lines(
        'import express from "express";',
        "const app = express();",
        'app.get("/a/me", (req, res, next) => next(null));',
        'app.get("/a/:id", (req, res) => res.send("a"));',
        'app.get("/b/me", (req, res, next) => next(new Error("no")));',
        'app.get("/b/:id", (req, res) => res.send("b"));',
      ),
    };
    expect(reach(files, express, ["GET /a/me", "GET /b/me"]).reached).toEqual({ "GET /a/me": ["GET /a/me", "GET /a/{id}"], "GET /b/me": ["GET /b/me"] });
  });

  it("orders the routers one use mounts in the order of its arguments", () => {
    const files = {
      ...express5,
      "api/app.js": lines(
        'import express from "express";',
        "const app = express();",
        "const a = express.Router();",
        'a.get("/x/:id", (req, res) => res.send("a"));',
        "const b = express.Router();",
        'b.get("/x/me", (req, res) => res.send("b"));',
        'app.use("/", a, b);',
      ),
    };
    expect(reach(files, express, ["GET /x/me"]).reached).toEqual({ "GET /x/me": ["GET /x/{id}"] });
  });

  it("reads Express's strict option and an application's strict routing where the settings are settled before its router", () => {
    const strictRouter = {
      ...express5,
      "api/app.js": lines(
        'import express from "express";',
        "const app = express();",
        "const r = express.Router({ strict: true });",
        'r.get("/x/:id", (req, res) => res.send("id"));',
        'r.get("/x/me/", (req, res) => res.send("me"));',
        'r.get("/", (req, res) => res.send("root"));',
        'app.use("/r", r);',
      ),
    };
    expect(reach(strictRouter, express, ["GET /r/x/me/", "GET /r/x/me", "GET /r", "GET /r/"]).reached).toEqual({
      "GET /r/x/me/": ["GET /r/x/me"],
      "GET /r/x/me": ["GET /r/x/{id}"],
      "GET /r": ["GET /r"],
      "GET /r/": ["GET /r"],
    });
    const app = (...setup: string[]) => ({
      ...express5,
      "api/app.js": lines('import express from "express";', "const app = express();", ...setup),
    });
    const run = (...setup: string[]) => reach(app(...setup), express, ["GET /s/"]).reached["GET /s/"];
    expect(run('app.enable("strict routing");', 'app.get("/s", (req, res) => res.send("s"));')).toEqual([]);
    expect(run('app.enable("strict routing");', 'app.disable("strict routing");', 'app.get("/s", (req, res) => res.send("s"));')).toEqual(["GET /s"]);
    // Set after the first route, it comes after the router it would change: not read, matched either way.
    expect(run('app.get("/s", (req, res) => res.send("s"));', 'app.enable("strict routing");')).toEqual(["GET /s"]);
    // An Express 4 wildcard after a `/` takes `/x/` and not `/x` under a router whose own rule is not read.
    const four = { "api/package.json": pkg({ express: "^4.21.0" }), "api/app.js": lines('const express = require("express");', "const app = express();", "app.set(\"strict routing\", flag);", 'app.get("/w/*", (req, res) => res.send("w"));') };
    expect(reach(four, express, ["GET /w", "GET /w/"]).reached).toEqual({ "GET /w": [], "GET /w/": ["GET /w/**"] });
  });

  it("resolves a Fastify route's only options argument held in a const", () => {
    const files = {
      "api/package.json": pkg({ fastify: "^5.0.0" }),
      "api/app.js": lines('import Fastify from "fastify";', "const app = Fastify();", 'const opts = { constraints: { version: "1.0.0" }, handler: h };', 'app.get("/v", opts);'),
    };
    expect(reach(files, express, ["GET /v"]).reached).toEqual({ "GET /v": ["constrained: GET /v"] });
  });

  it("reads Next.js's trailingSlash: true as its redirects do: a file's path loses the /, /.well-known/ keeps what is written", () => {
    const files = {
      "api/app/robots.txt/route.js": "export function GET() {}",
      "api/app/.well-known/thing/route.js": "export function GET() {}",
      "api/next.config.js": "module.exports = { trailingSlash: true };",
    };
    expect(reach(files, { styles: ["next"] }, ["GET /robots.txt/", "GET /.well-known/thing", "GET /.well-known/thing/"]).reached).toEqual({
      "GET /robots.txt/": ["redirect /robots.txt: GET /robots.txt"],
      "GET /.well-known/thing": ["GET /.well-known/thing"],
      "GET /.well-known/thing/": ["GET /.well-known/thing"],
    });
  });

  it("reads Spring's setter in code only, its version from Spring's own artifacts, and a registered or exchange mapping's /", () => {
    const pom = (group: string) => `<project>\n<parent>\n<groupId>${group}</groupId>\n<artifactId>spring-boot-starter-parent</artifactId>\n<version>3.5.0</version>\n</parent>\n</project>\n`;
    const controller = '@RestController\nclass A {\n  @PostMapping("/a") void a() {}\n}\n';
    const commented = { "api/Web.java": 'class Web implements WebMvcConfigurer {\n  // c.setUseTrailingSlashMatch(true);\n  String s = "setUseTrailingSlashMatch(true)";\n}\n' };
    expect(reach({ "api/pom.xml": pom("org.springframework.boot"), "api/A.java": controller, ...commented }, { styles: ["spring"] }, ["POST /a/"]).reached).toEqual({ "POST /a/": [] });
    // Another group's artifact of the same name names no Spring version.
    const other = reach({ "api/pom.xml": pom("com.example"), "api/A.java": controller }, { styles: ["spring"] }, ["POST /a/"]);
    expect(other.reached).toEqual({ "POST /a/": ["POST /a"] });
    const registered = lines(
      "@Configuration",
      "class Reg {",
      "  @Autowired",
      "  void register(RequestMappingHandlerMapping mapping, Handler handler) throws Exception {",
      '    mapping.registerMapping(RequestMappingInfo.paths("/health/").methods(RequestMethod.GET).build(), handler, Handler.class.getMethod("health"));',
      '    mapping.registerMapping(RequestMappingInfo.paths("/both", "/both/").methods(RequestMethod.GET).build(), handler, Handler.class.getMethod("both"));',
      "  }",
      "}",
    );
    // The exchanges a controller serves under both forms of its mapping are one route, served at both.
    const exchange = lines(
      "@HttpExchange",
      "interface Api {",
      "  @GetExchange String e();",
      "}",
      "@RestController",
      '@RequestMapping({"/x/e", "/x/e/"})',
      "class Impl implements Api {",
      "  public String e() { return null; }",
      "}",
    );
    const spring = { "api/pom.xml": pom("org.springframework.boot"), "api/Reg.java": registered, "api/Api.java": exchange };
    expect(reach(spring, { styles: ["spring"] }, ["GET /health", "GET /health/", "GET /both", "GET /both/", "GET /x/e", "GET /x/e/"]).reached).toEqual({
      "GET /health": [],
      "GET /health/": ["GET /health"],
      "GET /both": ["GET /both"],
      "GET /both/": ["GET /both"],
      "GET /x/e": ["GET /x/e"],
      "GET /x/e/": ["GET /x/e"],
    });
  });

  it("ranks Nest's routes by specificity across controllers, and those of one rank in declaration order", () => {
    const files = {
      "api/package.json": pkg({ "@nestjs/core": "^12.0.0", "@nestjs/platform-express": "^12.0.0" }),
      "api/a.controller.ts": lines("import { Controller, Get } from '@nestjs/common';", "@Controller('users')", "export class A {", "  @Get(':id') one() {}", "  @Get(':name/x') x() {}", "  @Get('*rest') all() {}", "}"),
      "api/b.controller.ts": lines("import { Controller, Get } from '@nestjs/common';", "@Controller('users')", "export class B {", "  @Get('me') me() {}", "  @Get(':other') other() {}", "}"),
      "api/main.ts": lines("import { NestFactory } from '@nestjs/core';", "const app = await NestFactory.create(AppModule, { routeResolutionStrategy: 'specificity' });"),
    };
    expect(reach(files, { styles: ["nest"] }, ["GET /users/me", "GET /users/1", "GET /users/1/x", "GET /users/1/y"]).reached).toEqual({
      "GET /users/me": ["GET /users/me"],
      // `:id` and `:other` rank alike, in two controllers whose order is not read.
      "GET /users/1": ["GET /users/{id}", "GET /users/{other}"],
      "GET /users/1/x": ["GET /users/{name}/x"],
      "GET /users/1/y": ["GET /users/{rest}/**"],
    });
  });
});
