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

  it("says once where route(path) is given a path not spelled out, whatever the methods chained on it", () => {
    const files = { "api/app.js": lines('const app = require("express")();', "app.route(BOOK).get(h).post(h);", 'app.route("book").get(h);') };
    expect(routes(files)).toEqual({
      ids: [],
      limits: [
        'routes api: api/app.js:3 registers "book" on app, a path that does not start with `/`; its routes are not read',
        "routes api: api/app.js:2 registers a path the file does not spell out (BOOK); its routes are not read",
      ],
    });
  });

  it("places each method chained on route(path) where it is named", () => {
    const files = { "api/app.js": lines('const app = require("express")();', "app", '  .route("/book")', "  .get(h)", "  .post(h);") };
    const config = normalizeConfig({ components: [{ name: "api", path: "api" }], routes: [{ component: "api", files: ["api/**"], styles: ["express"] }] });
    const limits: string[] = [];
    const placed = extractRoutes(memory(files), config, undefined, [], limits).map((s) => `${s.method} ${s.path} ${s.at.line}`);
    expect({ placed: placed.sort(), limits }).toEqual({ placed: ["GET /book 4", "POST /book 5"], limits: [] });
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

describe("Nest: the QUERY method", () => {
  it("reads @QueryMethod as QUERY, under the controller's path", () => {
    const files = { "api/cats.controller.ts": lines("@Controller('cats')", "export class CatsController {", "  @QueryMethod('search') search() {}", "  @Query() q() {}", "}") };
    expect(routes(files, { styles: ["nest"] })).toEqual({ ids: ["QUERY /cats/search"], limits: [] });
  });
});

describe("FastAPI: add_api_route", () => {
  const python = (text: string) => routes({ "api/main.py": text }, { styles: ["fastapi"], files: ["api/**/*.py"] });

  it("reads add_api_route with the methods it names, GET where it names none or None", () => {
    const text = lines(
      "from fastapi import APIRouter, FastAPI",
      "app = FastAPI()",
      'router = APIRouter(prefix="/items")',
      'app.add_api_route("/health", health)',
      'app.add_api_route(path="/ping", endpoint=ping, methods=None)',
      'router.add_api_route("/{item_id}", update, methods=["PUT", "patch"])',
      "app.include_router(router)",
    );
    expect(python(text)).toEqual({ ids: ["GET /health", "GET /ping", "PATCH /items/{item_id}", "PUT /items/{item_id}"], limits: [] });
  });

  it("says where its path or its methods are not spelled out", () => {
    const text = lines("from fastapi import FastAPI", "app = FastAPI()", "app.add_api_route(PATH, health)", 'app.add_api_route("/x", h, methods=VERBS)');
    expect(python(text)).toEqual({
      ids: [],
      limits: [
        "routes api: api/main.py:3 registers a path the file does not spell out (PATH); its routes are not read",
        "routes api: api/main.py:4 registers /x with methods the file does not spell out; its routes are not read",
      ],
    });
  });
});

describe("Spring: functional endpoints", () => {
  const spring = (files: Record<string, string>) => {
    const limits: string[] = [];
    const config = normalizeConfig({ components: [{ name: "api", path: "api" }], routes: [{ component: "api", files: ["api/**/*.{java,kt}"], styles: ["spring"] }] });
    const surfaces = extractRoutes(memory(files), config, undefined, [], limits);
    return { ids: surfaces.map((s) => `${s.method} ${s.path}`).sort(), limits };
  };
  const java = (...body: string[]) =>
    lines(
      "package app;",
      "import static org.springframework.web.servlet.function.RequestPredicates.*;",
      "import static org.springframework.web.servlet.function.RouterFunctions.route;",
      "import org.springframework.web.servlet.function.*;",
      "@Configuration",
      "class Routes {",
      ...body,
      "}",
    );

  it("reads the builder's methods, nests, predicates and the router functions it adds", () => {
    const text = java(
      "  @Bean",
      "  RouterFunction<ServerResponse> people(PeopleHandler handler) {",
      '    RouterFunction<ServerResponse> other = route(GET("/hello"), request -> ok().build());',
      "    return route()",
      '        .GET("/people/{id}", accept(APPLICATION_JSON), handler::get)',
      '        .POST("/people", handler::create)',
      '        .path("/teams", b1 -> b1',
      "            .nest(accept(APPLICATION_JSON), b2 -> b2",
      '                .GET("/{id:[0-9]+}", handler::get)',
      "                .GET(handler::list))",
      "            .POST(handler::create))",
      '        .nest(path("/admin"), () -> route().DELETE("/cache", handler::clear).build())',
      '        .route(method(HttpMethod.PATCH).and(path("/settings")), handler::update)',
      "        .add(other)",
      "        .filter((request, next) -> next.handle(request))",
      "        .build();",
      "  }",
    );
    expect(spring({ "api/Routes.java": text })).toEqual({
      ids: ["DELETE /admin/cache", "GET /hello", "GET /people/{id}", "GET /teams/**", "GET /teams/{id}", "PATCH /settings", "POST /people", "POST /teams/**"],
      limits: [],
    });
  });

  it("reads the static composition: nest, route, andRoute, or and and, and resources", () => {
    const text = java(
      "  @Bean",
      "  RouterFunction<ServerResponse> orders(Handler handler) {",
      '    return nest(path("/orders"),',
      '        route(GET("/{id}"), handler::get)',
      '            .andRoute(GET("/{id}/items").or(GET("/{id}/lines")), handler::list)',
      '            .andRoute(POST("").and(accept(APPLICATION_JSON)), handler::create))',
      '        .and(RouterFunctions.resources("/files/**", new ClassPathResource("files/")));',
      "  }",
    );
    expect(spring({ "api/Routes.java": text })).toEqual({
      ids: ["GET /files/{path}/**", "GET /orders/{id}", "GET /orders/{id}/items", "GET /orders/{id}/lines", "HEAD /files/{path}/**", "POST /orders"],
      limits: [],
    });
  });

  it("reads the Kotlin DSL: nests, a route with no path, invoke and resources", () => {
    const text = lines(
      "package app",
      "import org.springframework.web.servlet.function.router",
      "@Configuration",
      "class Routes {",
      "  @Bean",
      "  fun memoRouter() = router {",
      '    "/memos".nest {',
      '      GET("/{id}") { ok().build() }',
      "      GET { ok().build() }",
      '      (POST("") and accept(APPLICATION_JSON)) { ok().build() }',
      "    }",
      '    "/ping" { ok().build() }',
      '    accept(TEXT_HTML).nest { GET("/page", handler::page) }',
      '    resources("/static/**", ClassPathResource("static/"))',
      '    GET("/predicate-only")',
      "  }",
      "}",
    );
    expect(spring({ "api/Routes.kt": text })).toEqual({
      ids: ["* /ping", "GET /memos/**", "GET /memos/{id}", "GET /page", "GET /static/{path}/**", "HEAD /static/{path}/**", "POST /memos"],
      limits: [],
    });
  });

  it("says what it does not read: a predicate or a router function not spelled out, a lookup, one outside a bean", () => {
    const text = java(
      "  @Bean",
      "  RouterFunction<ServerResponse> a(Handler handler, RouterFunction<ServerResponse> injected) {",
      "    return route()",
      '        .GET("/a", custom, handler::get)',
      '        .GET(pathExtension("json"), handler::get)',
      "        .add(injected)",
      "        .resources(request -> Optional.empty())",
      '        .GET("/ok", handler::get)',
      "        .build();",
      "  }",
      '  RouterFunction<ServerResponse> unused = RouterFunctions.route(GET("/x"), h);',
    );
    expect(spring({ "api/Routes.java": text })).toEqual({
      ids: ["GET /ok"],
      limits: [
        "routes api: api/Routes.java:10 registers GET on a predicate the file does not spell out (custom); its routes are not read",
        "routes api: api/Routes.java:11 registers GET on a predicate atlas does not read (pathExtension(\"json\")); its routes are not read",
        "routes api: api/Routes.java:12 adds a router function the file does not spell out (injected); its routes are not read",
        "routes api: api/Routes.java:13 serves resources at paths a lookup function or a pattern the file does not spell out decides (resources); its routes are not read",
        "routes api: api/Routes.java:17 builds a router function outside a @Bean method (RouterFunctions); its routes are not read",
      ],
    });
  });

  it("reads past an argument it does not parse: a cast, in a handler or before it", () => {
    const text = java(
      "  @Bean",
      "  RouterFunction<ServerResponse> r(Repo repo, H h) {",
      "    return route()",
      '        .GET("/count", req -> ok().header("X-Count", (String) repo.count()).build())',
      '        .GET("/cast", (HandlerFunction<ServerResponse>) req -> ok().build())',
      '        .POST("/items", h::create)',
      "        .build();",
      "  }",
    );
    expect(spring({ "api/Routes.java": text })).toEqual({ ids: ["GET /cast", "GET /count", "POST /items"], limits: [] });
  });

  it("does not take a local assigned again, a method not named on HttpMethod, or a predicate grown past its bound", () => {
    const text = java(
      "  @Bean",
      "  RouterFunction<ServerResponse> r(H h) {",
      '    String p = "/a";',
      '    p = "/b";',
      '    final String q = "/q";',
      '    RequestPredicate p0 = path("/x").or(path("/y"));',
      ...Array.from({ length: 22 }, (_, i) => `    RequestPredicate p${i + 1} = p${i}.or(p${i});`),
      "    return route(GET(p), h::a)",
      '        .andRoute(method(VERB).and(path("/m")), h::m)',
      '        .andRoute(method(HttpMethod.PUT).and(path("/put")), h::put)',
      "        .andRoute(GET(q), h::q)",
      "        .andRoute(p22, h::x);",
      "  }",
    );
    expect(spring({ "api/Routes.java": text })).toEqual({
      ids: ["GET /q", "PUT /put"],
      limits: [
        "routes api: api/Routes.java:35 routes on a pattern the file does not spell out (p); its routes are not read",
        'routes api: api/Routes.java:36 routes on a predicate atlas does not read (method(VERB)); its routes are not read',
        "routes api: api/Routes.java:39 routes on a predicate of more than 256 combinations of methods and paths; its routes are not read",
      ],
    });
  });

  it("reads a helper a bean calls, no bean twice, and says where a helper no bean calls builds one", () => {
    const text = java(
      "  @Bean RouterFunction<ServerResponse> all() { return api().and(admin()); }",
      '  @Bean RouterFunction<ServerResponse> admin() { return route(GET("/admin"), h); }',
      '  private RouterFunction<ServerResponse> api() { return route(GET("/api"), h); }',
      '  RouterFunction<ServerResponse> spare() { return route(GET("/spare"), h); }',
    );
    expect(spring({ "api/Routes.java": text })).toEqual({
      ids: ["GET /admin", "GET /api"],
      limits: ["routes api: api/Routes.java:10 builds a router function in spare, which no @Bean method of the file calls; its routes are not read"],
    });
  });

  it("reads the DSL imported under another name, WebFlux's included", () => {
    const text = lines(
      "package app",
      "import org.springframework.web.reactive.function.server.coRouter as routes",
      "@Configuration",
      "class Routes {",
      '  @Bean fun memos() = routes { GET("/memos") { ok().buildAndAwait() } }',
      '  @Bean fun notes(): RouterFunction<*> = RouterFunctions.route().GET("/notes") { ok().build() }.build()',
      "}",
    );
    expect(spring({ "api/Routes.kt": text })).toEqual({ ids: ["GET /memos", "GET /notes"], limits: [] });
  });

  it("leaves a predicate of too many combinations unread", () => {
    const any = (f: string) => `(${["a", "b", "c", "d"].map((x) => `${f}("${x}")`).join(" or ")})`;
    const predicate = [any("path"), any("accept"), any("contentType"), any("headers"), any("param")].join(" and ");
    const text = lines("package app", "import org.springframework.web.servlet.function.router", "@Configuration", "class Routes {", `  @Bean fun many() = router { (${predicate}) { ok().build() } }`, "}");
    expect(spring({ "api/Routes.kt": text })).toEqual({
      ids: [],
      limits: ["routes api: api/Routes.kt:5 routes on a predicate of more than 256 combinations of methods and paths; its routes are not read"],
    });
  });
});

describe("Spring: @HttpExchange interfaces a controller implements, and registerMapping", () => {
  const spring = (files: Record<string, string>) => {
    const limits: string[] = [];
    const config = normalizeConfig({ components: [{ name: "api", path: "api" }], routes: [{ component: "api", files: ["api/**/*.{java,kt}"], styles: ["spring"] }] });
    const surfaces = extractRoutes(memory(files), config, undefined, [], limits);
    return { ids: surfaces.map((s) => `${s.method} ${s.path} ${s.at.file}:${s.at.line}`).sort(), limits };
  };
  const service = lines(
    "package app;",
    "import org.springframework.web.service.annotation.*;",
    '@HttpExchange(url = "/members")',
    "public interface MemberService {",
    '  @GetExchange("/{id}") Member get(@PathVariable long id);',
    "  @PostExchange void add(@RequestBody Member m);",
    '  @HttpExchange(url = "/{id}", method = "DELETE") void remove(@PathVariable long id);',
    "}",
  );

  it("serves a controller at the exchanges of the interface it implements, under its prefix", () => {
    const files = {
      "api/MemberService.java": service,
      "api/MemberController.java": lines("package app;", "@RestController", "public class MemberController implements MemberService, Serializable {", "  public Member get(long id) { return null; }", "}"),
      "api/Config.java": lines("package app;", "class Config implements WebMvcConfigurer {", "  public void configurePathMatch(PathMatchConfigurer c) {", '    c.addPathPrefix("/api", HandlerTypePredicate.forAnnotation(RestController.class));', "  }", "}"),
    };
    expect(spring(files)).toEqual({
      ids: ["DELETE /api/members/{id} api/MemberService.java:7", "GET /api/members/{id} api/MemberService.java:5", "POST /api/members api/MemberService.java:6"],
      limits: [],
    });
  });

  it("takes the controller's own mappings first, and serves no interface no controller implements", () => {
    const files = {
      "api/MemberService.java": service,
      "api/Client.java": lines("package app;", '@HttpExchange("/clients")', "interface Client {", '  @GetExchange("/{id}") Object get();', "}"),
      "api/MemberController.kt": lines(
        "package app",
        "@RestController",
        '@RequestMapping("/v2/members")',
        "class MemberController : MemberService {",
        '  @GetMapping("/{id}/full") override fun get(id: Long): Member = TODO()',
        "  override fun add(m: Member) {}",
        "  override fun remove(id: Long) {}",
        "}",
      ),
    };
    expect(spring(files)).toEqual({
      ids: ["DELETE /v2/members/{id} api/MemberService.java:7", "GET /v2/members/{id}/full api/MemberController.kt:5", "POST /v2/members api/MemberService.java:6"],
      limits: [],
    });
  });

  it("puts the controller's own methods and every interface's under the one type-level mapping Spring takes", () => {
    const files = {
      "api/A.java": lines("package app;", "interface A {", '  @GetExchange("/a") String a();', "}"),
      "api/B.java": lines("package app;", '@HttpExchange("/b")', "interface B {", '  @GetExchange("/x") String x();', "}"),
      "api/C.java": lines("package app;", "@RestController", "class C implements A, B {", '  @GetMapping("/own") String own() { return ""; }', "}"),
    };
    expect(spring(files)).toEqual({ ids: ["GET /b/a api/A.java:3", "GET /b/own api/C.java:4", "GET /b/x api/B.java:4"], limits: [] });
  });

  it("reads registerMapping's RequestMappingInfo, in place or in a local, with no prefix", () => {
    const text = lines(
      "package app;",
      "import org.springframework.web.servlet.mvc.method.RequestMappingInfo;",
      "class Registration {",
      "  @Autowired",
      "  void register(RequestMappingHandlerMapping mapping, UserHandler handler) throws Exception {",
      '    RequestMappingInfo info = RequestMappingInfo.paths("/user/{id}", "users/{id}").methods(RequestMethod.GET, RequestMethod.HEAD).produces("application/json").build();',
      '    mapping.registerMapping(info, handler, UserHandler.class.getMethod("get", Long.class));',
      '    mapping.registerMapping(RequestMappingInfo.paths("/any").build(), handler, m);',
      "    mapping.registerMapping(RequestMappingInfo.paths(PATH).build(), handler, m);",
      "    mapping.registerMapping(other, handler, m);",
      "  }",
      "}",
    );
    expect(spring({ "api/Registration.java": text })).toEqual({
      ids: ["* /any api/Registration.java:8", "GET /user/{id} api/Registration.java:7", "GET /users/{id} api/Registration.java:7", "HEAD /user/{id} api/Registration.java:7", "HEAD /users/{id} api/Registration.java:7"],
      limits: [
        "routes api: api/Registration.java:9 registers a handler method with paths the file does not spell out (RequestMappingInfo.paths(PATH).build()); its route is not read",
        "routes api: api/Registration.java:10 registers a handler method with a mapping the file does not spell out (other); its route is not read",
      ],
    });
  });
});
