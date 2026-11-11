import { describe, expect, it } from "vitest";
import { normalizeConfig } from "../src/config.js";
import { extractRoutes } from "../src/extract/routes.js";
import {
  nestSyntax,
  packageRanges,
  rangeMajor,
  readExpress,
  readFindMyWay,
  readHono,
  readNest,
  readPathToRegexp,
  readPathToRegexp01,
  readPlain,
  slashFree,
  syntaxOf,
} from "../src/extract/syntax.js";
import { matchCalls } from "../src/match.js";
import type { Call, Surface } from "../src/model.js";
import { pathCovers, pathsMatch } from "../src/paths.js";
import { scan } from "../src/scan.js";
import { validate } from "../src/schema.js";
import type { Source } from "../src/source.js";

const memory = (files: Record<string, string>): Source => ({
  ref: "WORKTREE",
  list: () => Object.keys(files),
  read: (p) => files[p],
  asOf: () => "2026-11-01T00:00:00Z",
});

/** The routes and limits an express-style entry reads from `files`, each route with its patterns where it has any. */
const routes = (files: Record<string, string>, entry: Record<string, unknown> = {}) => {
  const limits: string[] = [];
  const config = normalizeConfig({ components: [{ name: "api", path: "api" }], routes: [{ component: "api", files: ["api/src/**"], styles: ["express"], ...entry }] });
  const ids = extractRoutes(memory(files), config, undefined, [], limits).map((s) => `${s.method} ${s.path}${s.patterns ? ` ${JSON.stringify(s.patterns)}` : ""}`);
  return { ids, limits };
};

const paths = (read: ReturnType<typeof readPathToRegexp>) => ("paths" in read ? read.paths : read);

describe("path-to-regexp 8 (Express 5, @koa/router 14 and later)", () => {
  it("reads optional groups as each path they make, and parameters wherever they stand in a segment", () => {
    expect(paths(readPathToRegexp("/about{/:section}"))).toEqual([{ path: "/about/{section}" }, { path: "/about" }]);
    expect(paths(readPathToRegexp("/a{/b{/c}}"))).toEqual([{ path: "/a/b/c" }, { path: "/a/b" }, { path: "/a" }]);
    expect(paths(readPathToRegexp("/flights/:from-:to"))).toEqual([{ path: "/flights/{from}-{to}" }]);
    expect(paths(readPathToRegexp("/plantae/:genus.:species"))).toEqual([{ path: "/plantae/{genus}.{species}" }]);
    expect(paths(readPathToRegexp("/api/v:version/status"))).toEqual([{ path: "/api/v{version}/status" }]);
    expect(paths(readPathToRegexp('/downloads/:"file-name"'))).toEqual([{ path: "/downloads/{file-name}" }]);
    // `\` makes the next character text.
    expect(paths(readPathToRegexp("/name\\:verb"))).toEqual([{ path: "/name:verb" }]);
  });

  it("reads a wildcard that ends the path as one segment or more, and in an optional group as none or more", () => {
    expect(paths(readPathToRegexp("/files/*filepath"))).toEqual([{ path: "/files/{filepath}/**" }]);
    expect(paths(readPathToRegexp('/archive/*"rest-path"'))).toEqual([{ path: "/archive/{rest-path}/**" }]);
    expect(paths(readPathToRegexp("/static{/*path}"))).toEqual([{ path: "/static/{*path}" }]);
    // The `/` before the group is text: the path without the rest is served only with it, `/static/`.
    expect(paths(readPathToRegexp("/static/{*path}"))).toEqual([{ path: "/static/{*path}", trailing: "slash" }]);
  });

  it("leaves out a path it rejects, or one no template holds, and says why", () => {
    expect(readPathToRegexp("/users/:id?")).toEqual({ why: "path-to-regexp 8 rejects an unexpected `?`", rejected: true });
    expect(readPathToRegexp("/files/*")).toEqual({ why: "path-to-regexp 8 rejects a `*` with no parameter name", rejected: true });
    expect(readPathToRegexp("/a/:b:c")).toEqual({ why: "path-to-regexp 8 rejects `:c` with no text before it", rejected: true });
    expect(readPathToRegexp("/a{/b")).toEqual({ why: "path-to-regexp 8 rejects a `{` not closed", rejected: true });
    // `pathToRegexp` throws "Too many path combinations" on the 257th; the walk stops there, not after 2^30 of them.
    expect(readPathToRegexp(`/x${"{/a}".repeat(9)}`)).toEqual({ why: "path-to-regexp 8 rejects more than 256 combinations of optional groups", rejected: true });
    const started = Date.now();
    expect(readPathToRegexp(`/x${"{/a}".repeat(30)}`)).toEqual({ why: "path-to-regexp 8 rejects more than 256 combinations of optional groups", rejected: true });
    expect(Date.now() - started).toBeLessThan(1000);
    expect(paths(readPathToRegexp(`/x${Array.from({ length: 8 }, (_, i) => `{/a${i}}`).join("")}`))).toHaveLength(256);
    expect(readPathToRegexp("/files/*rest/edit")).toEqual({ why: "its wildcard `*rest` takes text across segments, not the whole end of the path" });
    expect(readPathToRegexp("/files/v*rest")).toEqual({ why: "its wildcard `*rest` takes text across segments, not the whole end of the path" });
    // Escaped text that a template would read as syntax is not written as one.
    expect(readPathToRegexp("/a/\\{b\\}")).toEqual({ why: "its text `{b}` would read as path syntax" });
    expect(readPathToRegexp("/\\:verb")).toEqual({ why: "its text `:verb` would read as path syntax" });
  });
});

describe("Express 4 (path-to-regexp 0.1) and Express of a version not read", () => {
  it("reads optional segments, a final `*` and parameters sharing a segment, and no other regular expression", () => {
    expect(paths(readPathToRegexp01("/users/:id?"))).toEqual([{ path: "/users/{id}" }, { path: "/users" }]);
    expect(paths(readPathToRegexp01("/files/*"))).toEqual([{ path: "/files/**", trailing: "slash" }]);
    expect(paths(readPathToRegexp01("/flights/:from-:to"))).toEqual([{ path: "/flights/{from}-{to}" }]);
    const why = { why: "Express 4 (path-to-regexp 0.1) writes it into a regular expression, which is not read" };
    expect(readPathToRegexp01("/ab?cd")).toEqual(why);
    expect(readPathToRegexp01("/users/:id(\\d+)")).toEqual(why);
    expect(readPathToRegexp01("/files/*/edit")).toEqual(why);
    // Express compiles one regular expression; atlas writes no more paths than path-to-regexp 8 would allow.
    expect(paths(readPathToRegexp01(`/x${Array.from({ length: 8 }, (_, i) => `/:a${i}?`).join("")}`))).toHaveLength(256);
    expect(readPathToRegexp01(`/x${Array.from({ length: 20 }, (_, i) => `/:a${i}?`).join("")}`)).toEqual({ why: "its optional segments make more than 256 paths, which atlas does not write" });
  });

  it("reads a path as both versions do where they agree, and as Express 4 where Express 5 rejects it", () => {
    expect(paths(readExpress("/flights/:from-:to"))).toEqual([{ path: "/flights/{from}-{to}" }]);
    expect(paths(readExpress("/files/*"))).toEqual([{ path: "/files/**", trailing: "slash" }]);
    expect(paths(readExpress("/users/:id?"))).toEqual([{ path: "/users/{id}" }, { path: "/users" }]);
    const differ = { why: "Express 4 and 5 read it differently (path-to-regexp 0.1 and 8), and no package.json above it gives one major version of express" };
    expect(readExpress("/about{/:section}")).toEqual(differ);
    expect(readExpress("/files/*filepath")).toEqual(differ);
  });
});

describe("Nest on Express", () => {
  it("converts a legacy wildcard at the end as Nest 11 and later do, then reads path-to-regexp 8", () => {
    expect(paths(readNest("/api/cats/abcd/*"))).toEqual([{ path: "/api/cats/abcd/{*path}", trailing: "slash" }]);
    expect(paths(readNest("/api/cats/(.*)"))).toEqual([{ path: "/api/cats/{*path}", trailing: "slash" }]);
    expect(paths(readNest("/api/cats/+"))).toEqual([{ path: "/api/cats/{path}/**" }]);
    expect(paths(readNest("/api/cats/files/*filepath"))).toEqual([{ path: "/api/cats/files/{filepath}/**" }]);
    expect(readNest("/api/*/cats")).toEqual({ why: "Nest converts a `*` segment before the end of a path differently by version" });
  });

  it("takes the syntax from the version of @nestjs/platform-express, unless a Fastify adapter is installed", () => {
    const ranges = (deps: Record<string, string>) => (pkg: string) => deps[pkg];
    expect(nestSyntax(ranges({ "@nestjs/platform-express": "^12.3.2" }))).toEqual({ kind: "nest" });
    expect(nestSyntax(ranges({ "@nestjs/platform-express": "10.4.1" }))).toEqual({ kind: "path-to-regexp-0.1" });
    expect(nestSyntax(ranges({ "@nestjs/platform-express": "^11.0.0", "@nestjs/platform-fastify": "^11.0.0" }))).toEqual({
      kind: "plain",
      why: "@nestjs/platform-fastify is installed, and which adapter, Express or Fastify, serves the routes is not read",
    });
    expect(nestSyntax(ranges({ "@nestjs/platform-express": "latest" }))).toEqual({
      kind: "plain",
      why: "no package.json above it gives one major version of @nestjs/platform-express, whose path syntax differs between versions",
    });
  });
});

describe("find-my-way (Fastify)", () => {
  it("reads regexps, parameters sharing a segment, an optional last parameter, `::` and the final wildcard", () => {
    expect(paths(readFindMyWay("/example/:file(^\\d+).png"))).toEqual([{ path: "/example/{file}.png", patterns: { file: "(\\d+)" } }]);
    expect(paths(readFindMyWay("/at/:hour(^\\d{2})h:minute(^\\d{2})m"))).toEqual([{ path: "/at/{hour}h{minute}m", patterns: { hour: "(\\d{2})", minute: "(\\d{2})" } }]);
    // In a node with static text, a parameter without a regexp takes `(.*?)`, or, after another, anything up to the
    // text before it: empty text too.
    expect(paths(readFindMyWay("/near/:lat-:lng/radius/:r"))).toEqual([{ path: "/near/{lat}-{lng}/radius/{r}", patterns: { lat: "(.*?)", lng: "(-|(?:(?!-).)*)" } }]);
    expect(paths(readFindMyWay("/files/:name.png"))).toEqual([{ path: "/files/{name}.png", patterns: { name: "(.*?)" } }]);
    expect(paths(readFindMyWay("/posts/:id?"))).toEqual([{ path: "/posts/{id}" }, { path: "/posts" }]);
    expect(paths(readFindMyWay("/:id?"))).toEqual([{ path: "/{id}" }, { path: "/" }]);
    expect(paths(readFindMyWay("/name::verb"))).toEqual([{ path: "/name:verb" }]);
    expect(paths(readFindMyWay("/example/*"))).toEqual([{ path: "/example/**", trailing: "slash" }]);
  });

  it("leaves out what find-my-way rejects or no template holds, and says why", () => {
    expect(readFindMyWay("/a/:b?/c")).toEqual({ why: "find-my-way rejects an optional parameter before the end of the path" });
    expect(readFindMyWay("/a/*/c")).toEqual({ why: "find-my-way rejects a wildcard that is not the last character of the path" });
    expect(readFindMyWay("/files/v*")).toEqual({ why: "its wildcard `*` takes text across segments, not the whole end of the path" });
    expect(readFindMyWay("/a/:b(\\d+")).toEqual({ why: "find-my-way rejects a regexp that is not closed" });
    expect(readFindMyWay("/a/:b([)")).toEqual({ why: "find-my-way rejects a regexp that is not a valid regular expression" });
    expect(readFindMyWay("/::verb")).toEqual({ why: "its text `:verb` would read as path syntax" });
    expect(readFindMyWay("/a/:(\\d+)")).toEqual({ why: "its parameter name `` cannot be written in a path template" });
    expect(readFindMyWay("/a/:x(\\d+)/:x([a-z]+)")).toEqual({ why: "two parameters named `x` take different regexps" });
  });
});

describe("Hono", () => {
  it("reads an optional last parameter, regexps that take no `/`, a `*` segment and the final `/*`", () => {
    expect(paths(readHono("/animal/:type?"))).toEqual([{ path: "/animal" }, { path: "/animal/{type}" }]);
    expect(paths(readHono("/post/:date{[0-9]+}/:title{[a-z]+}"))).toEqual([{ path: "/post/{date}/{title}", patterns: { date: "[0-9]+", title: "[a-z]+" } }]);
    expect(paths(readHono("/wild/*/card"))).toEqual([{ path: "/wild/*/card" }]);
    expect(paths(readHono("/api/*"))).toEqual([{ path: "/api/**" }]);
    expect(paths(readHono("/*"))).toEqual([{ path: "/**" }]);
  });

  it("leaves out a regexp that may take a `/`, and a segment its two routers read differently", () => {
    expect(readHono("/posts/:filename{.+\\.png}")).toEqual({ why: "the regexp of `:filename` may take a `/`, so its parameter may span segments" });
    expect(readHono("/a/:b{[}")).toEqual({ why: "the regexp of `:b` is not a valid regular expression" });
    expect(readHono("/api/v:version")).toEqual({ why: "its segment `v:version` is read differently by Hono's RegExpRouter and TrieRouter" });
    expect(readHono("/files/v*")).toEqual({ why: "its `*` at the end of a segment's text takes text across segments" });
    expect(readHono("/a/:a-:b")).toEqual({ why: "its parameter name `a-:b` cannot be written in a path template" });
  });

  it("records a parameter named like a property of every object as any other", () => {
    expect(paths(readHono("/items/:constructor{[a-z]+}"))).toEqual([{ path: "/items/{constructor}", patterns: { constructor: "[a-z]+" } }]);
    const proto = paths(readHono("/items/:__proto__{[0-9]+}")) as Array<{ path: string; patterns?: Record<string, string> }>;
    expect(proto[0]!.path).toBe("/items/{__proto__}");
    expect(Object.hasOwn(proto[0]!.patterns!, "__proto__")).toBe(true);
    expect(pathsMatch("/items/{__proto__}", "/items/12", proto[0]!.patterns)).toBe(true);
    expect(pathsMatch("/items/{__proto__}", "/items/ab", proto[0]!.patterns)).toBe(false);
    // A parameter `patterns` does not name takes any segment, whatever `Object.prototype` holds.
    expect(pathsMatch("/items/{constructor}", "/items/ab", { id: "\\d+" })).toBe(true);
    expect(pathCovers("/items/{toString}", "/items/{}", { id: "\\d+" })).toBe(true);
  });

  it("tells a regexp that surely takes no `/` from one that may", () => {
    expect(["[0-9]+", "\\d{2}", "[a-z-]+", "(?:ab|cd)\\w*", "[\\d.]+"].map(slashFree)).toEqual([true, true, true, true, true]);
    expect([".+", "[^a]+", "\\W", "\\S+", "[!-z]+", "a\\/b", "\\x2f", "[\\/]"].map(slashFree)).toEqual([false, false, false, false, false, false, false, false]);
    // A control escape is the character it stands for, so `\t-0` (U+0009 to U+0030) holds `/`; an escaped `-` makes no range.
    expect(["[\\t-0]+", "[\\n-z]"].map(slashFree)).toEqual([false, false]);
    expect(["[\\t-\\r]+", "[!\\-z]+", "[a\\-z]"].map(slashFree)).toEqual([true, true, true]);
  });
});

describe("the syntax of a router", () => {
  it("is read plain, `:name` alone, where the router or its version is not known", () => {
    expect(paths(readPlain("/users/:id/books", "why"))).toEqual([{ path: "/users/{id}/books" }]);
    expect(readPlain("/users/:id?", "the reason")).toEqual({ why: "the reason" });
    expect(syntaxOf(undefined, undefined)).toEqual({ kind: "plain", why: "its router is not traced to Express, @koa/router, Fastify or Hono, which read path syntax differently" });
    expect(syntaxOf("@koa/router", "^13.1.0")).toEqual({ kind: "plain", why: "@koa/router 13 reads it with path-to-regexp 6, which is not read" });
    expect(syntaxOf("hono", "*")).toEqual({ kind: "plain", why: "no package.json above it gives one major version of hono, whose path syntax differs between versions" });
    expect(syntaxOf("hono/tiny", "^4.0.0")).toEqual({ kind: "plain", why: "the path syntax of hono/tiny is not read" });
    expect(syntaxOf("express", "^5.1.0")).toEqual({ kind: "path-to-regexp" });
    expect(syntaxOf("express", "~4.18.1")).toEqual({ kind: "path-to-regexp-0.1" });
    expect(syntaxOf("express", undefined)).toEqual({ kind: "express" });
    expect(syntaxOf("@koa/router", "^15.7.0")).toEqual({ kind: "path-to-regexp" });
    expect(syntaxOf("fastify", "5.12.7")).toEqual({ kind: "find-my-way" });
  });

  it("takes the one major version a package.json range admits", () => {
    expect(["^5.1.0", "~4.18", "5", "5.x", "=5.0.1", "v4.1.0", "^4.0.0 || ^4.2.0", "5.0.0-beta.1"].map(rangeMajor)).toEqual([5, 4, 5, 5, 5, 4, 4, 5]);
    expect([">=4", "^4 || ^5", "*", "latest", "workspace:*", "npm:express@5", "", "github:expressjs/express"].map(rangeMajor)).toEqual(
      new Array(8).fill(undefined),
    );
  });

  it("finds the range in the nearest package.json above a file that names the package", () => {
    const ranges = packageRanges(
      memory({
        "package.json": JSON.stringify({ dependencies: { express: "^4.18.0", hono: "^4.0.0" } }),
        "api/package.json": JSON.stringify({ devDependencies: { express: "^5.1.0" } }),
        "web/package.json": "{ not json",
        "worker/package.json": JSON.stringify({ dependencies: { express: { version: "5" } } }),
      }),
    );
    expect(ranges("api/src/app.js", "express")).toBe("^5.1.0");
    expect(ranges("api/src/app.js", "hono")).toBe("^4.0.0");
    expect(ranges("web/src/app.js", "express")).toBe("^4.18.0");
    expect(ranges("api/src/app.js", "fastify")).toBeUndefined();
    // Named with a value that is no range: at no one version, not at the root's.
    expect(ranges("worker/src/app.js", "express")).toBe("*");
  });
});

describe("routes registered in each router's syntax", () => {
  it("reads Express 5 paths by the version its package.json gives, and names what it leaves out", () => {
    const files = {
      "api/package.json": JSON.stringify({ dependencies: { express: "^5.1.0" } }),
      "api/src/app.js": [
        'import express from "express";',
        "const app = express();",
        'app.get("/about{/:section}", (req, res) => res.send(""));',
        'app.get("/files/*filepath", (req, res) => res.send(""));',
        'app.get("/users/:id?", (req, res) => res.send(""));',
      ].join("\n"),
    };
    expect(routes(files)).toEqual({
      ids: ["GET /about/{section}", "GET /about", "GET /files/{filepath}/**"],
      limits: ["routes api: api/src/app.js:5 registers /users/:id?, a path not read: path-to-regexp 8 rejects an unexpected `?`"],
    });
  });

  it("reads Express 4 paths, and Express of no version where its versions agree", () => {
    const app = ['import express from "express";', "const app = express();", 'app.get("/files/*", h);', 'app.get("/users/:id?", h);', 'app.get("/about{/:section}", h);'].join("\n");
    expect(routes({ "api/package.json": JSON.stringify({ dependencies: { express: "~4.18.1" } }), "api/src/app.js": app })).toEqual({
      ids: ["GET /files/**", "GET /users/{id}", "GET /users"],
      limits: ["routes api: api/src/app.js:5 registers /about{/:section}, a path not read: Express 4 (path-to-regexp 0.1) writes it into a regular expression, which is not read"],
    });
    expect(routes({ "api/src/app.js": app })).toEqual({
      ids: ["GET /files/**", "GET /users/{id}", "GET /users"],
      limits: [
        "routes api: api/src/app.js:5 registers /about{/:section}, a path not read: Express 4 and 5 read it differently (path-to-regexp 0.1 and 8), and no package.json above it gives one major version of express",
      ],
    });
  });

  it("joins an @koa/router prefix holding a parameter before the path and reads them as one", () => {
    const files = {
      "api/package.json": JSON.stringify({ dependencies: { "@koa/router": "^15.7.0" } }),
      "api/src/routes.js": [
        'import Koa from "koa";',
        'import Router from "@koa/router";',
        'const router = new Router({ prefix: "/api/v:version" });',
        'router.get("/files/*path", h);',
        "new Koa().use(router.routes());",
      ].join("\n"),
    };
    expect(routes(files, { receivers: ["router"] })).toEqual({ ids: ["GET /api/v{version}/files/{path}/**"], limits: [] });
    const old = { ...files, "api/package.json": JSON.stringify({ dependencies: { "@koa/router": "^13.1.0" } }) };
    expect(routes(old, { receivers: ["router"] })).toEqual({
      ids: [],
      limits: ["routes api: api/src/routes.js:4 registers /api/v:version/files/*path, a path not read: @koa/router 13 reads it with path-to-regexp 6, which is not read"],
    });
  });

  it("keeps the regexps Fastify and Hono test parameters with, and reads a plain path on an untraced receiver", () => {
    const fastify = {
      "api/package.json": JSON.stringify({ dependencies: { fastify: "^5.0.0" } }),
      "api/src/server.js": ['import Fastify from "fastify";', "const app = Fastify();", 'app.get("/img/:file(^\\\\d+).png", h);', 'app.get("/posts/:id?", h);'].join("\n"),
    };
    expect(routes(fastify, { receivers: ["app"] })).toEqual({ ids: ['GET /img/{file}.png {"file":"(\\\\d+)"}', "GET /posts/{id}", "GET /posts"], limits: [] });
    const hono = {
      "api/package.json": JSON.stringify({ dependencies: { hono: "^4.13.0" } }),
      "api/src/app.js": ['import { Hono } from "hono";', "const app = new Hono();", 'app.get("/post/:date{[0-9]+}", h);', 'app.get("/api/*", h);'].join("\n"),
    };
    expect(routes(hono, { receivers: ["app"] })).toEqual({ ids: ['GET /post/{date} {"date":"[0-9]+"}', "GET /api/**"], limits: [] });
    const untraced = { "api/src/routes.ts": ['router.get("/users/:id", h);', 'router.get("/drafts/:id?", h);'].join("\n") };
    expect(routes(untraced, { receivers: ["router"] })).toEqual({
      ids: ["GET /users/{id}"],
      limits: [
        "routes api: api/src/routes.ts:2 registers /drafts/:id?, a path not read: its router is not traced to Express, @koa/router, Fastify or Hono, which read path syntax differently",
      ],
    });
  });

  it("writes the regexps into a graph that conforms to its schema", () => {
    const files = {
      "api/package.json": JSON.stringify({ dependencies: { fastify: "^5.0.0" } }),
      "api/src/server.js": ['import Fastify from "fastify";', "const app = Fastify();", 'app.get("/lang/:code(^[a-z]+)", h);'].join("\n"),
    };
    const config = normalizeConfig({ components: [{ name: "api", path: "api" }], routes: [{ component: "api", files: ["api/src/**"], styles: ["express"], receivers: ["app"] }] });
    const graph = scan(memory(files), config);
    expect(graph.surfaces.map((s) => [s.id, s.patterns])).toEqual([["api|GET /lang/{code}", { code: "([a-z]+)" }]]);
    expect(validate("graph", graph)).toEqual([]);
  });

  it("resolves a router's package from where it is created, and a Fastify plugin's from the instance it is under", () => {
    const read = (files: Record<string, string>) => {
      const limits: string[] = [];
      const config = normalizeConfig({ components: [{ name: "api", path: "." }], routes: [{ component: "api", files: ["shared/**", "web/**", "plugins/**", "server/**"], styles: ["express"], receivers: [] }] });
      return { ids: extractRoutes(memory(files), config, undefined, [], limits).map((s) => `${s.method} ${s.path}`), limits };
    };
    // An Express 4 application imported into a package that depends on Express 5 is still Express 4.
    expect(
      read({
        "shared/package.json": JSON.stringify({ dependencies: { express: "~4.18.1" } }),
        "shared/app.js": 'import express from "express";\nexport const app = express();\n',
        "web/package.json": JSON.stringify({ dependencies: { express: "^5.1.0" } }),
        "web/routes.js": 'import { app } from "../shared/app.js";\napp.get("/posts/:id?", h);\n',
      }),
    ).toEqual({ ids: ["GET /posts/{id}", "GET /posts"], limits: [] });
    // A plugin in a directory with no package.json takes the Fastify of the instance that registers it.
    expect(
      read({
        "plugins/files.js": 'export default async function (f) {\n  f.get("/files/*", h);\n}\n',
        "server/package.json": JSON.stringify({ dependencies: { fastify: "^5.0.0" } }),
        "server/app.js": 'import Fastify from "fastify";\nimport files from "../plugins/files.js";\nconst app = Fastify();\napp.register(files);\n',
      }),
    ).toEqual({ ids: ["GET /files/**"], limits: [] });
  });

  it("keeps no regexp on a path two registrations take by different ones", () => {
    const files = {
      "api/package.json": JSON.stringify({ dependencies: { fastify: "^5.0.0" } }),
      "api/src/server.js": ['import Fastify from "fastify";', "const app = Fastify();", 'app.get("/v/:id(^\\\\d+)", h);', 'app.get("/v/:id(^[a-z]+)", h);'].join("\n"),
    };
    expect(routes(files, { receivers: ["app"] })).toEqual({ ids: ["GET /v/{id}"], limits: [] });
  });

  it("reads a Nest controller's wildcard by the Nest version its package.json gives", () => {
    const controller = [
      "import { Controller, Get } from '@nestjs/common';",
      "@Controller('cats')",
      "export class CatsController {",
      "  @Get('abcd/*') wild() {}",
      "  @Get('trips/:from-:to') trips() {}",
      "  @Get(':id?') maybe() {}",
      "}",
    ].join("\n");
    const nest = (deps: Record<string, string>) => {
      const limits: string[] = [];
      const config = normalizeConfig({ components: [{ name: "api", path: "api" }], routes: [{ component: "api", files: ["api/src/**"], styles: ["nest"] }] });
      const files = { "api/package.json": JSON.stringify({ dependencies: deps }), "api/src/cats.controller.ts": controller };
      return { ids: extractRoutes(memory(files), config, undefined, [], limits).map((s) => `${s.method} ${s.path}`), limits };
    };
    expect(nest({ "@nestjs/platform-express": "^12.3.2" })).toEqual({
      ids: ["GET /cats/abcd/{*path}", "GET /cats/trips/{from}-{to}"],
      limits: ["routes api: api/src/cats.controller.ts:6 registers /cats/:id?, a path not read: path-to-regexp 8 rejects an unexpected `?`"],
    });
    expect(nest({ "@nestjs/platform-express": "^10.4.0" })).toEqual({ ids: ["GET /cats/abcd/**", "GET /cats/trips/{from}-{to}", "GET /cats/{id}", "GET /cats"], limits: [] });
  });

  it("takes Nest's adapter from the application the bootstrap names, not from the controllers' package", () => {
    const limits: string[] = [];
    const config = normalizeConfig({
      components: [{ name: "api", path: "." }],
      routes: [{ component: "api", files: ["libs/**"], styles: ["nest"], bootstrap: "server/main.ts" }],
    });
    const files = {
      "libs/package.json": JSON.stringify({ dependencies: { "@nestjs/common": "^12.3.2" } }),
      "libs/cats/cats.controller.ts": "import { Controller, Get } from '@nestjs/common';\n@Controller('cats')\nexport class CatsController {\n  @Get('abcd/*') wild() {}\n}\n",
      "server/package.json": JSON.stringify({ dependencies: { "@nestjs/platform-express": "^12.3.2" } }),
      "server/main.ts": "import { NestFactory } from '@nestjs/core';\nasync function bootstrap() {\n  const app = await NestFactory.create(AppModule);\n  await app.listen(3000);\n}\nbootstrap();\n",
    };
    expect({ ids: extractRoutes(memory(files), config, undefined, [], limits).map((s) => `${s.method} ${s.path}`), limits }).toEqual({ ids: ["GET /cats/abcd/{*path}"], limits: [] });
  });
});

describe("matching the forms read", () => {
  const surface = (path: string, patterns?: Record<string, string>): Surface => ({
    id: `s|GET ${path}`,
    component: "s",
    method: "GET",
    path,
    at: { file: "a", line: 1 },
    evidence: "static",
    ...(patterns ? { patterns } : {}),
  });
  const call = (path: string): Call => ({ id: `c|${path}`, from: "w", to: "s", method: "GET", path, at: { file: "b", line: 1 }, evidence: "text", based: false });

  it("takes a segment of several parameters by the text between them, not as one parameter", () => {
    expect(pathsMatch("/flights/{from}-{to}", "/flights/ICN-SFO")).toBe(true);
    expect(pathsMatch("/flights/{from}-{to}", "/flights/ICN")).toBe(false);
    expect(pathsMatch("/plantae/{genus}.{species}", "/plantae/prunus.persica")).toBe(true);
    expect(pathsMatch("/plantae/{genus}.{species}", "/plantae/{}")).toBe(true);
    // A call that interpolates part of the segment meets it where the fixed text at either end agrees.
    expect(pathsMatch("/flights/{from}-{to}", "/flights/ICN-{}")).toBe(true);
    expect(pathsMatch("/flights/{from}-{to}", "/flights/{}-SFO")).toBe(true);
    expect(pathsMatch("/files/{name}.png", "/files/a{}.png")).toBe(true);
    expect(pathsMatch("/files/{name}.png", "/files/{}.jpg")).toBe(false);
    expect(pathsMatch("/resources/*.png", "/resources/{}.jpg")).toBe(false);
    expect(pathsMatch("/v{version}/status", "/x{}/status")).toBe(false);
  });

  it("lets a parameter sharing a segment take empty text where its router does", () => {
    // Fastify's `(.*?)` and Spring's `(.*)` take none; path-to-regexp's `[^/]+`, the default, takes some.
    expect(pathsMatch("/lib/{name}-{version}", "/lib/-1", { name: ".*", version: ".*" })).toBe(true);
    expect(pathsMatch("/near/{lat}-{lng}", "/near/-5", { lat: "(.*?)", lng: "(-|(?:(?!-).)*)" })).toBe(true);
    expect(pathsMatch("/flights/{from}-{to}", "/flights/-SFO")).toBe(false);
    const files = { "src/main/java/app/Lib.java": '@RestController\nclass Lib {\n  @GetMapping("/lib/{name:[a-z-]+}-{version}") String a() { return ""; }\n  @GetMapping("/lib/{id}") String b() { return ""; }\n}\n' };
    const config = normalizeConfig({ components: [{ name: "s", path: "." }], routes: [{ component: "s", files: ["src/**"], styles: ["spring"] }] });
    expect(extractRoutes(memory(files), config).map((s) => [s.id, s.patterns])).toEqual([
      ["s|GET /lib/{name}-{version}", { name: ".*", version: ".*" }],
      ["s|GET /lib/{id}", undefined],
    ]);
  });

  it("settles no segment by a regexp this runtime cannot compile", () => {
    const python = { id: "(?P<n>\\d+)" };
    expect(pathsMatch("/users/{id}", "/users/abc", python)).toBe(true);
    expect(pathCovers("/users/{id}", "/users/abc", python)).toBe(false);
    expect(pathCovers("/users/{id}", "/users/abc")).toBe(true);
  });

  it("holds a route reached by Starlette's slash redirect to its regexps too", () => {
    const route = surface("/api/{v}/{path:path}", { v: "\\d+" });
    const { targetsOf } = matchCalls({ surfaces: [route], calls: [call("/api/1"), call("/api/x")] });
    expect([targetsOf.get(0)?.length, targetsOf.get(1)?.length]).toEqual([1, undefined]);
  });

  it("takes a parameter's text only where its regexp does, and any where the call interpolates it", () => {
    expect(pathsMatch("/example/{file}.png", "/example/12.png", { file: "(\\d+)" })).toBe(true);
    expect(pathsMatch("/example/{file}.png", "/example/ab.png", { file: "(\\d+)" })).toBe(false);
    expect(pathsMatch("/lang/{code}", "/lang/ko", { code: "([a-z]+)" })).toBe(true);
    expect(pathsMatch("/lang/{code}", "/lang/KO", { code: "([a-z]+)" })).toBe(false);
    expect(pathsMatch("/at/{hour}h{minute}m", "/at/09h30m", { hour: "(\\d{2})", minute: "(\\d{2})" })).toBe(true);
    expect(pathsMatch("/at/{hour}h{minute}m", "/at/9h30m", { hour: "(\\d{2})", minute: "(\\d{2})" })).toBe(false);
    expect(pathsMatch("/lang/{code}", "/lang/{}", { code: "([a-z]+)" })).toBe(true);
    // A parameter with a regexp does not take every value an interpolation may hold.
    expect(pathCovers("/lang/{code}", "/lang/{}", { code: "([a-z]+)" })).toBe(false);
    expect(pathCovers("/lang/{code}", "/lang/{}")).toBe(true);
    const { targetsOf } = matchCalls({ surfaces: [surface("/lang/{code}", { code: "([a-z]+)" })], calls: [call("/lang/ko"), call("/lang/42")] });
    expect([targetsOf.get(0)?.length, targetsOf.get(1)?.length]).toEqual([1, undefined]);
  });

  it("takes one character for Spring's `?` within a segment", () => {
    expect(pathsMatch("/pages/t?st.html", "/pages/test.html")).toBe(true);
    expect(pathsMatch("/pages/t?st.html", "/pages/toast.html")).toBe(false);
    expect(pathsMatch("/resources/*.png", "/resources/a.png")).toBe(true);
  });

  it("counts every variable of a segment in Spring's ranking", () => {
    // `{name}-{version}` scores two variables to `{id}`'s one, so Spring prefers `{id}` (PathPattern.getScore).
    const { targetsOf } = matchCalls({ surfaces: [surface("/lib/{name}-{version}"), surface("/lib/{id}")], calls: [call("/lib/a-1")] }, new Map([["s", "spring"]]));
    expect(targetsOf.get(0)!.map((s) => s.id)).toEqual(["s|GET /lib/{id}"]);
  });
});
