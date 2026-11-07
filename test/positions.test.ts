import { describe, expect, it } from "vitest";
import { callsFromTemplate, callsFromText, callsFromTypeScript } from "../src/extract/calls.js";
import { inventory } from "../src/inventory.js";
import { callPath } from "../src/paths.js";
import type { Source } from "../src/source.js";

const memory = (files: Record<string, string>): Source => ({
  ref: "WORKTREE",
  list: () => Object.keys(files),
  read: (p) => files[p],
  asOf: () => "2026-11-01T00:00:00Z",
});

const spec = { from: "web", to: "api", files: [], wrappers: [{ name: "authFetch", defaultMethod: "GET" }] };
const read = (code: string, file = "a.tsx") => callsFromTypeScript(file, code, spec).map((c) => `${c.method} ${c.path}${c.based ? " based" : ""}`);
const rows = (table: Array<[string, string[]]>) => expect(table.map(([code]) => read(code))).toEqual(table.map(([, calls]) => calls));

describe("the root path where a string is a request (#31)", () => {
  it("reads / only where a reader asks for it", () => {
    expect(callPath("/")).toBeUndefined();
    expect(callPath("/", true)).toEqual({ path: "/", based: false });
    expect(callPath("/?tab=1#top", true)).toEqual({ path: "/", based: false });
    expect(callPath("http://localhost:3000/", true)).toEqual({ path: "/", based: true });
    expect(callPath("{}/", true)).toEqual({ path: "/", based: true });
    expect(callPath("/orders/", true)).toEqual({ path: "/orders", based: false });
    expect(callPath("//cdn.example/", true)).toBeUndefined();
  });

  it("reads / as the request a call makes with it as its URL, with the call's method", () => {
    const next = 'import Link from "next/link";\n';
    rows([
      ['fetch("/");', ["GET /"]],
      ["axios.get(`/`);", ["GET /"]],
      ['api.post("/", body);', ["POST /"]],
      ['window.fetch("/", { method: "DELETE" });', ["DELETE /"]],
      ['authFetch("/");', ["GET /"]],
      ['fetch("http://localhost:3000/");', ["GET / based"]],
      ['fetch("/?page=2");', ["GET /"]],
      // A link, a form target and a source: HTML's request attributes.
      ['const a = <a href="/">home</a>;', ["GET /"]],
      // The method of a form in JSX is read for no path; the root is read as any other path there.
      ['const f = <form action="/" method="post" />;', ["* /"]],
      [next + 'const a = <Link href="/">home</Link>;', ["GET /"]],
      // A branch of a conditional is in the place of the conditional.
      [next + 'const a = <Link href={off ? "/" : "/docs"}>x</Link>;', ["GET /", "GET /docs"]],
      [next + 'const a = <Link href={off ? "/" : item.href}>x</Link>;', ["GET /"]],
      ['fetch(local ? "/" : "/api");', ["GET /", "GET /api"]],
      // The window's Location navigates with GET, as HTML defines.
      ['location.assign("/");', ["GET /"]],
      ['window.location.replace("/");', ["GET /"]],
      ['window.location.href = "/";', ["GET /"]],
      ['location.href = "/";', ["GET /"]],
      ['window.location = "/";', ["GET /"]],
    ]);
  });

  it("leaves a bare / anywhere else unread: a separator, a key, a part of a URL being built", () => {
    rows([
      ['const p = parts.join("/");', []],
      ['const s = path.split("/");', []],
      ['const u = base + "/" + id;', []],
      ["const u = `${a}/${b}`;", []],
      ['axios.get(parts.join("/"));', []],
      ['const ROOT = "/";', []],
      ['log("/");', []],
      ['if (path === "/") go();', []],
      ['cache.get(key, "/");', []],
      ['const nav = { href: "/" };', []],
      ['const parts = [];\nparts.push("/");', []],
      ['const location = useLocation();\nlocation.replace("/");', []],
      ['const x = { location: "/" };\nx.location.href = "/";', []],
      // A fetch the code declares is its own function, not the global one.
      ['function f(fetch) {\n  fetch("/");\n}', []],
      ['const window = { fetch: log };\nwindow.fetch("/");', []],
    ]);
  });

  it("reads / in code read as text only as the URL of a verb call", () => {
    const text = (file: string, code: string) => callsFromText(file, code, spec).map((c) => `${c.method} ${c.path}`);
    expect(text("Client.kt", 'val home = client.get("/")\nval parts = path.split("/")\nval root = "/"')).toEqual(["GET /"]);
    expect(text("client.py", 'r = requests.post("/", json=body)\nsep = "/".join(parts)')).toEqual(["POST /"]);
  });

  it("reads / in a template's links, form targets and sources, not in a configured data-* URL", () => {
    const call = { from: "web", to: "server", files: [], dataUrls: ["data-api-url"] };
    const calls = (html: string) => callsFromTemplate("t.html", html, call).map((c) => `${c.method} ${c.path} ${c.at.line}`);
    const html = [
      '<a href="/">home</a>',
      '<a th:href="@{/}">home</a>',
      '<form method="post" action="/"></form>',
      '<div data-api-url="/"></div>',
      '<a href="//cdn.example/">cdn</a>',
    ].join("\n");
    expect(calls(html)).toEqual(["GET / 1", "GET / 2", "POST / 3"]);
  });
});

describe("client-side routers (#34)", () => {
  const rr = 'import { Link, NavLink, Navigate, Route, createBrowserRouter, redirect, redirectDocument, useNavigate } from "react-router";\n';
  const tanstack = 'import { Link, Navigate, createFileRoute, createRouter, getRouteApi, redirect, useNavigate, useRouter } from "@tanstack/react-router";\n';

  it("reads no request in React Router's navigations and route definitions", () => {
    rows([
      [rr + 'const a = <Link to="/about">a</Link>;', []],
      [rr + 'const a = <NavLink to="/users" end />;', []],
      [rr + 'const a = <Navigate to="/login" replace />;', []],
      [rr + 'const a = <Link to={{ pathname: "/search", search: "?q=x" }} />;', []],
      [rr + 'const a = <Link to={off ? "/" : "/users"} />;', []],
      [rr + "const a = <Link to={`/users/${id}`} />;", []],
      [rr + 'const navigate = useNavigate();\nnavigate("/settings");', []],
      [rr + 'const navigate = useNavigate();\nnavigate({ pathname: "/settings" }, { replace: true });', []],
      [rr + 'export async function loader() {\n  throw redirect("/login");\n}', []],
      [rr + 'const r = <Route path="/users" element={<Users />} />;', []],
      [rr + 'const router = createBrowserRouter([{ path: "/", children: [{ path: "/users", loader: () => fetch("/api/users") }] }]);\nrouter.navigate("/users");', ["GET /api/users"]],
      ['import { Link, useNavigate } from "react-router-dom";\nconst navigate = useNavigate();\nnavigate("/settings");\nconst a = <Link to="/about" />;', []],
    ]);
  });

  it("reads no request in TanStack Router's navigations and route definitions", () => {
    rows([
      [tanstack + 'export const Route = createFileRoute("/_layout/items")({ component: Items });', []],
      [tanstack + 'const a = <Link to="/items" search={{ page: 1 }}>items</Link>;', []],
      [tanstack + 'const a = <Link from="/items" to="/items/$id" params={{ id }} />;', []],
      [tanstack + 'const a = <Navigate to="/login" />;', []],
      [tanstack + 'const navigate = useNavigate();\nnavigate({ to: "/login" });', []],
      [tanstack + 'const navigate = useNavigate({ from: "/items" });\nnavigate({ to: "/" });', []],
      [tanstack + 'throw redirect({ to: "/login", search: { next: "/items" } });', []],
      [tanstack + 'const router = useRouter();\nrouter.navigate({ to: "/items" });', []],
      [tanstack + 'const { navigate } = useRouter();\nnavigate({ to: "/items" });', []],
      [tanstack + 'const router = createRouter({ routeTree });\nrouter.navigate({ to: "/items" });', []],
      [tanstack + 'const api = getRouteApi("/items");', []],
      // A request made inside a route's options still runs.
      [tanstack + 'export const Route = createFileRoute("/items")({ loader: () => fetch("/api/v1/items") });', ["GET /api/v1/items"]],
    ]);
  });

  it("reads no request in a router imported as a namespace", () => {
    rows([
      ['import * as RR from "react-router";\nthrow RR.redirect("/login");', []],
      ['import * as RR from "react-router";\nconst a = <RR.Link to="/users" />;', []],
      ['import * as RR from "react-router";\nconst navigate = RR.useNavigate();\nnavigate("/settings");', []],
      ['import * as RR from "react-router";\nthrow RR.redirectDocument("/login");', ["GET /login"]],
      ['import * as TR from "@tanstack/react-router";\nconst navigate = TR.useNavigate();\nnavigate({ to: "/login" });', []],
      ['import * as ui from "./ui";\nconst a = <ui.Link to="/about" />;', ["* /about"]],
    ]);
  });

  it("reads a destination to another origin in a router's navigation, the root path too", () => {
    rows([
      [rr + 'const a = <Link to="http://localhost:8000/users" />;', ["* /users based"]],
      [rr + 'const a = <Link to="http://localhost:8000/" />;', ["* / based"]],
    ]);
  });

  it("reads a navigation that loads the document as a GET to the server", () => {
    rows([
      // Only the URL redirectDocument takes first; its response options are no request.
      [rr + 'throw redirectDocument("/login", { headers: { "X-Trace": "/internal" } });', ["GET /login"]],
      // Only the destination loads; the route navigated from and the search's values are the router's.
      [tanstack + 'const navigate = useNavigate();\nnavigate({ from: "/items", to: "/logout", reloadDocument: true, search: { next: "/items" } });', ["GET /logout"]],
      // reloadDocument set in a spread of a literal object, the last value set winning.
      [rr + 'const a = <Link {...{ reloadDocument: true }} to="/logout" />;', ["GET /logout"]],
      [rr + 'const a = <Link to="/" {...{ reloadDocument: true }} />;', ["GET /"]],
      [rr + 'const a = <Link reloadDocument {...{ reloadDocument: false }} to="/users" />;', []],
      [rr + 'const a = <Link {...{ to: "/logout", reloadDocument: true }} />;', ["GET /logout"]],
      [tanstack + 'const navigate = useNavigate();\nnavigate({ to: "/logout", ...{ reloadDocument: true } });', ["GET /logout"]],
      [tanstack + 'const navigate = useNavigate();\nnavigate({ reloadDocument: true, ...{ reloadDocument: false }, to: "/users" });', []],
      [rr + 'throw redirectDocument("/admin/login/");', ["GET /admin/login"]],
      [rr + "throw redirectDocument(`/admin/login/?next=${encodeURIComponent(next)}`);", ["GET /admin/login"]],
      [rr + 'const a = <Link to="/logout" reloadDocument>out</Link>;', ["GET /logout"]],
      [tanstack + 'const navigate = useNavigate();\nnavigate({ to: "/logout", reloadDocument: true });', ["GET /logout"]],
      [tanstack + 'const a = <Link to="/logout" reloadDocument={false} />;', []],
      ['window.location.href = "/login";', ["GET /login"]],
      ['location.href = "/login";', ["GET /login"]],
      ['location.assign("/login");', ["GET /login"]],
      ['document.location.replace("/login");', ["GET /login"]],
    ]);
  });

  it("knows a router by its import: the same names from anywhere else are read as before", () => {
    rows([
      ['import { Link } from "./ui";\nconst a = <Link to="/about" />;', ["* /about"]],
      ['import { useNavigate } from "./hooks";\nconst navigate = useNavigate();\nnavigate("/settings");', ["* /settings"]],
      ['import { redirect } from "./mine";\nredirect("/login");', ["* /login"]],
    ]);
  });

  it("reads nothing in the route tree TanStack Router generates, and still reads a file that registers the router", () => {
    const tree = [
      "import { Route as rootRouteImport } from './routes/__root'",
      "import { Route as LoginRouteImport } from './routes/login'",
      "const LoginRoute = LoginRouteImport.update({",
      "  id: '/login',",
      "  path: '/login',",
      "  getParentRoute: () => rootRouteImport,",
      "} as any)",
      "export interface FileRoutesByFullPath {",
      "  '/login': typeof LoginRoute",
      "}",
      "declare module '@tanstack/react-router' {",
      "  interface FileRoutesByPath {",
      "    '/login': {",
      "      id: '/login'",
      "      path: '/login'",
      "      fullPath: '/login'",
      "      preLoaderRoute: typeof LoginRouteImport",
      "      parentRoute: typeof rootRouteImport",
      "    }",
      "  }",
      "}",
    ].join("\n");
    expect(read(tree, "src/routeTree.gen.ts")).toEqual([]);
    const main = [
      'import { createRouter } from "@tanstack/react-router"',
      "const router = createRouter({ routeTree })",
      'declare module "@tanstack/react-router" {',
      "  interface Register {",
      "    router: typeof router",
      "  }",
      "}",
      'const onError = () => { window.location.href = "/login" }',
    ].join("\n");
    expect(read(main, "src/main.tsx")).toEqual(["GET /login"]);
  });
});

describe("inventory's Next.js pages (#34)", () => {
  it("offers next for pages only in a package that depends on next, or where no package.json says", () => {
    const page = "export default function Home() { return null; }\n";
    const styles = (files: Record<string, string>) => inventory(memory(files), []).routes.map((r) => `${r.file} ${r.style}`);
    expect(styles({ "web/package.json": '{"name":"web","dependencies":{"react-router":"7"}}', "web/src/pages/Home.tsx": page })).toEqual([]);
    expect(styles({ "web/package.json": '{"name":"web","dependencies":{"next":"15"}}', "web/src/pages/index.tsx": page })).toEqual(["web/src/pages/index.tsx next"]);
    expect(styles({ "web/src/pages/index.tsx": page })).toEqual(["web/src/pages/index.tsx next"]);
    // The nearest package.json decides: a package inside a Next.js monorepo that does not use it.
    expect(styles({ "package.json": '{"name":"mono","devDependencies":{"next":"15"}}', "spa/package.json": '{"name":"spa"}', "spa/src/pages/Home.tsx": page })).toEqual([]);
  });
});
