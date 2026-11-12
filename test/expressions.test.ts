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
  const calls = extractCalls(memory(files), config, [], undefined, limits).map((c) => `${c.method} ${c.path}${c.based ? " based" : ""} @${c.at.line}`);
  return { calls: calls.sort(), limits };
}

const lines = (...code: string[]) => code.join("\n");
const untyped = (why: string, ...at: string[]) => `calls web->api: the requests are not read where ${why}: ${at.join(", ")}`;

describe("a URL concatenated from literals and values", () => {
  it("reads the operands of a + as one URL, each value a hole, in each language", () => {
    const java = lines("class C {", '  String a(String id) { return client.get().uri("/users/" + id + "/posts").retrieve().body(String.class); }', "}");
    expect(read({ "web/C.java": java })).toEqual({ calls: ["GET /users/{}/posts @2"], limits: [] });
    expect(read({ "web/a.go": 'package a\nfunc a() { http.Get(base + "/users/" + id) }' })).toEqual({ calls: ["GET /users/{} based @2"], limits: [] });
    expect(read({ "web/a.py": 'requests.get(API_URL + "/users/" + user_id + "/avatar")' })).toEqual({ calls: ["GET /users/{}/avatar based @1"], limits: [] });
    expect(read({ "web/a.dart": "final r = await dio.get('/orders/' + id + '/items');" })).toEqual({ calls: ["GET /orders/{}/items @1"], limits: [] });
  });

  it("reads a concatenation without a leading / where a configured client takes it", () => {
    const cs = 'public Task<Item[]?> Items(string id) => httpClient.GetFromJsonAsync<Item[]>("orders/" + id + "/items");';
    expect(read({ "web/A.cs": cs }, { base: "/api/", join: "resolve", receivers: ["httpClient"] })).toEqual({ calls: ["GET /api/orders/{}/items @1"], limits: [] });
    expect(read({ "web/A.kt": 'suspend fun d(id: String) = client.delete("users/" + id)' }, { base: "/api/v1/", join: "resolve", receivers: ["client"] })).toEqual({ calls: ["DELETE /api/v1/users/{} @1"], limits: [] });
  });

  it("reads a concatenation across lines, and leaves one with another operator to its literals", () => {
    const java = lines("class C {", "  void a() {", '    rest.exchange("/invoices/"', '        + number + "/lines", HttpMethod.DELETE, null, Void.class);', "  }", "}");
    expect(read({ "web/C.java": java })).toEqual({ calls: ["DELETE /invoices/{}/lines @3"], limits: [] });
    // A conditional is no concatenation atlas reads: each literal is read as before.
    const kotlin = 'fun a() = client.get(if (x) "/a" else "/b" + id)';
    expect(read({ "web/A.kt": kotlin })).toEqual({ calls: ["GET /a @1", "GET /b @1"], limits: [] });
  });

  it("takes no + in a comment or a string for a concatenation", () => {
    const kotlin = lines('fun a(id: String) = client.get("/users/" /* + id */)', 'fun b() = client.get("/a + /b")');
    expect(read({ "web/A.kt": kotlin })).toEqual({ calls: ["GET /users @1"], limits: [] });
  });
});

describe("a URL with values interpolated", () => {
  it("reads Swift's \\(...) and C#'s {...} as values", () => {
    const swift = 'let (data, _) = try await session.data(from: URL(string: "\\(base)/orders/\\(order.id)")!)';
    expect(read({ "web/A.swift": swift })).toEqual({ calls: ["GET /orders/{} based @1"], limits: [] });
    const cs = 'var r = await client.DeleteAsync($"/users/{user.Id.ToString()}/keys/{{x}}");';
    expect(read({ "web/A.cs": cs })).toEqual({ calls: ["DELETE /users/{}/keys/{x} @1"], limits: [] });
  });
});

describe("a URL formatted", () => {
  it("reads Go's fmt.Sprintf, by the name the file imports fmt under", () => {
    const go = lines("package a", 'import f "fmt"', 'func a() { http.Get(f.Sprintf("/users/%v/files/%d?q=%s%%", id, n, q)) }');
    expect(read({ "web/a.go": go })).toEqual({ calls: ["GET /users/{}/files/{} @3"], limits: [] });
  });

  it("leaves unread a format whose verb writes more than its value, and says so where it is a URL", () => {
    const go = lines("package a", 'import "fmt"', 'func a() { http.Get(fmt.Sprintf("/users/%5d", id)); log(fmt.Sprintf("%5d users", n)) }');
    expect(read({ "web/a.go": go })).toEqual({ calls: [], limits: [untyped("a format verb (%5d) writes more than its value", "web/a.go:3")] });
  });

  it("reads Java's String.format and Kotlin's format, by position or by index", () => {
    const java = 'class C { Object a() { return rest.getForObject(String.format("/users/%s/posts/%1$s", id), Map.class); } }';
    expect(read({ "web/C.java": java })).toEqual({ calls: ["GET /users/{}/posts/{} @1"], limits: [] });
    expect(read({ "web/A.kt": 'fun a() = client.get("/users/%s".format(id))' })).toEqual({ calls: ["GET /users/{} @1"], limits: [] });
  });

  it("reads C#'s string.Format, and leaves an aligned item unread", () => {
    const cs = lines('var a = await client.GetAsync(string.Format("/users/{0}/{{x}}", id));', 'var b = await client.GetAsync(string.Format("/users/{0,8}", id));');
    expect(read({ "web/A.cs": cs })).toEqual({ calls: ["GET /users/{}/{x} @1"], limits: [untyped("a format item pads its value", "web/A.cs:2")] });
  });

  it("reads Python's str.format and % formatting", () => {
    const python = lines(
      'requests.get("{}/reports/{}".format(API_URL, year))',
      'requests.get("/users/{id}/keys/{0}".format(key, id=uid))',
      'requests.get("/users/%s/keys/%d" % (uid, key))',
      'requests.get("/users/%s" % uid)',
      'requests.get("/a/{}/{0}".format(x, y))',
    );
    expect(read({ "web/a.py": python })).toEqual({
      calls: ["GET /reports/{} based @1", "GET /users/{} @4", "GET /users/{}/keys/{} @2", "GET /users/{}/keys/{} @3"],
      limits: [untyped("str.format numbers its fields both ways", "web/a.py:5")],
    });
  });
});

describe("a URL joined or built", () => {
  it("reads Go's url.JoinPath, path.Join, url.Parse and String(), by the names the file imports them under", () => {
    const go = lines(
      "package a",
      'import (\n\tu "net/url"\n\t"path"\n)',
      'func a() { e, _ := u.JoinPath(base, "users", id); http.Get(e) }',
      'func b() { http.Get(path.Join("/orders", id, "items")) }',
      'func c() { e, _ := u.JoinPath(base, "../users"); http.Get(e) }',
      'func d() { e, _ := url.JoinPath(base, "other"); http.Get(e) }',
    );
    expect(read({ "web/a.go": go })).toEqual({
      calls: ["GET /orders/{}/items @7", "GET /users/{} based @6"],
      limits: [untyped("url.JoinPath or path.Join cleans a . or .. segment", "web/a.go:8")],
    });
  });

  it("reads OkHttp's HttpUrl.Builder, a / in addPathSegment encoded, and leaves other path calls unread", () => {
    const kotlin = lines(
      "import okhttp3.HttpUrl",
      'val a = base.newBuilder().addPathSegment("users").addPathSegment(id).addQueryParameter("next", "/home").build()',
      'val b = HttpUrl.Builder().scheme("https").host("localhost").addPathSegments("api/orders").addPathSegment("a/b").build()',
      'val c = base.newBuilder().setPathSegment(0, "users").build()',
      'val d = base.newBuilder().addPathSegment("users")',
    );
    expect(read({ "web/A.kt": kotlin })).toEqual({
      calls: ["* /api/orders/a%2Fb based @3", "* /users/{} based @2"],
      limits: [untyped("an OkHttp HttpUrl.Builder calls setPathSegment", "web/A.kt:4")],
    });
    // Without OkHttp imported, the calls are no HttpUrl.Builder's: each literal is read as before.
    expect(read({ "web/A.kt": kotlin.replace("import okhttp3.HttpUrl", "") })).toEqual({ calls: ["* /home @2"], limits: [] });
  });

  it("reads Spring's UriComponentsBuilder: path as written, // as /, pathSegment after a /", () => {
    const java = lines(
      "import org.springframework.web.util.UriComponentsBuilder;",
      "class C {",
      '  String a() { return UriComponentsBuilder.fromUriString(this.url).path("/invoices/").path("/{id}").queryParam("q", "/x").buildAndExpand(id).toUriString(); }',
      '  String b() { return UriComponentsBuilder.fromPath("/a").path("b").pathSegment("c", id).path("d").build().toUriString(); }',
      '  String c() { return UriComponentsBuilder.fromUriString(url).host("other").path("/x").toUriString(); }',
      "}",
    );
    expect(read({ "web/C.java": java })).toEqual({
      calls: ["* /ab/c/{}/d @4", "* /invoices/{} based @3"],
      limits: [untyped("a Spring UriComponentsBuilder calls host", "web/C.java:5")],
    });
  });

  it("reads Swift's appendingPathComponent and appending(path:), and encodes appending(component:)", () => {
    const swift = lines(
      'let a = URLRequest(url: base.appendingPathComponent("users").appendingPathComponent(id))',
      'let (b, _) = try await session.data(from: URL(string: root)!.appending(path: "orders/\\(id)"))',
      'let (c, _) = try await session.data(from: base.appending(component: "a/b"))',
    );
    expect(read({ "web/A.swift": swift })).toEqual({ calls: ["GET /a%2Fb based @3", "GET /orders/{} based @2", "GET /users/{} based @1"], limits: [] });
  });

  it("reads Ktor's appendPathSegments in a request's url block, relative to the client's base", () => {
    const kotlin = lines(
      "import io.ktor.http.appendPathSegments",
      "suspend fun a() = client.post {",
      "    url {",
      '        appendPathSegments("orders", id, "items")',
      '        parameters.append("q", "/x")',
      "    }",
      "}",
      'suspend fun b() = client.get("users") { url { appendPathSegments(id) } }',
      'suspend fun c() = client.get { url { appendPathSegments("a/b", encodeSlash = true) } }',
      'suspend fun d() = client.get { url("/x"); url { appendPathSegments("y") } }',
      'suspend fun e() = client.get { url { protocol = URLProtocol.HTTPS; appendPathSegments("y") } }',
    );
    expect(read({ "web/A.kt": kotlin }, { base: "/api/v1/", join: "resolve", receivers: ["client"] })).toEqual({
      calls: ["GET /api/v1/users/{} @8", "POST /api/v1/orders/{}/items @2"],
      limits: [
        untyped("a Ktor request's block encodes a / in a segment", "web/A.kt:9"),
        untyped("a Ktor request's block sets the URL otherwise", "web/A.kt:10"),
        untyped("a Ktor request's block writes the URL in its url block otherwise", "web/A.kt:11"),
      ],
    });
  });
});

describe("a URL that starts with a value", () => {
  it("reads the configured base's path for a value the call source names as holding it", () => {
    const kotlin = lines(
      'fun a() = Request.Builder().url("$base/users/$id").build()',
      'fun b() = Request.Builder().url(base + "/users/" + id).delete().build()',
      'fun c() = Request.Builder().url("$cdn/users").build()',
      'fun d() = Request.Builder().url("${this.base}/a").build()',
    );
    expect(read({ "web/A.kt": kotlin }, { prefix: "/api", baseValues: ["base"] })).toEqual({
      calls: ["DELETE /api/users/{} based @2", "GET /api/a based @4", "GET /api/users/{} based @1", "GET /users based @3"],
      limits: [],
    });
    // Without a base, the names say nothing.
    expect(() => read({ "web/A.kt": kotlin }, { baseValues: ["base"] })).toThrow(/baseValues needs base \(with join\) or prefix/);
  });

  it("takes the text of a string constant of the file, and of none that may hold another value", () => {
    const cs = lines(
      "class C {",
      '  private const string Projects = "projects";',
      '  private const string Health = "/health";',
      '  private const string Twice = "twice";',
      "  Task A() => httpClient.GetFromJsonAsync<P[]>(Projects);",
      '  Task B(string id) => httpClient.PostAsync($"{Projects}/{id}/archive", null);',
      "  Task C() => httpClient.GetStringAsync(Health);",
      '  Task D(string Twice) => httpClient.GetAsync(Twice + "/x");',
      "}",
    );
    expect(read({ "web/C.cs": cs }, { base: "/api/", join: "resolve", receivers: ["httpClient"] })).toEqual({
      calls: ["GET /api/projects @5", "GET /health @7", "GET /x based @8", "POST /api/projects/{}/archive @6"],
      limits: [],
    });
    const kotlin = lines('const val USERS = "/users"', 'fun a() = client.get("$USERS/$id")');
    expect(read({ "web/A.kt": kotlin })).toEqual({ calls: ["GET /users/{} @2"], limits: [] });
  });
});

describe("a URL held in a value", () => {
  it("reads the method of the calls that send it, or * where they differ or do something else", () => {
    const go = lines(
      "package a",
      'import "net/url"',
      'func a() { u, err := url.Parse(base + "/users/search"); q := u.Query(); u.RawQuery = q.Encode(); http.Get(u.String()) }',
      'func b() { p := "/users"; http.Get(p); http.Head(p) }',
      'func c() { p := "/orders"; http.Get(p); p = "/other" }',
      'func d() { p := "/items"; send(p) }',
      'func e() { p := "/carts"; p += "?q=" + q; http.Post(p, "", nil) }',
    );
    expect(read({ "web/a.go": go })).toEqual({
      calls: ["* /items @6", "* /orders @5", "* /other @5", "* /users @4", "GET /users/search based @3", "POST /carts @7"],
      limits: [],
    });
  });

  it("reads a Swift URLComponents' value sent by URLSession, its query set", () => {
    const swift = lines("func a() async throws {", '    var c = components(path: "/store/products")', '    c.queryItems = [URLQueryItem(name: "q", value: "x")]', "    let (data, _) = try await session.data(from: c.url!)", "}");
    expect(read({ "web/A.swift": swift })).toEqual({ calls: ["GET /store/products @2"], limits: [] });
  });

  it("reads a path relative to the base held in a value a configured client's call takes after a method", () => {
    const go = lines(
      "package a",
      'import "net/http"',
      'func (c *Client) A() { path := "invoices"; path += "?" + q.Encode(); c.newRequest(ctx, http.MethodGet, path, nil) }',
      'func (c *Client) B() { c.newRequest(ctx, http.MethodPost, "invoices", nil) }',
      'func (c *Client) C() { c.newRequest(ctx, "DELETE", "invoices/"+id, nil) }',
    );
    expect(read({ "web/a.go": go }, { base: "/api/v1/", join: "resolve", receivers: ["c"] })).toEqual({
      calls: ["DELETE /api/v1/invoices/{} @5", "GET /api/v1/invoices @3", "POST /api/v1/invoices @4"],
      limits: [],
    });
  });
});

describe("requests a library makes from declarations atlas does not read", () => {
  it("names Ktor's typed resources and Alamofire's routers in a limit, and reads no resource path as a request", () => {
    const kotlin = lines("import io.ktor.resources.Resource", '@Resource("/articles")', "class Articles", "suspend fun a() = client.get(Articles())");
    expect(read({ "web/A.kt": kotlin })).toEqual({ calls: [], limits: [untyped("Ktor's Resources plugin makes them from @Resource classes (client.get(Articles()))", "web/A.kt:2")] });
    const swift = lines("import Alamofire", "enum Router: URLRequestConvertible {", '    var path: String { "orders" }', "}");
    expect(read({ "web/A.swift": swift })).toEqual({ calls: [], limits: [untyped("an Alamofire router (URLRequestConvertible) builds them in its asURLRequest", "web/A.swift:2")] });
  });
});

describe("string literals with a prefix", () => {
  it("reads a Python f-string, a C# verbatim string and Kotlin's escaped $ as each language writes them", () => {
    expect(read({ "web/a.py": 'requests.get(f"{API}/users/" + uid)' })).toEqual({ calls: ["GET /users/{} based @1"], limits: [] });
    expect(read({ "web/A.cs": 'var a = await client.GetAsync(@"/users/" + id);' })).toEqual({ calls: ["GET /users/{} @1"], limits: [] });
    expect(read({ "web/A.kt": 'fun a() = client.get("/price/\\$x")' })).toEqual({ calls: [], limits: [] });
  });
});

describe("the review round's cases", () => {
  it("places a URL held in a value only where every call that sends it places it alike", () => {
    const cs = (a: string, b: string) => lines("class C {", `  async Task A() { string p = "users"; await ${a}.GetAsync(p); await ${b}.GetAsync(p); }`, "}");
    const source = { base: "/api/", join: "resolve", receivers: ["api"] };
    const differ = { calls: [], limits: [untyped("a URL held in a value is sent by calls that place it differently", "web/C.cs:2")] };
    expect(read({ "web/C.cs": cs("api", "other") }, source)).toEqual(differ);
    expect(read({ "web/C.cs": cs("other", "api") }, source)).toEqual(differ);
    expect(read({ "web/C.cs": cs("api", "api") }, source)).toEqual({ calls: ["GET /api/users @2"], limits: [] });
    const methods = lines("class C {", '  async Task A() { string p = "users"; await api.GetAsync(p); await api.DeleteAsync(p); }', "}");
    expect(read({ "web/C.cs": methods }, source)).toEqual({ calls: ["* /api/users @2"], limits: [] });
  });

  it("cleans // only in a path, keeping an absolute URL's scheme", () => {
    const java = lines(
      "import org.springframework.web.util.UriComponentsBuilder;",
      'class C { String a() { return UriComponentsBuilder.fromUriString("https://localhost/api/").path("/users").toUriString(); } }',
    );
    expect(read({ "web/C.java": java })).toEqual({ calls: ["* /api/users based @2"], limits: [] });
    const go = lines("package a", 'import (\n\t"net/url"\n\t"path"\n)', 'func a() { http.Get(path.Join("/api//users/", "active/")) }', 'func b() { e, _ := url.JoinPath("http://localhost//api", "users/"); http.Get(e) }');
    expect(read({ "web/a.go": go })).toEqual({ calls: ["GET /api/users based @7", "GET /api/users/active @6"], limits: [] });
  });

  it("reads JoinPath on a URL held in a value, and none on a name a package goes by", () => {
    const go = lines("package a", 'import "net/http"', 'func a() { http.Get(baseURL.JoinPath("users", id).String()) }', 'func b() { http.Get(path.JoinPath("x")) }');
    expect(read({ "web/a.go": go }, { base: "/api", join: "resolve", baseValues: ["baseURL"] })).toEqual({ calls: ["GET /api/users/{} based @3"], limits: [] });
  });

  it("reads the host, scheme and port an OkHttp builder sets last, and no host set on a URL it is made from", () => {
    const kotlin = lines(
      "import okhttp3.HttpUrl",
      'val a = HttpUrl.Builder().scheme("http").host("cdn.example").host("localhost").port(8080).addPathSegment("a").build()',
      'val b = HttpUrl.Builder().scheme("https").host("localhost").host("cdn.example").addPathSegment("b").build()',
      'val c = "http://localhost/api".toHttpUrl().newBuilder().host("cdn.example").addPathSegment("c").build()',
      'val d = HttpUrl.Builder().scheme(scheme).host("localhost").addPathSegment("d").build()',
      'val e = "http://localhost/api".toHttpUrl().newBuilder().port(9000).addPathSegment("e").build()',
      'val f = base.newBuilder().scheme("http").port(9000).addPathSegment("f").build()',
    );
    expect(read({ "web/A.kt": kotlin })).toEqual({
      calls: ["* /a based @2", "* /f based @7"],
      limits: [
        "calls web->api: URLs to cdn.example (web/A.kt:3) are not read as requests to api; set origins.api if that is its host",
        untyped("an OkHttp HttpUrl.Builder sets the host of the URL it is made from", "web/A.kt:4"),
        untyped("an OkHttp HttpUrl.Builder sets a host with a scheme atlas does not read", "web/A.kt:5"),
        untyped("an OkHttp HttpUrl.Builder sets the scheme or the port of the URL it is made from", "web/A.kt:6"),
      ],
    });
  });

  it("encodes and checks a constant's text as a segment", () => {
    const kotlin = lines("import okhttp3.HttpUrl", 'const val KEY = "a/b"', 'const val UP = ".."', "val a = base.newBuilder().addPathSegment(KEY).build()", "val b = base.newBuilder().addPathSegment(UP).build()");
    expect(read({ "web/A.kt": kotlin })).toEqual({ calls: ["* /a%2Fb based @4"], limits: [untyped('an OkHttp HttpUrl.Builder adds the segment ".."', "web/A.kt:5")] });
    const swift = lines("enum K {", '    static let key = "a/b"', "    static func c() async throws { let (c, _) = try await session.data(from: base.appending(component: key)) }", "}");
    expect(read({ "web/A.swift": swift })).toEqual({ calls: ["GET /a%2Fb based @3"], limits: [] });
  });

  it("leaves a request made inside a format's argument to be read on its own", () => {
    expect(read({ "web/a.py": 'requests.get("/users/{}".format(requests.get("/token").text))' })).toEqual({ calls: ["GET /token @1", "GET /users/{} @1"], limits: [] });
    const go = lines("package a", 'import "fmt"', 'func a() { http.Get(fmt.Sprintf("/users/%s", load("/token"))) }');
    // The URL a call nested in a request's URL builds is that request's (`http.get(Uri.parse(...))`), as before.
    expect(read({ "web/a.go": go })).toEqual({ calls: ["GET /token @3", "GET /users/{} @3"], limits: [] });
  });

  it("reads the method a Ktor request block sets", () => {
    const kotlin = (block: string) =>
      lines("import io.ktor.client.request.request", "import io.ktor.http.appendPathSegments", `suspend fun a() = client.request("users") { ${block}url { appendPathSegments("active") } }`);
    const source = { base: "/api/v1/", join: "resolve", receivers: ["client"] };
    expect(read({ "web/A.kt": kotlin("method = HttpMethod.Post; ") }, source)).toEqual({ calls: ["POST /api/v1/users/active @3"], limits: [] });
    expect(read({ "web/A.kt": kotlin("") }, source)).toEqual({ calls: ["GET /api/v1/users/active @3"], limits: [] });
    expect(read({ "web/A.kt": kotlin("if (x) method = HttpMethod.Post; ") }, source)).toEqual({ calls: ["* /api/v1/users/active @3"], limits: [] });
  });

  it("refuses Java's argument index 0, and reads a Python field whose spec holds a field as a value", () => {
    const java = 'class C { Object a() { return rest.getForObject(String.format("/users/%0$s", id), Map.class); } }';
    expect(read({ "web/C.java": java })).toEqual({ calls: [], limits: [untyped("a format names argument 0, which Java's Formatter refuses", "web/C.java:1")] });
    const python = lines('requests.get("/u/{0:{1}}/x".format(v, w))', 'requests.get("/u/{}/{:{}}".format(a, b, w))', 'requests.get("/u/{0:{}}".format(a, w))');
    expect(read({ "web/a.py": python })).toEqual({
      calls: ["GET /u/{}/x @1", "GET /u/{}/{} @2"],
      limits: [untyped("str.format numbers its fields both ways", "web/a.py:3")],
    });
  });
});

describe("what a client puts into every request", () => {
  const without = (what: string, ...at: string[]) => `calls web->api: the requests are read without ${what}: ${at.join(", ")}`;

  it("fills a resty request's template with the path parameters its client sets, where the request sets none", () => {
    const go = lines(
      "package api",
      'import "github.com/go-resty/resty/v2"',
      "type Users struct { http *resty.Client }",
      'func New() *Users { client := resty.New().\n\tSetPathParam("version", "v2").\n\tSetPathParams(map[string]string{"tenant": "acme"})\n\treturn &Users{http: client} }',
      'func (u *Users) A() { u.http.R().Get("/{version}/{tenant}/reports/{year}") }',
      'func (u *Users) B() { u.http.R().SetPathParam("version", "v3").Get("/{version}/reports") }',
      'func (u *Users) C() { other.R().Get("/{version}/items") }',
    );
    expect(read({ "web/a.go": go })).toEqual({ calls: ["GET /v2/acme/reports/{} @8", "GET /{}/items @10", "GET /{}/reports @9"], limits: [] });
  });

  it("names a resty client whose path parameters are not literals, or whose holder it does not see", () => {
    const go = lines("package api", 'import r "github.com/go-resty/resty/v2"', 'func New(v string) { c := r.New().SetPathParam("version", v); c.R().Get("/{version}/x") }', 'func Make() { use(r.New().SetPathParam("k", "v")) }');
    expect(read({ "web/a.go": go })).toEqual({
      calls: ["GET /{}/x @3"],
      limits: [without("a resty client's own path parameters (SetPathParam on the client), a hole in their place", "web/a.go:3", "web/a.go:4")],
    });
  });

  it("names a dio interceptor that writes the request's path", () => {
    const dart = lines(
      "import 'package:dio/dio.dart';",
      "class Version extends Interceptor {",
      "  @override",
      "  void onRequest(RequestOptions options, RequestInterceptorHandler handler) { options.path = '/v2${options.path}'; super.onRequest(options, handler); }",
      "}",
      "final a = dio.get('/invoices');",
    );
    expect(read({ "web/a.dart": dart })).toEqual({
      calls: ["GET /invoices @6"],
      limits: [without("the path a dio interceptor writes into each request's (options.path), which the call source's prefix can state", "web/a.dart:2")],
    });
  });
});
