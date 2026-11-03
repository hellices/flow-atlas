import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it, vi } from "vitest";
import { main } from "../src/commands.js";
import { normalizeConfig } from "../src/config.js";
import { callsFromTemplate, callsFromTypeScript } from "../src/extract/calls.js";
import { handlerNames } from "../src/extract/openapi.js";
import { extractRoutes } from "../src/extract/routes.js";
import { routesFromSpring, type Views } from "../src/extract/spring.js";
import { documentUrl } from "../src/arazzo.js";
import { inventory } from "../src/inventory.js";
import { matchCalls } from "../src/match.js";
import type { Call, Surface } from "../src/model.js";
import { scan } from "../src/scan.js";
import { WorktreeSource, type Source } from "../src/source.js";

const memory = (files: Record<string, string>): Source => ({
  ref: "WORKTREE",
  list: () => Object.keys(files),
  read: (p) => files[p],
  asOf: () => "2026-11-01T00:00:00Z",
});
const spec = { component: "server", files: [] };
const routes = (text: string, file = "A.java") => routesFromSpring(file, text, spec).map((s) => `${s.method} ${s.path} ${s.at.line}`);

describe("Spring routes", () => {
  it("joins a class @RequestMapping to each method mapping", () => {
    const text = [
      "@RestController",
      '@RequestMapping("/api")',
      "class ReviewApiController {",
      '  @GetMapping("/reviews") Slice feed() { return null; }',
      '  @PostMapping(value = "/movies/{tmdbId}/reviews", consumes = "application/json")',
      "  ResponseEntity<Review> create(@PathVariable long tmdbId) { return null; }",
      '  @DeleteMapping(path = {"/reviews/{id}", "/reviews/{id}/"}) void delete() {}',
      "  @GetMapping Slice all() { return null; }",
      "}",
    ].join("\n");
    expect(routes(text)).toEqual(["GET /api/reviews 4", "POST /api/movies/{tmdbId}/reviews 5", "DELETE /api/reviews/{id} 7", "GET /api 8"]);
  });

  it("reads @RequestMapping methods, regex variables and unannotated classes", () => {
    const text = [
      "@Controller",
      "class Web {",
      '  @RequestMapping(value = "/items/{id:\\\\d+}", method = {RequestMethod.GET, RequestMethod.HEAD}) String item() { return "items/item"; }',
      '  @RequestMapping("/any") String any() { return "x"; }',
      "}",
    ].join("\n");
    expect(routes(text)).toEqual(["GET /items/{id} 3", "HEAD /items/{id} 3", "* /any 4"]);
  });

  it("registers nothing for a path held in a constant, and ignores mappings in comments", () => {
    const text = ['@RequestMapping(Paths.API)', "class A {", '  @GetMapping("/x") void x() {}', "}", 'class B {', '  // @GetMapping("/old")', '  /* @PostMapping("/older") */', "  @GetMapping(ROUTE) void y() {}", "}"].join("\n");
    expect(routes(text)).toEqual([]);
  });

  it("reads Kotlin annotations", () => {
    const text = ['@RestController', '@RequestMapping("/api/orders")', "class Orders {", '  @GetMapping("/{id}") fun read(@PathVariable id: String) = repo.find(id)', '  @PostMapping(path = ["/", "/new"]) fun create() {}', "}"].join("\n");
    expect(routes(text, "Orders.kt")).toEqual(["GET /api/orders/{id} 4", "POST /api/orders 5", "POST /api/orders/new 5"]);
  });

  it("serves the login and logout Spring Security configures", () => {
    const text = [
      "class SecurityConfig {",
      "  SecurityFilterChain chain(HttpSecurity http) {",
      '    http.formLogin(form -> form.loginPage("/signin").permitAll())',
      '        .logout(logout -> logout.logoutSuccessUrl("/reviews"));',
      "  }",
      "}",
    ].join("\n");
    expect(routes(text)).toEqual(["POST /signin 3", "POST /logout 4"]);
    const config = (chain: string) => routes(`SecurityFilterChain chain(HttpSecurity http) { ${chain} }`);
    expect(config('http.formLogin(f -> f.loginProcessingUrl("/auth").loginPage("/signin")).logout(l -> l.logoutUrl("/bye"));')).toEqual(["POST /auth 1", "POST /bye 1"]);
    expect(config('http.formLogin().loginPage("/signin").and().logout().logoutUrl("/bye");')).toEqual(["POST /signin 1", "POST /bye 1"]);
    expect(config("http.formLogin(withDefaults()).logout(withDefaults());")).toEqual(["POST /login 1", "POST /logout 1"]);
  });

  it("registers nothing for a disabled configurer or a URL held in a constant", () => {
    const config = (chain: string) => routes(`SecurityFilterChain chain(HttpSecurity http) { ${chain} }`);
    expect(config("http.formLogin(AbstractHttpConfigurer::disable).logout(l -> l.disable());")).toEqual([]);
    expect(config("http.formLogin(f -> f.loginProcessingUrl(LOGIN_URL)).logout(l -> l.logoutUrl(Paths.OUT));")).toEqual([]);
    expect(config("http.logout(l -> l.logoutRequestMatcher(matcher));")).toEqual([]);
    expect(routes("class C { void out(HttpServletRequest request) { request.logout(); } }")).toEqual([]);
  });

  it("takes a type's mapping only for the type whose body holds the handler", () => {
    const text = [
      '@RestController @RequestMapping("/api")',
      "class Outer {",
      "  static class Request { String name; }",
      '  @GetMapping("/items") List<Item> items() { return null; }',
      '  @RequestMapping("/nested") static class Inner {',
      '    @GetMapping("/x") String x() { return null; }',
      "  }",
      '  @GetMapping("/after") String after() { return null; }',
      "}",
    ].join("\n");
    expect(routes(text)).toEqual(["GET /api/items 4", "GET /nested/x 6", "GET /api/after 8"]);
  });

  it("unites a type's methods with a handler's, as Spring combines them", () => {
    const text = [
      '@RequestMapping(path = "/api", method = RequestMethod.GET)',
      "class Api {",
      '  @RequestMapping("/items") List<Item> items() { return null; }',
      '  @PostMapping("/items") Item create() { return null; }',
      '  @RequestMapping(path = "/trace", method = RequestMethod.TRACE) void trace() {}',
      '  @RequestMapping(path = "/dyn", method = METHODS) void dyn() {}',
      "}",
    ].join("\n");
    expect(routes(text)).toEqual(["GET /api/items 3", "GET /api/items 4", "POST /api/items 4", "GET /api/trace 5", "TRACE /api/trace 5"]);
  });

  it("keeps commas inside a path literal and catch-all segments", () => {
    const text = ['class A {', '  @GetMapping("/items/{id:[0-9]{1,3}}") void a() {}', '  @GetMapping("/files/{*rest}") void b() {}', '  @GetMapping({"/x", "/y"}) void c() {}', "}"].join("\n");
    expect(routes(text)).toEqual(["GET /items/{id} 2", "GET /files/{*rest} 3", "GET /x 4", "GET /y 4"]);
  });

  it("does not read an annotation written in a string", () => {
    expect(routes('class A { String label = "@GetMapping"; String other = "@RequestMapping(\\"/x\\")"; }')).toEqual([]);
  });

  it("collects the views a handler renders, not its redirects or response bodies", () => {
    const views: Views = new Map();
    const text = [
      "@Controller",
      "class Web {",
      '  @GetMapping("/reviews/{id}") String detail(Model model) {',
      '    if (missing) { return "redirect:/reviews"; }',
      '    String sort = "desc";',
      '    return "reviews/detail";',
      "  }",
      '  @GetMapping("/legacy") ModelAndView legacy() { return new ModelAndView("legacy/page"); }',
      '  @ResponseBody @GetMapping("/ping") String ping() { return "pong"; }',
      "}",
      "@RestController",
      "class Api {",
      '  @GetMapping("/health") String health() { return "health"; }',
      '  @GetMapping("/page") ModelAndView page() { return new ModelAndView("api/page"); }',
      "}",
    ].join("\n");
    routesFromSpring("Web.java", text, spec, views);
    expect([...views].map(([id, v]) => [id, v.names])).toEqual([
      ["server|GET /reviews/{id}", ["reviews/detail"]],
      ["server|GET /legacy", ["legacy/page"]],
      ["server|GET /page", ["api/page"]],
    ]);
  });
});

describe("template calls", () => {
  const call = { from: "web", to: "server", files: [] };
  const calls = (html: string) => callsFromTemplate("t.html", html, call).map((c) => `${c.method} ${c.path} ${c.at.line}`);

  it("reads Thymeleaf links with the method each attribute implies", () => {
    const html = [
      '<html xmlns:th="http://www.thymeleaf.org" xmlns:sec="http://www.thymeleaf.org/extras/spring-security">',
      '<a th:href="@{/movies/{id}(id=${movie.tmdbId})}">movie</a>',
      '<form method="post" th:action="${reviewId == null} ? @{/movies/{id}/reviews(id=${m})} : @{/reviews/{id}/edit(id=${r})}">',
      '<form th:action="@{/reviews/{id}(id=${r})}" th:method="delete"></form>',
      '<form th:action="@{/movies}"><input name="q"></form>',
      '<div th:attr="data-api-url=@{/api/movies/search},data-movie-url=@{/movies/}"></div>',
      '<a href="/plain">plain</a> <a href="https://www.themoviedb.org/settings/api">tmdb</a>',
      '<link th:href="@{/css/app.css}" rel="stylesheet">',
    ].join("\n");
    expect(calls(html)).toEqual([
      "GET /movies/{} 2",
      "POST /movies/{}/reviews 3",
      "POST /reviews/{}/edit 3",
      "* /reviews/{} 4",
      "GET /movies 5",
      "* /api/movies/search 6",
      "* /movies/{} 6",
      "GET /plain 7",
    ]);
  });

  it("reads links whose parameters hold nested expressions", () => {
    expect(calls('<a th:href="@{/items/{id}(id=${item.getOwner().getId()})}">x</a>')).toEqual(["GET /items/{} 1"]);
  });

  it("skips commented-out markup but reads Thymeleaf prototype-only blocks", () => {
    const html = ['<!-- <a th:href="@{/api/retired}">old</a> -->', '<!--/* <a href="/hidden">x</a> */-->', '<!--/*/ <a th:href="@{/shown}">y</a> /*/-->'].join("\n");
    expect(calls(html)).toEqual(["GET /shown 3"]);
  });

  it("does not request a plain attribute Thymeleaf replaces", () => {
    const html = ['<a href="/mock" th:href="@{/real}">x</a>', '<form action="/mock" th:action="@{/save}" method="post"></form>', '<div data-api-url="/mock" th:attr="data-api-url=@{/api/real}"></div>'].join("\n");
    expect(calls(html)).toEqual(["GET /real 1", "POST /save 2", "* /api/real 3"]);
  });

  it("reads attributes in any case and requests in inline scripts", () => {
    const html = ['<A HREF="/orders">o</A>', '<FORM ACTION="/orders" METHOD="POST"></FORM>', "<script>", '  fetch("/api/reviews");', "</script>", '<script src="/js/app.js"></script>'].join("\n");
    expect(calls(html)).toEqual(["GET /orders 1", "POST /orders 2", "GET /api/reviews 4"]);
  });

  it("joins th:attrappend and th:attrprepend to the static value instead of replacing it", () => {
    const html = ['<a href="/base" th:attrappend="href=@{/suffix}">x</a>', '<a href="/tail" th:attrprepend="href=@{/head}">y</a>', '<a th:attrappend="href=@{/alone}">z</a>'].join("\n");
    expect(calls(html)).toEqual(["GET /base/suffix 1", "GET /head/tail 2"]);
  });

  it("reads link expressions only where Thymeleaf evaluates them as URLs", () => {
    const html = [
      "<pre>@{/admin}</pre>",
      '<p th:text="@{/shown-as-text}">t</p>',
      "<p>[[@{/printed}]]</p>",
      '<script th:inline="javascript">const url = [[@{/api/inlined}]];</script>',
    ].join("\n");
    expect(calls(html)).toEqual(["* /api/inlined 4"]);
  });

  it("reads URLs only from attributes of start tags", () => {
    const html = ['<pre>href="/example"</pre>', "<script>const sample = 'href=\"/in-script\"';</script>", '<p>see action="/nowhere"</p>', '<a href="/real">r</a>'].join("\n");
    expect(calls(html)).toEqual(["GET /real 4"]);
  });

  it("takes a submit button's method from formmethod, else its form", () => {
    const html = ['<form method="get">', '  <button formaction="/save">s</button>', '  <button formmethod="post" formaction="/drop">d</button>', "</form>", '<button form="f" formaction="/out">o</button><form id="f" method="post"></form>'].join("\n");
    expect(calls(html)).toEqual(["GET /save 2", "POST /drop 3", "POST /out 5"]);
  });
});

describe("matching", () => {
  it("picks Spring's most specific route for a fully known path, and keeps every route elsewhere", () => {
    const surface = (method: string, path: string): Surface => ({ id: `s|${method} ${path}`, component: "s", method, path, at: { file: "a", line: 1 }, evidence: "text" });
    const call = (method: string, path: string): Call => ({ id: `c|${method} ${path}`, from: "w", to: "s", method, path, at: { file: "b", line: 1 }, evidence: "text", based: false });
    const surfaces = [surface("GET", "/api/movies/search"), surface("GET", "/api/movies/{tmdbId}"), surface("POST", "/api/movies/{tmdbId}")];
    const calls = [call("*", "/api/movies/search"), call("GET", "/api/movies/{}")];
    const ranked = matchCalls({ surfaces, calls }, new Set(["s"])).targetsOf;
    expect(ranked.get(0)!.map((s) => s.id)).toEqual(["s|GET /api/movies/search", "s|POST /api/movies/{tmdbId}"]);
    expect(ranked.get(1)!.map((s) => s.id)).toEqual(["s|GET /api/movies/search", "s|GET /api/movies/{tmdbId}"]);
    // Express and the like follow registration order, which is not read: every route the request fits stays.
    expect(matchCalls({ surfaces, calls }).targetsOf.get(0)!.map((s) => s.id)).toEqual(["s|GET /api/movies/search", "s|GET /api/movies/{tmdbId}", "s|POST /api/movies/{tmdbId}"]);
    // Spring scores a variable 1 and a wildcard 100: /a/{x}/{y} over /a/*/*.
    const scored = [surface("GET", "/a/*/*"), surface("GET", "/a/{x}/{y}")];
    expect(matchCalls({ surfaces: scored, calls: [call("GET", "/a/p/q")] }, new Set(["s"])).targetsOf.get(0)!.map((s) => s.id)).toEqual(["s|GET /a/{x}/{y}"]);
    // Spring prefers fewer variables: /a/{x}/c/d over /a/b/{x}/{y}.
    const spring = [surface("GET", "/a/b/{x}/{y}"), surface("GET", "/a/{x}/c/d")];
    expect(matchCalls({ surfaces: spring, calls: [call("GET", "/a/b/c/d")] }, new Set(["s"])).targetsOf.get(0)!.map((s) => s.id)).toEqual(["s|GET /a/{x}/c/d"]);
  });

  it("matches a catch-all against the rest of the path", () => {
    const surface = (path: string): Surface => ({ id: `s|GET ${path}`, component: "s", method: "GET", path, at: { file: "a", line: 1 }, evidence: "text" });
    const call = (path: string): Call => ({ id: `c|${path}`, from: "w", to: "s", method: "GET", path, at: { file: "b", line: 1 }, evidence: "text", based: false });
    const { targetsOf } = matchCalls({ surfaces: [surface("/files/{*rest}"), surface("/static/**")], calls: [call("/files/a/b"), call("/static"), call("/other/a")] });
    expect([0, 1, 2].map((i) => targetsOf.get(i)?.map((s) => s.id) ?? [])).toEqual([["s|GET /files/{*rest}"], ["s|GET /static/**"], []]);
  });
});

describe("a server-rendered Spring app", () => {
  const files = {
    "src/main/java/app/MovieWebController.java": [
      "@Controller",
      "class MovieWebController {",
      '  @GetMapping("/movies/{tmdbId}") String detail(@PathVariable long tmdbId) { return "movies/detail"; }',
      "}",
    ].join("\n"),
    "src/main/java/app/ReviewApiController.java": [
      "@RestController",
      '@RequestMapping("/api")',
      "class ReviewApiController {",
      '  @GetMapping("/movies/{tmdbId}/reviews") Slice forMovie(@PathVariable long tmdbId) { return null; }',
      '  @GetMapping("/reviews/{id}") Review get(@PathVariable long id) { return null; }',
      "}",
    ].join("\n"),
    "src/main/resources/templates/movies/detail.html": '<div th:attr="data-api-url=@{/api/movies/{id}/reviews(id=${movie.tmdbId})}"></div>',
    "openapi.json": JSON.stringify({
      openapi: "3.1.0",
      paths: { "/api/movies/{tmdbId}/reviews": { get: { operationId: "forMovie" } }, "/api/reviews/{id}": { get: { operationId: "get_1" } } },
    }),
  };
  const config = normalizeConfig({
    components: [
      { name: "server", path: "src/main/java" },
      { name: "web", path: "src/main/resources" },
    ],
    routes: [{ component: "server", files: ["src/main/java/**/*.java"], styles: ["spring"], openapi: "openapi.json" }],
    calls: [{ from: "web", to: "server", files: ["src/main/resources/templates/**/*.html"] }],
  });

  it("keeps code locations, takes springdoc's operationIds, and links a page to the requests of its template", () => {
    const graph = scan(memory(files), config);
    expect(graph.surfaces.map((s) => `${s.id} ${s.at.file.split("/").pop()}:${s.at.line} ${s.operationId ?? "-"}`)).toEqual([
      "server|GET /movies/{tmdbId} MovieWebController.java:3 -",
      "server|GET /api/movies/{tmdbId}/reviews ReviewApiController.java:4 forMovie",
      "server|GET /api/reviews/{id} ReviewApiController.java:5 get_1",
    ]);
    expect(graph.edges.map((e) => `${e.kind} ${e.from.split("@")[0]} -> ${e.to.split("@")[0]} ${e.evidence}${e.via ? ` ${e.via}` : ""}`)).toEqual([
      "match web->server|* /api/movies/{}/reviews -> server|GET /api/movies/{tmdbId}/reviews text",
      "reach server|GET /movies/{tmdbId} -> web->server|* /api/movies/{}/reviews name view movies/detail",
    ]);
  });

  it("does not trace a numbered operationId back to a name, since nothing says springdoc numbered it", () => {
    expect(handlerNames("get_1", "GET", "/api/reviews/{id}")).toEqual(["get_1"]);
    expect(handlerNames("health_2024", "GET", "/health")).toEqual(["health_2024"]);
  });
});

describe("export with a document outside the repository", () => {
  it("reads the document from disk to resolve operations", () => {
    const fixture = fileURLToPath(new URL("../fixtures/shop", import.meta.url));
    const out = mkdtempSync(join(tmpdir(), "atlas-abs-"));
    try {
      const doc = join(out, "orders.json");
      writeFileSync(doc, JSON.stringify({ openapi: "3.1.0", paths: { "/orders/{orderId}": { get: { operationId: "OrdersFromDisk" } } } }));
      writeFileSync(join(out, "atlas.config.yaml"), `${new WorktreeSource(fixture).read("atlas.config.yaml")}\nopenapi:\n  bff: openapi/bff.json\n  orders: ${doc}\n`);
      let text = "";
      const o = vi.spyOn(process.stdout, "write").mockImplementation((c) => ((text += String(c)), true));
      const e = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
      try {
        expect(main(["export", "arazzo", "--root", fixture, "--out", out, "--config", join(out, "atlas.config.yaml"), "--flow", "view-order"])).toBe(0);
      } finally {
        o.mockRestore();
        e.mockRestore();
      }
      expect(text).toContain("operationId: $sourceDescriptions.orders.OrdersFromDisk");
    } finally {
      rmSync(out, { recursive: true, force: true });
    }
  });

  it("takes a chosen path that names a directory as served, not as a file", () => {
    const out = mkdtempSync(join(tmpdir(), "atlas-dir-"));
    try {
      const graph = { apiDescriptions: [], apiDocuments: [] } as unknown as Parameters<typeof documentUrl>[1];
      const config = normalizeConfig({ openapi: { svc: out }, origins: { svc: "https://svc.example" } });
      expect(documentUrl("svc", graph, config)).toEqual({ url: `https://svc.example${out}` });
    } finally {
      rmSync(out, { recursive: true, force: true });
    }
  });
});

describe("templates of several applications", () => {
  it("links a view to its own application's template only", () => {
    const controller = (pkg: string) => `@Controller\nclass Home {\n  @GetMapping("/${pkg}") String home() { return "index"; }\n}`;
    const files = {
      "shop/src/main/java/shop/Home.java": controller("shop"),
      "admin/src/main/java/admin/Home.java": controller("admin"),
      "shop/src/main/resources/templates/index.html": '<a href="/shop/cart">cart</a>',
      "admin/src/main/resources/templates/index.html": '<a href="/admin/users">users</a>',
    };
    const config = normalizeConfig({
      components: [
        { name: "shop", path: "shop" },
        { name: "admin", path: "admin" },
      ],
      routes: [
        { component: "shop", files: ["shop/src/main/java/**/*.java"], styles: ["spring"] },
        { component: "admin", files: ["admin/src/main/java/**/*.java"], styles: ["spring"] },
      ],
      calls: [
        { from: "shop", to: "shop", files: ["shop/src/main/resources/templates/**/*.html"] },
        { from: "admin", to: "admin", files: ["admin/src/main/resources/templates/**/*.html"] },
      ],
    });
    const graph = scan(memory(files), config);
    const reach = graph.edges.filter((e) => e.kind === "reach").map((e) => `${e.from} -> ${graph.calls.find((c) => c.id === e.to)!.path}`);
    expect(reach.sort()).toEqual(["admin|GET /admin -> /admin/users", "shop|GET /shop -> /shop/cart"]);
  });

  it("reports a view outside the standard layout that several templates could be", () => {
    const files = {
      "build.gradle.kts": "",
      "app/Home.java": '@Controller\nclass Home {\n  @GetMapping("/") String home() { return "index"; }\n}',
      "a/templates/index.html": "",
      "b/templates/index.html": "",
    };
    const limits: string[] = [];
    extractRoutes(memory(files), normalizeConfig({ routes: [{ component: "app", files: ["app/*.java"], styles: ["spring"] }] }), undefined, [], limits, new Map());
    expect(limits).toEqual(["routes app|GET /: view index names 2 templates (a/templates/index.html, b/templates/index.html); none is linked"]);
  });
});

describe("templates outside the standard layout", () => {
  const controller = '@Controller\nclass Home {\n  @GetMapping("/") String home() { return "home"; }\n}';
  const run = (files: Record<string, string>) => {
    const limits: string[] = [];
    const executed = new Map<string, Set<string>>();
    extractRoutes(memory(files), normalizeConfig({ routes: [{ component: "a", files: ["a/code/*.java"], styles: ["spring"] }] }), undefined, [], limits, executed);
    return { links: [...(executed.get("a|GET /") ?? [])], limits };
  };

  it("links only a template inside the handler's application, found by its build file", () => {
    expect(run({ "a/pom.xml": "", "a/code/Home.java": controller, "a/web/templates/home.html": "", "b/pom.xml": "", "b/web/templates/home.html": "" }).links).toEqual(["a/web/templates/home.html:*home"]);
    expect(run({ "a/pom.xml": "", "a/code/Home.java": controller, "b/pom.xml": "", "b/web/templates/home.html": "" }).links).toEqual([]);
  });

  it("links nothing and says so when no build file tells the application", () => {
    expect(run({ "a/code/Home.java": controller, "b/web/templates/home.html": "" })).toEqual({
      links: [],
      limits: ["routes a|GET /: no build file above a/code/Home.java tells which application view home belongs to; none is linked"],
    });
  });
});

describe("Spring handlers, continued", () => {
  it("reads a multi-line Kotlin expression body", () => {
    const views: Views = new Map();
    routesFromSpring("Web.kt", '@Controller\nclass Web {\n  @GetMapping("/") fun page(): String =\n    "home"\n  @GetMapping("/b") fun b() = if (x)\n    "left"\n  else "right"\n}', spec, views);
    expect([...views].map(([id, v]) => [id, v.names])).toEqual([
      ["server|GET /", ["home"]],
      ["server|GET /b", ["left", "right"]],
    ]);
  });

  it("sees @ResponseBody after the mapping, and reads the body past other annotations", () => {
    const views: Views = new Map();
    const text = [
      "@Controller",
      "class Web {",
      '  @GetMapping("/x")',
      "  @ResponseBody",
      '  fun x() = "payload"',
      '  @GetMapping("/y")',
      "  @ResponseStatus(HttpStatus.OK)",
      '  String y() { return "pages/y"; }',
      "}",
    ].join("\n");
    routesFromSpring("Web.java", text, spec, views);
    expect([...views].map(([id, v]) => [id, v.names])).toEqual([["server|GET /y", ["pages/y"]]]);
  });

  it("takes the last value a security setter is given", () => {
    const text = 'SecurityFilterChain chain(HttpSecurity http) { http.formLogin(f -> { f.loginPage("/old"); f.loginPage("/new"); }).logout(l -> { l.logoutUrl("/a"); l.logoutUrl("/b"); }); }';
    expect(routes(text)).toEqual(["POST /new 1", "POST /b 1"]);
  });
});

describe("inventory", () => {
  it("proposes template files whose form targets are written in any case or unquoted", () => {
    const files = { "web/a.html": '<FORM ACTION="/submit"></FORM>', "web/b.html": "<form action=/submit></form>" };
    expect(inventory(memory(files), []).calls.map((c) => `${c.file} ${c.count}`)).toEqual(["web/a.html 1", "web/b.html 1"]);
  });

  it("proposes controllers that write the annotations' full names", () => {
    const files = { "Api.java": "@org.springframework.web.bind.annotation.RestController\nclass Api {\n  @org.springframework.web.bind.annotation.GetMapping(\"/x\") void x() {}\n}" };
    expect(inventory(memory(files), []).routes.map((r) => `${r.style} ${r.count}`)).toEqual(["spring 1"]);
  });
});

describe("extractRoutes with the spring style", () => {
  it("reads only the styles a route source names", () => {
    const source = memory({ "A.java": '@RestController class A { @GetMapping("/x") void x() {} }' });
    expect(extractRoutes(source, normalizeConfig({ routes: [{ component: "s", files: ["*.java"] }] }))).toEqual([]);
    expect(extractRoutes(source, normalizeConfig({ routes: [{ component: "s", files: ["*.java"], styles: ["spring"] }] })).map((s) => s.id)).toEqual(["s|GET /x"]);
  });
});

describe("review fixes: templates", () => {
  const call = { from: "web", to: "server", files: [] };
  const calls = (html: string) => callsFromTemplate("t.html", html, call).map((c) => `${c.method} ${c.path} ${c.at.line}`);

  it("still blanks comments inside a prototype-only block", () => {
    const html = ['<!--/*/', '<!-- <a href="/retired">x</a> -->', '<a href="/shown">y</a>', "/*/-->"].join("\n");
    expect(calls(html)).toEqual(["GET /shown 3"]);
  });

  it("does not open a comment inside a script body", () => {
    const html = ["<script>", 'const marker = "<!--";', 'fetch("/api/one");', "</script>", '<a href="/after">a</a>', "<!-- -->"].join("\n");
    expect(calls(html)).toEqual(["GET /api/one 3", "GET /after 5"]);
  });

  it("reads a script's attributes by exact name and past quoted '>'", () => {
    const html = ['<script data-src="/x.js">fetch("/api/body");</script>', '<script data-note="a > b">fetch("/api/quoted");</script>', '<script data-type="text/plain">fetch("/api/typed");</script>'].join("\n");
    expect(calls(html)).toEqual(["GET /api/body 1", "GET /api/quoted 2", "GET /api/typed 3"]);
  });

  it("finds a button's form by its exact id", () => {
    const html = ['<button form="f" formaction="/out">o</button>', '<form data-id="f" method="get"></form>', '<form id="f" method="post"></form>'].join("\n");
    expect(calls(html)).toEqual(["POST /out 1"]);
  });
});

describe("review fixes: Spring", () => {
  it("splits a class-like operationId as Nest does, without guessing a numbering", () => {
    expect(handlerNames("Get_list_1", "GET", "/x")).toEqual(["Get_list_1", "list_1"]);
  });

  it("links no template that belongs to a nested build module", () => {
    const limits: string[] = [];
    const executed = new Map<string, Set<string>>();
    const files = { "a/pom.xml": "", "a/code/Home.java": '@Controller\nclass Home {\n  @GetMapping("/") String home() { return "home"; }\n}', "a/lib/pom.xml": "", "a/lib/templates/home.html": "" };
    extractRoutes(memory(files), normalizeConfig({ routes: [{ component: "a", files: ["a/code/*.java"], styles: ["spring"] }] }), undefined, [], limits, executed);
    expect([...(executed.get("a|GET /") ?? [])]).toEqual([]);
  });

  it("combines a Kotlin backtick-named class's mapping with its methods", () => {
    expect(routes('@RestController\n@RequestMapping("/api")\nclass `Review Api` {\n  @GetMapping("/reviews") fun list() = 1\n}', "A.kt")).toEqual(["GET /api/reviews 4"]);
  });

  it("reads a Kotlin raw string's backslash as a character, and a Java text block's as an escape", () => {
    const kotlin = '@RestController\nclass A {\n  val p = """C:\\"""\n  @GetMapping("/k") fun k() = 1\n}';
    expect(routes(kotlin, "A.kt")).toEqual(["GET /k 4"]);
    const java = '@RestController\nclass A {\n  String p = """\n  a\\"""\n  """;\n  @GetMapping("/j") String j() { return ""; }\n}';
    expect(routes(java, "A.java")).toEqual(["GET /j 6"]);
  });
});

describe("review fixes, continued", () => {
  const call = { from: "web", to: "server", files: [] };
  const calls = (html: string) => callsFromTemplate("t.html", html, call).map((c) => `${c.method} ${c.path} ${c.at.line}`);

  it("reads the method of Thymeleaf's HTML-friendly data-th- attributes", () => {
    const html = ['<form data-th-method="post" data-th-action="@{/save}"></form>', '<form method="post"><button data-th-formmethod="delete" formaction="/drop">d</button></form>'].join("\n");
    expect(calls(html)).toEqual(["POST /save 1", "* /drop 2"]);
  });

  it("does not take a form written in a script body as a control's form", () => {
    const html = ['<form method="post">', "<script>const t = '<form method=\"get\">';</script>", '<button formaction="/save">s</button>', "</form>"].join("\n");
    expect(calls(html)).toEqual(["POST /save 3"]);
  });

  it("reads an inline script whose type has parameters", () => {
    expect(calls('<script type="text/javascript; charset=utf-8">fetch("/api/one");</script>')).toEqual(["GET /api/one 1"]);
  });

  it("reads a Kotlin raw string as one path", () => {
    expect(routes('@RestController\nclass A {\n  @GetMapping("""/users""") fun users() = 1\n}', "A.kt")).toEqual(["GET /users 3"]);
  });

  it("collects no view from a call written in a string", () => {
    const views: Views = new Map();
    routesFromSpring("Web.kt", '@Controller\nclass Web {\n  @GetMapping("/") fun page(): String {\n    val sample = """ModelAndView("admin")"""\n    return "home"\n  }\n}', spec, views);
    expect([...views].map(([id, v]) => [id, v.names])).toEqual([["server|GET /", ["home"]]]);
  });

  it("registers nothing for a Security customizer defined elsewhere", () => {
    const config = (chain: string) => routes(`SecurityFilterChain chain(HttpSecurity http) { ${chain} }`);
    expect(config("http.formLogin(loginCustomizer).logout(logoutCustomizer);")).toEqual([]);
    expect(config("http.formLogin(f -> configure(f)).logout(this::logout);")).toEqual([]);
    expect(config("http.formLogin(Customizer.withDefaults()).logout((LogoutConfigurer<HttpSecurity> l) -> l.permitAll());")).toEqual(["POST /login 1", "POST /logout 1"]);
  });

  it("prefers the longer of two catch-all routes before their scores, as Spring does", () => {
    const surface = (path: string): Surface => ({ id: `s|GET ${path}`, component: "s", method: "GET", path, at: { file: "a", line: 1 }, evidence: "text" });
    const request: Call = { id: "c", from: "w", to: "s", method: "GET", path: "/bar/foo/z", at: { file: "b", line: 1 }, evidence: "text", based: false };
    const { targetsOf } = matchCalls({ surfaces: [surface("/bar/{*rest}"), surface("/{x}/foo/{*rest}")], calls: [request] }, new Set(["s"]));
    expect(targetsOf.get(0)!.map((s) => s.id)).toEqual(["s|GET /{x}/foo/{*rest}"]);
  });
});

describe("scope: what a template states for certain", () => {
  const call = { from: "web", to: "server", files: [] };
  const calls = (html: string) => callsFromTemplate("t.html", html, call).map((c) => `${c.method} ${c.path} ${c.at.line}`);

  it("reads plain form methods as a browser does: GET or POST, GET for any other value, nothing for dialog", () => {
    const html = [
      '<form method="put" action="/items"></form>',
      '<form method="POST" action="/save"></form>',
      '<form method="dialog" action="/close"></form>',
      '<form method="post"><button formmethod="delete" formaction="/drop">d</button><button formmethod="dialog" formaction="/x">x</button></form>',
    ].join("\n");
    expect(calls(html)).toEqual(["GET /items 1", "POST /save 2", "GET /drop 4"]);
  });

  it("leaves a Thymeleaf method other than GET or POST unknown, since Spring Boot does not apply the hidden field by default", () => {
    const html = ['<form th:action="@{/a}" th:method="post"></form>', '<form th:action="@{/b}" th:method="put"></form>', '<form th:action="@{/c}" th:method="${m}"></form>'].join("\n");
    expect(calls(html)).toEqual(["POST /a 1", "* /b 2", "* /c 3"]);
  });

  it("treats only the exact script and style elements as raw text", () => {
    const html = ['<script-widget><a href="/inside">i</a></script-widget>', '<script>const s = "</script-widget>"; fetch("/api/one");</script>', '<a href="/after">a</a>'].join("\n");
    expect(calls(html)).toEqual(["GET /inside 1", "GET /api/one 2", "GET /after 3"]);
  });
});

describe("scope: concatenated URLs", () => {
  const ts = (text: string) => callsFromTypeScript("a.ts", text, { from: "web", to: "server", files: [] }).map((c) => `${c.method} ${c.path} ${c.based}`);

  it("reads a concatenation as one URL with a hole for each part it cannot know, not as separate requests", () => {
    expect(ts('fetch(BASE + "/reviews");')).toEqual(["GET /reviews true"]);
    expect(ts('fetch("/api/movies/" + id + "/reviews", { method: "POST" });')).toEqual(["POST /api/movies/{}/reviews false"]);
    expect(ts('const label = "Total: " + count;')).toEqual([]);
  });
});

describe("scope: Spring reads only what the code spells out", () => {
  it("registers nothing for a Kotlin string template, whose value is computed", () => {
    expect(routes('@RestController\nclass A {\n  @GetMapping("$BASE/users") fun users() = 1\n  @GetMapping("${Paths.X}") fun x() = 1\n  @GetMapping("/plain") fun p() = 1\n}', "A.kt")).toEqual(["GET /plain 5"]);
    expect(routes('@RestController\nclass A {\n  @GetMapping("/cost$") String c() { return ""; }\n}', "A.java")).toEqual(["GET /cost$ 3"]);
  });

  it("reads a Security setter only on the configurer, not on another object a customizer calls", () => {
    const config = (chain: string) => routes(`SecurityFilterChain chain(HttpSecurity http) { ${chain} }`);
    expect(config('http.formLogin(f -> helper.loginPage("/admin"));')).toEqual(["POST /login 1"]);
    expect(config('http.formLogin(f -> f.permitAll().loginPage("/signin"));')).toEqual(["POST /signin 1"]);
    expect(config('http.formLogin().successHandler(h -> helper.loginPage("/x")).loginPage("/signin").and();')).toEqual(["POST /signin 1"]);
  });

  it("scores a wildcard inside a segment as Spring does", () => {
    const surface = (path: string): Surface => ({ id: `s|GET ${path}`, component: "s", method: "GET", path, at: { file: "a", line: 1 }, evidence: "text" });
    const request: Call = { id: "c", from: "w", to: "s", method: "GET", path: "/files/a.txt", at: { file: "b", line: 1 }, evidence: "text", based: false };
    const { targetsOf } = matchCalls({ surfaces: [surface("/files/*.txt"), surface("/files/{name}")], calls: [request] }, new Set(["s"]));
    expect(targetsOf.get(0)!.map((s) => s.id)).toEqual(["s|GET /files/{name}"]);
  });
});
