import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it, vi } from "vitest";
import { main } from "../src/commands.js";
import { normalizeConfig } from "../src/config.js";
import { callsFromTemplate } from "../src/extract/calls.js";
import { handlerNames } from "../src/extract/openapi.js";
import { extractRoutes } from "../src/extract/routes.js";
import { routesFromSpring } from "../src/extract/spring.js";
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
    expect(routes(text)).toEqual(["GET /api/reviews 4", "POST /api/movies/{tmdbId}/reviews 5", "DELETE /api/reviews/{id} 7", "DELETE /api/reviews/{id} 7", "GET /api 8"]);
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
    expect(routes('http.formLogin(f -> f.loginProcessingUrl("/auth").loginPage("/signin")).logout(l -> l.logoutUrl("/bye"));')).toEqual(["POST /auth 1", "POST /bye 1"]);
  });

  it("collects the views a handler renders, not its redirects", () => {
    const views = new Map<string, string[]>();
    const text = [
      "@Controller",
      "class Web {",
      '  @GetMapping("/reviews/{id}") String detail(Model model) {',
      '    if (missing) { return "redirect:/reviews"; }',
      '    String sort = "desc";',
      '    return "reviews/detail";',
      "  }",
      '  @GetMapping("/legacy") ModelAndView legacy() { return new ModelAndView("legacy/page"); }',
      "}",
    ].join("\n");
    routesFromSpring("Web.java", text, spec, views);
    expect([...views]).toEqual([
      ["server|GET /reviews/{id}", ["reviews/detail"]],
      ["server|GET /legacy", ["legacy/page"]],
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
      "DELETE /reviews/{} 4",
      "GET /movies 5",
      "* /api/movies/search 6",
      "* /movies/{} 6",
      "GET /plain 7",
    ]);
  });
});

describe("matching", () => {
  it("prefers a fixed segment over a parameter, per method", () => {
    const surface = (method: string, path: string): Surface => ({ id: `s|${method} ${path}`, component: "s", method, path, at: { file: "a", line: 1 }, evidence: "text" });
    const call = (method: string, path: string): Call => ({ id: `c|${method} ${path}`, from: "w", to: "s", method, path, at: { file: "b", line: 1 }, evidence: "text", based: false });
    const surfaces = [surface("GET", "/api/movies/search"), surface("GET", "/api/movies/{tmdbId}"), surface("POST", "/api/movies/{tmdbId}")];
    const calls = [call("*", "/api/movies/search"), call("GET", "/api/movies/{}")];
    const { targetsOf } = matchCalls({ surfaces, calls });
    expect(targetsOf.get(0)!.map((s) => s.id)).toEqual(["s|GET /api/movies/search", "s|POST /api/movies/{tmdbId}"]);
    expect(targetsOf.get(1)!.map((s) => s.id)).toEqual(["s|GET /api/movies/search", "s|GET /api/movies/{tmdbId}"]);
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

  it("guesses a handler from springdoc's numbered operationIds", () => {
    expect(handlerNames("get_1", "GET", "/api/reviews/{id}")).toEqual(["get_1", "get"]);
    expect(handlerNames("create_12", "POST", "/x")).toContain("create");
  });
});

describe("export with a document outside the repository", () => {
  it("reads the document from disk to resolve operations", () => {
    const fixture = fileURLToPath(new URL("../fixtures/shop", import.meta.url));
    const out = mkdtempSync(join(tmpdir(), "atlas-abs-"));
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
  });
});

describe("extractRoutes with the spring style", () => {
  it("reads only the styles a route source names", () => {
    const source = memory({ "A.java": '@RestController class A { @GetMapping("/x") void x() {} }' });
    expect(extractRoutes(source, normalizeConfig({ routes: [{ component: "s", files: ["*.java"] }] }))).toEqual([]);
    expect(extractRoutes(source, normalizeConfig({ routes: [{ component: "s", files: ["*.java"], styles: ["spring"] }] })).map((s) => s.id)).toEqual(["s|GET /x"]);
  });
});
