import { describe, expect, it } from "vitest";
import { normalizeConfig } from "../src/config.js";
import { extractCalls } from "../src/extract/calls.js";
import type { Source } from "../src/source.js";

const memory = (files: Record<string, string>): Source => ({
  ref: "WORKTREE",
  list: () => Object.keys(files),
  read: (p) => files[p],
  asOf: () => "2026-11-01T00:00:00Z",
});

/** The calls and limits atlas reads from `web/` as a call source to `api`, with what the source names besides. */
function read(files: Record<string, string>, source: Record<string, unknown> = {}): { calls: string[]; limits: string[] } {
  const config = normalizeConfig({
    components: [
      { name: "web", path: "web" },
      { name: "api", path: "api" },
    ],
    calls: [{ from: "web", to: "api", files: ["web/**"], ...source }],
  });
  const limits: string[] = [];
  const calls = extractCalls(memory(files), config, [], undefined, limits).map((c) => `${c.method} ${c.path} @${c.at.line}`);
  return { calls: calls.sort(), limits };
}

const lines = (...code: string[]) => code.join("\n");

describe("the method a client library's annotations and attributes state", () => {
  it("reads Retrofit's method annotations and @HTTP's method, and names a URL given by @Url", () => {
    const api = lines(
      "interface UserApi {",
      '  @GET("users") suspend fun users(): Page',
      '  @POST("users") suspend fun create(@Body u: User): User',
      '  @HTTP(method = "DELETE", path = "users/{id}/sessions", hasBody = true) suspend fun end(@Path("id") id: String)',
      '  @HTTP(method = "delete", path = "users/{id}") suspend fun lower(@Path("id") id: String)',
      "  @GET suspend fun page(@Url url: String): Page",
      "}",
    );
    expect(read({ "web/UserApi.kt": api }, { base: "/api/", join: "resolve" })).toEqual({
      calls: ["* /api/users/{} @5", "DELETE /api/users/{}/sessions @4", "GET /api/users @2", "POST /api/users @3"],
      limits: ["calls web->api: the requests are not read where a Retrofit method takes its URL from its @Url parameter, a value: web/UserApi.kt:6"],
    });
  });

  it("reads Refit's verb attributes", () => {
    const api = lines("public interface IUsersApi", "{", '    [Get("/users/{id}")] Task<User> Get(int id);', '    [Delete("/users/{id}")] Task Delete(int id);', "}");
    expect(read({ "web/Api.cs": api })).toEqual({ calls: ["DELETE /users/{} @4", "GET /users/{} @3"], limits: [] });
  });

  it("reads OpenFeign's request line as its method and its path, as Feign's contract splits it", () => {
    const api = lines(
      "public interface RepoApi {",
      '  @RequestLine("GET /repos/{owner}/{repo}") Repo get(@Param("owner") String o, @Param("repo") String r);',
      '  @RequestLine("POST users?sort={sort}") void add(@Param("sort") String s);',
      '  @RequestLine("PATCH") void root();',
      '  @RequestLine("GET {url}") Repo at(@Param("url") String url);',
      '  @RequestLine("FETCH /repos") void unknown();',
      '  @RequestLine(value = "DELETE /repos/{id}") void delete(@Param("id") long id);',
      "}",
    );
    expect(read({ "web/RepoApi.java": api }, { prefix: "/v1" })).toEqual({
      calls: ["DELETE /v1/repos/{} @7", "GET /v1/repos/{}/{} @2", "PATCH /v1 @4", "POST /v1/users @3"],
      limits: ["calls web->api: the requests are not read where a Feign request line's URI starts with a value: web/RepoApi.java:5"],
    });
  });
});

describe("the method a builder chain sets around the URL", () => {
  it("reads RestClient's and WebClient's method before .uri(...), across lines", () => {
    const client = lines(
      "class C {",
      "  User a() { return restClient.get()",
      '      .uri("/users/{id}", id).retrieve().body(User.class); }',
      '  void b() { webClient.method(HttpMethod.PATCH).uri(b -> b.path("/orders/{id}").build(id)).retrieve(); }',
      '  void c() { webClient.method(method).uri("/orders").retrieve(); }',
      '  void d() { other.uri("/elsewhere"); }',
      "}",
    );
    expect(read({ "web/C.java": client })).toEqual({ calls: ["* /elsewhere @6", "* /orders @5", "GET /users/{} @3", "PATCH /orders/{} @4"], limits: [] });
  });

  it("reads RestTemplate's methods and the HttpMethod its exchange takes", () => {
    const client = lines(
      'Account a = rest.getForObject("/accounts/{id}", Account.class, id);',
      'URI b = rest.postForLocation("/accounts", form);',
      'rest.exchange("/accounts/{id}/sessions", HttpMethod.DELETE, null, Void.class, id);',
      'rest.exchange("/accounts/{id}/roles", method, null, Map.class, id);',
      'rest.getForObject(UriComponentsBuilder.fromUriString(base).path("/invoices").toUriString(), Map.class);',
    );
    expect(read({ "web/A.java": client })).toEqual({
      calls: ["* /accounts/{}/roles @4", "DELETE /accounts/{}/sessions @3", "GET /accounts/{} @1", "GET /invoices @5", "POST /accounts @2"],
      limits: [],
    });
  });

  it("reads OkHttp's method from a Request.Builder chain up to build(), GET where it sets none", () => {
    const code = lines(
      'val a = Request.Builder().url("/users").build()',
      'val b = Request.Builder()\n  .url("/users")\n  .header("X", "y")\n  .post(body)\n  .build()',
      'val c = Request.Builder().url("/users/1").method("PATCH", body).build()',
      'val d = Request.Builder().url("/users/2").method(verb, body).build()',
      'val e = Request.Builder().url("/users/3").apply { post(body) }.build()',
      'val f = Request.Builder().url("/users/4")',
      'val g = other.url("/users/5")',
    );
    expect(read({ "web/A.kt": code })).toEqual({
      calls: ["* /users/2 @8", "* /users/3 @9", "* /users/4 @10", "* /users/5 @11", "GET /users @1", "PATCH /users/1 @7", "POST /users @3"],
      limits: [],
    });
  });

  it("reads a resty verb on the line after its chain's dot, as gofmt lays it out, and Execute's method", () => {
    const code = lines(
      "package api",
      'import r "github.com/go-resty/resty/v2"',
      "func a(c *r.Client) {",
      "\tc.R().",
      "\t\tSetResult(x).",
      '\t\tGet("/users")',
      '\tc.R().Execute(r.MethodPost, "/users/{id}/roles")',
      '\tc.R().Execute(method, "/sessions")',
      '\tc.R().Execute(resty.MethodPut, "/teams")',
      "}",
    );
    expect(read({ "web/a.go": code })).toEqual({ calls: ["* /sessions @8", "* /teams @9", "GET /users @6", "POST /users/{}/roles @7"], limits: [] });
  });

  it("reads the method a Ktor request's block sets, GET where it sets none, and submitForm's", () => {
    const code = lines(
      "import io.ktor.client.request.request",
      "import io.ktor.client.request.forms.submitForm",
      'suspend fun a() = client.request("/users/1") {\n  method = HttpMethod.Patch\n  setBody(x)\n}',
      'suspend fun b() = client.request("/users/2") { setBody(x) }',
      'suspend fun c() = client.request("/users/3") {\n  if (p) { method = HttpMethod.Put }\n}',
      'suspend fun d() = client.request("/users/4") { header("X", "method = HttpMethod.Post") }',
      'suspend fun e() = client.submitForm(url = "/auth/token", formParameters = p)',
      'suspend fun f() = client.submitForm("/search", p, encodeInQuery = true)',
      'suspend fun g() = client.submitForm("/forms", p, encodeInQuery = q)',
      'suspend fun h() = client.request("/query") { method = HttpMethod.Query }',
    );
    expect(read({ "web/A.kt": code })).toEqual({
      calls: ["* /forms @14", "* /users/3 @8", "GET /search @13", "GET /users/2 @7", "GET /users/4 @11", "PATCH /users/1 @3", "POST /auth/token @12", "QUERY /query @15"],
      limits: [],
    });
    // Without Ktor's request imported, `request` may be anyone's.
    expect(read({ "web/B.kt": 'suspend fun a() = client.request("/users") {\n  method = HttpMethod.Patch\n}' })).toEqual({ calls: ["* /users @1"], limits: [] });
  });
});

describe("the method given as a value before or around the URL", () => {
  it("reads the method Python's request(method, url) takes, and Requests' and HTTPX's Request", () => {
    const code = lines(
      "import requests as rq",
      "from httpx import Request as R",
      'rq.request("patch", f"{API}/users/{uid}")',
      'client.build_request("PUT", url=f"{API}/items/{iid}")',
      'client.request(method, f"{API}/orders")',
      'rq.Request("POST", f"{API}/imports")',
      'R(method="DELETE", url=f"{API}/sessions")',
      'urllib.request.Request(f"{API}/legacy", method="POST")',
      'session.get(url("/helped"))',
      'client.post("/a", json=build("/b"))',
    );
    expect(read({ "web/a.py": code })).toEqual({
      calls: ["* /b @10", "* /legacy @8", "* /orders @5", "DELETE /sessions @7", "GET /helped @9", "POST /a @10", "POST /imports @6", "PATCH /users/{} @3", "PUT /items/{} @4"].sort(),
      limits: [],
    });
  });

  it("reads net/http's request methods and constants by the name the file imports it under", () => {
    const code = lines(
      "package users",
      'import (\n\tnethttp "net/http"\n\t"fmt"\n)',
      "func a() {",
      '\tnethttp.Head(base + "/health")',
      '\tnethttp.PostForm(base+"/sessions", values)',
      '\tnethttp.Get(fmt.Sprintf("%s/v2/reports/%d", base, year))',
      '\tnethttp.NewRequestWithContext(ctx, nethttp.MethodPatch, fmt.Sprintf("%s/users/%s", base, id), nil)',
      '\tnethttp.NewRequest("DELETE", base+"/users", nil)',
      '\tnethttp.NewRequest(method, base+"/teams", nil)',
      '\tnethttp.NewRequest(http.MethodPut, base+"/groups", nil)',
      '\tnethttp.NewRequest("delete", base+"/roles", nil)',
      "}",
    );
    expect(read({ "web/a.go": code })).toEqual({
      calls: ["* /groups @13", "* /roles @14", "* /teams @12", "DELETE /users @11", "GET /v2/reports/{} @9", "HEAD /health @7", "PATCH /users/{} @10", "POST /sessions @8"],
      limits: [],
    });
  });

  it("reads package:http's Request and read, and dio's query and the method in request's Options", () => {
    const http = lines(
      "import 'package:http/http.dart' as http;",
      "final a = http.Request('PATCH', Uri.parse('$base/users/$id'));",
      "final b = await http.read(Uri.parse('$base/avatar'));",
      "final c = await http.get(Uri.parse('$base/users'));",
      "final d = await file.read('/etc/hosts');",
    );
    expect(read({ "web/a.dart": http })).toEqual({ calls: ["* /etc/hosts @5", "GET /avatar @3", "GET /users @4", "PATCH /users/{} @2"], limits: [] });
    const dio = lines(
      "import 'package:dio/dio.dart' as d;",
      "await dio.request('/users/$id', options: d.Options(method: 'patch'));",
      "await dio.request('/orders', options: d.Options(method: verb));",
      "await dio.request('/teams');",
      "await dio.query('/products/search', data: {'q': term});",
      "await dio.request('/groups', options: Options(method: 'PUT'));",
    );
    expect(read({ "web/b.dart": dio })).toEqual({ calls: ["* /groups @6", "* /orders @3", "* /teams @4", "PATCH /users/{} @2", "QUERY /products/search @5"], limits: [] });
  });

  it("reads a URLRequest's httpMethod, URLSession's GET of a URL and Alamofire's method", () => {
    const code = lines(
      "func a() async throws {",
      '  var request = URLRequest(url: URL(string: "/users")!)',
      '  request.httpMethod = "PATCH"',
      '  let fixed = URLRequest(url: URL(string: "/fixed")!)',
      '  _ = try await session.data(for: URLRequest(url: URL(string: "/direct")!))',
      '  var twice = URLRequest(url: URL(string: "/twice")!)',
      '  twice.httpMethod = "PUT"',
      '  twice.httpMethod = "POST"',
      '  var nested = URLRequest(url: URL(string: "/nested")!)',
      '  if flag { nested.httpMethod = "DELETE" }',
      '  var passed = URLRequest(url: URL(string: "/passed")!)',
      "  sign(&passed)",
      '  var plain = URLRequest(url: URL(string: "/plain")!)',
      '  _ = AF.request("/af", method: .patch)',
      '  _ = AF.request("/af/default")',
      '  _ = AF.request("/af/value", method: verb)',
      '  _ = try await URLSession.shared.data(from: URL(string: "/loaded")!)',
      "}",
    );
    expect(read({ "web/A.swift": code })).toEqual({
      calls: ["* /af/value @16", "* /nested @9", "* /passed @11", "* /twice @6", "GET /af/default @15", "GET /direct @5", "GET /fixed @4", "GET /loaded @17", "GET /plain @13", "PATCH /af @14", "PATCH /users @2"],
      limits: [],
    });
  });

  it("reads the method of a Request handed to fetch, unless fetch's own init sets one", () => {
    const code = lines(
      'const upload = new Request("/api/uploads", { method: "POST", body: file });',
      "fetch(upload);",
      'const plain = new Request("/api/plain");',
      "fetch(plain);",
      'const replaced = new Request("/api/replaced", { method: "POST" });',
      'fetch(replaced, { method: "PUT" });',
      'const spread = new Request("/api/spread", { ...init });',
      "fetch(spread);",
      'fetch(new Request("/api/inline", { ["method"]: "DELETE" }));',
    );
    expect(read({ "web/a.ts": code })).toEqual({
      calls: ["* /api/spread @7", "DELETE /api/inline @9", "GET /api/plain @3", "POST /api/uploads @1", "PUT /api/replaced @5"],
      limits: [],
    });
  });
});

describe("the method of a client's own methods", () => {
  it("reads HttpClient's methods and HttpRequestMessage's method", () => {
    const code = lines(
      'var a = await client.GetFromJsonAsync<User[]>("/users");',
      'var b = await client.PostAsJsonAsync("/users", user);',
      'var c = await client.DeleteAsync(requestUri: "/users/1");',
      'var d = new HttpRequestMessage(new HttpMethod("PATCH"), "/users/2");',
      'var e = new HttpRequestMessage(method, "/users/3");',
      'var f = await client.GetStringAsync("/health");',
    );
    expect(read({ "web/A.cs": code })).toEqual({ calls: ["* /users/3 @5", "DELETE /users/1 @3", "GET /health @6", "GET /users @1", "PATCH /users/2 @4", "POST /users @2"], limits: [] });
  });

  it("reads Ky's query method as QUERY, on an instance and on the default export", () => {
    const code = lines(
      'import ky from "ky";',
      'const search = ky.create({ prefix: "/api" });',
      'export const q = () => search.query("items", { json: {} });',
      'export const r = () => ky.query("/api/reports", { json: {} });',
      'export const s = () => db.query("/api/other");',
    );
    expect(read({ "web/a.js": code, "web/package.json": '{"dependencies":{"ky":"^2.2.0"}}' })).toEqual({ calls: ["* /api/other @5", "QUERY /api/items @3", "QUERY /api/reports @4"], limits: [] });
  });
});

describe("what reads a method only in code", () => {
  it("takes no import, method or chain written in a comment or a string for code", () => {
    const go = lines("package api", '/* import r "github.com/go-resty/resty/v2" */', 'var s = `import r "github.com/go-resty/resty/v2"`', 'func a() { c.R().Execute(r.MethodPost, "/x") }');
    const python = lines('"""', "import requests as rq", '"""', 'rq.Request("POST", f"{API}/x")');
    const dart = lines("// import 'package:dio/dio.dart';", "await dio.request('/x', options: Options(method: 'PUT'));");
    const kotlin = lines("// import io.ktor.client.request.request", 'val s = """\nimport io.ktor.client.request.request\n"""', 'suspend fun a() = client.request("/x") {\n  method = HttpMethod.Post\n}');
    const java = lines('String a = rest.getForObject("/a" /* .post() */, A.class);', 'log.info("rest.exchange(\\"/b\\", HttpMethod.DELETE)");');
    expect([read({ "web/a.go": go }), read({ "web/a.py": python }), read({ "web/a.dart": dart }), read({ "web/A.kt": kotlin }), read({ "web/A.java": java })]).toEqual([
      { calls: ["* /x @4"], limits: [] },
      { calls: ["* /x @4"], limits: [] },
      { calls: ["* /x @2"], limits: [] },
      { calls: ["* /x @5"], limits: [] },
      { calls: ["GET /a @1"], limits: [] },
    ]);
  });
});
