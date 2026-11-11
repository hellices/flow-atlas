import { describe, expect, it } from "vitest";
import { normalizeConfig } from "../src/config.js";
import { extractRoutes } from "../src/extract/routes.js";
import type { Source } from "../src/source.js";
import { fastapiDocumentation } from "./documentation.js";

const memory = (files: Record<string, string>): Source => ({
  ref: "WORKTREE",
  list: () => Object.keys(files),
  read: (p) => files[p],
  asOf: () => "2026-11-01T00:00:00Z",
});

const routes = (files: Record<string, string>, entry: Record<string, unknown>) => {
  const limits: string[] = [];
  const config = normalizeConfig({ components: [{ name: "api", path: "api" }], routes: [{ component: "api", files: ["api/**"], ...entry }] });
  const ids = extractRoutes(memory(files), config, undefined, [], limits)
    .filter((s) => !fastapiDocumentation(s))
    .map((s) => `${s.method} ${s.path}`)
    .sort();
  return { ids, limits };
};
const lines = (...l: string[]) => l.join("\n");
const express = { styles: ["express"] };

describe("Express sub-applications", () => {
  it("serves an application another mounts with use under the mount's path, and one mounted nowhere at the root", () => {
    const files = {
      "api/app.js": lines('import express from "express";', 'import admin from "./admin.js";', "const app = express();", 'app.get("/", h);', 'app.use("/admin", admin);'),
      "api/admin.js": lines('const express = require("express");', "const admin = express();", 'admin.get("/dashboard", h);', "module.exports = admin;"),
    };
    expect(routes(files, express)).toEqual({ ids: ["GET /", "GET /admin/dashboard"], limits: [] });
  });

  it("leaves a sub-application mounted at a path the code does not spell out unread, and says so", () => {
    const files = { "api/app.js": lines('import express from "express";', "const app = express();", "const admin = express();", 'admin.get("/x", h);', "app.use(base, admin);") };
    expect(routes(files, express)).toEqual({
      ids: [],
      limits: ["routes api: router admin in api/app.js is mounted where the code gives no literal path; its routes are not read (declare it in mounts)"],
    });
  });
});

describe("@koa/router prefixes and nested routers", () => {
  it("joins a router's prefix, the path it is nested at and the prefixes of the routers above it", () => {
    const files = {
      "api/app.js": lines('import Koa from "koa";', 'import api from "./api.js";', "const app = new Koa();", "app.use(api.routes()).use(api.allowedMethods());"),
      "api/api.js": lines(
        'import Router from "@koa/router";',
        "const users = new Router();",
        'users.get("/", h);',
        'users.get("/:id", h);',
        "const legacy = new Router();",
        'legacy.prefix("/legacy");',
        'legacy.get("/items", h);',
        'const api = new Router({ prefix: "/api" });',
        'api.use("/users", users.routes());',
        "api.use(legacy.middleware());",
        "export default api;",
      ),
    };
    expect(routes(files, express)).toEqual({ ids: ["GET /api/legacy/items", "GET /api/users", "GET /api/users/{id}"], limits: [] });
  });

  it("leaves a router unread where its prefix is not spelled out, is set twice or it is mounted nowhere, and says so", () => {
    const files = {
      "api/app.js": lines(
        'const Koa = require("koa");',
        'const Router = require("koa-router");',
        "const app = new Koa();",
        "const a = new Router({ prefix: PREFIX });",
        'a.get("/a", h);',
        'const b = new Router({ prefix: "/b" });',
        'b.prefix("/c");',
        'b.get("/b", h);',
        "const c = new Router();",
        'c.get("/c", h);',
        "app.use(a.routes());",
        "app.use(b.routes());",
      ),
    };
    expect(routes(files, express)).toEqual({
      ids: [],
      limits: [
        "routes api: router a in api/app.js has a prefix the code does not spell out (prefix: PREFIX); its routes are not read (declare it in mounts)",
        "routes api: router b in api/app.js has its prefix set more than once, which @koa/router applies differently by version (stacked before 15.1, replaced since); its routes are not read (declare it in mounts)",
        "routes api: router c in api/app.js is mounted where the code gives no literal path; its routes are not read (declare it in mounts)",
      ],
    });
  });
});

describe("prefix options under a computed name", () => {
  it("reads a computed name spelled out, and leaves one that may be the prefix unread", () => {
    const files = {
      "api/app.js": lines(
        'import Koa from "koa";',
        'import Router from "@koa/router";',
        'import Fastify from "fastify";',
        "const app = new Koa();",
        'const a = new Router({ ["prefix"]: "/a" });',
        'a.get("/x", h);',
        'const b = new Router({ prefix: "/b", [key]: "/c" });',
        'b.get("/x", h);',
        "app.use(a.routes());",
        "app.use(b.routes());",
        "const server = Fastify();",
        'server.register(async function (f) { f.get("/x", h); }, { [`prefix`]: "/f" });',
      ),
    };
    expect(routes(files, express)).toEqual({
      ids: ["GET /a/x", "GET /f/x"],
      limits: ['routes api: router b in api/app.js has a prefix the code does not spell out ([key]: "/c"); its routes are not read (declare it in mounts)'],
    });
  });
});

describe("Hono groups and base paths", () => {
  it("serves a group under the path route mounts it at, joined to the base path of the instance it is mounted on", () => {
    const files = {
      "api/app.ts": lines('import { Hono } from "hono";', 'import api from "./api";', "const app = new Hono();", 'app.get("/", h);', 'app.route("/", api);'),
      "api/api.ts": lines(
        'import { Hono } from "hono";',
        "const v1 = new Hono();",
        'v1.get("/status", h);',
        'const api = new Hono().basePath("/api");',
        'api.get("/catalog", h);',
        'api.route("/v1", v1);',
        'const admin = api.basePath("/admin");',
        'admin.get("/users", h);',
        "export default api;",
      ),
    };
    expect(routes(files, express)).toEqual({ ids: ["GET /", "GET /api/admin/users", "GET /api/catalog", "GET /api/v1/status"], limits: [] });
  });

  it("leaves a group unread where its path or base path is not spelled out, and says so", () => {
    const files = {
      "api/app.ts": lines(
        'import { Hono } from "hono";',
        "const app = new Hono();",
        "const book = new Hono();",
        'book.get("/", h);',
        "app.route(BOOKS, book);",
        "const api = new Hono().basePath(BASE);",
        'api.get("/x", h);',
      ),
    };
    expect(routes(files, express)).toEqual({
      ids: [],
      limits: [
        "routes api: router book in api/app.ts is mounted where the code gives no literal path; its routes are not read (declare it in mounts)",
        "routes api: router api in api/app.ts has a base path the code does not spell out (BASE); its routes are not read (declare it in mounts)",
      ],
    });
  });
});

describe("a Hono base path the code does not spell out", () => {
  it("takes the path mounts declares for the file, and the literal base paths put after it", () => {
    const files = {
      "api/app.ts": lines('import { Hono } from "hono";', "const api = new Hono().basePath(BASE);", 'api.get("/x", h);', 'const admin = api.basePath("/admin");', 'admin.get("/y", h);'),
    };
    expect(routes(files, { ...express, mounts: { "api/app.ts": "/api" } })).toEqual({ ids: ["GET /api/admin/y", "GET /api/x"], limits: [] });
  });
});

describe("Fastify plugin prefixes", () => {
  it("serves a plugin's routes under the prefix of each register, nested, inline and imported", () => {
    const files = {
      "api/server.js": lines('import Fastify from "fastify";', 'import app from "./app.js";', "const server = Fastify();", "server.register(app);"),
      "api/app.js": lines(
        'import users from "./users.js";',
        'const admin = require("./admin.js");',
        "export default async function app(fastify) {",
        '  fastify.get("/", h);',
        '  fastify.register(users, { prefix: "/v1" });',
        "  fastify.register(async (instance) => {",
        '    instance.get("/", h);',
        '    instance.register(admin, { prefix: "admin" });',
        '  }, { prefix: "/api" });',
        "}",
      ),
      "api/users.js": lines("export default function (fastify, opts, done) {", '  fastify.get("/user", h);', "  done();", "}"),
      "api/admin.js": lines("module.exports = async function (f) {", '  f.delete("/settings/:key", h);', "};"),
    };
    expect(routes(files, express)).toEqual({ ids: ["DELETE /api/admin/settings/{key}", "GET /", "GET /api", "GET /v1/user"], limits: [] });
  });

  it("places a plugin registered on a receiver no register takes in at the root, and leaves one registered with a prefix it cannot read unread", () => {
    const files = {
      "api/app.js": lines(
        "module.exports = async function (fastify) {",
        '  fastify.get("/health", h);',
        '  fastify.register(require("./items.js"), { prefix: "/items" });',
        "  fastify.register(require(\"./orders.js\"), { prefix: config.orders });",
        "  fastify.register(require(\"./carts.js\"), options);",
        "};",
      ),
      "api/items.js": 'module.exports = async function (fastify) { fastify.get("/:id", h); };',
      "api/orders.js": 'module.exports = async function (fastify) { fastify.get("/:id", h); };',
      "api/carts.js": 'module.exports = async function (fastify) { fastify.get("/:id", h); };',
    };
    expect(routes(files, express)).toEqual({
      ids: ["GET /health", "GET /items/{id}"],
      limits: [
        "routes api: router fastify in api/orders.js is registered with a prefix the code does not spell out (prefix: config.orders); its routes are not read (declare it in mounts)",
        "routes api: router fastify in api/carts.js is registered with options the code does not spell out (options); its routes are not read (declare it in mounts)",
      ],
    });
  });
});

describe("a FastAPI application of another name", () => {
  it("is read under where it is mounted, whatever its name", () => {
    const files = { "api/main.py": lines("app = FastAPI()", "subapi = FastAPI()", '@subapi.get("/sub")', "def sub(): ...", 'app.mount("/subapi", subapi)') };
    expect(routes(files, { styles: ["fastapi"] })).toEqual({ ids: ["GET /subapi/sub"], limits: [] });
  });
});

describe("NestJS RouterModule paths", () => {
  const nest = { styles: ["nest"] };
  const controllers = {
    "api/src/admin/admin.controller.ts": "@Controller()\nexport class AdminController {\n  @Get() index() {}\n}",
    "api/src/admin/admin.module.ts": "import { AdminController } from './admin.controller';\n@Module({ controllers: [AdminController] })\nexport class AdminModule {}",
    "api/src/dash/dash.controller.ts": "@Controller('widgets')\nexport default class DashController {\n  @Get(':id') read() {}\n}",
    "api/src/dash/dash.module.ts": "import Dash from './dash.controller';\n@Module({ controllers: [Dash] })\nexport class DashModule {}",
    "api/src/stats/stats.module.ts": "@Controller('cpu')\nexport class StatsController {\n  @Get() cpu() {}\n}\n@Module({ controllers: [StatsController] })\nexport class StatsModule {}",
  };
  const module = (routes: string) => ({
    ...controllers,
    "api/src/app.module.ts": lines(
      "import { RouterModule } from '@nestjs/core';",
      "import { AdminModule } from './admin/admin.module';",
      "import { DashModule } from '@app/dash';",
      "import { StatsModule } from './stats/stats.module';",
      routes,
    ),
  });

  it("puts a module's path, joined to its parents', before the routes of its controllers", () => {
    const files = module(
      "@Module({ imports: [RouterModule.register([{ path: 'admin', module: AdminModule, children: [{ path: 'dash', module: DashModule }, StatsModule] }])] })\nexport class AppModule {}",
    );
    expect(routes(files, nest)).toEqual({ ids: ["GET /admin", "GET /admin/cpu", "GET /admin/dash/widgets/{id}"], limits: [] });
  });

  it("reads routes held in a const of the file, and leaves the controllers a path not spelled out reaches unread", () => {
    const files = module(
      "const routes: Routes = [{ path: ADMIN, module: AdminModule, children: [{ path: 'dash', module: DashModule }] }, { path: 'stats', module: StatsModule }];\n@Module({ imports: [RouterModule.register(routes)] })\nexport class AppModule {}",
    );
    expect(routes(files, nest)).toEqual({
      ids: ["GET /stats/cpu"],
      limits: ["routes api: api/src/app.module.ts:5 gives RouterModule a path the file does not spell out (ADMIN); the routes of the controllers it reaches are not read"],
    });
  });

  it("reads no controller's routes where the routes passed to register are not spelled out", () => {
    const files = module("@Module({ imports: [RouterModule.register(buildRoutes())] })\nexport class AppModule {}");
    expect(routes(files, nest)).toEqual({
      ids: [],
      limits: [
        "routes api: api/src/app.module.ts:5 registers routes the file does not spell out (buildRoutes()) with RouterModule, and which controllers they serve under which path is not read, so no route of the controllers is",
      ],
    });
  });

  it("reads RouterModule imported under another name, and a module named with `$` through a path alias", () => {
    const files = {
      ...controllers,
      "api/src/admin/admin.module.ts": "import { AdminController } from './admin.controller';\n@Module({ controllers: [AdminController] })\nexport class $AdminModule {}",
      "api/src/app.module.ts": lines(
        "import { RouterModule as RM } from '@nestjs/core';",
        "import { $AdminModule } from '@app/admin';",
        "@Module({ imports: [RM.register([{ path: 'admin', module: $AdminModule }])] })",
        "export class AppModule {}",
      ),
    };
    expect(routes(files, nest)).toEqual({ ids: ["GET /admin", "GET /cpu", "GET /widgets/{id}"], limits: [] });
  });

  it("leaves a module among the children of an entry whose path is not spelled out unread", () => {
    const files = module("@Module({ imports: [RouterModule.register([{ path: ADMIN, module: AdminModule, children: [StatsModule] }])] })\nexport class AppModule {}");
    expect(routes(files, nest)).toEqual({
      ids: ["GET /widgets/{id}"],
      limits: ["routes api: api/src/app.module.ts:5 gives RouterModule a path the file does not spell out (ADMIN); the routes of the controllers it reaches are not read"],
    });
  });

  it("leaves a module given two paths unread, as Nest keeps one", () => {
    const files = module("@Module({ imports: [RouterModule.register([{ path: 'a', module: AdminModule }, { path: 'b', module: AdminModule }])] })\nexport class AppModule {}");
    expect(routes(files, nest)).toEqual({
      ids: ["GET /cpu", "GET /widgets/{id}"],
      limits: ["routes api: RouterModule gives AdminModule more than one path (/a, /b), of which Nest keeps the last; the routes of its controllers are not read"],
    });
  });
});

describe("Spring path prefixes", () => {
  const spring = { styles: ["spring"] };
  const controllers = {
    "api/src/main/java/com/example/api/Rest.java":
      "package com.example.api;\nimport org.springframework.web.bind.annotation.*;\n@RestController\n@RequestMapping(\"/items\")\nclass Rest {\n  @GetMapping(\"/{id}\") String get() { return \"\"; }\n}",
    "api/src/main/java/com/example/web/Page.java":
      "package com.example.web;\nimport org.springframework.stereotype.Controller;\n@Controller\nclass Page {\n  @GetMapping(\"/home\") String home() { return \"home\"; }\n}",
  };
  const config = (body: string, file = "api/src/main/java/com/example/WebConfig.java") => ({
    ...controllers,
    [file]: `package com.example;\n@Configuration\nclass WebConfig implements WebMvcConfigurer {\n  public void configurePathMatch(PathMatchConfigurer configurer) {\n    ${body}\n  }\n}`,
  });

  const read = (ids: string[]) => ({ ids, limits: [] });

  it("gives the prefix to the handler types a predicate it reads accepts", () => {
    expect(routes(config('configurer.addPathPrefix("/api", HandlerTypePredicate.forAnnotation(RestController.class));'), spring)).toEqual(read(["GET /api/items/{id}", "GET /home"]));
    expect(routes(config('configurer.addPathPrefix("/v1", HandlerTypePredicate.forAnnotation(Controller.class));'), spring)).toEqual(read(["GET /v1/home", "GET /v1/items/{id}"]));
    expect(routes(config('configurer.addPathPrefix("/web", HandlerTypePredicate.forBasePackage("com.example.web"));'), spring)).toEqual(read(["GET /items/{id}", "GET /web/home"]));
    expect(routes(config('configurer.addPathPrefix(API, c -> c.isAnnotationPresent(RestController.class));\n  }\n  static final String API = "/api";\n  void x() {'), spring)).toEqual(
      read(["GET /api/items/{id}", "GET /home"]),
    );
  });

  it("reads a Kotlin configurer's trailing lambda, and the first of two prefixes one configurer gives", () => {
    const kotlin = config(
      'configurer.addPathPrefix("/api") { it.isAnnotationPresent(RestController::class.java) }\n    configurer.addPathPrefix("/all", HandlerTypePredicate.forAnnotation(Controller::class.java))',
      "api/src/main/kotlin/com/example/WebConfig.kt",
    );
    expect(routes(kotlin, spring)).toEqual(read(["GET /all/home", "GET /api/items/{id}"]));
  });

  it("reads a configurer outside the entry's files, in the component's code", () => {
    const files = config('configurer.addPathPrefix("/api", HandlerTypePredicate.forAnnotation(RestController.class));');
    expect(routes(files, { ...spring, files: ["api/**/Rest.java", "api/**/Page.java"] })).toEqual(read(["GET /api/items/{id}", "GET /home"]));
  });

  it("takes two configurers in one file as two, whose prefixes disagree", () => {
    const configurer = (name: string, prefix: string) =>
      `@Configuration\nclass ${name} implements WebMvcConfigurer {\n  public void configurePathMatch(PathMatchConfigurer c) {\n    c.addPathPrefix("${prefix}", HandlerTypePredicate.forAnnotation(RestController.class));\n  }\n}`;
    const files = { ...controllers, "api/src/main/java/com/example/WebConfig.java": `package com.example;\n${configurer("A", "/a")}\n${configurer("B", "/b")}` };
    expect(routes(files, spring)).toEqual({
      ids: ["GET /home"],
      limits: [
        "routes api: api/src/main/java/com/example/WebConfig.java:5, api/src/main/java/com/example/WebConfig.java:11 give path prefixes (/a, /b) in configurers whose order is not read; the routes of Rest are not read",
      ],
    });
  });

  it("follows the meta-annotations of the annotations a type carries, and decides none it cannot follow", () => {
    const files = {
      ...config('configurer.addPathPrefix("/audited", HandlerTypePredicate.forAnnotation(Audit.class));'),
      "api/src/main/java/com/example/Audited.java": "package com.example;\nimport java.lang.annotation.*;\n@Audit\n@Retention(RetentionPolicy.RUNTIME)\npublic @interface Audited {}",
      "api/src/main/java/com/example/web/Logged.java": "package com.example.web;\nimport com.example.Audited;\nimport org.springframework.web.bind.annotation.RestController;\n@RestController\n@Audited\nclass Logged {\n  @GetMapping(\"/logged\") String logged() { return \"\"; }\n}",
      "api/src/main/java/com/example/web/Tagged.java": "package com.example.web;\nimport org.springframework.web.bind.annotation.RestController;\nimport com.example.docs.Tag;\n@RestController\n@Tag(name = \"t\")\nclass Tagged {\n  @GetMapping(\"/tagged\") String tagged() { return \"\"; }\n}",
    };
    expect(routes(files, spring)).toEqual({
      ids: ["GET /audited/logged", "GET /home", "GET /items/{id}"],
      limits: [
        "routes api: api/src/main/java/com/example/WebConfig.java:5 gives a path prefix to the handler types HandlerTypePredicate.forAnnotation(Audit.class) accepts, which a supertype or a meta-annotation may decide; the routes of Tagged are not read",
      ],
    });
  });

  it("follows the annotations Spring, springdoc, Lombok and Jakarta declare, where the file imports them from there", () => {
    const tagged = (imports: string) => ({
      "api/src/main/java/com/example/WebConfig.java":
        'package com.example;\nclass WebConfig implements WebMvcConfigurer {\n  public void configurePathMatch(PathMatchConfigurer c) {\n    c.addPathPrefix("/api", HandlerTypePredicate.forAnnotation(RestController.class));\n  }\n}',
      "api/src/main/java/com/example/web/Docs.java": `package com.example.web;\n${imports}\n@Controller\n@Tag(name="x")\n@RequestMapping("/a")\n@Slf4j\n@Validated\nclass Docs {\n  @GetMapping("/b") String b() { return ""; }\n}`,
      "api/src/main/java/com/example/web/Rest.java": `package com.example.web;\nimport org.springframework.web.bind.annotation.*;\nimport io.swagger.v3.oas.annotations.tags.Tag;\n@RestController\n@Tag(name="x")\n@RequestMapping("/a")\nclass Rest {\n  @GetMapping("/c") String c() { return ""; }\n}`,
    });
    const known = [
      "import org.springframework.stereotype.Controller;",
      "import org.springframework.web.bind.annotation.*;",
      "import io.swagger.v3.oas.annotations.tags.Tag;",
      "import lombok.extern.slf4j.Slf4j;",
      "import org.springframework.validation.annotation.Validated;",
    ].join("\n");
    expect(routes(tagged(known), spring)).toEqual({ ids: ["GET /a/b", "GET /api/a/c"], limits: [] });
    // `Tag` from a package atlas does not know may carry @RestController.
    expect(routes(tagged(known.replace("io.swagger.v3.oas.annotations.tags.Tag", "com.example.docs.Tag")), spring)).toEqual({
      ids: ["GET /api/a/c"],
      limits: [
        "routes api: api/src/main/java/com/example/WebConfig.java:4 gives a path prefix to the handler types HandlerTypePredicate.forAnnotation(RestController.class) accepts, which a supertype or a meta-annotation may decide; the routes of Docs are not read",
      ],
    });
  });

  it("leaves the types a predicate or a prefix it does not read may reach unread, and says so", () => {
    expect(routes(config('configurer.addPathPrefix("/api", HandlerTypePredicate.forAssignableType(Base.class));'), spring)).toEqual({
      ids: [],
      limits: [
        "routes api: api/src/main/java/com/example/WebConfig.java:5 gives a path prefix to the handler types a predicate atlas does not read accepts (HandlerTypePredicate.forAssignableType(Base.class)); the routes of Page, Rest are not read",
      ],
    });
    expect(routes(config('configurer.addPathPrefix("${api.prefix}", HandlerTypePredicate.forAnnotation(RestController.class));'), spring)).toEqual({
      ids: ["GET /home"],
      limits: [
        'routes api: api/src/main/java/com/example/WebConfig.java:5 gives the handler types HandlerTypePredicate.forAnnotation(RestController.class) accepts a path prefix the file does not spell out ("${api.prefix}"); the routes of Rest are not read',
      ],
    });
  });

  it("does not decide an annotation for a type that names a supertype, or for an interface", () => {
    const files = {
      ...config('configurer.addPathPrefix("/api", HandlerTypePredicate.forAnnotation(RestController.class));'),
      "api/src/main/java/com/example/web/Sub.java": "package com.example.web;\nimport org.springframework.stereotype.Controller;\n@Controller\nclass Sub extends Base {\n  @GetMapping(\"/sub\") String sub() { return \"sub\"; }\n}",
      "api/src/main/java/com/example/web/Api.java": "package com.example.web;\ninterface Api {\n  @GetMapping(\"/i\") String i();\n}",
    };
    expect(routes(files, spring)).toEqual({
      ids: ["GET /api/items/{id}", "GET /home"],
      limits: [
        "routes api: api/src/main/java/com/example/WebConfig.java:5 gives a path prefix to the handler types HandlerTypePredicate.forAnnotation(RestController.class) accepts, which a supertype or a meta-annotation may decide; the routes of Sub are not read",
        "routes api: api/src/main/java/com/example/WebConfig.java:5 gives a path prefix to the handler types HandlerTypePredicate.forAnnotation(RestController.class) accepts, which the class that implements an interface decides; the routes of Api are not read",
      ],
    });
  });
});
