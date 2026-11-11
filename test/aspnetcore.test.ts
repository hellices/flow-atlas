import { describe, expect, it } from "vitest";
import { normalizeConfig } from "../src/config.js";
import { aspnetcoreRoutes } from "../src/extract/aspnetcore.js";
import { lexCSharp, maskCSharp, stringValue } from "../src/extract/csharp.js";
import { readCsFile } from "../src/extract/csharpdecls.js";
import { extractRoutes } from "../src/extract/routes.js";
import { constraintPattern, dotnetRegex, parsePattern, precedence, servedPaths } from "../src/extract/routepattern.js";
import { Spans } from "../src/extract/spans.js";
import { inventory } from "../src/inventory.js";
import { matchCalls } from "../src/match.js";
import type { Call, Surface } from "../src/model.js";
import type { Source } from "../src/source.js";

const memory = (files: Record<string, string>): Source => ({
  ref: "WORKTREE",
  list: () => Object.keys(files),
  read: (p) => files[p],
  asOf: () => "2026-11-01T00:00:00Z",
});

/** The routes and limits the aspnetcore style reads in these files, each route `METHOD path`. */
function read(files: Record<string, string>, extra: Record<string, unknown> = {}) {
  const limits: string[] = [];
  const config = normalizeConfig({ components: [{ name: "api", path: "." }], routes: [{ component: "api", files: ["**/*.cs"], styles: ["aspnetcore"], ...extra }] });
  const surfaces = extractRoutes(memory(files), config, undefined, [], limits);
  return { routes: surfaces.map((s) => `${s.method} ${s.path}`), surfaces, limits };
}

const program = (body: string) => ({ "App.csproj": "<Project Sdk=\"Microsoft.NET.Sdk.Web\" />", "Program.cs": `var builder = WebApplication.CreateBuilder(args);\nvar app = builder.Build();\n${body}\napp.Run();\n` });

const call = (method: string, path: string): Call => ({
  id: `c|${method} ${path}`,
  from: "c",
  to: "api",
  method,
  path: path.replace(/\/+$/, "") || "/",
  based: false,
  ...(path.length > 1 && path.endsWith("/") ? { slash: true as const } : {}),
  at: { file: "c.ts", line: 1 },
  evidence: "static",
});

/** The routes each request reaches, `METHOD path` each. */
function reach(surfaces: Surface[], requests: string[]): Record<string, string[]> {
  const calls = requests.map((r) => call(r.split(" ")[0]!, r.split(" ")[1]!));
  const { targetsOf } = matchCalls({ surfaces, calls });
  return Object.fromEntries(requests.map((r, i) => [r, (targetsOf.get(i) ?? []).map((s) => `${s.method} ${s.path}`)]));
}

describe("C# lexing", () => {
  it("reads no code in comments, directives or strings", () => {
    const text = [
      "// app.MapGet(\"/comment\", () => 1);",
      "/* app.MapGet(\"/block\", () => 1); */",
      "#if NEVER app.MapGet(\"/directive\")",
      "var s = \"app.MapGet(\\\"/string\\\")\";",
      "var c = '\"';",
      "app.MapGet(\"/real\", () => 1);",
    ].join("\n");
    const words = lexCSharp(text).filter((t) => t.kind === "id").map((t) => t.text);
    expect(words.filter((w) => w === "MapGet")).toHaveLength(1);
    expect(read(program(text)).routes).toEqual(["GET /real"]);
  });

  it("reads each string form's value", () => {
    const value = (src: string) => stringValue(lexCSharp(src)[0]);
    expect(value('"/a\\tb\\u0041"')).toBe("/a\tbA");
    expect(value('@"C:\\x""y"')).toBe('C:\\x"y');
    expect(value('"""/raw "quoted" path"""')).toBe('/raw "quoted" path');
    expect(value('"""\n    /first\n      second\n    """')).toBe("/first\n  second");
    expect(value('"/utf8"u8')).toBe("/utf8");
    // An interpolated string keeps its holes, each lexed as code, a nested string included.
    const t = lexCSharp('$"/api/{Prefix}/{(ok ? "a" : "b")}/{n:N2}"')[0]!;
    expect(t.parts!.map((p) => (typeof p === "string" ? p : p.map((x) => x.text).join(" ")))).toEqual(["/api/", "Prefix", "/", '( ok ? "a" : "b" )', "/", "n"]);
    const raw = lexCSharp('$$"""{"id":{{Id}}}"""')[0]!;
    expect(raw.parts!.map((p) => (typeof p === "string" ? p : p.map((x) => x.text).join(" ")))).toEqual(['{"id":', "Id", "}"]);
  });

  it("masks comments and strings at the same offsets", () => {
    const text = 'a /* [Route("x")] */ b "[HttpGet]" c\n// .MapGet(\nd';
    const masked = maskCSharp(text);
    expect(masked).toHaveLength(text.length);
    expect(masked).not.toMatch(/Route|HttpGet|MapGet/);
    expect(masked.split("\n")).toHaveLength(3);
  });

  it("reads aliases, namespaces, types, constants and methods", () => {
    const f = readCsFile(
      "A.cs",
      [
        "using R = Microsoft.AspNetCore.Mvc.RouteAttribute;",
        "namespace Shop.Api;",
        "[R(\"api/[controller]\")]",
        "public partial class OrdersController : Microsoft.AspNetCore.Mvc.ControllerBase, IDisposable",
        "{",
        "  public const string Base = \"orders\", Other = Base + \"/x\";",
        "  public (int a, int b) Pair() => (1, 2);",
        "  public int Count { get; set; } = 1;",
        "  [Microsoft.AspNetCore.Mvc.HttpGet(\"{id}\")] public async Task<Results<Ok, NotFound>> GetAsync<T>(int id, [FromQuery] string? q = null) { return null; }",
        "  void IDisposable.Dispose() {}",
        "}",
      ].join("\n"),
    );
    expect(f.aliases.get("R")).toBe("RouteAttribute");
    const t = f.types[0]!;
    expect([t.namespace, t.name, t.bases]).toEqual(["Shop.Api", "OrdersController", ["ControllerBase", "IDisposable"]]);
    expect(t.attributes.map((a) => a.name)).toEqual(["Route"]);
    expect([...t.consts.keys()]).toEqual(["Base", "Other"]);
    expect(t.methods.map((m) => [m.name, m.generic, m.explicit, m.params.map((p) => `${p.type} ${p.name}${p.optional ? "?" : ""}`)])).toEqual([
      ["Pair", false, false, []],
      ["GetAsync", true, false, ["int id", "string? q?"]],
      ["Dispose", false, true, []],
    ]);
  });
});

describe("ASP.NET Core route templates", () => {
  it("parses parameters, constraints, defaults, catch-alls and escapes as RoutePatternParser does", () => {
    const p = parsePattern("~/a/{id:int:range(1,10)?}");
    expect(p).toEqual({ segments: [[{ literal: "a" }], [{ parameter: { name: "id", catchAll: false, optional: true, constraints: ["int", "range(1,10)"] } }]] });
    expect(parsePattern("{**rest}")).toMatchObject({ segments: [[{ parameter: { name: "rest", catchAll: true } }]] });
    expect(parsePattern("x/{p:regex(^\\d{{3}}$)}")).toMatchObject({ segments: [[{ literal: "x" }], [{ parameter: { constraints: ["regex(^\\d{3}$)"] } }]] });
    expect(parsePattern("{{literal}}/{a=b}")).toMatchObject({ segments: [[{ literal: "{literal}" }], [{ parameter: { name: "a", default: "b" } }]] });
    for (const bad of ["a//b", "{*a}/b", "{a?=1}", "{a}{b}", "{a?}.{b}", "{a}-{b?}", "~a", "{a}/{A}", "{*a?}", "a?b"]) expect(parsePattern(bad)).toHaveProperty("error");
  });

  it("serves the forms a request may leave optional segments out of, and a catch-all as one path", () => {
    const paths = (raw: string) => servedPaths((parsePattern(raw) as { segments: never }).segments).map((p) => p.path);
    expect(paths("{controller=Home}/{action=Index}/{id?}")).toEqual(["/", "/{controller}", "/{controller}/{action}", "/{controller}/{action}/{id}"]);
    expect(paths("/posts/{*rest}")).toEqual(["/posts/{*rest}"]);
    expect(paths("/a/{b?}/{*rest}")).toEqual(["/a", "/a/{b}/{*rest}"]);
    expect(paths("/files/{name}.{ext?}")).toEqual(["/files/{name}", "/files/{name}.{ext}"]);
    // An optional segment before a required one is never left out.
    expect(paths("/a/{b?}/c")).toEqual(["/a/{b}/c"]);
  });

  it("ranks segments as RoutePrecedence.ComputeInbound does", () => {
    const digits = (raw: string) => precedence((parsePattern(raw) as { segments: never }).segments);
    expect(digits("api/{id:int}/{x}/{a}.{b}/{*r:nonfile}")).toEqual([1, 2, 3, 2, 4]);
    expect(digits("{*rest}")).toEqual([5]);
  });

  it("writes the constraints it can as regular expressions, exactly", () => {
    const test = (constraints: string[], value: string) => new RegExp(`^(?:${constraintPattern(constraints)})$`).test(value);
    expect(["0", "-5", "+5", " 7 ", "0002147483647", "-2147483648", "2147483647"].map((v) => test(["int"], v))).toEqual([true, true, true, true, true, true, true]);
    expect(["2147483648", "-2147483649", "1.0", "a", "", "--1"].map((v) => test(["int"], v))).toEqual([false, false, false, false, false, false]);
    expect(["9223372036854775807", "9223372036854775808"].map((v) => test(["long"], v))).toEqual([true, false]);
    expect(["abc", "ABC", "a1"].map((v) => test(["alpha"], v))).toEqual([true, true, false]);
    expect(["ab", "abc", "abcd"].map((v) => test(["minlength(3)"], v))).toEqual([false, true, true]);
    expect(["ab", "abc", "abcdef"].map((v) => test(["length(3,5)"], v))).toEqual([false, true, false]);
    expect(["12", "123"].map((v) => test(["int", "maxlength(2)"], v))).toEqual([true, false]);
    // .NET tests the regex anywhere in the value, in either case.
    expect(["Post-1", "x_y", "a b"].map((v) => test(["regex(^[a-z0-9_-]+$)"], v))).toEqual([true, true, false]);
    expect(test(["regex(\\.json)"], "data.JSON")).toBe(true);
    // What atlas does not repeat leaves the parameter unchecked: a range, a parse, Unicode classes, inline options.
    for (const c of [["min(2000)"], ["range(1,12)"], ["guid"], ["datetime"], ["custom"], ["regex(^\\d+$)"], ["regex((?i)x)"], ["int", "min(1)"]]) expect(constraintPattern(c)).toBeUndefined();
    expect(constraintPattern([])).toBeNull();
    expect(dotnetRegex("a$")).toBe("[\\s\\S]*?(?:[aA](?=\\n?$))[\\s\\S]*");
  });
});

describe("minimal APIs", () => {
  it("reads the routes of the application, its groups and the extension and static methods it passes them to", () => {
    const files = {
      ...program(
        [
          'app.MapGet("/", () => "root");',
          'app.MapMethods("/ping", new[] { HttpMethods.Get, "patch" }, () => "pong");',
          'app.MapMethods("/opts", ["OPTIONS", "HEAD"], () => "");',
          'app.Map("/any", () => "any");',
          'var api = app.MapGroup("/api").RequireAuthorization();',
          'api.MapGroup("v1").WithTags("v1").MapTodos();',
          "Routes.Map(app);",
          "app.MapGroup(Paths.Admin).MapTodos();",
        ].join("\n"),
      ),
      "Todos.cs": [
        "public static class Todos {",
        "  public static RouteGroupBuilder MapTodos(this RouteGroupBuilder group) {",
        '    var todos = group.MapGroup($"/{Paths.Todos}");',
        '    todos.MapGet("", () => "all");',
        '    todos.MapDelete("/{id:int}", (int id) => id);',
        "    return group;",
        "  }",
        "}",
        "public static class Paths { public const string Todos = \"todos\"; public const string Admin = \"/admin/\" + Todos; }",
      ].join("\n"),
      "Routes.cs": 'public static class Routes { public static void Map(WebApplication app) { app.MapPost("/routes", () => 1); } }',
    };
    const { routes, limits } = read(files);
    expect(routes).toEqual([
      "GET /",
      "GET /ping",
      "PATCH /ping",
      "OPTIONS /opts",
      "HEAD /opts",
      "* /any",
      "GET /api/v1/todos",
      "DELETE /api/v1/todos/{id}",
      "POST /routes",
      "GET /admin/todos/todos",
      "DELETE /admin/todos/todos/{id}",
    ]);
    expect(limits).toEqual([]);
  });

  it("reads endpoints mapped in UseEndpoints, a Main method and a Startup class's Configure", () => {
    const main = 'public class Program { public static void Main(string[] args) { var app = WebApplication.Create(args); app.UseEndpoints(e => { e.MapGet("/main", () => 1); }); } }';
    expect(read({ "Program.cs": main }).routes).toEqual(["GET /main"]);
    const startup = {
      "Program.cs": "Host.CreateDefaultBuilder(args).ConfigureWebHostDefaults(w => w.UseStartup<Startup>()).Build().Run();",
      "Startup.cs": 'public class Startup { public void ConfigureServices(IServiceCollection s) {} public void Configure(IApplicationBuilder app, IWebHostEnvironment env) { app.UseRouting(); app.UseEndpoints(endpoints => endpoints.MapPut("/startup", () => 1)); } }',
    };
    expect(read(startup).routes).toEqual(["PUT /startup"]);
  });

  it("names what it does not read, and reads nothing at a wrong path", () => {
    const files = {
      ...program(
        [
          "var prefix = Environment.GetEnvironmentVariable(\"PREFIX\");",
          'app.MapGroup(prefix).MapGet("/x", () => 1);',
          "app.MapGet(Settings.Path, () => 1);",
          'app.Map("/branch", branch => branch.UseStaticFiles());',
          "app.MapDefaultEndpoints();",
          'app.MapHub<ChatHub>("/chat");',
          'app.UsePathBase("/base");',
          "RouteGroupBuilder g;",
          'if (x) g = app.MapGroup("/a"); else g = app.MapGroup("/b");',
          'g.MapGet("/y", () => 1);',
          "_mapper.Map<Dto>(entity);",
        ].join("\n"),
      ),
      "Module.cs": 'public class Module { public void AddRoutes(IEndpointRouteBuilder app) { app.MapGet("/module", () => 1); } }',
    };
    const { routes, limits } = read(files);
    expect(routes).toEqual([]);
    expect(limits).toEqual([
      expect.stringMatching(/^routes api: Program\.cs:4 MapGet is called on a builder atlas does not read \(MapGroup at Program\.cs:4 is given a prefix atlas does not read\); what it maps is not read$/),
      "routes api: Program.cs:5 MapGet is given a path atlas does not read; the route is not read",
      "routes api: Program.cs:6 calls Map with a lambda that may branch the middleware pipeline (IApplicationBuilder.Map) or handle a route; it is not read",
      "routes api: Program.cs:6 UseStaticFiles is called on a builder atlas does not read (branch is a parameter of a lambda); what it maps is not read",
      "routes api: Program.cs:7 calls MapDefaultEndpoints, which is not among the files read; the routes it may map are not read",
      "routes api: Program.cs:8 calls MapHub: the SignalR hub it maps is not read",
      "routes api: Program.cs:9 calls UsePathBase: the routes are also served under the path base it strips; that is not read",
      "routes api: Program.cs:12 MapGet is called on a builder atlas does not read (g is assigned more than one value); what it maps is not read",
      "routes api: Module.cs:1 declares Module.AddRoutes, which maps routes on a builder no call atlas reads passes it; they are not read",
    ]);
  });

  it("names a route mapped on a field or a local function's parameter", () => {
    const files = {
      ...program('static void Extra(WebApplication a) { a.MapGet("/local", () => 1); }'),
      "Holder.cs": 'public class Holder { private readonly WebApplication _app; public void Run() { _app.MapGet("/field", () => 1); } }',
    };
    const { routes, limits } = read(files);
    expect(routes).toEqual([]);
    expect(limits).toEqual([
      "routes api: Program.cs:3 MapGet is called on a, which atlas does not read; what it maps is not read",
      "routes api: Holder.cs:1 declares Holder.Run, which maps routes on a builder no call atlas reads passes it; they are not read",
    ]);
  });

  it("reads a type through its alias, and leaves out code in #if false", () => {
    const files = {
      "Program.cs": [
        "using WA = Microsoft.AspNetCore.Builder.WebApplication;",
        "var app = WA.CreateBuilder(args).Build();",
        "#if false",
        'app.MapGet("/disabled", () => 1);',
        "#if DEBUG",
        'app.MapGet("/nested", () => 1);',
        "#endif",
        "#else",
        'app.MapGet("/enabled", () => 1);',
        "#endif",
        "#if DEBUG",
        'app.MapGet("/debug", () => 1);',
        "#endif",
      ].join("\n"),
    };
    expect(read(files)).toMatchObject({ routes: ["GET /enabled", "GET /debug"], limits: [] });
  });

  it("names the routes a method maps on a builder a call passes it that atlas does not read", () => {
    const files = {
      ...program(["Todos.Map(app);", "Todos.Map(Lookup());", "Unknown().MapTodos();"].join("\n")),
      "Todos.cs": 'public static class Todos { public static void Map(IEndpointRouteBuilder b) { b.MapGet("/todos", () => 1); } public static void MapTodos(this RouteGroupBuilder g) { g.MapGet("/g", () => 1); } }',
    };
    const { routes, limits } = read(files);
    expect(routes).toEqual(["GET /todos"]);
    expect(limits).toEqual([
      "routes api: Todos.cs:1 MapGet is called on a builder atlas does not read (Lookup is not a method atlas reads); what it maps is not read",
      "routes api: Program.cs:5 calls MapTodos on a builder atlas does not read (Unknown is not a method atlas reads); the routes it maps there are not read",
      "routes api: Todos.cs:1 declares Todos.MapTodos, which maps routes on a builder no call atlas reads passes it; they are not read",
    ]);
  });

  it("reads a route's WithOrder, and no value a compound assignment changes", () => {
    const files = program(
      [
        'var prefix = "/api";',
        'prefix += "/v1";',
        'app.MapGroup(prefix).MapGet("/x", () => 1);',
        'app.MapGet("/first", () => 1).WithName("first").WithOrder(-1);',
        'app.MapGet("/later", () => 1).WithOrder(Orders.Late);',
        'app.MapGroup("/g").WithOrder(2).MapGet("/y", () => 1);',
      ].join("\n"),
    );
    const { surfaces, limits } = read(files);
    expect(surfaces.map((s) => `${s.method} ${s.path} ${JSON.stringify(s.dispatch)}`)).toEqual([
      'GET /first {"picks":"precedence","rank":[-1,1],"slashes":"ignored","caseless":true}',
      'GET /later {"slashes":"ignored","caseless":true}',
    ]);
    expect(limits).toEqual([
      "routes api: Program.cs:5 MapGet is called on a builder atlas does not read (MapGroup at Program.cs:5 is given a prefix atlas does not read); what it maps is not read",
      "routes api: Program.cs:7 MapGet's route is given an Order atlas does not read; which route a request reaches there is not read",
      "routes api: Program.cs:8 MapGet is called on a builder atlas does not read (WithOrder at Program.cs:8 sets the Order of a group's routes, which is not read); what it maps is not read",
    ]);
  });

  it("does not run away on methods and constants that refer to themselves", () => {
    const files = {
      ...program("Loop.A(app);"),
      "Loop.cs": [
        "public static class Loop {",
        '  public const string X = Y + "/x"; public const string Y = X;',
        "  public static void A(WebApplication app) { B(app); app.MapGet(X, () => 1); }",
        "  public static void B(WebApplication app) { A(app); }",
        "}",
      ].join("\n"),
    };
    const { routes, limits } = read(files);
    expect(routes).toEqual([]);
    expect(limits).toEqual(["routes api: Loop.cs:3 MapGet is given a path atlas does not read; the route is not read"]);
  });

  it("reads what the framework serves by itself as implicit routes", () => {
    const files = {
      ...program(['app.MapStaticAssets();', "app.UseStaticFiles();", "app.MapOpenApi();", 'app.MapHealthChecks("/healthz");', 'app.MapFallbackToFile("index.html");'].join("\n")),
      "wwwroot/css/site.css": "",
      "wwwroot/index.html": "",
      "Other/wwwroot/no.css": "",
    };
    const { surfaces, limits } = read(files);
    expect(surfaces.map((s) => `${s.method} ${s.path} ${s.implicit ? s.convention : "code"}`)).toEqual([
      "GET /openapi/{documentName}.json aspnetcore MapOpenApi",
      "* /healthz aspnetcore MapHealthChecks",
      "* /{*path} code",
      "GET /css/site.css aspnetcore MapStaticAssets",
      "HEAD /css/site.css aspnetcore MapStaticAssets",
      "GET /index.html aspnetcore MapStaticAssets",
      "HEAD /index.html aspnetcore MapStaticAssets",
    ]);
    expect(limits).toEqual([expect.stringMatching(/^routes api: Program\.cs:3 calls MapStaticAssets, which also serves each file under the fingerprinted name/)]);
    // UseStaticFiles' files are served by middleware, not endpoint routing: they keep no dispatch of their own.
    const middleware = read({ ...program("app.UseStaticFiles();"), "wwwroot/a.js": "" }).surfaces;
    expect(middleware.map((s) => [s.method, s.path, s.convention, s.dispatch])).toEqual([
      ["GET", "/a.js", "aspnetcore UseStaticFiles", undefined],
      ["HEAD", "/a.js", "aspnetcore UseStaticFiles", undefined],
    ]);
  });

  it("puts the configured prefix before each route, and keeps route registrations out of the requests", () => {
    expect(read(program('app.MapGet("/x", () => 1);'), { prefix: "/svc" }).routes).toEqual(["GET /svc/x"]);
    const spans = new Spans();
    const text = 'var app = WebApplication.Create();\napp.MapGet("/registered", () => 1);';
    aspnetcoreRoutes(memory({ "Program.cs": text }), { component: "api", files: ["Program.cs"], styles: ["aspnetcore"] }, ["Program.cs"], [], [], spans);
    expect(spans.holds("Program.cs", text.indexOf('"/registered"'))).toBe(true);
  });
});

describe("controllers", () => {
  const mapped = (body: string) => ({ ...program("app.MapControllers();\n" + body) });

  it("joins controller and action routes, replaces tokens and takes overriding templates", () => {
    const files = {
      ...mapped(""),
      "Controllers/Items.cs": [
        "using Microsoft.AspNetCore.Mvc;",
        "using Get = Microsoft.AspNetCore.Mvc.HttpGetAttribute;",
        '[Route("api/[controller]")]',
        "public class ItemsController : ControllerBase {",
        "  [Get] public IActionResult List() => Ok();",
        '  [HttpGet("{id:int}", Order = -1)] public IActionResult One(int id) => Ok();',
        '  [HttpPost("[action]/[[x]]")] public Task<IActionResult> ImportAsync() => null;',
        '  [HttpDelete("~/items/{id}")] public IActionResult Remove(int id) => Ok();',
        '  [AcceptVerbs("GET", "head", Route = "/legacy")] public IActionResult Legacy() => Ok();',
        '  [ActionName("Renamed")] [HttpPut("[action]")] public IActionResult Put() => Ok();',
        "  [NonAction] public void Helper() {}",
        "  public static void Static() {}",
        "  // [HttpGet(\"commented\")]",
        "  public IActionResult NoAttribute() => Ok();",
        "}",
      ].join("\n"),
    };
    const { surfaces, limits } = read(files);
    expect(surfaces.map((s) => `${s.method} ${s.path} ${JSON.stringify(s.dispatch?.rank)}`)).toEqual([
      "GET /api/Items [0,1,1]",
      "GET /api/Items/{id} [-1,1,1,2]",
      "POST /api/Items/Import/[x] [0,1,1,1,1]",
      "DELETE /items/{id} [0,1,3]",
      "GET /legacy [0,1]",
      "HEAD /legacy [0,1]",
      "PUT /api/Items/Renamed [0,1,1,1]",
      "* /api/Items [0,1,1]",
    ]);
    expect(limits).toEqual([]);
  });

  it("crosses several controller routes with several action routes, and reads areas", () => {
    const files = {
      ...mapped(""),
      "Shop.cs": '[Route("Store")] [Route("[controller]")] public class ShopController : Controller { [HttpPost("Buy")] [HttpPost("Checkout")] public IActionResult Buy() => null; [HttpGet] [HttpPost("Both")] public IActionResult Two() => null; }',
      "Admin.cs": '[Area("Admin")] [Route("[area]/[controller]/[action]")] public class ReportsController : ControllerBase { public IActionResult Daily() => null; public void Dispose() {} }',
    };
    const crossed = read(files);
    expect(crossed.limits).toEqual([]);
    expect(crossed.routes).toEqual([
      "POST /Store/Buy",
      "POST /Shop/Buy",
      "POST /Store/Checkout",
      "POST /Shop/Checkout",
      "POST /Store/Both",
      "POST /Shop/Both",
      "GET /Store",
      "GET /Shop",
      "* /Admin/Reports/Daily",
      "* /Admin/Reports/Dispose",
    ]);
  });

  it("reads conventional routes for the controllers without attribute routes, in their order", () => {
    const files = {
      ...program(['app.MapControllerRoute(name: "default", pattern: "{controller=Home}/{action=Index}/{id?}");', 'app.MapAreaControllerRoute("admin", "Admin", "admin/{controller}/{action=Index}");', 'app.MapControllerRoute("blog", "blog/{action}", defaults: new { controller = "Blog" });'].join("\n")),
      "Home.cs": "public class HomeController : Controller { public IActionResult Index() => View(); [HttpPost] public IActionResult Contact() => View(); }",
      "Blog.cs": "public class BlogController : Controller { public IActionResult Latest() => View(); }",
      "Users.cs": '[Area("Admin")] public class UsersController : Controller { public IActionResult Index() => View(); }',
    };
    const { surfaces, limits } = read(files);
    expect(limits).toEqual([]);
    expect(surfaces.map((s) => `${s.method} ${s.path} ${JSON.stringify(s.dispatch?.rank)}`)).toEqual([
      "* / [1,1,1,3]",
      "* /Home [1,1,1,3]",
      "* /Home/Index [1,1,1,3]",
      "* /Home/Index/{id} [1,1,1,3]",
      "POST /Home/Contact [1,1,1,3]",
      "POST /Home/Contact/{id} [1,1,1,3]",
      "* /Blog/Latest [1,1,1,3]",
      "* /Blog/Latest/{id} [1,1,1,3]",
      "* /blog/Latest [3,1,1]",
      "* /admin/Users [2,1,1,1]",
      "* /admin/Users/Index [2,1,1,1]",
    ]);
  });

  it("reads no controller that uses an attribute the files declare under MVC's name or derive from MVC's", () => {
    const files = {
      ...program("app.MapControllers();"),
      "Attrs.cs": "public class RouteAttribute : System.Attribute { public RouteAttribute(string t) {} } public class GetV2Attribute : HttpGetAttribute { }",
      "A.cs": '[Route("a")] public class AController : ControllerBase { public void Get() {} }',
      "B.cs": '[ApiController] public class BController : ControllerBase { [GetV2("b")] public void Get() {} }',
    };
    expect(read(files)).toEqual({
      routes: [],
      surfaces: [],
      limits: [
        "routes api: A.cs:1 declares AController, which uses [Route], an attribute the files declare themselves; its routes are not read",
        "routes api: B.cs:1 declares BController, which uses [GetV2], an attribute the files declare themselves; its routes are not read",
      ],
    });
  });

  it("reads no controller whose base, attributes or mapping it cannot read, and says so", () => {
    const files = {
      ...program("app.MapControllers();"),
      "A.cs": '[Route("a")] public class AController : LibraryController { [HttpGet] public void Get() {} }',
      "B.cs": "[Route(Routes.Missing)] public class BController : ControllerBase { [HttpGet] public void Get() {} }",
      "C.cs": '[Route("c")] public abstract class CBase : ControllerBase { [HttpGet("x")] public void X() {} } public class CController : CBase { [HttpGet("y")] public void Y() {} }',
      "D.cs": '[Route("d")] public class DController : ControllerBase { [HttpGet("{x}/[unknown]")] public void Get() {} }',
    };
    const { routes, limits } = read(files);
    expect(routes).toEqual(["GET /c/y", "GET /c/x"]);
    expect(limits).toEqual([
      "routes api: A.cs:1 declares AController, which derives from LibraryController, a class not among the files read: the routes, area and actions it may give are not read",
      "routes api: B.cs:1 declares BController, whose [Route] at B.cs:1 gives a template atlas does not read; its routes are not read",
      'routes api: D.cs:1 gives D.Get the route "d/{x}/[unknown]", which has a token [unknown] with no value; it is not read',
    ]);
    const unmapped = read({ ...program(""), "E.cs": '[Route("e")] public class EController : ControllerBase { [HttpGet] public void Get() {} }' });
    expect(unmapped.routes).toEqual([]);
    expect(unmapped.limits).toEqual(["routes api: no MapControllers or MapControllerRoute call atlas reads maps the controllers (EController); their routes are not read"]);
  });
});

describe("matching as ASP.NET Core's endpoint routing picks", () => {
  const files = {
    ...program(
      [
        'app.MapGet("/", () => 1);',
        'app.MapGet("/todos/{id:int}", (int id) => id);',
        'app.MapGet("/todos/{text}", (string text) => text);',
        'app.MapGet("/years/{y:min(2000)}", (int y) => y);',
        'app.MapGet("/years/{name}", (string name) => name);',
        'app.MapGet("/api/Products", () => 1);',
        'app.Map("/api/Products", () => 1);',
        'app.MapGet("/files/{name}.{ext?}", (string name) => name);',
        'app.MapControllerRoute("default", "{controller=Home}/{action=Index}");',
      ].join("\n"),
    ),
    "Home.cs": "public class HomeController : Controller { public IActionResult Index() => View(); }",
  };
  const { surfaces } = read(files);

  it("takes a literal before a constrained parameter before a parameter, a lower Order first, a named method before any", () => {
    expect(
      reach(surfaces, ["GET /todos/1", "GET /todos/abc", "GET /todos/", "HEAD /", "GET /", "GET /api/Products", "POST /api/Products", "GET /files/a.b", "GET /files/a", "GET /Home/"]),
    ).toEqual({
      "GET /todos/1": ["GET /todos/{id}"],
      "GET /todos/abc": ["GET /todos/{text}"],
      "GET /todos/": [],
      "HEAD /": ["* /"],
      "GET /": ["GET /"],
      "GET /api/Products": ["GET /api/Products"],
      "POST /api/Products": ["* /api/Products"],
      "GET /files/a.b": ["GET /files/{name}.{ext}"],
      "GET /files/a": ["GET /files/{name}"],
      "GET /Home/": ["* /Home"],
    });
  });

  it("keeps every route a request may reach where a constraint is not read, or a value is not known", () => {
    expect(reach(surfaces, ["GET /years/2020", "GET /todos/{}"])).toEqual({
      "GET /years/2020": ["GET /years/{y}", "GET /years/{name}"],
      "GET /todos/{}": ["GET /todos/{id}", "GET /todos/{text}"],
    });
  });

  it("matches the literal text of a path whatever its case, and HEAD only to a route that takes it", () => {
    expect(reach(surfaces, ["GET /API/products", "HEAD /api/Products", "GET /home/index"])).toEqual({
      "GET /API/products": ["GET /api/Products"],
      "HEAD /api/Products": ["* /api/Products"],
      "GET /home/index": ["* /Home/Index"],
    });
  });

  it("is offered by inventory for C# files that map routes", () => {
    const routes = inventory(memory({ "Program.cs": '// app.MapGet("/no")\napp.MapGet("/yes", () => 1);', "C.cs": '[HttpGet("x")] void A() {}\nvar s = "[Route(\\"y\\")]";' }), []).routes;
    expect(routes.map((r) => `${r.file} ${r.style} ${r.count} ${r.example}`)).toEqual(["Program.cs aspnetcore 1 Program.cs:2", "C.cs aspnetcore 1 C.cs:1"]);
  });
});
