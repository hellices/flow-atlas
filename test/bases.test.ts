import { describe, expect, it } from "vitest";
import { normalizeConfig } from "../src/config.js";
import { extractCalls } from "../src/extract/calls.js";
import { onBase, relativePath } from "../src/paths.js";
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

describe("a client's base", () => {
  it("joins a path to a base by resolving it as a URL reference or by appending it", () => {
    const rows: Array<[Parameters<typeof onBase>, string]> = [
      [[{ path: "/api/v1/", join: "resolve" }, "/users", true], "/api/v1/users"],
      [[{ path: "/api/v1", join: "resolve" }, "/users", true], "/api/users"],
      [[{ path: "/api/v1/", join: "resolve" }, "/health", false], "/health"],
      [[{ path: "/api/v1/", join: "resolve" }, "/../users", true], "/api/users"],
      [[{ path: "/api", join: "append" }, "/users", false], "/api/users"],
      [[{ path: "/api/", join: "append" }, "/users", true], "/api/users"],
      [[{ path: "/", join: "append" }, "/health", false], "/health"],
    ];
    expect(rows.map(([args]) => onBase(...args))).toEqual(rows.map(([, path]) => path));
    expect(["users/{}", "./users", "/users", "{}/users", "mailto:a@b.example", "", "users.json"].map((t) => relativePath(t)?.path)).toEqual(["/users/{}", "/./users", undefined, undefined, undefined, undefined, undefined]);
  });

  it("takes base and join, or prefix appended to, and names what does not fit", () => {
    const calls = (source: Record<string, unknown>) => () => normalizeConfig({ calls: [{ from: "web", to: "api", files: [], ...source }] });
    expect(calls({ base: "/api/", join: "resolve", receivers: ["client"] })().calls[0]).toMatchObject({ base: "/api/", join: "resolve" });
    expect(calls({ base: "api/", join: "resolve" })).toThrow("base is the path of the client's base URL, starting with /");
    expect(calls({ base: "/api/" })).toThrow("base needs join, how the client joins a path to it: resolve or append");
    expect(calls({ base: "/api/", join: "concat" })).toThrow("base needs join");
    expect(calls({ base: "/api/", join: "append", prefix: "/api" })).toThrow("base and prefix both give the client's base; keep one");
    expect(calls({ join: "resolve" })).toThrow("join says how a path joins base, which is not given");
    expect(calls({ receivers: "client" })).toThrow("receivers lists the names clients are called on");
    expect(calls({ receivers: ["a.b"] })).toThrow("receivers lists the names clients are called on");
  });
});

describe("the base a client library's instance states", () => {
  const http = 'import axios from "axios";\nexport const api = axios.create({ baseURL: `${config.apiUrl}/api` });\nexport const other = axios.create({ baseURL: "https://other.example/v1" });\n';

  it("reads axios's baseURL for the requests made through the instance, across imports", () => {
    const { calls, limits } = read({
      "web/http.js": http,
      "web/users.js": [
        'import { api, other } from "./http.js";',
        'api.get("/users");',
        "api.post(`users/${id}`, body);",
        'api({ url: "sessions", method: "post" });',
        'api.request({ url: "/me", baseURL: "/" });',
        'api.get("/x", { baseURL: "/v2" });',
        "api.get(`${base}/raw`);",
        'other.get("/reports");',
      ].join("\n"),
    });
    expect({ calls, limits }).toEqual({
      calls: ["* /me @5", "GET /api/users @2", "GET /v2/x @6", "POST /api/sessions @4", "POST /api/users/{} @3"],
      limits: [
        "calls web->api: URLs to other.example (web/users.js:8) are not read as requests to api; set origins.api if that is its host",
        "calls web->api: requests through a client are not read where it starts with a value, an absolute URL or a path api's base takes: web/users.js:7",
      ],
    });
  });

  it("puts before each URL the text an axios request interceptor writes before it, and reads none through one it does not read", () => {
    const interceptor = (body: string) => `import axios from "axios";\nexport const api = axios.create({ baseURL: "/billing" });\napi.interceptors.request.use(${body});\napi.get("/invoices");`;
    const rows: Array<[string, string[], string[]]> = [
      ["(c) => { c.url = `/v2${c.url}`; return c; }", ["GET /billing/v2/invoices @4"], []],
      ['(c) => { c.url = "/v2" + c.url; return c; }', ["GET /billing/v2/invoices @4"], []],
      ["(c) => { c.headers.Authorization = token; if (c.url.startsWith('/a')) c.params = {}; return c; }", ["GET /billing/invoices @4"], []],
      ["(c) => { if (x) c.url = `/v2${c.url}`; return c; }", [], ["calls web->api: requests through a client are not read where a request interceptor of api may change its URLs: web/a.js:4"]],
      ["(c) => ({ ...c, url: `/v2${c.url}` })", [], ["calls web->api: requests through a client are not read where a request interceptor of api may change its URLs: web/a.js:4"]],
      // The base it sets is read as any string is.
      ["(c) => { c.baseURL = '/other'; return c; }", ["* /other @3"], ["calls web->api: requests through a client are not read where a request interceptor of api may change its URLs: web/a.js:4"]],
      ["(c) => { sign(c); return c; }", [], ["calls web->api: requests through a client are not read where a request interceptor of api may change its URLs: web/a.js:4"]],
      ["auth", [], ["calls web->api: requests through a client are not read where a request interceptor of api may change its URLs: web/a.js:4"]],
    ];
    expect(rows.map(([body]) => read({ "web/a.js": interceptor(body) }))).toEqual(rows.map(([, calls, limits]) => ({ calls, limits })));
    const defaults = read({ "web/a.js": 'import axios from "axios";\nconst api = axios.create({ baseURL: "/api" });\napi.defaults.baseURL = next;\napi.get("/users");' });
    expect(defaults).toEqual({ calls: [], limits: ["calls web->api: requests through a client are not read where api's defaults are changed in the code: web/a.js:4"] });
    const headers = read({ "web/a.js": 'import axios from "axios";\nconst api = axios.create({ baseURL: "/api" });\napi.defaults.headers.common.Authorization = token;\napi.get("/users");' });
    expect(headers).toEqual({ calls: ["GET /api/users @4"], limits: [] });
  });

  it("leaves a base it does not read to the configured one, and reads no path that joins it without", () => {
    const code = 'import axios from "axios";\nconst api = axios.create({ baseURL: env.API });\napi.get("/users");\napi.get("orders");\napi.get("https://x.example/a");';
    expect(read({ "web/a.js": code })).toEqual({
      calls: [],
      limits: [
        "calls web->api: URLs to x.example (web/a.js:5) are not read as requests to api; set origins.api if that is its host",
        "calls web->api: requests through a client are not read where api's base is a value atlas does not read (set base and join): web/a.js:3, web/a.js:4",
      ],
    });
    expect(read({ "web/a.js": code }, { base: "/api/", join: "append" })).toEqual({
      calls: ["GET /api/orders @4", "GET /api/users @3"],
      limits: ["calls web->api: URLs to x.example (web/a.js:5) are not read as requests to api; set origins.api if that is its host"],
    });
    // Stated nowhere: a path from the root is read as written (axios.defaults may give one), one without no.
    expect(read({ "web/a.js": 'import axios from "axios";\nconst api = axios.create({ timeout: 5 });\napi.get("/users");\napi.get("orders");' })).toEqual({
      calls: ["GET /users @3"],
      limits: ["calls web->api: requests through a client are not read where api states no base a path without a leading / joins (set base and join): web/a.js:4"],
    });
  });

  it("finds the factory by the import that binds it, aliased or not, and the option by its name however the key is written", () => {
    const rows: Array<[string, string[], string[]]> = [
      ['import Http from "axios";\nconst api = Http.create({ ["baseURL"]: "/api" });\napi.get("users");', ["GET /api/users @3"], []],
      // A spread or a computed key after it may set it.
      ['import axios from "axios";\nconst api = axios.create({ baseURL: "/api", ...more });\napi.get("users");', [], ["calls web->api: requests through a client are not read where api sets baseURL where a spread, a computed key or a prototype may (set base and join): web/a.js:3"]],
      ['import axios from "axios";\nconst api = axios.create({ __proto__: defaults });\napi.get("users");', [], ["calls web->api: requests through a client are not read where api sets baseURL where a spread, a computed key or a prototype may (set base and join): web/a.js:3"]],
      ['import axios from "axios";\nconst api = axios.create({ baseURL: "/api", [key]: "/v2" });\napi.get("users");', ["* /v2 @2"], ["calls web->api: requests through a client are not read where api sets baseURL where a spread, a computed key or a prototype may (set base and join): web/a.js:3"]],
      // A spread before it does not.
      ['import axios from "axios";\nconst api = axios.create({ ...more, baseURL: "/api" });\napi.get("users");', ["GET /api/users @3"], []],
      // A local `axios`, a `let` or another package is no instance of axios; their strings are read as any string is.
      ['const axios = make();\nconst api = axios.create({ baseURL: "/api" });\napi.get("users");', ["* /api @2"], []],
      ['import axios from "axios";\nlet api = axios.create({ baseURL: "/api" });\napi.get("users");', [], []],
      ['import axios from "redaxios";\nconst api = axios.create({ baseURL: "/api" });\napi.get("users");', ["* /api @2"], []],
      // Instances that refer to each other end unread.
      ['import ky from "ky";\nconst a = b.extend({});\nconst b = a.extend({});\na.get("users");', [], []],
    ];
    expect(rows.map(([code]) => read({ "web/a.js": code, "package.json": '{ "dependencies": { "ky": "^2.0.0" } }' }))).toEqual(rows.map(([, calls, limits]) => ({ calls, limits })));
  });

  it("reads Ky's prefix as appended, its baseUrl as resolved, by the major version the package.json gives", () => {
    const ky2 = { "package.json": '{ "dependencies": { "ky": "^2.2.0" } }' };
    const http = [
      'import ky from "ky";',
      'export const api = ky.create({ prefix: "/api", hooks: { beforeRequest: [({ request }) => { request.headers.set("a", "b"); }] } });',
      "export const admin = api.extend((options) => ({ prefix: `${options.prefix}/admin` }));",
      'export const search = ky.create({ baseUrl: "/search/" });',
    ].join("\n");
    const calls = [
      'import { api, admin, search } from "./http.js";',
      'api.get("users");',
      'api.head("/users");',
      'api("sessions", { method: "post" });',
      'admin.post(`users/${id}/suspend`);',
      'search.get("items");',
      'search.get("/status");',
      'api.get("users", { prefix: "/v2" });',
    ].join("\n");
    expect(read({ ...ky2, "web/http.js": http, "web/calls.js": calls })).toEqual({
      calls: ["GET /api/users @2", "GET /search/items @6", "GET /status @7", "GET /v2/users @8", "HEAD /api/users @3", "POST /api/admin/users/{}/suspend @5", "POST /api/sessions @4"],
      limits: [],
    });
    // Ky 1 appends prefixUrl and refuses an input with a leading `/`; Ky 2 refuses prefixUrl.
    const old = 'import ky from "ky";\nconst api = ky.create({ prefixUrl: "/api" });\napi.get("users");\napi.get("/users");';
    expect(read({ "package.json": '{ "dependencies": { "ky": "^1.7.0" } }', "web/a.js": old })).toEqual({
      calls: ["GET /api/users @3"],
      limits: ["calls web->api: requests through a client are not read where Ky 1 refuses an input that starts with / under prefixUrl: web/a.js:4"],
    });
    expect(read({ ...ky2, "web/a.js": old })).toEqual({ calls: [], limits: ["calls web->api: requests through a client are not read where api sets prefixUrl, which Ky 2 refuses: web/a.js:3, web/a.js:4"] });
    expect(read({ "web/a.js": old })).toEqual({
      calls: [],
      limits: ["calls web->api: requests through a client are not read where no package.json above web/a.js gives one major version of ky, whose prefixUrl, prefix and baseUrl differ between versions: web/a.js:3, web/a.js:4"],
    });
    // A hook that may return another request, or an init hook, may change any URL.
    const hooked = (hooks: string) => read({ ...ky2, "web/a.js": `import ky from "ky";\nconst api = ky.create({ prefix: "/api", hooks: ${hooks} });\napi.get("users");` });
    expect(hooked("{ beforeRequest: [({ request }) => new Request(request)] }")).toEqual({
      calls: [],
      limits: ["calls web->api: requests through a client are not read where api's beforeRequest hook may return another request: web/a.js:3"],
    });
    // The prefix the hook writes is read as any string is.
    expect(hooked("{ init: [(o) => { o.prefix = '/x'; }] }")).toEqual({
      calls: ["* /x @2"],
      limits: ["calls web->api: requests through a client are not read where api's init hook may change its options: web/a.js:3"],
    });
    expect(hooked("{ afterResponse: [(r) => r] }")).toEqual({ calls: ["GET /api/users @3"], limits: [] });
    expect(hooked("{ __proto__: base }")).toEqual({ calls: [], limits: ["calls web->api: requests through a client are not read where api's hooks are not read: web/a.js:3"] });
    // An instance extended from one with such a hook keeps it, whatever prefix it sets.
    const extended = read({ ...ky2, "web/a.js": 'import ky from "ky";\nconst a = ky.create({ hooks: { init: [f] } });\nconst b = a.extend({ prefix: "/api" });\nb.get("users");' });
    expect(extended).toEqual({ calls: [], limits: ["calls web->api: requests through a client are not read where a's init hook may change its options: web/a.js:4"] });
  });

  it("reads openapi-fetch's baseUrl and a request's own, and no request through a middleware that may return another", () => {
    const client = (middleware: string) =>
      read({
        "web/a.ts": [
          'import createClient from "openapi-fetch";',
          'const client = createClient<paths>({ baseUrl: "/api/v1/" });',
          `client.use(${middleware});`,
          'client.GET("/items/{id}", { params });',
          'client.GET("/health", { baseUrl: "/" });',
        ].join("\n"),
      });
    expect(client("{ async onRequest({ request }) { request.headers.set('a', 'b'); return request; } }")).toEqual({ calls: ["GET /api/v1/items/{id} @4", "GET /health @5"], limits: [] });
    expect(client("{ onRequest({ request }) { return new Request('/other', request); } }")).toEqual({
      calls: ["* /other @3"],
      limits: ["calls web->api: requests through a client are not read where a middleware of client may return another request: web/a.ts:4, web/a.ts:5"],
    });
  });

  it("reads RTK Query's endpoints under fetchBaseQuery's baseUrl, with the method fetchBaseQuery sends", () => {
    const api = [
      'import { createApi as make, fetchBaseQuery } from "@reduxjs/toolkit/query/react";',
      "export const api = make({",
      '  baseQuery: fetchBaseQuery({ baseUrl: "/api/" }),',
      "  endpoints: (build) => ({",
      "    health: build.query({ query: () => '/health' }),",
      "    post: build.query({ query: (id) => `posts/${id}` }),",
      "    add: build.mutation({ query: (body) => ({ url: 'posts', method: 'post', body }) }),",
      "    remove: build.mutation({ query(id) { return { url: `posts/${id}`, method: verb }; } }),",
      "    report: build.query({ query: (year) => `${year}/summary` }),",
      "  }),",
      "});",
    ].join("\n");
    const users = 'import { api } from "./api";\nexport const users = api.injectEndpoints({ endpoints: (b) => ({ user: b.query({ query: (id) => ({ url: `users/${id}` }) }) }) });';
    expect(read({ "web/api.ts": api, "web/users.ts": users })).toEqual({
      calls: ["* /api/posts/{} @8", "GET /api/health @5", "GET /api/posts/{} @6", "GET /api/users/{} @2", "POST /api/posts @7"],
      limits: ["calls web->api: requests through a client are not read where it starts with a value, an absolute URL or a path api's base takes: web/api.ts:9"],
    });
    // Another base query may do anything with the URL.
    expect(read({ "web/a.ts": 'import { createApi } from "@reduxjs/toolkit/query";\nconst api = createApi({ baseQuery: withAuth, endpoints: (b) => ({ x: b.query({ query: () => "x" }) }) });' })).toEqual({
      calls: [],
      limits: ["calls web->api: requests through a client are not read where api's baseQuery is not fetchBaseQuery written in place: web/a.ts:2"],
    });
  });

  it("reads a client's base option as its base, no request of its own", () => {
    const code = 'import axios from "axios";\nimport ky from "ky";\nconst a = axios.create({ baseURL: "/api/v1" });\nconst b = ky.create({ prefix: `${API}/v2` });';
    expect(read({ "web/a.js": code, "package.json": '{ "dependencies": { "ky": "2" } }' })).toEqual({ calls: [], limits: [] });
  });
});

describe("the configured base", () => {
  it("is no request where the code writes it as a value", () => {
    const code = 'export const api = new ApiClient({ baseUrl: "/api/v1/" });\nconst base = options.baseUrl || "/api/v1";\nconst full = `${origin}/api/v1`;\nfetch("/api/v1/users");';
    expect(read({ "web/a.js": code }, { prefix: "/api/v1" })).toEqual({
      calls: ["GET /api/v1/api/v1/users @4"],
      limits: ["calls web->api: the configured prefix /api/v1, written as a value (web/a.js:1, web/a.js:2, web/a.js:3), is the client's base, not a request"],
    });
    expect(read({ "web/client.py": 'client = httpx.Client(base_url=f"{API_URL}/api/v1/")\nclient.get("/items")' }, { base: "/api/v1/", join: "append" })).toEqual({
      calls: ["GET /api/v1/items @2"],
      limits: ["calls web->api: the configured base /api/v1/, written as a value (web/client.py:1), is the client's base, not a request"],
    });
  });

  it("is resolved against or appended to as the call source's join says", () => {
    const code = 'client.get("/health")\nclient.get("users/$id")\nother.get("users")';
    expect(read({ "web/A.kt": code }, { base: "/api/v1/", join: "resolve", receivers: ["client"] })).toEqual({ calls: ["GET /api/v1/users/{} @2", "GET /health @1"], limits: [] });
    expect(read({ "web/A.kt": code }, { base: "/api/v1", join: "resolve", receivers: ["client"] })).toEqual({ calls: ["GET /api/users/{} @2", "GET /health @1"], limits: [] });
    expect(read({ "web/A.kt": code }, { base: "/api/v1", join: "append", receivers: ["client"] })).toEqual({ calls: ["GET /api/v1/health @1", "GET /api/v1/users/{} @2"], limits: [] });
    expect(read({ "web/A.kt": code }, { prefix: "/api/v1", receivers: ["client"] })).toEqual({ calls: ["GET /api/v1/health @1", "GET /api/v1/users/{} @2"], limits: [] });
  });
});

describe("paths relative to a client's base, in code read as text", () => {
  it("reads one only where a client takes it, whole, and names it where no base is given", () => {
    const python = [
      'api.get("projects")',
      'api.request("POST", f"projects/{pid}/archive")',
      'api.get("projects/" + pid)',
      'data.get("items")',
      'api.headers.update({"X": "y"})',
      'api.get("https://other.example/x")',
    ].join("\n");
    expect(read({ "web/p.py": python }, { base: "/api/v2/", join: "resolve", receivers: ["api"] })).toEqual({
      calls: ["* /api/v2/projects/{}/archive @2", "GET /api/v2/projects @1"],
      limits: ["calls web->api: URLs to other.example (web/p.py:6) are not read as requests to api; set origins.api if that is its host"],
    });
    expect(read({ "web/p.py": python }, { receivers: ["api"] })).toEqual({
      calls: [],
      limits: [
        "calls web->api: URLs to other.example (web/p.py:6) are not read as requests to api; set origins.api if that is its host",
        "calls web->api: paths without a leading / are relative to a client's base, which the call source does not give (set base and join): web/p.py:1, web/p.py:2",
      ],
    });
  });

  it("reads Retrofit's annotations, .NET's HttpRequestMessage and Dart's Uri.http without receivers", () => {
    const retrofit = 'interface UserApi {\n  @GET("users/{id}")\n  suspend fun user(@Path("id") id: String): User\n  @HTTP(method = "DELETE", path = "users/{id}/sessions", hasBody = true)\n  suspend fun end(): Unit\n  @GET("/health")\n  suspend fun health(): Unit\n}';
    expect(read({ "web/UserApi.kt": retrofit }, { base: "/api/v1/", join: "resolve" })).toEqual({ calls: ["* /api/v1/users/{} @2", "* /api/v1/users/{}/sessions @4", "* /health @6"], limits: [] });
    const dotnet = 'var request = new HttpRequestMessage(HttpMethod.Patch, $"users/{id}");\nvar other = new HttpRequestMessage(HttpMethod.Head, requestUri: "reports");';
    expect(read({ "web/A.cs": dotnet }, { base: "/api/", join: "resolve" })).toEqual({ calls: ["HEAD /api/reports @2", "PATCH /api/users/{} @1"], limits: [] });
    const dart = "final a = client.get(Uri.http(host, 'catalog/items'));\nfinal b = client.get(Uri.https(host, '/catalog/items/$id'));\nfinal c = client.get(Uri.https('maps.example.com', '/x'));";
    expect(read({ "web/a.dart": dart }, { prefix: "/api" })).toEqual({
      calls: ["* /catalog/items based @1", "* /catalog/items/{} based @2"],
      limits: ["calls web->api: URLs to maps.example.com (web/a.dart:3) are not read as requests to api; set origins.api if that is its host"],
    });
  });
});

describe("prefixes a type or a helper puts before its paths", () => {
  it("puts Refit's [PathPrefix] before the routes of its interface, and leaves those of an interface that inherits unread", () => {
    const refit = [
      '[PathPrefix("/projects")]',
      "public interface IProjectsApi",
      "{",
      '    [Get("/{id}")] Task<Project> Get(int id);',
      '    [Post("/{id}/archive")] Task Archive(int id);',
      "}",
      '[Headers("Accept: x")]',
      "public interface IUsersApi",
      "{",
      '    [Get("/users/{id}")] Task<User> Get(int id);',
      "}",
      '[PathPrefix("/v2/reports")]',
      "public interface IReportsApi : IBaseApi",
      "{",
      '    [Get("/{year}")] Task<Report> Get(int year);',
      "}",
    ].join("\n");
    expect(read({ "web/Apis.cs": refit }, { prefix: "/api" })).toEqual({
      calls: ["* /api/projects/{} @4", "* /api/projects/{}/archive @5", "* /api/users/{} @10"],
      limits: ["calls web->api: the requests are not read where Refit's [PathPrefix] is not read where IReportsApi extends another interface: web/Apis.cs:12"],
    });
  });

  it("reads an @HttpExchange interface's methods under its own path, with their methods", () => {
    const java = [
      '@HttpExchange(url = "/projects")',
      "public interface ProjectsClient {",
      "  @GetExchange",
      "  List<Project> list();",
      '  @GetExchange("/{id}")',
      "  Project get(@PathVariable String id);",
      '  @HttpExchange(method = "POST", url = "/{id}/members/{member}")',
      "  void add(@PathVariable String id, @PathVariable String member);",
      "}",
    ].join("\n");
    expect(read({ "web/ProjectsClient.java": java })).toEqual({ calls: ["GET /projects @3", "GET /projects/{} @5", "POST /projects/{}/members/{} @7"], limits: [] });
  });

  it("puts the text a module's helper writes before its path parameter before the paths passed to it", () => {
    const code = (callers: string) => `async function request(path, init = {}) {\n  const r = await fetch(\`/api\${path}\`, init);\n  if (!r.ok) throw new Error(\`\${r.status} \${path}\`);\n}\n${callers}`;
    expect(read({ "web/a.js": code('export const list = () => request("/projects");\nexport const one = (id) => request(`/projects/${id}`, { method: "DELETE" });') }, { wrappers: [{ name: "request", defaultMethod: "GET" }] })).toEqual({
      calls: ["DELETE /api/projects/{} @6", "GET /api/projects @5"],
      limits: ["calls web->api: /api, which a function puts before the path it is given (web/a.js:2), is read before the paths passed to it, not as a request of its own"],
    });
    // A segment after `/` is no path, and a function given other text is no helper of paths.
    expect(read({ "web/a.js": "export const one = (id) => fetch(`/users/${id}`);\none(\"/x\");" })).toEqual({ calls: ["* /x @2", "GET /users/{} @1"], limits: [] });
    expect(read({ "web/a.js": code('request("projects");') })).toEqual({ calls: ["* /api{} @2"], limits: [] });
  });
});

describe("Ky's options merged over the instance's", () => {
  const ky2 = { "package.json": '{ "dependencies": { "ky": "^2.0.0" } }' };
  it("resolves a prefix from the root against the origin of baseUrl, and leaves one relative to it unread", () => {
    const rows: Array<[string, string[], string[]]> = [
      ['const a = ky.create({ baseUrl: "http://localhost:9000/v1/", prefix: "/api" });\na.get("users");', ["GET /api/users @3"], []],
      ['const a = ky.create({ baseUrl: "https://other.example/v1/" });\nconst b = a.extend({ prefix: "/api" });\nb.get("users");', [], ["calls web->api: URLs to other.example (web/a.js:4) are not read as requests to api; set origins.api if that is its host"]],
      ['const a = ky.create({ baseUrl: "/v1/", prefix: "api" });\na.get("users");', [], ["calls web->api: requests through a client are not read where a sets a prefix that baseUrl resolves: web/a.js:3"]],
      // A parent's prefix not read stays under a baseUrl the child sets.
      ['const a = ky.create({ prefix: env.API });\nconst b = a.extend({ baseUrl: "/v1/" });\nb.get("users");', [], ["calls web->api: requests through a client are not read where b's base is a value atlas does not read (set base and join): web/a.js:4"]],
      // A request's own prefix with the instance's baseUrl.
      ['const a = ky.create({ baseUrl: "/v1/" });\na.get("users", { prefix: "/v2" });\na.get("users");', ["GET /v1/users @4", "GET /v2/users @3"], []],
    ];
    expect(rows.map(([code]) => read({ ...ky2, "web/a.js": `import ky from "ky";\n${code}` }))).toEqual(rows.map(([, calls, limits]) => ({ calls, limits })));
  });
});

describe("a helper around a client, and an interceptor's rewrite", () => {
  it("hands the paths passed to a function on to the client it requests them through, with its base", () => {
    const http = 'import axios from "axios";\nexport const api = axios.create({ baseURL: "/api" });\nexport function get(path) { return api.get(`/v2${path}`); }\nexport const fetchJson = (url) => api.get(url).then((r) => r.data);';
    expect(read({ "web/http.js": http, "web/u.js": 'import { get, fetchJson } from "./http.js";\nget("/users");\nfetchJson("/orders");\nfetchJson("items");' })).toEqual({
      calls: ["* /api/items @4", "* /api/orders @3", "GET /api/v2/users @2"],
      limits: ["calls web->api: /v2, which a function puts before the path it is given (web/http.js:3), is read before the paths passed to it, not as a request of its own"],
    });
  });

  it("reads as a rewrite only text put before the config's own URL, set as that config's URL", () => {
    const rows: Array<[string, string[]]> = [
      ["export function go(req) { return axios.request({ method: 'post', url: `/audit?from=${req.url}` }); }", ["POST /audit @1"]],
      ["export function go(item) { return fetch({ url: `/shares/${item.url}` }); }", ["GET /shares/{} @1"]],
      ["export function go(a, b) { a.url = `/v2${b.url}`; }", ["* /v2{} @1"]],
      ["export const go = (c) => ({ ...c, url: `/v2${c.url}` });", []],
      ["export const go = (c) => { c.url = '/v2' + c.url; return c; };", []],
    ];
    expect(rows.map(([code]) => read({ "web/a.js": code }).calls)).toEqual(rows.map(([, calls]) => calls));
  });

  it("reads no URL that starts with a value through a client whose base it does not read", () => {
    const code = 'import axios from "axios";\nconst api = axios.create({ baseURL: process.env.API });\napi.get(`${seg}/users`);';
    expect(read({ "web/a.js": code }, { base: "/api", join: "append" })).toEqual({
      calls: [],
      limits: ["calls web->api: requests through a client are not read where it starts with a value, an absolute URL or a path api's base takes: web/a.js:3"],
    });
  });

  it("reads no method of an @HttpExchange interface that takes its type-level mapping from the one it extends", () => {
    const java = '@HttpExchange("/api/v1")\ninterface Base {\n  @GetExchange("/health") String health();\n}\ninterface Users extends Base {\n  @GetExchange("/users") List<User> users();\n}';
    expect(read({ "web/Clients.java": java })).toEqual({
      calls: ["GET /api/v1/health @3"],
      limits: ["calls web->api: the requests are not read where an @HttpExchange interface without a type-level mapping of its own extends another: web/Clients.java:5"],
    });
  });
});
