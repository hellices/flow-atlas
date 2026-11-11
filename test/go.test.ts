import { describe, expect, it } from "vitest";
import { loadConfig, normalizeConfig } from "../src/config.js";
import { parseGo, tokenize } from "../src/extract/golang.js";
import { chiPath, chiPattern, ginJoin, goClean, re2ToJs } from "../src/extract/goroutes.js";
import { extractRoutes } from "../src/extract/routes.js";
import { inventory } from "../src/inventory.js";
import { matchCalls, rankedComponents, redirectedLimits } from "../src/match.js";
import type { Call, Surface } from "../src/model.js";
import { scan } from "../src/scan.js";
import { validate } from "../src/schema.js";
import { WorktreeSource, type Source } from "../src/source.js";

/** Go's routers (#53): what Gin, chi and net/http's ServeMux register, where they serve it, and where a request goes. */
const memory = (files: Record<string, string>): Source => ({
  ref: "WORKTREE",
  list: () => Object.keys(files),
  read: (p) => files[p],
  asOf: () => "2026-11-01T00:00:00Z",
});
const lines = (...l: string[]) => l.join("\n");
const GO_MOD = lines("module example.com/svc", "", "go 1.22", "");

/** Every surface the files give, `METHOD /path`, implicit ones and conventions marked, with the limits. */
const read = (files: Record<string, string>, entry: Record<string, unknown> = {}) => {
  const limits: string[] = [];
  const all = { "svc/go.mod": GO_MOD, ...files };
  const config = normalizeConfig({ components: [{ name: "svc", path: "svc" }], routes: [{ component: "svc", files: ["svc/**/*.go"], styles: ["go"], ...entry }] });
  const surfaces = extractRoutes(memory(all), config, undefined, [], limits);
  const mark = (s: Surface) => `${s.method} ${s.path}${s.implicit ? " (implicit)" : ""}${s.convention ? ` [${s.convention}]` : ""}`;
  return { surfaces: surfaces.map(mark), limits, raw: surfaces };
};

/** A call to `svc` as a sample request is written: `METHOD /path`, a `/` at its end kept as the call's `slash`. */
const call = (request: string, i = 0): Call => {
  const [method, raw] = request.split(" ") as [string, string];
  return {
    id: `web->svc|${request}@x:${i + 1}`,
    from: "web",
    to: "svc",
    method,
    path: raw.replace(/\/+$/, "") || "/",
    based: false,
    ...(raw.length > 1 && raw.endsWith("/") ? { slash: true as const } : {}),
    at: { file: "x", line: i + 1 },
    evidence: "text",
  };
};

/** What each request reaches: `METHOD /path` of each target, and `redirect /path/: ...` where the router redirects it. */
const reach = (files: Record<string, string>, requests: string[]) => {
  const config = normalizeConfig({ components: [{ name: "svc", path: "svc" }], routes: [{ component: "svc", files: ["svc/**/*.go"], styles: ["go"] }] });
  const surfaces = extractRoutes(memory({ "svc/go.mod": GO_MOD, ...files }), config, undefined, [], []);
  const calls = requests.map(call);
  const m = matchCalls({ surfaces, calls }, rankedComponents(config));
  const out: Record<string, string[]> = {};
  requests.forEach((r, i) => {
    const redirected = m.redirected.get(i);
    out[r] = [
      ...(m.targetsOf.get(i) ?? []).map((s) => `${s.method} ${s.path}`).sort(),
      ...(redirected ? [`redirect ${redirected.path}${redirected.slash ? "/" : ""}: ${redirected.surfaces.map((s) => `${s.method} ${s.path}`).join(", ")}`] : []),
    ];
  });
  return { reached: out, matched: redirectedLimits({ calls }, m.redirected) };
};

const ginFile = (...body: string[]) => lines("package app", "", 'import "github.com/gin-gonic/gin"', "", "func New() *gin.Engine {", "\tr := gin.New()", ...body.map((b) => `\t${b}`), "\treturn r", "}", "", "func h(c *gin.Context) {}");
const chiFile = (...body: string[]) => lines("package app", "", "import (", '\t"net/http"', "", '\t"github.com/go-chi/chi/v5"', ")", "", "func New() http.Handler {", "\tr := chi.NewRouter()", ...body.map((b) => `\t${b}`), "\treturn r", "}", "", "func h(w http.ResponseWriter, r *http.Request) {}");
const muxFile = (...body: string[]) => lines("package app", "", 'import "net/http"', "", "func New() *http.ServeMux {", "\tmux := http.NewServeMux()", ...body.map((b) => `\t${b}`), "\treturn mux", "}", "", "func h(w http.ResponseWriter, r *http.Request) {}");

describe("reading Go source", () => {
  it("reads comments, interpreted and raw strings and runes whole, with the semicolons a line's end inserts", () => {
    const toks = tokenize(lines('x := "a // b" + `c /* d', '` // e', "y := '\"' /* f", "g */ z := \"\\x41\\u00e9\\101\""));
    expect(toks.filter((t) => t.kind !== ";" && t.kind !== "eof").map((t) => (t.kind === "string" ? `S:${t.value}` : t.text))).toEqual(["x", ":=", "S:a // b", "+", "S:c /* d\n", "y", ":=", "'\"'", "z", ":=", "S:AéA"]);
    // A general comment over a line's end ends the statement as a newline would.
    expect(toks.map((t) => t.kind).filter((k) => k === ";").length).toBe(3);
    // An escape Go refuses leaves the string's value unread.
    expect(tokenize('"\\q"')[0]!.value).toBeUndefined();
  });

  it("reads declarations, parameter lists, blocks and composite literals as Go's grammar groups them", () => {
    const file = parseGo(
      lines(
        "package app",
        'import ( g "github.com/gin-gonic/gin"; _ "embed"; . "net/http" )',
        "type S struct { *g.Engine; name, other string `json:\"n\"` }",
        "func (s *S) M(a, b int, c ...string) (x int, err error) {",
        "\tfor _, t := range []struct{ p string }{{p: \"/a\"}} { _ = t }",
        "\tif v := (T{}); v.ok { return }",
        "\tswitch x := y.(type) { case int: f(x); default: }",
        "\treturn 1, nil",
        "}",
        "func F[T any](list []T) {}",
      ),
    );
    expect(file.imports.map((i) => `${i.name ?? ""}=${i.path}`)).toEqual(["g=github.com/gin-gonic/gin", "_=embed", ".=net/http"]);
    expect(file.funcs.map((f) => `${f.recv ? "(S) " : ""}${f.name}(${f.type.params.map((p) => `${p.names.map((n) => n.name).join(",")}${p.variadic ? "..." : ""}`).join(" ")})`)).toEqual(["(S) M(a,b c...)", "F(list)"]);
    expect(file.funcs[0]!.body!.stmts.map((s) => s.k)).toEqual(["range", "if", "switch", "return"]);
    const struct = file.decls[0]!.specs[0]!.type;
    expect(struct?.k === "structtype" ? struct.fields.map((f) => f.names.map((n) => n.name).join(",") || "embedded") : []).toEqual(["embedded", "name,other"]);
  });

  it("cleans and joins paths as Go's path package and Gin's joinPaths do", () => {
    expect([goClean("/a/../b//c/./"), goClean(""), goClean("a/../../b")]).toEqual(["/b/c", ".", "../b"]);
    expect([ginJoin("/", "/x"), ginJoin("/api/", "users"), ginJoin("/api", "/"), ginJoin("/a/b", "../c/"), ginJoin("/v1", "")]).toEqual(["/x", "/api/users", "/api/", "/a/c/", "/v1"]);
  });
});

describe("Gin's routes", () => {
  it("reads the method functions, Handle, Any, Match and static files, each group's path joined as joinPaths joins it", () => {
    const { surfaces, limits } = read({
      "svc/app.go": ginFile(
        'r.GET("/", h)',
        'r.POST("x", h)',
        "r.Handle(http.MethodPut, \"/put\", h)",
        'r.Any("/any", h)',
        'r.Match([]string{"GET", http.MethodDelete}, "/match", h)',
        'api := r.Group("/api/")',
        "{",
        '\tapi.GET("users", h)',
        '\tv1 := api.Group("v1")',
        "\t{",
        '\t\tv1 := v1.Group("/inner")',
        '\t\tv1.GET("/", h)',
        "\t}",
        '\tv1.GET("/up/../down", h)',
        "}",
        'r.Group("/admin", h).GET("/:id/*rest", h).POST("/:id", h)',
        'r.Static("/assets", "./public")',
        'r.StaticFile("/favicon.ico", "./f.ico")',
      ).replace('import "github.com/gin-gonic/gin"', 'import (\n\t"net/http"\n\n\t"github.com/gin-gonic/gin"\n)'),
    });
    expect(surfaces).toEqual([
      "GET /",
      "POST /x",
      "PUT /put",
      "* /any",
      "GET /match",
      "DELETE /match",
      "GET /api/users",
      "GET /api/v1/inner",
      "GET /api/v1/down",
      "GET /admin/{id}/{*rest}",
      "POST /admin/{id}",
      "GET /assets/{*filepath} (implicit) [gin static]",
      "HEAD /assets/{*filepath} (implicit) [gin static]",
      "GET /favicon.ico (implicit) [gin static]",
      "HEAD /favicon.ico (implicit) [gin static]",
    ]);
    expect(limits).toEqual([]);
  });

  it("knows Gin by any name it is imported under, and no other package by Gin's name", () => {
    const files = {
      "svc/a.go": lines("package app", 'import web "github.com/gin-gonic/gin"', "func A() { e := web.Default(); e.GET(\"/a\", nil) }"),
      "svc/b.go": lines("package other", 'import gin "example.com/fake"', "func B() { e := gin.Default(); e.GET(\"/b\", nil) }"),
      "svc/c.go": lines("package third", 'import "github.com/gin-gonic/gin"', "func C(gin *Thing) { e := gin.New(); e.GET(\"/c\", nil) }"),
    };
    // A parameter named `gin` is no package: what it makes is no router, though a call on it looks like Gin's.
    expect(read(files)).toMatchObject({ surfaces: ["GET /a"], limits: ['routes svc: svc/c.go:3 registers GET "/c" on e, which atlas does not trace to a router; it is not read'] });
  });

  it("names the routes it does not read: a path, method or group the file does not spell out, and a wildcard Gin refuses", () => {
    const { surfaces, limits } = read({
      "svc/app.go": ginFile(
        "p := pathFor()",
        "r.GET(p, h)",
        'r.Handle("get", "/lower", h)',
        "r.Match(methods, \"/m\", h)",
        "g := r.Group(p)",
        'g.GET("/in-group", h)',
        'r.GET("/file_:name", h)',
        'r.GET("/a/*rest/b", h)',
        'r.Static("/s/:x", "./d")',
        'r.GET("/{curly}", h)',
      ),
    });
    expect(surfaces).toEqual([]);
    expect(limits).toEqual([
      "routes svc: svc/app.go:8 registers a GET route at a path the file does not spell out (p); it is not read",
      'routes svc: svc/app.go:9 registers a route with a method Gin refuses ("get"); it is not read',
      "routes svc: svc/app.go:10 registers a route with methods the file does not spell out (methods); it is not read",
      "routes svc: svc/app.go:11 makes a group at a path the file does not spell out (p); its routes are not read",
      "routes svc: svc/app.go:12 registers a GET route /in-group on a group whose path is not read; it is not read",
      'routes svc: svc/app.go:15 serves files at /s/:x, whose : or * Gin refuses ("URL parameters can not be used when serving a static file"); it is not read',
      "routes svc: svc/app.go:13 registers /file_:name has a wildcard within a segment (file_:name), which atlas does not read; the route is not read",
      "routes svc: svc/app.go:14 registers /a/*rest/b has a catch-all before its end, which Gin refuses; the route is not read",
      "routes svc: svc/app.go:16 registers /{curly} has text atlas's path form would read as a parameter ({curly}); the route is not read",
    ]);
  });

  it("follows a router through functions, packages, struct fields, methods, constants and literal lists", () => {
    const files = {
      "svc/main.go": lines(
        "package main",
        "",
        "import (",
        '\t"github.com/gin-gonic/gin"',
        '\trt "example.com/svc/routes"',
        ")",
        "",
        "const api = \"/api\"",
        "",
        "type Server struct {",
        "\trouter *gin.Engine",
        "}",
        "",
        "type App struct {",
        "\t*gin.Engine",
        "}",
        "",
        "func main() {",
        "\ts := &Server{router: gin.Default()}",
        "\ts.routes()",
        "\tapp := App{gin.New()}",
        '\tapp.GET("/embedded", nil)',
        "}",
        "",
        "func (s *Server) routes() {",
        "\trt.Register(s.router.Group(api + rt.Version))",
        '\tfor _, p := range []string{"/a", "/b"} {',
        "\t\ts.router.GET(p, nil)",
        "\t}",
        "}",
      ),
      "svc/routes/routes.go": lines("package routes", "", 'import "github.com/gin-gonic/gin"', "", 'const Version = "/v2"', "", "func Register(g *gin.RouterGroup) {", '\tg.GET("/users", list)', "}", "", "func list(c *gin.Context) {}"),
    };
    expect(read(files)).toMatchObject({ surfaces: ["GET /api/v2/users", "GET /a", "GET /b", "GET /embedded"], limits: [] });
  });

  it("names a router it does not trace: an unbound parameter, a router a branch may replace, a recursive call", () => {
    const files = {
      "svc/app.go": lines(
        "package app",
        "",
        'import "github.com/gin-gonic/gin"',
        "",
        "func Register(g *gin.RouterGroup) {",
        '\tg.GET("/unbound", nil)',
        "}",
        "",
        "func New(debug bool) *gin.Engine {",
        "\tr := gin.New()",
        "\tloop(r)",
        "\tif debug {",
        "\t\tr = gin.Default()",
        "\t}",
        '\tr.GET("/either", nil)',
        "\treturn r",
        "}",
        "",
        "func loop(r *gin.Engine) {",
        '\tr.GET("/once", nil)',
        "\tloop(r)",
        "}",
      ),
    };
    const { surfaces, limits } = read(files);
    expect(surfaces).toEqual(["GET /once"]);
    expect(limits).toEqual([
      'routes svc: svc/app.go:6 registers GET "/unbound" on g (g, a parameter of Register that no call of the route files passes a router), which atlas does not trace to a router; it is not read',
      "routes svc: svc/app.go:19 loop calls itself; what the recursive call registers is not read",
      'routes svc: svc/app.go:15 registers GET "/either" on r (a router a branch, a loop or another function may replace), which atlas does not trace to a router; it is not read',
    ]);
    // `mounts` gives the path the routers a file makes, and its unbound router parameters, are served under.
    expect(read(files, { mounts: { "svc/app.go": "/ext" } }).surfaces).toEqual(["GET /ext/unbound", "GET /ext/once"]);
  });

  it("reads RedirectTrailingSlash where the code sets it to true or false, and names a setting or option it does not read", () => {
    const { raw, limits } = read({
      "svc/app.go": lines(
        "package app",
        'import "github.com/gin-gonic/gin"',
        "func A() {",
        "\ta := gin.New()",
        "\ta.RedirectTrailingSlash = false",
        '\ta.GET("/a", nil)',
        "\tb := gin.New()",
        "\tb.RedirectTrailingSlash = flag",
        '\tb.GET("/b", nil)',
        "\tc := gin.New(opts...)",
        '\tc.GET("/c", nil)',
        "\td := gin.New(func(e *gin.Engine) { e.RedirectTrailingSlash = false })",
        '\td.GET("/d", nil)',
        "}",
      ),
    });
    expect(raw.map((s) => `${s.path} ${s.dispatch?.slashes ?? "unread"}`)).toEqual(["/a strict", "/b unread", "/c unread", "/d strict"]);
    expect(limits).toEqual([
      "routes svc: svc/app.go:8 sets Gin's RedirectTrailingSlash to a value the file does not spell out; whether the engine redirects a request whose trailing / differs is not read",
      "routes svc: svc/app.go:10 gives gin.New options atlas does not read (opts...); the routes and settings they add are not read",
    ]);
  });
});

describe("chi's routes", () => {
  it("reads method functions, Method, Handle with and without a method, Route, Group, With and Mount", () => {
    const files = {
      "svc/app.go": chiFile(
        'r.Get("/", h)',
        'r.With(mw).Post("/posts", h)',
        'r.Method("put", "/m", http.HandlerFunc(h))',
        'r.Handle("/any", http.HandlerFunc(h))',
        'r.HandleFunc("DELETE /del/{id}", h)',
        'r.Route("/users", func(r chi.Router) {',
        '\tr.Get("/", h)',
        '\tr.Route("/{id:[0-9]+}", userRoutes)',
        "})",
        "r.Group(func(r chi.Router) {",
        '\tr.Get("/grouped/*", h)',
        "})",
        'r.Mount("/admin", admin())',
        'r.Mount("/static/", http.StripPrefix("/static/", http.FileServer(http.Dir("."))))',
        'r.Mount("/api", api)',
      ),
      "svc/admin.go": lines(
        "package app",
        "",
        "import (",
        '\t"net/http"',
        "",
        '\t"github.com/go-chi/chi/v5"',
        ")",
        "",
        "func admin() http.Handler {",
        "\tr := chi.NewRouter()",
        '\tr.Get("/", h)',
        '\tr.Get("/stats/", h)',
        "\treturn r",
        "}",
        "",
        "func userRoutes(r chi.Router) {",
        '\tr.Get("/", h)',
        '\tr.Post("/ban", h)',
        "}",
      ),
    };
    const { surfaces, limits, raw } = read(files);
    expect(surfaces).toEqual([
      "GET /",
      "POST /posts",
      "PUT /m",
      "* /any",
      "DELETE /del/{id}",
      "GET /grouped/**",
      "* /static/** (implicit) [net/http FileServer]",
      "GET /users",
      "GET /users/{id}",
      "POST /users/{id}/ban",
      "GET /admin",
      "GET /admin/stats",
    ]);
    expect(raw.map((s) => `${s.path} ${JSON.stringify(s.dispatch)}${s.patterns ? ` ${JSON.stringify(s.patterns)}` : ""}`)).toEqual([
      '/ {"picks":"chi","slashes":"strict"}',
      '/posts {"picks":"chi","slashes":"strict"}',
      '/m {"picks":"chi","slashes":"strict"}',
      '/any {"picks":"chi","slashes":"strict"}',
      '/del/{id} {"picks":"chi","slashes":"strict"}',
      '/grouped/** {"picks":"chi","slashes":"strict","trailing":"slash"}',
      '/static/** {"picks":"chi","slashes":"strict","trailing":"slash"}',
      '/users {"picks":"chi","slashes":"strict","trailing":"both","mounted":[1]}',
      '/users/{id} {"picks":"chi","slashes":"strict","trailing":"both","mounted":[1,2]} {"id":"[0-9]+"}',
      '/users/{id}/ban {"picks":"chi","slashes":"strict","mounted":[1,2]} {"id":"[0-9]+"}',
      '/admin {"picks":"chi","slashes":"strict","trailing":"both","mounted":[1]}',
      '/admin/stats {"picks":"chi","slashes":"strict","trailing":"slash","mounted":[1]}',
    ]);
    expect(limits).toEqual(["routes svc: svc/app.go:25 mounts api at /api, which atlas does not trace to a router or handler; what it serves is not read"]);
  });

  it("names what it does not read: a method chi does not know, a pattern versions split differently, a regexp in RE2's own syntax, a mount into itself, a slash middleware", () => {
    const files = {
      "svc/app.go": chiFile(
        'r.Method("JELLO", "/jello", http.HandlerFunc(h))',
        'r.Handle("GET\\t/tab", http.HandlerFunc(h))',
        'r.Get("/{name:\\\\pL+}", h)',
        'r.Get("/{a}/{a}", h)',
        "a := chi.NewRouter()",
        "b := chi.NewRouter()",
        'a.Mount("/b", b)',
        'b.Mount("/a", a)',
        'a.Get("/x", h)',
        "s := chi.NewRouter()",
        "s.Use(middleware.StripSlashes)",
        's.Get("/s", h)',
      ).replace('\t"github.com/go-chi/chi/v5"', '\t"github.com/go-chi/chi/v5"\n\t"github.com/go-chi/chi/v5/middleware"'),
    };
    const { surfaces, limits, raw } = read(files);
    expect(surfaces).toEqual(["GET /s"]);
    expect(raw[0]!.dispatch).toEqual({ picks: "chi" });
    expect(limits).toEqual([
      'routes svc: svc/app.go:13 registers "GET\\t/tab", which chi versions split into a method and a path differently; it is not read',
      "routes svc: svc/app.go:12 registers a route with the method JELLO, which chi refuses unless chi.RegisterMethod adds it, and no code of the route files does; it is not read",
      'routes svc: svc/app.go:14 registers /{name:\\pL+} tests name with a regexp atlas does not read ("\\\\pL+"); the route is not read',
      "routes svc: svc/app.go:15 registers /{a}/{a} names the parameter a twice; the route is not read",
      "routes svc: svc/app.go:16 makes a router that is mounted into itself; its routes are not read there",
      "routes svc: svc/app.go:21 makes a chi router that uses middleware.StripSlashes, which rewrites a request's trailing /; how its routes and those mounted on it take a request with or without one is not read",
    ]);
    // A method chi.RegisterMethod adds, in any file read, is one chi takes.
    const registered = { ...files, "svc/init.go": lines("package app", 'import "github.com/go-chi/chi/v5"', 'func init() { chi.RegisterMethod("jello") }') };
    expect(read(registered).surfaces).toEqual(["JELLO /jello", "GET /s"]);
  });

  it("writes a parameter's regexp as chi tests it: anchored as text, with RE2's own classes carried over", () => {
    expect([chiPattern("[a-z-]+"), chiPattern("^[0-9]{5,6}"), chiPattern("a|b"), chiPattern("x\\$")]).toEqual(["[a-z-]+", "[0-9]{5,6}", "[\\s\\S]*?(?:^a|b$)[\\s\\S]*", "[\\s\\S]*?(?:^x\\$)[\\s\\S]*"]);
    expect([re2ToJs("\\d+\\s.[]a]"), re2ToJs("(?P<y>\\d{4})"), re2ToJs("\\pL"), re2ToJs("(?i)abc"), re2ToJs("[[:alpha:]]"), re2ToJs("a\\z")]).toEqual(["\\d+[\\t\\n\\f\\r ][^\\n][\\]a]", "(?<y>\\d{4})", undefined, undefined, undefined, undefined]);
    // `a|b` anchored by chi is `^a|b$`: a value that starts with a or ends with b.
    const alternation = new RegExp(`^(?:${chiPattern("a|b")!})$`);
    expect(["ax", "xb", "xax"].map((v) => alternation.test(v))).toEqual([true, true, false]);
    expect(chiPath("/{x}/files*")).toEqual({ why: "/{x}/files* has a * after text in its segment, which atlas does not read" });
  });
});

describe("net/http's ServeMux routes", () => {
  it("reads Go 1.22 patterns: a method (GET serving HEAD too), wildcards, a remainder, {$} and subtrees", () => {
    const { surfaces, raw, limits } = read({
      "svc/app.go": muxFile(
        'mux.HandleFunc("GET /{$}", h)',
        'mux.HandleFunc("POST  /items", h)',
        'mux.Handle("/items/{id}/", http.HandlerFunc(h))',
        'mux.HandleFunc("PUT /files/{path...}", h)',
        'mux.Handle("GET /static/", http.StripPrefix("/static/", http.FileServer(http.Dir("."))))',
        'http.HandleFunc("/default", h)',
        'mux.HandleFunc("/", h)',
      ),
    });
    expect(surfaces).toEqual([
      "GET /",
      "POST /items",
      "* /items/{id}/**",
      "PUT /files/{*path}",
      "GET /static/** (implicit) [net/http FileServer]",
      "* /**",
      "* /default",
      "HEAD / (implicit)",
      "HEAD /static/** (implicit) [net/http FileServer]",
    ]);
    expect(raw.map((s) => s.dispatch?.trailing ?? "-")).toEqual(["-", "-", "slash", "slash", "slash", "-", "-", "-", "slash"]);
    expect(limits).toEqual([]);
  });

  it("names the patterns it does not read: a host, a method or wildcard Go refuses, an unclean path, an escape", () => {
    const { surfaces, limits } = read({
      "svc/app.go": muxFile(
        'mux.HandleFunc("example.com/x", h)',
        'mux.HandleFunc("G(T /x", h)',
        'mux.HandleFunc("/a/{x}y", h)',
        'mux.HandleFunc("/a/{x...}/b", h)',
        'mux.HandleFunc("GET /a/../b", h)',
        'mux.HandleFunc("/a%2Fb", h)',
        "mux.HandleFunc(pattern, h)",
      ),
    });
    expect(surfaces).toEqual([]);
    expect(limits).toEqual([
      "routes svc: svc/app.go:13 registers a pattern at a path the file does not spell out (pattern); it is not read",
      'routes svc: svc/app.go:7 registers "example.com/x" matches requests by host (example.com), which atlas does not read; the route is not read',
      'routes svc: svc/app.go:8 registers "G(T /x" has a method Go refuses; the route is not read',
      'routes svc: svc/app.go:9 registers "/a/{x}y" has a wildcard that is not a segment whole, which Go refuses; the route is not read',
      'routes svc: svc/app.go:10 registers "/a/{x...}/b" has a {...} wildcard before its end, which Go refuses; the route is not read',
      'routes svc: svc/app.go:11 registers "GET /a/../b" has a path Go cleans away before it matches (/a/../b), so it matches no request; the route is not read',
      'routes svc: svc/app.go:12 registers "/a%2Fb" has an escaped character, which atlas does not read; the route is not read',
    ]);
  });

  it("reads patterns as the Go of the nearest go.mod reads them: Go 1.21's mux before 1.22 or under GODEBUG httpmuxgo121=1", () => {
    const app = { "svc/app.go": muxFile('mux.HandleFunc("GET /new/{id}", h)', 'mux.HandleFunc("/old/", h)') };
    const legacy = 'routes svc: svc/app.go:7 registers "GET /new/{id}" is read by Go before 1.22 (or with GODEBUG httpmuxgo121=1) as a path with a host or literal braces, which atlas does not read; the route is not read';
    expect(read({ ...app, "svc/go.mod": lines("module example.com/svc", "go 1.21") })).toMatchObject({ surfaces: ["* /old/**"], limits: [legacy] });
    expect(read({ ...app, "svc/go.mod": lines("module example.com/svc", "go 1.24", "godebug (", "\thttpmuxgo121=1", ")") })).toMatchObject({ surfaces: ["* /old/**"], limits: [legacy] });
    expect(read({ ...app, "svc/cmd/main.go": lines("//go:debug httpmuxgo121=1", "package main") })).toMatchObject({ surfaces: ["* /old/**"], limits: [legacy] });
    // The go.mod of another module, above the file's own, does not count.
    expect(read({ ...app, "go.mod": lines("module example.com/root", "go 1.20") }).surfaces).toEqual(["GET /new/{id}", "* /old/**", "HEAD /new/{id} (implicit)"]);
    const none = extractRoutes(memory(app), normalizeConfig({ components: [{ name: "svc", path: "svc" }], routes: [{ component: "svc", files: ["svc/**/*.go"], styles: ["go"] }] }), undefined, [], []);
    expect(none).toEqual([]);
  });

  it("reads a router served under a subtree with http.StripPrefix, or at the root, and names another mount", () => {
    const { surfaces, limits } = read({
      "svc/app.go": lines(
        "package app",
        "",
        "import (",
        '\t"net/http"',
        "",
        '\t"github.com/go-chi/chi/v5"',
        '\t"github.com/gin-gonic/gin"',
        ")",
        "",
        "func New() *http.ServeMux {",
        "\tmux := http.NewServeMux()",
        "\tapi := chi.NewRouter()",
        '\tapi.Get("/", nil)',
        '\tapi.Get("/users", nil)',
        '\tmux.Handle("/api/", http.StripPrefix("/api", api))',
        "\tengine := gin.New()",
        '\tengine.GET("/health", nil)',
        '\tmux.Handle("/", engine)',
        "\tother := chi.NewRouter()",
        '\tother.Get("/x", nil)',
        '\tmux.Handle("/other/", http.StripPrefix("/other/", other))',
        '\tmux.Handle("/full/", other)',
        "\treturn mux",
        "}",
      ),
    });
    expect(surfaces).toEqual(["GET /api", "GET /api/users", "GET /health"]);
    expect(limits).toEqual([
      'routes svc: svc/app.go:22 serves other at "/full/" without http.StripPrefix, so it is handed the request\'s whole path; its routes are not read',
      'routes svc: svc/app.go:21 serves a router under "/other/" with http.StripPrefix("/other/"); atlas reads such a mount only where the pattern is a subtree with no method and StripPrefix removes its path without the last /, so its routes are not read',
    ]);
  });
});

describe("where each router dispatches a request", () => {
  it("Gin: static text before a parameter before a catch-all, and a redirect where its tree reaches a route of the other form first", () => {
    const files = {
      "svc/app.go": ginFile('r.GET("/user/:name", h)', 'r.GET("/user/:name/*action", h)', 'r.GET("/user/groups", h)', 'r.POST("/user/:name/*action", h)', 'r.GET("/list/", h)', 'r.GET("/a/:x/b", h)'),
    };
    const { reached } = reach(files, ["GET /user/groups", "GET /user/bob", "GET /user/groups/", "POST /user/groups/", "GET /user/bob/", "GET /user/bob/x/y", "GET /list", "GET /list/", "GET /a/1/", "HEAD /user/bob", "DELETE /user/bob"]);
    expect(reached).toEqual({
      "GET /user/groups": ["GET /user/groups"],
      "GET /user/bob": ["GET /user/{name}"],
      "GET /user/groups/": ["redirect /user/groups: GET /user/groups"],
      "POST /user/groups/": ["POST /user/{name}/{*action}"],
      "GET /user/bob/": ["GET /user/{name}/{*action}"],
      "GET /user/bob/x/y": ["GET /user/{name}/{*action}"],
      "GET /list": ["redirect /list/: GET /list"],
      "GET /list/": ["GET /list"],
      "GET /a/1/": [],
      "HEAD /user/bob": [],
      "DELETE /user/bob": [],
    });
    // Without RedirectTrailingSlash, a request of the other form reaches nothing.
    const strict = { "svc/app.go": ginFile("r.RedirectTrailingSlash = false", 'r.GET("/list/", h)') };
    expect(reach(strict, ["GET /list"]).reached).toEqual({ "GET /list": [] });
  });

  it("chi: static text, then a regexp, then a parameter, then a catch-all, a parameter ending at a / last, and a mount as a catch-all", () => {
    const files = {
      "svc/app.go": chiFile(
        'r.Get("/articles/search", h)',
        'r.Get("/articles/{slug:[a-z-]+}", h)',
        'r.Get("/articles/{month}-{day}", h)',
        'r.Get("/articles/{id}", h)',
        'r.Get("/articles/*", h)',
        'r.Get("/admin/{id}", h)',
        'r.Route("/admin", func(r chi.Router) { r.Get("/accounts", h); r.Get("/", h) })',
      ),
    };
    const { reached } = reach(files, ["GET /articles/search", "GET /articles/hello-world", "GET /articles/01-16", "GET /articles/42", "GET /articles/4/2", "GET /articles/", "GET /admin/accounts", "GET /admin", "GET /admin/", "GET /articles/search/"]);
    expect(reached).toEqual({
      "GET /articles/search": ["GET /articles/search"],
      "GET /articles/hello-world": ["GET /articles/{slug}"],
      "GET /articles/01-16": ["GET /articles/{month}-{day}"],
      "GET /articles/42": ["GET /articles/{id}"],
      "GET /articles/4/2": ["GET /articles/**"],
      "GET /articles/": ["GET /articles/**"],
      "GET /admin/accounts": ["GET /admin/{id}"],
      "GET /admin": ["GET /admin"],
      "GET /admin/": ["GET /admin"],
      "GET /articles/search/": ["GET /articles/**"],
    });
  });

  it("ServeMux: the most specific pattern, a method's before none, and a redirect to a subtree's root or an empty remainder", () => {
    const files = {
      "svc/app.go": muxFile(
        'mux.HandleFunc("GET /posts/latest", h)',
        'mux.HandleFunc("GET /posts/{id}", h)',
        'mux.HandleFunc("/posts/{id}/raw", h)',
        'mux.HandleFunc("GET /posts/{id}/raw", h)',
        'mux.HandleFunc("/images/", h)',
        'mux.HandleFunc("/images/thumbs/", h)',
        'mux.HandleFunc("GET /files/{path...}", h)',
        'mux.HandleFunc("/exact", h)',
        'mux.HandleFunc("/exact/", h)',
        'mux.HandleFunc("/", h)',
        'mux.HandleFunc("HEAD /posts/latest", h)',
      ),
    };
    const { reached, matched } = reach(files, ["GET /posts/latest", "GET /posts/7", "HEAD /posts/7", "HEAD /posts/latest", "GET /posts/7/raw", "POST /posts/7/raw", "GET /images", "GET /images/a/b", "GET /images/thumbs/x", "GET /files", "GET /files/", "GET /exact", "GET /exact/x", "GET /nowhere", "POST /posts/7"]);
    expect(reached).toEqual({
      "GET /posts/latest": ["GET /posts/latest"],
      "GET /posts/7": ["GET /posts/{id}"],
      "HEAD /posts/7": ["HEAD /posts/{id}"],
      "HEAD /posts/latest": ["HEAD /posts/latest"],
      "GET /posts/7/raw": ["GET /posts/{id}/raw"],
      "POST /posts/7/raw": ["* /posts/{id}/raw"],
      "GET /images": ["redirect /images/: * /images/**"],
      "GET /images/a/b": ["* /images/**"],
      "GET /images/thumbs/x": ["* /images/thumbs/**"],
      "GET /files": ["redirect /files/: GET /files/{*path}"],
      "GET /files/": ["GET /files/{*path}"],
      "GET /exact": ["* /exact"],
      "GET /exact/x": ["* /exact/**"],
      "GET /nowhere": ["* /**"],
      "POST /posts/7": ["* /**"],
    });
    expect(matched).toEqual([
      "calls web->svc: GET /images at x:7 is answered with a redirect to /images/, which any method /images/** serves; it reaches that route only as its client follows the redirect, so it is matched to none",
      "calls web->svc: GET /files at x:10 is answered with a redirect to /files/, which GET /files/{*path} serves; it reaches that route only as its client follows the redirect, so it is matched to none",
    ]);
  });
});

describe("the go style around the routes", () => {
  it("offers the go style for files that import a router and register on it, not for a registration in a comment", () => {
    const files = {
      "svc/gin.go": ginFile('r.GET("/a", h)', 'r.Group("/g")'),
      "svc/mux.go": muxFile('mux.HandleFunc("GET /m", h)'),
      "svc/comment.go": lines("package app", 'import "net/http"', '// mux.HandleFunc("/x", h)', "var s = `", 'r.Get("/y", h)', "`"),
      "svc/client.go": lines("package app", 'import "example.com/client"', 'func f() { client.Get("/z") }'),
    };
    expect(inventory(memory(files), []).routes.map((r) => `${r.file} ${r.style} ${r.count} ${r.example}`)).toEqual(["svc/gin.go go 2 svc/gin.go:7", "svc/mux.go go 1 svc/mux.go:7"]);
  });

  it("keeps a registered path from being read as a request of the file's own calls", () => {
    const files = { "svc/go.mod": GO_MOD, "svc/app.go": ginFile('r.GET("/orders", h)', 'resp, _ := http.Get("/payments")', "_ = resp").replace('import "github.com/gin-gonic/gin"', 'import (\n\t"net/http"\n\n\t"github.com/gin-gonic/gin"\n)') };
    const config = normalizeConfig({
      components: [
        { name: "svc", path: "svc" },
        { name: "pay", path: "pay" },
      ],
      routes: [{ component: "svc", files: ["svc/**/*.go"], styles: ["go"] }],
      calls: [{ from: "svc", to: "pay", files: ["svc/**/*.go"] }],
    });
    const graph = scan(memory(files), config, { root: ".", requested: "WORKTREE" });
    expect(graph.calls.map((c) => `${c.method} ${c.path}`)).toEqual(["GET /payments"]);
  });

  it("writes the routes of the gin, chi and nethttp fixtures as the model's schema says", () => {
    for (const name of ["gin", "chi", "nethttp"]) {
      const dir = `fixtures/frameworks/${name}`;
      const graph = scan(new WorktreeSource(dir), loadConfig(`${dir}/atlas.config.yaml`), { root: dir, requested: "WORKTREE" });
      expect(graph.surfaces.length).toBeGreaterThan(0);
      expect(validate("graph", JSON.parse(JSON.stringify(graph)))).toEqual([]);
    }
  });
});

describe("a router held in a struct no read code fills", () => {
  it("names the routes registered on a field whose type is a router, where the method is read with no caller", () => {
    const files = {
      "svc/server.go": lines(
        "package app",
        "",
        'import "github.com/go-chi/chi/v5"',
        "",
        "type Server struct {",
        "\trouter chi.Router",
        "}",
        "",
        "func (s *Server) routes() {",
        '\ts.router.Get("/health", nil)',
        "}",
      ),
    };
    expect(read(files)).toMatchObject({
      surfaces: [],
      limits: ['routes svc: svc/server.go:10 registers Get "/health" on s.router (the field router of a Server that no call of the route files passes), which atlas does not trace to a router; it is not read'],
    });
  });
});

describe("chi middlewares that change how a request is routed", () => {
  it("serves HEAD with GET routes under middleware.GetHead, reads none in a group, and names a path rewrite", () => {
    const files = {
      "svc/app.go": chiFile(
        "r.Use(middleware.GetHead, middleware.URLFormat)",
        'r.Get("/a", h)',
        'r.Head("/a", h)',
        "r.Group(func(r chi.Router) {",
        "\tr.Use(middleware.StripSlashes)",
        '\tr.Get("/g", h)',
        "})",
        "sub := chi.NewRouter()",
        'sub.Get("/s", h)',
        'r.Mount("/sub", sub)',
      ).replace('\t"github.com/go-chi/chi/v5"', '\t"github.com/go-chi/chi/v5"\n\t"github.com/go-chi/chi/v5/middleware"'),
    };
    const { surfaces, raw, limits } = read(files);
    expect(surfaces).toEqual(["GET /a", "HEAD /a", "GET /g", "GET /sub/s", "HEAD /g (implicit)", "HEAD /sub/s (implicit)"]);
    expect(raw.every((s) => s.dispatch?.slashes === "strict")).toBe(true);
    expect(limits).toEqual([
      "routes svc: svc/app.go:11 makes a chi router that uses middleware.URLFormat, which routes a request by another path than it names; its routes are read at the paths they are written at, and a request rewritten to one of them is not",
    ]);
  });
});

describe("a package-level router", () => {
  it("follows a package-level variable through init and the functions that use it, and forgets one a branch may set", () => {
    const files = {
      "svc/app.go": lines(
        "package app",
        'import "github.com/gin-gonic/gin"',
        "var router = gin.New()",
        "var maybe *gin.Engine",
        "func init() {",
        '\trouter.GET("/init", nil)',
        "\tif flag {",
        "\t\tmaybe = gin.New()",
        "\t}",
        "}",
        "func Routes() {",
        '\trouter.GET("/later", nil)',
        '\tmaybe.GET("/maybe", nil)',
        "}",
      ),
    };
    expect(read(files)).toMatchObject({ surfaces: ["GET /init", "GET /later"], limits: ['routes svc: svc/app.go:13 registers GET "/maybe" on maybe (a router a branch, a loop or another function may replace), which atlas does not trace to a router; it is not read'] });
  });
});

describe("values atlas does not settle are not read as settled", () => {
  const chiApp = (...body: string[]) =>
    lines("package main", "", "import (", '\t"net/http"', '\t"os"', "", '\t"github.com/go-chi/chi/v5"', ")", "", ...body, "", "func h(w http.ResponseWriter, r *http.Request) {}");

  it("stops after the calls it follows in all, and reads no further", () => {
    const chain = Array.from({ length: 16 }, (_, i) => `func a${i}(r chi.Router) { a${i + 1}(r); a${i + 1}(r) }`);
    const { limits } = read({ "svc/main.go": chiApp("func main() { r := chi.NewRouter(); a0(r) }", ...chain, 'func a16(r chi.Router) { r.Get("/x", h) }', "func z() { y() }", "func y() {}") });
    expect(limits).toContain("routes svc: the calls between the functions of the route files go deeper or further than atlas follows (32 deep, 20000 in all); the routes registered beyond are not read");
  });

  it("leaves out a router put in a map, a slice or another package's struct, from which it may be mounted anywhere", () => {
    const { surfaces, limits } = read({
      "svc/main.go": chiApp(
        "func main() {",
        "\tr := chi.NewRouter()",
        "\tadmin := chi.NewRouter()",
        '\tadmin.Get("/stats", h)',
        '\tsubs := map[string]chi.Router{"/admin": admin}',
        "\tfor p, s := range subs {",
        "\t\tr.Mount(p, s)",
        "\t}",
        "\tlisted := chi.NewRouter()",
        '\tlisted.Get("/listed", h)',
        "\thandlers := []http.Handler{}",
        "\thandlers = append(handlers, listed)",
        '\thttp.Handle("/l/", http.StripPrefix("/l", handlers[0]))',
        '\tsrv := &http.Server{Addr: ":80", Handler: r}',
        "\tsrv.Handler = r",
        "\t_ = os.Args",
        "}",
      ),
    });
    expect(surfaces).toEqual(["* /l/**"]);
    expect(limits).toEqual([
      "routes svc: svc/main.go:16 mounts s at p, which atlas does not trace to a router or handler; what it serves is not read",
      "routes svc: svc/main.go:12 makes a router that svc/main.go:14 passes on where atlas does not follow it; where it is served is not read, so its routes are not read",
      "routes svc: svc/main.go:18 makes a router that svc/main.go:21 passes on where atlas does not follow it; where it is served is not read, so its routes are not read",
    ]);
  });

  it("copies a struct value as Go does, where a pointer shares it", () => {
    const { surfaces } = read({
      "svc/main.go": chiApp(
        "type Config struct{ Prefix string }",
        "type API struct {",
        "\tr      chi.Router",
        "\tprefix string",
        "}",
        "func (a API) under(p string) API { a.prefix = a.prefix + p; return a }",
        "func (a API) get(p string) { a.r.Get(a.prefix+p, h) }",
        "func (a *API) move(p string) { a.prefix = p }",
        "func main() {",
        "\tr := chi.NewRouter()",
        '\tbase := Config{Prefix: "/api"}',
        "\tv2 := base",
        '\tv2.Prefix = "/v2"',
        '\tr.Get(base.Prefix+"/users", h)',
        '\tapi := API{r: r, prefix: "/api"}',
        '\tapi.under("/admin").get("/stats")',
        '\tapi.get("/users2")',
        "\tp := &api",
        '\tp.move("/moved")',
        '\tapi.get("/x")',
        "}",
      ),
    });
    expect(surfaces).toEqual(["GET /api/users", "GET /api/admin/stats", "GET /api/users2", "GET /moved/x"]);
  });

  it("reads a package variable as the calls read assign it, and leaves one another entry point may assign unknown", () => {
    const configured = read({
      "svc/main.go": chiApp(
        'var prefix = "/api"',
        "func main() { configure(); r := chi.NewRouter(); routes(r); http.ListenAndServe(\":80\", r) }",
        'func configure() { prefix = "/v2" }',
        'func routes(r chi.Router) { r.Get(prefix+"/users", h) }',
      ),
    });
    expect(configured).toMatchObject({ surfaces: ["GET /v2/users"], limits: [] });
    const entries = read({
      "svc/main.go": chiApp(
        'var prefix = "/api"',
        "var r = chi.NewRouter()",
        'func Routes() { r.Get(prefix+"/users", h) }',
        "func Configure(p string) { prefix = p }",
      ),
    });
    expect(entries).toMatchObject({ surfaces: [], limits: ["routes svc: svc/main.go:12 registers a GET route at a path the file does not spell out (prefix+\"/users\"); it is not read"] });
  });

  it("forgets a field or a setting a branch or loop may change, keeping its type", () => {
    const { surfaces, limits, raw } = read({
      "svc/main.go": chiApp(
        "type Server struct{ r chi.Router }",
        "func pick(a, b chi.Router) chi.Router {",
        '\tif os.Getenv("V2") != "" {',
        "\t\treturn b",
        "\t}",
        "\treturn a",
        "}",
        "func main() {",
        "\troot := chi.NewRouter()",
        "\tapi := chi.NewRouter()",
        '\troot.Mount("/api", api)',
        "\ts := &Server{r: root}",
        '\tif os.Getenv("X") != "" {',
        "\t\ts.r = api",
        "\t}",
        '\ts.r.Get("/users", h)',
        '\tpick(root, api).Get("/picked", h)',
        '\troot.Get("/root", h)',
        "}",
      ),
      "svc/gin.go": ginFile("if cond {", "\tr.RedirectTrailingSlash = false", "}", 'r.GET("/g", h)'),
    });
    expect(surfaces).toEqual(["GET /root", "GET /g"]);
    expect(raw.find((s) => s.path === "/g")!.dispatch).toEqual({ picks: "httprouter" });
    expect(limits).toEqual([
      'routes svc: svc/main.go:25 registers Get "/users" on s.r (a router a branch, a loop or another function may replace), which atlas does not trace to a router; it is not read',
      'routes svc: svc/main.go:26 registers Get "/picked" on pick(root, api) (a router pick returns, which atlas does not settle), which atlas does not trace to a router; it is not read',
      "routes svc: svc/gin.go:8 sets Gin's RedirectTrailingSlash in a branch or loop that may not run; whether the engine redirects a request whose trailing / differs is not read",
    ]);
  });

  it("serves the routers `mounts` places as their own mounts say, under the declared path", () => {
    const files = {
      "svc/routes/api.go": lines(
        "package routes",
        'import "github.com/go-chi/chi/v5"',
        "func Register(r chi.Router) {",
        '\tr.Route("/users", func(u chi.Router) { u.Get("/{id}", nil) })',
        '\tadmin := chi.NewRouter(); admin.Get("/stats", nil); r.Mount("/admin", admin)',
        "}",
      ),
    };
    expect(read(files, { mounts: { "svc/routes/api.go": "/api" } }).surfaces).toEqual(["GET /api/users/{id}", "GET /api/admin/stats"]);
  });
});

describe("a router mounted on a value atlas does not trace", () => {
  it("is not read at the root", () => {
    const { surfaces, limits } = read({
      "svc/app.go": chiFile("sub := chi.NewRouter()", 'sub.Get("/x", h)', 'other.Mount("/api", sub)'),
    });
    expect(surfaces).toEqual([]);
    expect(limits).toEqual([
      'routes svc: svc/app.go:13 registers Mount "/api" on other, which atlas does not trace to a router; it is not read',
      "routes svc: svc/app.go:11 makes a router that svc/app.go:13 passes on where atlas does not follow it; where it is served is not read, so its routes are not read",
    ]);
  });
});
