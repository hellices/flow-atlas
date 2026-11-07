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
import { fileConstants, routesFromSpring, type Views } from "../src/extract/spring.js";
import { documentUrl } from "../src/arazzo.js";
import { inventory } from "../src/inventory.js";
import { matchCalls } from "../src/match.js";
import type { Call, Place, Surface } from "../src/model.js";
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

  it("reads Kotlin's escaped dollar, a nested type's own mapping, and only HttpSecurity's logout", () => {
    expect(routes('@RestController\nclass P {\n  @GetMapping("/price/\\$fixed") fun p() = 1\n}', "P.kt")).toEqual(["GET /price/$fixed 3"]);
    const nested = ["@RestController", "class Outer {", '  @RequestMapping("/old") fun old() = "old"', "  @RestController", "  class Inner {", '    @GetMapping("/new") fun n() = "n"', "  }", "}"].join("\n");
    expect(routes(nested, "Outer.kt")).toEqual(["* /old 3", "GET /new 6"]);
    const servlet = 'SecurityFilterChain chain(HttpSecurity http) { http.logout(l -> l.disable()); }\nvoid out(HttpServletRequest request) { request.logout(); }';
    expect(routes(servlet)).toEqual([]);
    // One name, two methods: the servlet request's logout is not the configurer's.
    const shadowed = 'SecurityFilterChain chain(HttpSecurity http) { http.formLogin(withDefaults()); }\nvoid out(HttpServletRequest http) { http.logout(); }';
    expect(routes(shadowed)).toEqual(["POST /login 1"]);
    // A type written with its package.
    expect(routes("SecurityFilterChain chain(org.springframework.security.config.annotation.web.builders.HttpSecurity http) {\n  http.formLogin(withDefaults());\n}")).toEqual(["POST /login 2"]);
    expect(routes("fun chain(http: org.springframework.security.config.annotation.web.builders.HttpSecurity) {\n  http.formLogin(withDefaults())\n}", "Q.kt")).toEqual(["POST /login 2"]);
    // A local that holds the HttpSecurity configures it too.
    expect(routes("SecurityFilterChain chain(HttpSecurity http) {\n  HttpSecurity security = http;\n  security.formLogin(withDefaults());\n}")).toEqual(["POST /login 3"]);
    // A field is seen throughout its type, before its declaration too.
    expect(routes("class C {\n  void configure() { http.formLogin(withDefaults()); }\n  private HttpSecurity http;\n}")).toEqual(["POST /login 2"]);
    // A function without a body takes nothing of the next one's.
    expect(routes("interface Config {\n  fun configure(http: HttpSecurity)\n  fun other(http: HttpServletRequest) { http.logout() }\n}", "I.kt")).toEqual([]);
    // A nested function's own `http` hides the outer HttpSecurity.
    const inner = ["fun config(http: HttpSecurity) {", "  http.formLogin(withDefaults())", "  fun handle(http: HttpServletRequest) { http.logout() }", "}"].join("\n");
    expect(routes(inner, "N.kt")).toEqual(["POST /login 2"]);
    const kotlin = ["fun chain(http: HttpSecurity): SecurityFilterChain =", "  http.formLogin(withDefaults())", "    .build()", "fun out(http: HttpServletRequest) = http.logout()"].join("\n");
    expect(routes(kotlin, "S.kt")).toEqual(["POST /login 2"]);
  });

  it("registers nothing for a disabled configurer or a URL held in a constant", () => {
    const config = (chain: string) => routes(`SecurityFilterChain chain(HttpSecurity http) { ${chain} }`);
    expect(config("http.formLogin(AbstractHttpConfigurer::disable).logout(l -> l.disable());")).toEqual([]);
    expect(config("http.formLogin(f -> f.loginProcessingUrl(LOGIN_URL)).logout(l -> l.logoutUrl(Paths.OUT));")).toEqual([]);
    expect(config("http.logout(l -> l.logoutRequestMatcher(matcher));")).toEqual([]);
    expect(routes("class C { void out(HttpServletRequest request) { request.logout(); } }")).toEqual([]);
  });

  it("evaluates each constant once, however often other constants repeat it", () => {
    // Without keeping values, C12 alone would evaluate C0 4096 times and the chain 8190 declarations.
    const chain = Array.from({ length: 12 }, (_, i) => `  static final String C${i + 1} = C${i} + C${i};`);
    const text = ["@RestController", "class A {", '  static final String C0 = "";', ...chain, '  @GetMapping(C12 + "/x") void a() {}', "}"].join("\n");
    const evaluated: number[] = [];
    const constant = fileConstants("S.java", text, (at) => evaluated.push(at));
    expect(constant('C12 + "/x"', text.indexOf("@GetMapping"))).toBe("/x");
    expect(evaluated).toHaveLength(13);
    expect(new Set(evaluated).size).toBe(13);
    expect(routesFromSpring("S.java", text, spec).map((r) => `${r.method} ${r.path}`)).toEqual(["GET /x"]);
  });

  it("reads a path from a string constant the file declares, and says when it cannot", () => {
    const read = (text: string, file = "S.java") => {
      const limits: string[] = [];
      const routes = routesFromSpring(file, text, spec, undefined, undefined, limits).map((r) => `${r.method} ${r.path} ${r.at.line}`);
      return { routes, limits: limits.map((l) => l.replace(/^routes server: /, "")) };
    };
    // The shape of a real controller: its paths are constants, one built from the other, declared together.
    const java = [
      "@RestController",
      "class SubscriptionController {",
      '  static final String PATH = "/v1/internal/subscription", BULK = PATH + "s";',
      "  @GetMapping(PATH) Sub find() { return null; }",
      "  @PostMapping(SubscriptionController.BULK) void replace() {}",
      '  @DeleteMapping({PATH, "/v1/legacy"}) void remove() {}',
      "  @PutMapping(Paths.ELSEWHERE) void elsewhere() {}",
      "}",
    ].join("\n");
    expect(read(java)).toEqual({
      routes: ["GET /v1/internal/subscription 4", "POST /v1/internal/subscriptions 5", "DELETE /v1/internal/subscription 6", "DELETE /v1/legacy 6"],
      limits: ["S.java:7 maps a path the file does not spell out (Paths.ELSEWHERE); its routes are not read"],
    });
    const rows: Array<[string, string, { routes: string[]; limits: string[] }]> = [
      // `Paths.P` means the imported Paths, or a type in scope; never one nested in another type.
      [
        "S.java",
        'import external.Paths;\nclass Holder { static class Paths { static final String P = "/wrong"; } }\n@RestController class A {\n  @GetMapping(Paths.P) void a() {}\n}',
        { routes: [], limits: ["S.java:4 maps a path the file does not spell out (Paths.P); its routes are not read"] },
      ],
      [
        "S.java",
        'class Holder { static class Paths { static final String P = "/wrong"; } }\n@RestController class A {\n  @GetMapping(Paths.P) void a() {}\n}',
        { routes: [], limits: ["S.java:3 maps a path the file does not spell out (Paths.P); its routes are not read"] },
      ],
      [
        "S.java",
        '@RestController class A {\n  static class Paths { static final String P = "/right"; }\n  @GetMapping(Paths.P) void a() {}\n}',
        { routes: ["GET /right 3"], limits: [] },
      ],
      // Imported by name, or possibly inherited: another type's constant of that name is not the one meant.
      [
        "S.java",
        'import static remote.Paths.REMOTE;\n@RestController class A {\n  @GetMapping(REMOTE) void a() {}\n}\nclass Other { static final String REMOTE = "/wrong"; }',
        { routes: [], limits: ["S.java:3 maps a path the file does not spell out (REMOTE); its routes are not read"] },
      ],
      [
        "S.java",
        '@RestController class B extends Base {\n  @GetMapping(PATH) void b() {}\n}\nclass Other { static final String PATH = "/wrong"; }',
        { routes: [], limits: ["S.java:2 maps a path the file does not spell out (PATH); its routes are not read"] },
      ],
      // A type mapping not read is named once, where it is written.
      [
        "S.java",
        '@RestController\n@RequestMapping(Paths.BASE)\nclass C {\n  @GetMapping("/x") void x() {}\n  @GetMapping("/y") void y() {}\n}',
        { routes: [], limits: ["S.java:2 maps a path the file does not spell out (Paths.BASE); its routes are not read"] },
      ],
      // Both levels unread: each is named where it is written.
      [
        "S.java",
        "@RestController\n@RequestMapping(Paths.BASE)\nclass D {\n  @GetMapping(Paths.ONE) void one() {}\n}",
        {
          routes: [],
          limits: [
            "S.java:2 maps a path the file does not spell out (Paths.BASE); its routes are not read",
            "S.java:4 maps a path the file does not spell out (Paths.ONE); its routes are not read",
          ],
        },
      ],
      // Kotlin: a const ending in `;`, a companion's constants, and a class annotation that names its type.
      [
        "K.kt",
        ["@RestController", "@RequestMapping(K.BASE)", "class K {", "  @GetMapping(arrayOf(ONE)) fun one() = 1", "  companion object {", '    const val BASE = "/k";', '    const val ONE = "/one"', "  }", "}"].join("\n"),
        { routes: ["GET /k/one 4"], limits: [] },
      ],
    ];
    for (const [file, text, expected] of rows) expect(read(text, file), text).toEqual(expected);
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
    // Any modifier the languages allow before a type keeps the mapping on it.
    expect(routes('@RestController @RequestMapping("/api") actual open class C {\n  @GetMapping("/x") fun x() = 1\n}', "C.kt")).toEqual(["GET /api/x 2"]);
    expect(routes('@RestController @RequestMapping("/api") public non-sealed class C extends B {\n  @GetMapping("/x") String x() { return null; }\n}')).toEqual(["GET /api/x 2"]);
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

  it("follows a view name held in a constant or returned by a private method, and reads where a reply redirects", () => {
    const views: Views = new Map();
    const limits: string[] = [];
    const text = [
      "@Controller",
      '@RequestMapping("/teams/{teamId}")',
      "class Members {",
      '  private static final String FORM = "members/form";',
      '  @GetMapping("/members/new") String create() { return FORM; }',
      '  @PostMapping("/members/new") String save(Member m) {',
      "    if (invalid) { return FORM; }",
      '    return "redirect:/teams/{teamId}";',
      "  }",
      '  @GetMapping("/members") String list(Model model) { return page(model); }',
      '  @PostMapping("/members/{id}") String update(Member m) { return "redirect:/teams/" + m.getTeamId() + "/members?sort=name"; }',
      '  @PostMapping("/members/{id}/move") String move() { return "redirect:edit"; }',
      '  @GetMapping("/elsewhere") String away() { return "redirect:https://example.com/x"; }',
      '  @GetMapping("/back") String back(String target) { return "redirect:" + target; }',
      '  @GetMapping("/either") String either(boolean a) { return choose(a); }',
      '  private String page(Model model) { return "members/list"; }',
      '  private String choose(int a) { return "members/a"; }',
      '  private String choose(boolean a) { return "members/b"; }',
      "}",
    ].join("\n");
    routesFromSpring("Members.java", text, spec, views, undefined, limits);
    expect([...views].map(([id, v]) => [id, v.names, v.redirects.map((r) => `${r.path} ${r.line}`)])).toEqual([
      ["server|GET /teams/{teamId}/members/new", ["members/form"], []],
      ["server|POST /teams/{teamId}/members/new", ["members/form"], ["/teams/{} 8"]],
      ["server|GET /teams/{teamId}/members", ["members/list"], []],
      ["server|POST /teams/{teamId}/members/{id}", [], ["/teams/{}/members 11"]],
      ["server|POST /teams/{teamId}/members/{id}/move", [], ["/teams/{}/members/{}/edit 12"]],
    ]);
    expect(limits).toEqual(["routes server: Members.java:14 redirects to a URL the file does not spell out (\"redirect:\" + target); the request it leads to is not read"]);
  });

  it("reads each whole result of a Kotlin expression body, branch by branch", () => {
    const views: Views = new Map();
    const limits: string[] = [];
    const text = [
      "@Controller",
      "class Teams {",
      "  companion object {",
      '    const val FORM = "teams/form"',
      "  }",
      '  @GetMapping("/teams/new") fun create() = FORM',
      '  @PostMapping("/teams/new") fun save(t: Team) = if (bad) FORM else "redirect:/teams/" + t.id',
      '  @PostMapping("/teams/{id}") fun update(t: Team) = when {',
      "    bad -> FORM",
      '    else -> "redirect:/teams/" +',
      '      t.id + "/members"',
      "  }",
      '  @GetMapping("/teams") fun list() = page()',
      '  @GetMapping("/back") fun back(target: String) = "redirect:" + target',
      '  @GetMapping("/one") fun one(id: Long) = "redirect:/teams/$id"',
      '  private fun page() = "teams/list"',
      "}",
    ].join("\n");
    routesFromSpring("Teams.kt", text, spec, views, undefined, limits);
    expect([...views].map(([id, v]) => [id, v.names, v.redirects.map((r) => `${r.path} ${r.line}`)])).toEqual([
      ["server|GET /teams/new", ["teams/form"], []],
      ["server|POST /teams/new", ["teams/form"], ["/teams/{} 7"]],
      ["server|POST /teams/{id}", ["teams/form"], ["/teams/{}/members 10"]],
      ["server|GET /teams", ["teams/list"], []],
      ["server|GET /one", [], ["/teams/{} 15"]],
    ]);
    expect(limits).toEqual(["routes server: Teams.kt:14 redirects to a URL the file does not spell out (\"redirect:\" + target); the request it leads to is not read"]);
  });
});

describe("template calls", () => {
  const call = { from: "web", to: "server", files: [], dataUrls: ["data-api-url", "data-movie-url"] };
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

  it("reads a quoted or appended URL base, preprocessed values and literal substitutions, and names links it cannot read", () => {
    const html = [
      `<a th:href="@{'/teams?page=1'}">1</a>`,
      `<a th:href="@{'/teams?page=' + \${i}}">i</a>`,
      `<a th:href="@{'/teams/' + \${t.id} + '/members'(sort='name')}">m</a>`,
      `<a th:href="@{/teams/__\${t.id}__}">t</a>`,
      `<a th:href="@{|/teams/\${t.id}/board|}">b</a>`,
      `<a th:href="@{\${url}}">u</a>`,
      `<a th:href="@{__\${link}__}">l</a>`,
      `<a th:href="@{(\${admin} ? '/admin' : '/home')}">c</a>`,
      `<a th:href="@{|\${base}/x|}">s</a>`,
      `<a th:href="@{https://example.com/x}">x</a> <p th:text="@{\${shown}}">p</p>`,
    ].join("\n");
    const unread: Place[] = [];
    expect(callsFromTemplate("t.html", html, call, { unread }).map((c) => `${c.method} ${c.path} ${c.at.line}`)).toEqual([
      "GET /teams 1",
      "GET /teams 2",
      "GET /teams/{}/members 3",
      "GET /teams/{} 4",
      "GET /teams/{}/board 5",
    ]);
    expect(unread.map((p) => p.line)).toEqual([6, 7, 8, 9]);
  });

  it("reads a path with a file extension only where a route of the target serves it", () => {
    const html = [`<a th:href="@{'/board.html?page=__\${i}__'}">b</a>`, '<link th:href="@{/css/site.css}" rel="stylesheet">', '<a href="/board.html">b</a>'].join("\n");
    expect(callsFromTemplate("t.html", html, call, { served: (p) => p === "/board.html" }).map((c) => `${c.method} ${c.path} ${c.at.line}`)).toEqual(["GET /board.html 1", "GET /board.html 3"]);
    expect(calls(html)).toEqual([]);
  });

  it("resolves page-relative links and forms with no action against each page that renders the template", () => {
    const html = [
      `<a th:href="@{__\${team.id}__/edit}">e</a> <a th:href="@{members/new}">n</a> <a th:href="@{#top}">top</a>`,
      `<form th:object="\${team}" method="post">`,
      "</form>",
      '<form action="" method="get"></form>',
      '<form method="dialog"></form>',
      '<form th:action="@{/teams}"></form>',
    ].join("\n");
    const read = (pages?: Map<string, string[]>, unpaged: Place[] = []) =>
      callsFromTemplate("t.html", html, call, { pages, unpaged }).map((c) => `${c.method} ${c.path} ${c.at.line}${c.page ? ` on ${c.page}` : ""}`);
    expect(read(new Map([["t.html", ["/teams/new", "/teams/{teamId}/edit"]]]))).toEqual([
      "GET /teams/{}/edit 1 on /teams/new",
      "GET /teams/{}/{}/edit 1 on /teams/{teamId}/edit",
      "GET /teams/members/new 1 on /teams/new",
      "GET /teams/{}/members/new 1 on /teams/{teamId}/edit",
      "POST /teams/new 2 on /teams/new",
      "POST /teams/{}/edit 2 on /teams/{teamId}/edit",
      "GET /teams/new 4 on /teams/new",
      "GET /teams/{}/edit 4 on /teams/{teamId}/edit",
      "GET /teams 6",
    ]);
    const unpaged: Place[] = [];
    expect(read(undefined, unpaged)).toEqual(["GET /teams 6"]);
    expect(unpaged.map((p) => p.line)).toEqual([1, 1, 2, 4]);
  });
});

describe("matching", () => {
  it("picks Spring's most specific route for a fully known path, and keeps every route elsewhere", () => {
    const surface = (method: string, path: string): Surface => ({ id: `s|${method} ${path}`, component: "s", method, path, at: { file: "a", line: 1 }, evidence: "text" });
    const call = (method: string, path: string): Call => ({ id: `c|${method} ${path}`, from: "w", to: "s", method, path, at: { file: "b", line: 1 }, evidence: "text", based: false });
    const surfaces = [surface("GET", "/api/movies/search"), surface("GET", "/api/movies/{tmdbId}"), surface("POST", "/api/movies/{tmdbId}")];
    const calls = [call("GET", "/api/movies/search"), call("GET", "/api/movies/{}"), call("*", "/api/movies/search")];
    const ranked = matchCalls({ surfaces, calls }, new Map([["s", "spring"]]));
    expect(ranked.targetsOf.get(0)!.map((s) => s.id)).toEqual(["s|GET /api/movies/search"]);
    expect(ranked.targetsOf.get(1)!.map((s) => s.id)).toEqual(["s|GET /api/movies/search", "s|GET /api/movies/{tmdbId}"]);
    // An unknown method picks its route per method, GET the search and POST the variable: which it is, is not read.
    expect(ranked.targetsOf.has(2)).toBe(false);
    expect(ranked.unsettled.get(2)!.map((s) => s.id)).toEqual(["s|GET /api/movies/search", "s|POST /api/movies/{tmdbId}"]);
    // Express and the like follow registration order, which is not read: every route the request fits stays.
    const ordered = matchCalls({ surfaces, calls });
    expect(ordered.targetsOf.get(0)!.map((s) => s.id)).toEqual(["s|GET /api/movies/search", "s|GET /api/movies/{tmdbId}"]);
    expect(ordered.targetsOf.has(2)).toBe(false);
    expect(ordered.unsettled.get(2)!.map((s) => s.id)).toEqual(["s|GET /api/movies/search", "s|GET /api/movies/{tmdbId}", "s|POST /api/movies/{tmdbId}"]);
    // Spring scores a variable 1 and a wildcard 100: /a/{x}/{y} over /a/*/*.
    const scored = [surface("GET", "/a/*/*"), surface("GET", "/a/{x}/{y}")];
    expect(matchCalls({ surfaces: scored, calls: [call("GET", "/a/p/q")] }, new Map([["s", "spring"]])).targetsOf.get(0)!.map((s) => s.id)).toEqual(["s|GET /a/{x}/{y}"]);
    // Where every route it fits takes one method, an unknown method does not change which it reaches.
    expect(matchCalls({ surfaces: scored, calls: [call("*", "/a/p/q")] }, new Map([["s", "spring"]])).targetsOf.get(0)!.map((s) => s.id)).toEqual(["s|GET /a/{x}/{y}"]);
    // Spring prefers fewer variables: /a/{x}/c/d over /a/b/{x}/{y}.
    const spring = [surface("GET", "/a/b/{x}/{y}"), surface("GET", "/a/{x}/c/d")];
    expect(matchCalls({ surfaces: spring, calls: [call("GET", "/a/b/c/d")] }, new Map([["s", "spring"]])).targetsOf.get(0)!.map((s) => s.id)).toEqual(["s|GET /a/{x}/c/d"]);
    // A mapping that names the method wins a tie with one that accepts any; an unknown method may reach either.
    const methods = [surface("*", "/m/{x}"), surface("GET", "/m/{x}")];
    expect(matchCalls({ surfaces: methods, calls: [call("GET", "/m/1")] }, new Map([["s", "spring"]])).targetsOf.get(0)!.map((s) => s.id)).toEqual(["s|GET /m/{x}"]);
    const tie = matchCalls({ surfaces: methods, calls: [call("*", "/m/1")] }, new Map([["s", "spring"]]));
    expect(tie.targetsOf.has(0)).toBe(false);
    expect(tie.unsettled.get(0)!.map((s) => s.id)).toEqual(["s|* /m/{x}", "s|GET /m/{x}"]);
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
    calls: [{ from: "web", to: "server", files: ["src/main/resources/templates/**/*.html"], dataUrls: ["data-api-url"] }],
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

  it("reads the method of Thymeleaf's HTML-friendly data-th- attributes, a formmethod as HTML does", () => {
    const html = [
      '<form data-th-method="post" data-th-action="@{/save}"></form>',
      '<form method="post"><button data-th-formmethod="delete" formaction="/drop">d</button></form>',
      // A value Thymeleaf computes is known only when the page renders; a quoted literal writes itself.
      '<form><button th:formmethod="${m}" formaction="/maybe">d</button><button th:formmethod="\'post\'" formaction="/sure">s</button></form>',
    ].join("\n");
    expect(calls(html)).toEqual(["POST /save 1", "GET /drop 2", "* /maybe 3", "POST /sure 3"]);
  });

  it("reads only what HTML makes a request of", () => {
    const rows: Array<[string, string[]]> = [
      ['<button type="submit" formaction="/save">s</button>', []],
      ['<form id="f"></form><button form="other" formaction="/save">s</button>', []],
      // A file is no request; the point is the body, which a browser does not run when the script has a src.
      ['<script th:src="@{/app.js}">fetch("/fallback")</script>', []],
      ['<script th:attr="src=@{/app.js}">fetch("/fallback")</script>', []],
      // A `, src=` inside a quoted value is that item's text: the script has no src, and its body runs.
      ["<script th:attr=\"data-note='x, src=y'\">fetch('/api')</script>", ["GET /api 1"]],
      ["<script th:attr=\"title=|x, src=y|\">fetch('/api')</script>", ["GET /api 1"]],
      // `src=null` removes the attribute, and a computed src may: the body is read.
      ["<script th:attr=\"src=null\">fetch('/api')</script>", ["GET /api 1"]],
      ["<script th:attr=\"src=${cdn}\">fetch('/api')</script>", ["GET /api 1"]],
      ["<script th:src=\"${maybe}\">fetch('/api')</script>", ["GET /api 1"]],
      // A link expression with path variables surely writes a src: the script is that file, and its body does not run.
      ["<script th:attr=\"src=@{/assets/{id}(id=${v})}\">fetch('/api')</script>", ["GET /assets/{} 1"]],
      ["<script th:src=\"@{/assets/{id}(id=${v})}\">fetch('/api')</script>", ["GET /assets/{} 1"]],
      // A brace in quoted text of the expression is text.
      ["<script th:src=\"@{/app(p='}')}\">fetch('/api')</script>", ["GET /app 1"]],
      ['<div data-url="/preview"></div>', []],
    ];
    expect(rows.map(([html]) => calls(html))).toEqual(rows.map(([, out]) => out));
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
    const { targetsOf } = matchCalls({ surfaces: [surface("/bar/{*rest}"), surface("/{x}/foo/{*rest}")], calls: [request] }, new Map([["s", "spring"]]));
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
    const { targetsOf } = matchCalls({ surfaces: [surface("/files/*.txt"), surface("/files/{name}")], calls: [request] }, new Map([["s", "spring"]]));
    expect(targetsOf.get(0)!.map((s) => s.id)).toEqual(["s|GET /files/{name}"]);
  });
});
