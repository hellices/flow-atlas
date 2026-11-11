import { describe, expect, it } from "vitest";
import { offersNext } from "../src/chains.js";
import { componentPath, normalizeConfig } from "../src/config.js";
import { callsFromTypeScript } from "../src/extract/calls.js";
import { nextRoute, nextStaticFile } from "../src/extract/routes.js";
import type { Graph } from "../src/model.js";
import { evaluate } from "../src/rules.js";
import { scan } from "../src/scan.js";
import type { Source } from "../src/source.js";

const memory = (files: Record<string, string>): Source => ({
  ref: "WORKTREE",
  list: () => Object.keys(files),
  read: (p) => files[p],
  asOf: () => "2026-11-01T00:00:00Z",
});

/** A Next.js app at the repository root whose own files call it. */
function app(files: Record<string, string>, more: Record<string, unknown> = {}) {
  const config = normalizeConfig({
    components: [{ name: "web", path: "." }],
    routes: [{ component: "web", files: ["app/**/*.{ts,tsx}", "src/app/**/*.{ts,tsx}"], styles: ["next"] }],
    calls: [{ from: "web", to: "web", files: ["app/**/*.{ts,tsx}", "src/app/**/*.{ts,tsx}", "components/**/*.tsx", "middleware.ts", "proxy.ts", "src/*.ts", "lib/*.ts"] }],
    ...more,
  });
  return { config, graph: scan(memory(files), config) };
}

const targets = (graph: Graph, path: string): string[] =>
  graph.edges.filter((e) => e.kind === "match" && graph.calls.find((c) => c.id === e.from)!.path === path).map((e) => e.to).sort();

describe("Next.js", () => {
  it("reads a component written as . or ./x/ as the directory its files sit in", () => {
    expect([".", "./", "", "./apps/web/", "apps/web", "apps//web/"].map(componentPath)).toEqual(["", "", "", "apps/web", "apps/web", "apps/web"]);
    const { graph } = app({ "app/page.tsx": "export default function Home() { return null; }" });
    expect(graph.surfaces.map((s) => s.id)).toEqual(["web|GET /", "web|HEAD /"]);
    expect(graph.components.map((c) => c.path)).toEqual([""]);
  });

  it("serves metadata routes at the paths Next.js gives them, and says which it leaves unread", () => {
    const rows: Array<[string, string | undefined, string | undefined]> = [
      ["app/robots.ts", "/robots.txt", "metadata"],
      ["src/app/manifest.js", "/manifest.webmanifest", "metadata"],
      ["app/sitemap.ts", "/sitemap.xml", "metadata"],
      // A sitemap serves in its segment; groups add none, a dynamic segment is a parameter.
      ["app/(shop)/products/sitemap.ts", "/products/sitemap.xml", "metadata"],
      ["app/[lang]/sitemap.tsx", "/{lang}/sitemap.xml", "metadata"],
      // Robots and manifest are read only at the root of app/; nested, they are no metadata route.
      ["app/blog/robots.ts", undefined, undefined],
      ["app/blog/manifest.ts", undefined, undefined],
      // Next.js generates the path of an image route.
      ["app/opengraph-image.tsx", "/opengraph-image", "image"],
      ["app/blog/icon2.tsx", "/blog/icon2", "image"],
      ["app/robots.mjs", undefined, undefined],
    ];
    expect(rows.map(([file]) => [nextRoute(file, "")?.path, nextRoute(file, "")?.kind])).toEqual(rows.map(([, path, kind]) => [path, kind]));
    const { config, graph } = app({
      "app/robots.ts": 'export default function robots() { return { rules: { userAgent: "*", allow: "/" } }; }',
      "app/products/sitemap.ts": "export async function generateSitemaps() { return [{ id: 0 }]; }\nexport default async function sitemap({ id }) { return []; }",
      "app/opengraph-image.tsx": "export default function Image() { return null; }",
      "app/manifest.ts": "const manifest = () => ({ name: \"Notes\" });\nexport default manifest;",
    });
    expect(graph.surfaces.map((s) => `${s.id}${s.implicit ? " (implicit)" : ""}`).sort()).toEqual([
      "web|GET /manifest.webmanifest (implicit)",
      "web|GET /products/sitemap/{id}.xml (implicit)",
      "web|GET /robots.txt (implicit)",
      "web|HEAD /manifest.webmanifest (implicit)",
      "web|HEAD /products/sitemap/{id}.xml (implicit)",
      "web|HEAD /robots.txt (implicit)",
      "web|OPTIONS /manifest.webmanifest (implicit)",
      "web|OPTIONS /products/sitemap/{id}.xml (implicit)",
      "web|OPTIONS /robots.txt (implicit)",
    ]);
    expect(graph.limits.filter((l) => l.startsWith("routes "))).toEqual(["routes web: app/opengraph-image.tsx is a metadata image route, served at a path Next.js generates; it is not read"]);
    // Crawlers and browsers request them by convention, never the app's own code: no rule expects a caller, and a call
    // that fetches one still reaches it.
    expect(evaluate(graph, config).map((f) => f.key)).toEqual([]);
    const fetched = app({
      "app/manifest.ts": "export default function manifest() { return {}; }",
      "lib/pwa.ts": 'export const load = () => fetch("/manifest.webmanifest");\nexport const any = () => request("/manifest.webmanifest");',
    });
    expect(targets(fetched.graph, "/manifest.webmanifest")).toEqual(["web|GET /manifest.webmanifest", "web|GET /manifest.webmanifest"]);
    // A split sitemap's GET calls generateSitemaps to find the id asked for, then the default export.
    const split = app({
      "app/sitemap.ts": 'export async function generateSitemaps() { return fetch("/api/ids"); }\nexport default async function sitemap({ id }) { return fetch("/api/pages"); }',
      "app/api/ids/route.ts": "export function GET() {}",
      "app/api/pages/route.ts": "export function GET() {}",
    });
    const reaches = (id: string) =>
      split.graph.edges.filter((e) => e.kind === "reach" && e.from === id).map((e) => split.graph.calls.find((c) => c.id === e.to)!.path).sort();
    expect(reaches("web|GET /sitemap/{id}.xml")).toEqual(["/api/ids", "/api/pages"]);
    expect(reaches("web|HEAD /sitemap/{id}.xml")).toEqual(["/api/ids", "/api/pages"]);
  });

  it("serves the files of public/ as GET and HEAD, and the metadata files of app/ with OPTIONS too, with no handler", () => {
    const rows: Array<[string, string | undefined]> = [
      ["public/favicon.ico", "/favicon.ico"],
      // A file's name is written as a request holds it: what the URL standard percent-encodes in a path is encoded.
      ["public/images/a b.png", "/images/a%20b.png"],
      ["public/{x}/100%#?.json", "/%7Bx%7D/100%25%23%3F.json"],
      ["public/fonts/inter@2x.ü.png", "/fonts/inter@2x.%C3%BC.png"],
      // public/ stays at the project's root when the code is under src/.
      ["src/public/x.png", undefined],
      ["app/favicon.ico", "/favicon.ico"],
      ["src/app/robots.txt", "/robots.txt"],
      ["app/manifest.json", "/manifest.json"],
      ["app/(docs)/docs/sitemap.xml", "/docs/sitemap.xml"],
      // Only the root of app/ holds a favicon; an image written as a file is served at its name in any segment.
      ["app/blog/favicon.ico", undefined],
      ["app/icon.png", "/icon.png"],
      ["app/_private/sitemap.xml", undefined],
    ];
    expect(rows.map(([file]) => nextStaticFile(file, "")?.path)).toEqual(rows.map(([, path]) => path));
    expect(nextStaticFile("apps/web/public/logo.svg", "apps/web")).toEqual({ path: "/logo.svg", kind: "public" });
    expect(nextStaticFile("public/logo.svg", "apps/web")).toBeUndefined();
    const { config, graph } = app({
      "public/favicon.ico": "",
      "public/fonts/inter.woff2": "",
      "app/[...slug]/page.tsx": "export default function Page() { return null; }",
      "app/layout.tsx": 'export const metadata = { icons: { icon: "/favicon.ico" } };\nexport default function Root({ children }) { return <html><head><link rel="preload" href="/fonts/inter.woff2" /></head><body>{children}</body></html>; }',
    }, { publicSurfaces: ["web|* /{slug}/**"] });
    // Next.js serves public files before any dynamic route, so neither reaches the catch-all.
    expect(targets(graph, "/favicon.ico")).toEqual(["web|GET /favicon.ico"]);
    expect(targets(graph, "/fonts/inter.woff2")).toEqual(["web|GET /fonts/inter.woff2"]);
    expect(graph.surfaces.filter((s) => s.path === "/favicon.ico").map((s) => `${s.id} ${s.implicit} ${s.at.file}:${s.at.line}`)).toEqual([
      "web|GET /favicon.ico true public/favicon.ico:1",
      "web|HEAD /favicon.ico true public/favicon.ico:1",
    ]);
    // Next.js compiles a metadata file into a route handler, which answers OPTIONS by itself; public/ is served as files.
    const served = app({
      "app/favicon.ico": "",
      "public/reports/annual report.pdf": "",
      "lib/files.ts": 'export const options = () => fetch("/favicon.ico", { method: "OPTIONS" });\nexport const report = () => fetch("/reports/annual%20report.pdf");',
    });
    expect(served.graph.surfaces.map((s) => s.id).sort()).toEqual([
      "web|GET /favicon.ico",
      "web|GET /reports/annual%20report.pdf",
      "web|HEAD /favicon.ico",
      "web|HEAD /reports/annual%20report.pdf",
      "web|OPTIONS /favicon.ico",
    ]);
    expect(targets(served.graph, "/favicon.ico")).toEqual(["web|OPTIONS /favicon.ico"]);
    expect(targets(served.graph, "/reports/annual%20report.pdf")).toEqual(["web|GET /reports/annual%20report.pdf"]);
    // No rule expects a caller for a file no code names.
    expect(evaluate(graph, config).map((f) => f.key)).toEqual([]);
    // An excluded file is not served as far as atlas reads.
    const excluded = app({ "public/favicon.ico": "" }, { exclude: ["public/**"] });
    expect(excluded.graph.surfaces).toEqual([]);
  });

  it("reaches every route a call with a value may be served by, down to the first that takes any value", () => {
    const { graph } = app({
      "app/editor/new/page.tsx": "export default function New() { return null; }",
      "app/editor/[id]/page.tsx": "export default function Edit() { return null; }",
      "app/[...slug]/page.tsx": "export default function Page() { return null; }",
      "app/docs/[[...slug]]/page.tsx": "export default function Docs() { return null; }",
      "public/files/report.pdf": "",
      "app/files/[name]/route.ts": "export function GET() {}",
      "lib/links.ts": [
        "export const edit = (id) => fetch(`/editor/${id}`);",
        "export const pre = (id) => fetch(`/editor/n${id}`);",
        "export const deep = (a, b) => fetch(`/editor/${a}/${b}`);",
        "export const doc = (a) => fetch(`/docs/${a}`);",
        "export const file = (n) => fetch(`/files/${n}`);",
      ].join("\n"),
    });
    // The static page may be the one, the dynamic segment takes every other value, and the catch-all none.
    expect(targets(graph, "/editor/{}")).toEqual(["web|* /editor/{id}", "web|GET /editor/new"]);
    expect(targets(graph, "/editor/n{}")).toEqual(["web|* /editor/{id}", "web|GET /editor/new"]);
    // Two segments under /editor fit only the catch-all.
    expect(targets(graph, "/editor/{}/{}")).toEqual(["web|* /{slug}/**"]);
    expect(targets(graph, "/docs/{}")).toEqual(["web|* /docs/{*slug}"]);
    // A public file is served before the route handler of the dynamic segment.
    expect(targets(graph, "/files/{}")).toEqual(["web|GET /files/report.pdf", "web|GET /files/{name}"]);
    // A route all of whose requests from the call a more specific route takes is reached by none of them: the call
    // reaches /editor/{id} only as /editor/new, which the static page serves.
    const crossed = app({
      "app/editor/new/page.tsx": "export default function New() { return null; }",
      "app/editor/[id]/page.tsx": "export default function Edit() { return null; }",
      "app/[section]/new/page.tsx": "export default function Add() { return null; }",
      "lib/links.ts": "export const add = (section) => fetch(`/${section}/new`);",
    });
    expect(targets(crossed.graph, "/{}/new")).toEqual(["web|* /{section}/new", "web|GET /editor/new"]);
  });

  it("reads no request in the matcher of a middleware or proxy", () => {
    const calls = (file: string, code: string) => callsFromTypeScript(file, code, { from: "a", to: "a", files: [] }).map((c) => `${c.method} ${c.path}`);
    const matcher = [
      "export function middleware() {}",
      'export const config = { matcher: ["/login", { source: "/account", has: [{ type: "header", key: "x-user" }] }] } as const;',
    ].join("\n");
    expect(calls("middleware.ts", matcher)).toEqual([]);
    expect(calls("src/middleware.js", matcher)).toEqual([]);
    expect(calls("proxy.ts", 'export function proxy() {}\nexport const config = { matcher: "/login" };')).toEqual([]);
    // A redirect in the middleware is a request; a config of another file, or one the file does not export, is not
    // a matcher Next.js reads.
    expect(calls("middleware.ts", 'export function middleware(req) { return Response.redirect(new URL("/login", req.url)); }\nexport const config = { matcher: ["/account"] };')).toEqual(["* /login"]);
    expect(calls("lib/config.ts", 'export const config = { matcher: ["/login"] };')).toEqual(["* /login"]);
    expect(calls("middleware.ts", 'const config = { matcher: ["/login"] };')).toEqual(["* /login"]);
  });

  it("goes with GET to either branch of a link's or a router's conditional address", () => {
    const head = 'import Link from "next/link";\nimport { useRouter } from "next/navigation";\nconst router = useRouter();\n';
    const calls = (code: string) => callsFromTypeScript("a.tsx", head + code, { from: "a", to: "a", files: [] }).map((c) => `${c.method} ${c.path}`).sort();
    expect(calls('const a = <Link href={ok ? "/notes" : "/login"}>n</Link>;')).toEqual(["GET /login", "GET /notes"]);
    expect(calls('const a = <a href={ok ? "#" : ("/notes")}>n</a>;')).toEqual(["GET /notes"]);
    expect(calls('router.push(ok ? "/notes" : "/login");')).toEqual(["GET /login", "GET /notes"]);
    // The condition is no address.
    expect(calls('const a = <Link href={go("/check") ? "/notes" : "/login"}>n</Link>;')).toEqual(["* /check", "GET /login", "GET /notes"]);
  });

  it("offers the links and forms a page and its layouts render on the server as the requests that may follow", () => {
    const { graph } = app({
      "app/layout.tsx": 'import Link from "next/link";\nexport default async function Root({ children }) { const s = await fetch("/api/session"); return <html><body><Link href="/">home</Link>{children}</body></html>; }',
      "app/(shop)/layout.tsx": 'import { Nav } from "../../components/nav";\nexport default function Shop({ children }) { return <div><Nav />{children}</div>; }',
      "app/(shop)/orders/template.tsx": 'export default function T({ children }) { return <form action="/api/orders">{children}</form>; }',
      "app/(shop)/orders/page.tsx": [
        'import Link from "next/link";',
        'import { Menu } from "../../../components/menu";',
        "export default function Orders({ ok }) {",
        '  const back = "/cart";',
        '  return <div><Link href={ok ? "/orders/new" : "#"}>new</Link><Link href={back}>cart</Link><Menu /><button formAction="/api/orders/clear">clear</button></div>;',
        "}",
      ].join("\n"),
      "app/(shop)/orders/new/page.tsx": "export default function New() { return null; }",
      "app/page.tsx": "export default function Home() { return null; }",
      "app/cart/page.tsx": "export default function Cart() { return null; }",
      "app/api/session/route.ts": "export function GET() {}",
      "app/api/orders/route.ts": "export function POST() {}",
      "app/api/orders/clear/route.ts": "export function POST() {}",
      "components/nav.tsx": 'import Link from "next/link";\nexport function Nav() { return <Link href="/cart">cart</Link>; }',
      "components/menu.tsx": '"use client";\nimport Link from "next/link";\nexport function Menu() { return <Link href="/orders/new">new</Link>; }',
    });
    // The layouts are read from the App Router's own directory, at the component's root or under its src/.
    expect([nextRoute("apps/app/src/app/x/page.tsx", "apps/app")?.app, nextRoute("web/app/x/page.tsx")?.app, nextRoute("pages/x.tsx", "")?.app]).toEqual([
      "apps/app/src/app",
      "web/app",
      undefined,
    ]);
    const reached = (id: string, next: boolean) =>
      graph.edges
        .filter((e) => e.kind === "reach" && e.from === id && offersNext(e) === next)
        .map((e) => `${graph.calls.find((c) => c.id === e.to)!.path} ${e.via} ${e.evidence}`)
        .sort();
    // The root layout's request runs in the page's request; its link, the group layout's component's, the template's
    // form and the page's own links are offered. A client component's link is the browser's, not the server's.
    expect(reached("web|GET /orders", false)).toEqual(["/api/session Root static"]);
    expect(reached("web|GET /orders", true)).toEqual([
      "/ view app/layout.tsx static",
      "/api/orders view app/(shop)/orders/template.tsx static",
      "/api/orders/clear view app/(shop)/orders/page.tsx static",
      "/cart view app/(shop)/orders/page.tsx static",
      "/cart view components/nav.tsx static",
      "/orders/new view app/(shop)/orders/page.tsx static",
    ]);
    // A HEAD response has no body, so it offers nothing; a page outside the group has only the root layout.
    expect(reached("web|HEAD /orders", true)).toEqual([]);
    expect(reached("web|GET /cart", true)).toEqual(["/ view app/layout.tsx static"]);
  });

  it("offers only what a link or a form holds: the address it ends in, through a const's branches", () => {
    const { graph } = app({
      "app/page.tsx": [
        'import Link from "next/link";',
        'import Form from "next/form";',
        'import { Badge } from "../components/badge";',
        'import { ClientLink } from "../components/client-link";',
        "export default function Home({ ok }) {",
        '  const back = ok ? "/cart" : "/login";',
        "  const again = back;",
        "  const x = y;",
        "  const y = x;",
        '  return <div><a href={("/ignored", "/next")}>n</a><Link href={again}>b</Link><Form action="/search" /><input formAction="/api/save" /><a href={x}>loop</a>',
        '    <Badge href="/badge" /><ClientLink href="/client" /><link rel="preload" href="/fonts/inter.woff2" /></div>;',
        "}",
      ].join("\n"),
      "components/badge.tsx": "export function Badge({ href }) { return <span>{href}</span>; }",
      "components/client-link.tsx": '"use client";\nexport function ClientLink({ href }) { return <a href={href}>x</a>; }',
    });
    const offered = graph.edges
      .filter((e) => e.kind === "reach" && e.from === "web|GET /" && offersNext(e))
      .map((e) => graph.calls.find((c) => c.id === e.to)!.path)
      .sort();
    // A component's prop, a client component's included, is no link unless what it renders is read; a <link> loads a
    // resource with the page; the left operand of a comma is discarded.
    expect(offered).toEqual(["/api/save", "/cart", "/login", "/next", "/search"]);
  });
});
