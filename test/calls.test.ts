import { describe, expect, it } from "vitest";
import { normalizeConfig } from "../src/config.js";
import { callsFromText, callsFromTypeScript, extractCalls } from "../src/extract/calls.js";
import { isLoopback } from "../src/paths.js";
import type { Source } from "../src/source.js";

const memory = (files: Record<string, string>): Source => ({
  ref: "WORKTREE",
  list: () => Object.keys(files),
  read: (p) => files[p],
  asOf: () => "2026-11-01T00:00:00Z",
});

const read = (code: string) => callsFromTypeScript("a.ts", code, { from: "a", to: "b", files: [] }).map((c) => `${c.method} ${c.path}${c.based ? " based" : ""}`);

describe("strings that are no requests", () => {
  it("leaves out a path handed to a function after its first argument, unless a method stated beside it makes it a request", () => {
    const rows: Array<[string, string[]]> = [
      // A label in an error or lookup helper.
      ['requireAsset(assets, id, "/devices");', []],
      ["requireAsset(assets, id, `/devices/${id}`);", []],
      ['throw new MissingAsset(id, "/devices");', []],
      // The URL first, as fetch, axios, ky, got and project wrappers take it.
      ['authFetch("/devices");', ["* /devices"]],
      ['this.json("/devices", "POST", body);', ["POST /devices"]],
      ["api.post(`/orders/${id}`, body);", ["POST /orders/{}"]],
      ['window.open("/help", "_blank");', ["* /help"]],
      ['const u = new URL("/status", origin);', ["* /status"]],
      // A method stated before the URL; XMLHttpRequest's open takes the method first.
      ['request("POST", "/orders");', ["POST /orders"]],
      ['xhr.open("GET", "/orders");', ["GET /orders"]],
      ['xhr.open(method, "/orders");', ["* /orders"]],
    ];
    expect(rows.map(([code]) => read(code))).toEqual(rows.map(([, calls]) => calls));
  });

  it("leaves out a path compared or tested, not requested", () => {
    const rows: Array<[string, string[]]> = [
      ['if (request.path === "/interactions") send();', []],
      ['if ("/interactions" !== path) send();', []],
      ['const same = path == "/interactions" || path != "/other";', []],
      ['switch (path) {\n  case "/status": break;\n}', []],
      ['const yes = path.startsWith("/api/v1") || path.endsWith("/raw") || path.includes("/admin");', []],
      ['const at = path.indexOf("/api/v1") + path.lastIndexOf("/api/v2");', []],
      ['const m = path.match("/items/") ?? path.search("/carts");', []],
      ['const bare = path.replace("/api/v1", "").replaceAll("/api/v2", "");', []],
      ['const parts = path.split("/api/v1");', []],
      // The string a test is made on, or a replacement made in, is still the URL.
      ['fetch("/orders/{id}".replace("{id}", id));', ["GET /orders/{id}"]],
      ['const u = `${base}/updates`.replace(/^\\/?/, "/");', ["* /updates based"]],
      // Location's and Next.js's router's replace navigate.
      ['window.location.replace("/login");', ["* /login"]],
      ['import { useRouter } from "next/navigation";\nconst router = useRouter();\nrouter.replace("/login");', ["GET /login"]],
    ];
    expect(rows.map(([code]) => read(code))).toEqual(rows.map(([, calls]) => calls));
  });

  it("reads a path option as Node's http.request defines it, from the root", () => {
    const rows: Array<[string, string[]]> = [
      ['client.request({ path: "/feed", method: "GET" });', ["GET /feed"]],
      ["client.request({ path: `/devices/${id}/status` });", ["* /devices/{}/status"]],
      // A path joined to another value is a file path, or a path under something else.
      ["saveSettings({ enabled: false, path: `${project.path}/raw/sources` });", []],
      ['const dir = { path: root + "/raw/sources" };', []],
      // A URL in another option keeps its base.
      ["client.request({ url: `${base}/feed` });", ["* /feed based"]],
    ];
    expect(rows.map(([code]) => read(code))).toEqual(rows.map(([, calls]) => calls));
  });

  it("reads a URL chosen by a condition once when both branches name the same path", () => {
    const rows: Array<[string, string[]]> = [
      ['const url = base ? `${base}/api/chat` : "/api/chat";\nfetch(url, { method: "POST" });', ["POST /api/chat"]],
      ['fetch(local ? "/api/chat" : "/api/chat");', ["GET /api/chat"]],
      ["fetch(base ? `${base}/api/chat` : `${other}/api/chat`);", ["GET /api/chat based"]],
      // Two paths are two requests.
      ['fetch(ok ? "/api/a" : "/api/b");', ["GET /api/a", "GET /api/b"]],
    ];
    expect(rows.map(([code]) => read(code))).toEqual(rows.map(([, calls]) => calls));
  });
});

describe("the review of #21", () => {
  it("names a method written in brackets as it names one after a dot", () => {
    const next = 'import { useRouter } from "next/navigation";\nconst router = useRouter();\n';
    const rows: Array<[string, string[]]> = [
      ['xhr["open"](method, "/orders");', ["* /orders"]],
      ['const yes = path["startsWith"]("/api/v1") || path[`endsWith`]("/raw");', []],
      ['const bare = path["replace"]("/api/v1", "");', []],
      // Next.js's router navigates, written either way.
      [next + 'router["replace"]("/login", { scroll: false });', ["GET /login"]],
    ];
    expect(rows.map(([code]) => read(code))).toEqual(rows.map(([, calls]) => calls));
  });

  it("takes a later argument as the URL only in XMLHttpRequest's open, not window.open's target", () => {
    const rows: Array<[string, string[]]> = [
      ['window.open("/help", "/preview");', ["* /help"]],
      ['open("/help", "/preview");', ["* /help"]],
      ['window.open(url, "/preview");', []],
      ['xhr.open(method, "/orders");', ["* /orders"]],
      ['this.http.request(method, "/orders");', ["* /orders"]],
    ];
    expect(rows.map(([code]) => read(code))).toEqual(rows.map(([, calls]) => calls));
  });
});

describe("the second review of #21", () => {
  it("takes any replace as a text operation, except where Location or Next.js's router navigates", () => {
    const next = 'import { useRouter } from "next/navigation";\nconst router = useRouter();\n';
    const rows: Array<[string, string[]]> = [
      ['const t = text.replace("/api");', []],
      ['const t = text["replace"]("/api");', []],
      ['location.replace("/login");', ["* /login"]],
      ['window.location.replace("/login");', ["* /login"]],
      ['document.location.replace("/login");', ["* /login"]],
      [next + 'router.replace("/login");', ["GET /login"]],
      // A value of the code's own named location is not the window's.
      ['const location = useLocation();\nlocation.replace("/login");', []],
    ];
    expect(rows.map(([code]) => read(code))).toEqual(rows.map(([, calls]) => calls));
  });

  it("knows a loopback address by its octets", () => {
    expect(["127.0.0.1", "127.255.0.9:3000", "localhost", "[::1]:8080", "127.999.999.999", "128.0.0.1", "127.0.0"].map(isLoopback)).toEqual([true, true, true, true, false, false, false]);
  });

  it("takes the method of a URL held in a const from the request that uses it", () => {
    const rows: Array<[string, string[]]> = [
      ['const url = "/api/chat";\nfetch(url, { method: "POST" });', ["POST /api/chat"]],
      ['const url = "/api/chat";\nfetch(url);', ["GET /api/chat"]],
      ['const url = "/api/chat";\napi.put(url, body);', ["PUT /api/chat"]],
      // Uses that state different methods, or none, leave it open.
      ['const url = "/api/chat";\nfetch(url);\nfetch(url, { method: "POST" });', ["* /api/chat"]],
      ['const url = "/api/chat";\nfetch(url);\nlog(url);', ["* /api/chat"]],
      // A use as the base of another URL is that URL's request.
      ['const items = "/items";\nfetch(items, { method: "POST" });\nfetch(`${items}/${id}`);', ["POST /items", "GET /items/{}"]],
    ];
    expect(rows.map(([code]) => read(code))).toEqual(rows.map(([, calls]) => calls));
  });
});

describe("the third review of #21", () => {
  it("takes open as the window's only where open, or the window it is called on, is the global", () => {
    const rows: Array<[string, string[]]> = [
      ['function open(method, url) { return send(method, url); }\nopen(methodValue, "/devices");', ["* /devices"]],
      ['const window = client;\nwindow.open(methodValue, "/devices");', ["* /devices"]],
      // The browser's own still take the URL first.
      ['open(url, "/preview");', []],
      ['window.open(url, "/preview");', []],
    ];
    expect(rows.map(([code]) => read(code))).toEqual(rows.map(([, calls]) => calls));
  });

  it("reads a conditional's branches as one call only when the configured prefix leaves their paths the same", () => {
    const calls = (code: string) => {
      const config = normalizeConfig({
        components: [{ name: "app", path: "" }, { name: "api", path: "" }],
        calls: [{ from: "app", to: "api", files: ["a.ts"], prefix: "/api" }],
        origins: { api: "https://target.example" },
      });
      return extractCalls(memory({ "a.ts": code }), config).map((c) => `${c.method} ${c.path}${c.based ? " based" : ""}`);
    };
    expect(calls('fetch(flag ? "https://target.example/chat" : "/chat");')).toEqual(["GET /chat based", "GET /api/chat"]);
    expect(calls('fetch(base ? `${base}/chat` : "/chat");')).toEqual(["GET /chat based", "GET /api/chat"]);
    expect(calls('fetch(flag ? "/chat" : "/chat");')).toEqual(["GET /api/chat"]);
    // The same request written with the target's origin and as a root-relative path the prefix completes.
    expect(calls('fetch(flag ? "https://target.example/api/chat" : "/chat");')).toEqual(["GET /api/chat"]);
    expect(calls('fetch(flag ? "https://target.example/chat" : `${base}/chat`);')).toEqual(["GET /chat based"]);
  });
});

describe("what a call source leaves unread", () => {
  const limits: string[] = [];
  const calls = (code: string, origins: Record<string, string> = {}) => {
    const config = normalizeConfig({ components: [{ name: "app", path: "" }, { name: "api", path: "" }], calls: [{ from: "app", to: "api", files: ["a.ts"] }], origins });
    limits.length = 0;
    return extractCalls(memory({ "a.ts": code }), config, [], undefined, limits).map((c) => `${c.method} ${c.path}${c.based ? " based" : ""}`);
  };

  it("reads a URL to the machine the client runs on, or to the host the target's origin names", () => {
    expect(calls('fetch("http://127.0.0.1:4800/inbox/items");')).toEqual(["GET /inbox/items based"]);
    expect(calls('fetch("http://localhost:3000/orders");\nfetch("http://[::1]:3000/carts");')).toEqual(["GET /orders based", "GET /carts based"]);
    expect(calls('fetch("https://api.example.com/orders");', { api: "https://API.example.com/v1" })).toEqual(["GET /orders based"]);
    // A host written as a value is not known to be another server's.
    expect(calls("fetch(`https://${host}/orders`);")).toEqual(["GET /orders based"]);
    expect(limits).toEqual([]);
  });

  it("names the functions paths were handed to after their first argument", () => {
    expect(calls('requireAsset(assets, a, "/devices");\nrequireAsset(assets, b, "/devices");\nnew MissingAsset(id, `/feed/${id}`);')).toEqual([]);
    expect(limits).toEqual(["calls app->api: paths handed to a function after its first argument are not read as requests: requireAsset (2, first at a.ts:1), MissingAsset (1, first at a.ts:3)"]);
  });

  it("keeps the host of an origin-only const a URL starts with", () => {
    expect(calls('const BASE = "https://example.org";\nfetch(`${BASE}/orders`);')).toEqual([]);
    expect(limits).toEqual(["calls app->api: URLs to example.org (a.ts:2) are not read as requests to api; set origins.api if that is its host"]);
    expect(calls('const BASE = "https://example.org";\nfetch(BASE + "/orders");')).toEqual([]);
    expect(limits).toEqual(["calls app->api: URLs to example.org (a.ts:2) are not read as requests to api; set origins.api if that is its host"]);
    // An origin the target is served at, or a loopback one, with or without a trailing slash.
    expect(calls('const BASE = "https://api.example.com";\nfetch(`${BASE}/orders`);', { api: "https://api.example.com" })).toEqual(["GET /orders based"]);
    expect(calls('const BASE = "http://localhost:3000/";\nfetch(BASE + "/orders");')).toEqual(["GET /orders based"]);
  });

  it("reads one call from a conditional whose branches both reach the target, and keeps a relative branch beside a foreign one", () => {
    expect(calls('fetch(local ? "http://localhost:3000/api/chat" : "/api/chat");')).toEqual(["GET /api/chat"]);
    expect(calls('fetch(live ? "https://api.example.com/api/chat" : "/api/chat");', { api: "https://api.example.com" })).toEqual(["GET /api/chat"]);
    expect(calls('fetch(remote ? "https://other.example.org/api/chat" : "/api/chat");')).toEqual(["GET /api/chat"]);
    expect(limits).toEqual(["calls app->api: URLs to other.example.org (a.ts:1) are not read as requests to api; set origins.api if that is its host"]);
  });

  it("leaves out a URL whose literal host is not a valid one", () => {
    expect(calls('fetch("http://127.999.999.999/orders");')).toEqual([]);
    expect(limits).toEqual(["calls app->api: URLs to 127.999.999.999 (a.ts:1) are not read as requests to api; set origins.api if that is its host"]);
  });

  it("leaves out a URL to another host: it is not a request to the configured target", () => {
    expect(calls('const release = { html_url: "https://example.org/owner/repo/releases" };')).toEqual([]);
    expect(limits).toEqual(["calls app->api: URLs to example.org (a.ts:1) are not read as requests to api; set origins.api if that is its host"]);
    expect(calls('fetch("https://api.example.com/orders");')).toEqual([]);
    expect(calls('fetch("https://api.example.com/orders");', { api: "https://other.example.com" })).toEqual([]);
    // Code read as text too.
    const kotlin = normalizeConfig({ components: [{ name: "app", path: "" }, { name: "api", path: "" }], calls: [{ from: "app", to: "api", files: ["A.kt"] }] });
    const text = 'val a = http.get("https://api.example.com/orders")\nval b = http.get("http://localhost:8080/orders")';
    expect(extractCalls(memory({ "A.kt": text }), kotlin).map((c) => `${c.method} ${c.path} ${c.at.line}`)).toEqual(["GET /orders 2"]);
  });
});

describe("a client's own prefixing helper", () => {
  const limits: string[] = [];
  const calls = (code: string, prefix = "/api/v1") => {
    const config = normalizeConfig({ components: [{ name: "app", path: "" }, { name: "api", path: "" }], calls: [{ from: "app", to: "api", files: ["a.ts"], ...(prefix ? { prefix } : {}) }] });
    limits.length = 0;
    const read = extractCalls(memory({ "a.ts": code }), config, [], undefined, limits).map((c) => `${c.method} ${c.path}${c.based ? " based" : ""}`);
    return { calls: read, limits: [...limits] };
  };
  const callers = '\nexport const list = () => request(apiPath("/notebooks"));\nexport const search = (id: string) => request(apiPath(`/notebooks/${id}/search`), { method: "POST" });';

  it("does not read the configured prefix put before a path parameter as a request: the paths passed to it are", () => {
    const rows: Array<[string, string[]]> = [
      ["function apiPath(path: string) { return `/api/v1${path}`; }", ["* /api/v1/notebooks", "POST /api/v1/notebooks/{}/search"]],
      ['const apiPath = (path: string) => "/api/v1" + path;', ["* /api/v1/notebooks", "POST /api/v1/notebooks/{}/search"]],
      // The value put after the prefix may be built from the parameter alone.
      ['function apiPath(path: string) { return path.startsWith("/api/v1") ? path : `/api/v1${path.startsWith("/") ? path : `/${path}`}`; }', ["* /api/v1/notebooks", "POST /api/v1/notebooks/{}/search"]],
    ];
    const limit = "calls app->api: the configured prefix /api/v1 put before a function's path parameter (a.ts:1) is not read as a request; the paths passed to that function are";
    for (const [helper, expected] of rows) expect(calls(helper + callers)).toEqual({ calls: expected, limits: [limit] });
    // The prefix as the configuration may write it.
    expect(calls("function apiPath(path: string) { return `/api/v1${path}`; }" + callers, "api/v1/").calls).toEqual(["* /api/v1/notebooks", "POST /api/v1/notebooks/{}/search"]);
  });

  it("still reads a path with a hole, a prefix put before anything but a parameter, and a base other than the prefix", () => {
    const rows: Array<[string, string, string[]]> = [
      // A segment under a path the code names is a request of its own, whatever fills it.
      ["const order = (id: string) => fetch(`/orders/${id}`);", "/api/v1", ["GET /api/v1/orders/{}"]],
      ["const item = (id: string) => fetch(`/api/v1/${id}`);", "/api/v1", ["GET /api/v1/api/v1/{}"]],
      // Another base, or text after the parameter.
      ["const list = (query: string) => fetch(`/orders${query}`);", "/api/v1", ["GET /api/v1/orders{}"]],
      ["const v2 = (path: string) => fetch(`/api/v2${path}`);", "/api/v1", ["GET /api/v1/api/v2{}"]],
      ["const sub = (path: string) => fetch(`/api/v1${path}/items`);", "/api/v1", ["GET /api/v1/api/v1{}/items"]],
      // A value that is not the function's parameter, or is more than it.
      ["const PATH = route();\nfetch(`/api/v1${PATH}`);", "/api/v1", ["GET /api/v1/api/v1{}"]],
      ["const get = (path: string) => fetch(`/api/v1${normalize(path)}`);", "/api/v1", ["GET /api/v1/api/v1{}"]],
      // `this` and `super` are inputs of their own, as another function is.
      ["class C { get(path: string) { return fetch(`/api/v1${this.normalize(path)}`); } }", "/api/v1", ["GET /api/v1/api/v1{}"]],
      ["class C extends B { get(path: string) { return fetch(`/api/v1${super.normalize(path)}`); } }", "/api/v1", ["GET /api/v1/api/v1{}"]],
      ['class C { get(path: string) { return fetch("/api/v1" + this[path]); } }', "/api/v1", ["GET /api/v1/api/v1{}"]],
      // No prefix configured: the helper's base is all the code says.
      ["const get = (path: string) => fetch(`/api/v1${path}`);", "", ["GET /api/v1{}"]],
    ];
    expect(rows.map(([code, prefix]) => calls(code, prefix))).toEqual(rows.map(([, , expected]) => ({ calls: expected, limits: [] })));
  });
});

describe("a label given to an exception in code read as text", () => {
  const read = (file: string, code: string) => callsFromText(file, code, { from: "a", to: "b", files: [] }).map((c) => `${c.method} ${c.path}`);

  it("does not read a path passed to an exception, thrown or built, or to Kotlin's throwing functions", () => {
    const rows: Array<[string, string]> = [
      ["A.kt", 'if (failed) throw BffUnavailable("/my")'],
      ["A.kt", 'throw ApiFailure(status = 503, path = "/my")'],
      ["A.kt", 'return Result.failure(IllegalStateException("/my"))'],
      ["A.kt", 'val e = SomeError("/my/$id")'],
      ["A.kt", 'val e = errors.NotFoundError("/my")'],
      ["A.kt", 'error("/my")'],
      ["A.kt", 'TODO("/my")'],
      ["A.kt", 'require(path != "/my")'],
      ["A.kt", 'check(path == "/my")'],
      ["A.java", 'throw new IllegalArgumentException("/my");'],
      ["A.java", 'throw new MissingPage(\n    "/my");'],
      ["a.py", 'raise ValueError(f"/my/{item_id}")'],
      ["a.dart", "throw StateError('/my');"],
      ["A.swift", 'throw ApiFailure.missing(path: "/my")'],
      // The languages' own exceptions, named by the suffix alone.
      ["A.kt", 'return Result.failure(Exception("/my"))'],
      ["a.py", 'e = Exception("/my")'],
      ["a.dart", "final e = Error('/my');"],
      // Triple-quoted strings, which the call reader reads from their third quote.
      ["A.kt", 'throw BffUnavailable("""/my""")'],
      ["a.py", 'raise ValueError("""/my""")'],
      ["a.py", "raise ValueError('''/my''')"],
      // Type arguments, nested ones too.
      ["A.kt", 'throw failure<Map<String, List<Int>>>("/my")'],
      ["A.kt", 'val e = ApiException<Map<String, Int>>("/my")'],
    ];
    expect(rows.map(([file, code]) => read(file, code))).toEqual(rows.map(() => []));
  });

  it("still reads a request made inside one, and a path passed to anything else", () => {
    const rows: Array<[string, string, string[]]> = [
      ["A.kt", 'val r = http.get("/my")', ["GET /my"]],
      ["A.kt", 'throw ApiFailure(http.get("/my").status)', ["GET /my"]],
      ["A.kt", 'val e = SomeError("x")\nval r = http.get("/my")', ["GET /my"]],
      // A member named like the standard function is the class's own, and lower-case names are functions.
      ["A.kt", 'val r = health.check("/my")', ["* /my"]],
      ["A.kt", 'reportError("/my")', ["* /my"]],
      ["A.kt", 'val h = ErrorHandler("/my")', ["* /my"]],
      // `error` and `TODO` throw in Kotlin only.
      ["a.py", 'error("/my")', ["* /my"]],
      // An exception's parentheses end where they close.
      ["A.kt", 'val e = SomeError(code)\nhttp.get("/my")', ["GET /my"]],
      // A request in a field of an exception's f-string runs on its own.
      ["a.py", "raise ApiError(f\"failed: {requests.get('/my').status_code}\")", ["GET /my"]],
      // A call after a comparison has no type arguments.
      ["A.kt", 'if (a < b && c > d) http.get("/my")', ["GET /my"]],
    ];
    expect(rows.map(([file, code]) => read(file, code))).toEqual(rows.map(([, , expected]) => expected));
  });

  it("names what it leaves unread in a limit", () => {
    const config = normalizeConfig({ components: [{ name: "app", path: "" }, { name: "api", path: "" }], calls: [{ from: "app", to: "api", files: ["A.kt"] }] });
    const limits: string[] = [];
    const text = 'val r = http.get("/my")\nif (r.failed) throw BffUnavailable("/my")\nerror("/my")\nerror("/other")';
    expect(extractCalls(memory({ "A.kt": text }), config, [], undefined, limits).map((c) => `${c.method} ${c.path} ${c.at.line}`)).toEqual(["GET /my 1"]);
    expect(limits).toEqual(["calls app->api: paths given to an exception or to a function that throws are not read as requests: BffUnavailable (1, first at A.kt:2), error (2, first at A.kt:3)"]);
  });
});

describe("client wrappers in the configuration", () => {
  const wrapped = (code: string, wrappers: Array<{ name: string; defaultMethod: string }> = [{ name: "authFetch", defaultMethod: "GET" }]) =>
    callsFromTypeScript("a.ts", code, { from: "a", to: "b", files: [], wrappers }).map((c) => `${c.method} ${c.path}`);

  it("reads a call that states no method as the wrapper's default, and keeps a method the call states", () => {
    const rows: Array<[string, string[]]> = [
      // fetch's semantics: no init, or an init without a method, sends the default.
      ['authFetch("/items");', ["GET /items"]],
      ["authFetch(`/items/${id}`, { headers });", ["GET /items/{}"]],
      ["authFetch(`/items/${id}`, { method: \"PUT\", body });", ["PUT /items/{}"]],
      ['authFetch("/items", { ...init, method: "DELETE" });', ["DELETE /items"]],
      ['authFetch("/items", "POST");', ["POST /items"]],
      // A known method in any case, as a method stated in the init is read.
      ['authFetch("/items", "post");', ["POST /items"]],
      // An init that may carry a method: a value, a spread, a method held in a value.
      ['authFetch("/items", init);', ["* /items"]],
      ['authFetch("/items", { ...init, headers });', ["* /items"]],
      ['authFetch("/items", { method });', ["* /items"]],
      // A URL held in a const takes the method of the wrapper call that uses it.
      ["const url = `/items/${id}`;\nauthFetch(url);", ["GET /items/{}"]],
      // Only the name configured, as it is written.
      ['otherFetch("/items");', ["* /items"]],
      ['api.authFetch("/items");', ["* /items"]],
    ];
    expect(rows.map(([code]) => wrapped(code))).toEqual(rows.map(([, calls]) => calls));
    expect(wrapped('api.authFetch("/items");', [{ name: "api.authFetch", defaultMethod: "GET" }])).toEqual(["GET /items"]);
    expect(wrapped('send("/items");\nsend("/items", { method: "GET" });', [{ name: "send", defaultMethod: "POST" }])).toEqual(["POST /items", "GET /items"]);
    // Without the configuration nothing is guessed.
    expect(wrapped('authFetch("/items");', [])).toEqual(["* /items"]);
  });

  it("leaves the method open while anything in the init may name method, and reads one stated after it", () => {
    const rows: Array<[string, string[]]> = [
      // A computed key, a getter, a prototype or a spread may carry a method.
      ['authFetch("/items", { [key]: verb });', ["* /items"]],
      ['authFetch("/items", { ["method"]: verb });', ["* /items"]],
      ['authFetch("/items", { get method() { return verb; } });', ["* /items"]],
      ['authFetch("/items", { __proto__: init, headers });', ["* /items"]],
      ['authFetch("/items", { method: "DELETE", ...init });', ["* /items"]],
      ['authFetch("/items", { method: "POST", [key]: verb });', ["* /items"]],
      // A method stated after them is the one sent; a computed key that is a literal is that name.
      ['authFetch("/items", { [key]: verb, method: "PUT" });', ["PUT /items"]],
      ['authFetch("/items", { ["headers"]: headers });', ["GET /items"]],
    ];
    expect(rows.map(([code]) => wrapped(code))).toEqual(rows.map(([, calls]) => calls));
    // fetch is read by the same rule.
    expect(read('fetch("/items", { [key]: verb });\nfetch("/items", { __proto__: init });')).toEqual(["* /items", "* /items"]);
    // fetch reads its init as a wrapper does: a method stated after a spread is the one the object ends with.
    expect(read('fetch("/items", { ...options, method: "POST" });\nfetch("/items", { method: "POST", ...options });\nfetch("/items", { ...options });')).toEqual(["POST /items", "* /items", "* /items"]);
  });

  it("reads a configured wrapper before the names a method is read from without one", () => {
    const post = [{ name: "post", defaultMethod: "POST" }];
    expect(wrapped('post("/items");\npost("/items", { method: "GET" });\npost("/items", init);', post)).toEqual(["POST /items", "GET /items", "* /items"]);
    const fetch = [{ name: "fetch", defaultMethod: "POST" }];
    expect(wrapped('fetch("/items");\nfetch("/items", { headers });\nfetch("/items", { method: "GET" });', fetch)).toEqual(["POST /items", "POST /items", "GET /items"]);
    // Without the wrapper the name decides.
    expect(read('post("/items", { method: "GET" });\npost("/items", init);')).toEqual(["POST /items", "POST /items"]);
  });

  it("takes a name and one of the HTTP methods as the default", () => {
    const wrappers = (list: unknown) => () => normalizeConfig({ components: [{ name: "a", path: "" }, { name: "b", path: "" }], calls: [{ from: "a", to: "b", files: ["*.ts"], wrappers: list }] });
    expect(wrappers([{ name: "authFetch", defaultMethod: "GET" }])).not.toThrow();
    expect(normalizeConfig({ calls: [{ from: "a", to: "b", files: [], wrappers: [{ name: "authFetch", defaultMethod: "post" }] }] }).calls[0]!.wrappers).toEqual([{ name: "authFetch", defaultMethod: "POST" }]);
    for (const bad of [{ name: "authFetch" }, { name: "authFetch", defaultMethod: "*" }, { name: "authFetch", defaultMethod: "FETCH" }, { name: "", defaultMethod: "GET" }, { defaultMethod: "GET" }, { name: "authFetch", defaultMethod: 1 }]) {
      expect(wrappers([bad]), JSON.stringify(bad)).toThrow(/client wrapper/);
    }
    expect(wrappers({ name: "authFetch", defaultMethod: "GET" })).toThrow(/client wrapper/);
  });
});

describe("a client @hey-api/openapi-ts generated", () => {
  const sdk = [
    "// This file is auto-generated by @hey-api/openapi-ts",
    "",
    "import { client } from './client.gen';",
    "",
    "export const usersList = (options?: Options) => (options?.client ?? client).get({ url: '/api/users/', ...options });",
    "",
    "export const usersCreate = (options: Options) => (options.client ?? client).post({ url: '/api/users/', ...options });",
  ].join("\n");
  const config = (files: string[]) =>
    normalizeConfig({ components: [{ name: "web", path: "web" }, { name: "api", path: "api" }], calls: [{ from: "web", to: "api", files }] });
  const read = (files: Record<string, string>, globs: string[]) => {
    const limits: string[] = [];
    const calls = extractCalls(memory(files), config(globs), [], undefined, limits).map((c) => `${c.method} ${c.path}${c.slash ? "/" : ""} ${c.scope}`);
    return { calls, limits };
  };

  it("reads a function's request only where another configured file names it", () => {
    const files = { "web/api/sdk.gen.ts": sdk, "web/pages/users.ts": "import { usersList } from '../api';\nexport const load = () => usersList();\n" };
    expect(read(files, ["web/**/*.ts"])).toEqual({
      calls: ["GET /api/users/ usersList"],
      limits: ["calls web->api: 1 function of web/api/sdk.gen.ts, which @hey-api/openapi-ts generated, is named in no other configured file, so its requests are not read: usersCreate"],
    });
  });

  it("reads every function where the generated client is all the component's call files hold, and says so", () => {
    expect(read({ "web/api/sdk.gen.ts": sdk }, ["web/api/*.ts"])).toEqual({
      calls: ["GET /api/users/ usersList", "POST /api/users/ usersCreate"],
      limits: [
        "calls web->api: web/api/sdk.gen.ts, which @hey-api/openapi-ts generated, is all that web's call files hold, so nothing configured could call its functions: each is read as a request, called or not; add the files that call the client to read only the functions they call",
      ],
    });
  });

  it("reads a file without the generator's header as any code", () => {
    expect(read({ "web/api/sdk.gen.ts": sdk.split("\n").slice(1).join("\n"), "web/pages/users.ts": "export {};\n" }, ["web/**/*.ts"]).calls).toEqual([
      "GET /api/users/ usersList",
      "POST /api/users/ usersCreate",
    ]);
  });
});
