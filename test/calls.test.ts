import { describe, expect, it } from "vitest";
import { normalizeConfig } from "../src/config.js";
import { callsFromTypeScript, extractCalls } from "../src/extract/calls.js";
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
      ['requireMedia(media, id, "/devices");', []],
      ["requireMedia(media, id, `/devices/${id}`);", []],
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
      ['const url = base ? `${base}/api/chat` : "/api/chat";\nfetch(url, { method: "POST" });', ["* /api/chat"]],
      ['fetch(local ? "/api/chat" : "/api/chat");', ["GET /api/chat"]],
      ["fetch(base ? `${base}/api/chat` : `${other}/api/chat`);", ["GET /api/chat based"]],
      // Two paths are two requests.
      ['fetch(ok ? "/api/a" : "/api/b");', ["GET /api/a", "GET /api/b"]],
    ];
    expect(rows.map(([code]) => read(code))).toEqual(rows.map(([, calls]) => calls));
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
    expect(calls('requireMedia(media, a, "/devices");\nrequireMedia(media, b, "/devices");\nnew MissingAsset(id, `/feed/${id}`);')).toEqual([]);
    expect(limits).toEqual(["calls app->api: paths handed to a function after its first argument are not read as requests: requireMedia (2, first at a.ts:1), MissingAsset (1, first at a.ts:3)"]);
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
