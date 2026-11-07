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
    const { graph } = app({
      "app/robots.ts": 'export default function robots() { return { rules: { userAgent: "*", allow: "/" } }; }',
      "app/products/sitemap.ts": "export async function generateSitemaps() { return [{ id: 0 }]; }\nexport default async function sitemap({ id }) { return []; }",
      "app/opengraph-image.tsx": "export default function Image() { return null; }",
      "app/manifest.ts": "const manifest = () => ({ name: \"Notes\" });\nexport default manifest;",
    });
    expect(graph.surfaces.map((s) => `${s.id}${s.implicit ? " (implicit)" : ""}`).sort()).toEqual([
      "web|GET /manifest.webmanifest",
      "web|GET /products/sitemap/{id}.xml",
      "web|GET /robots.txt",
      "web|HEAD /manifest.webmanifest (implicit)",
      "web|HEAD /products/sitemap/{id}.xml (implicit)",
      "web|HEAD /robots.txt (implicit)",
      "web|OPTIONS /manifest.webmanifest (implicit)",
      "web|OPTIONS /products/sitemap/{id}.xml (implicit)",
      "web|OPTIONS /robots.txt (implicit)",
    ]);
    expect(graph.limits.filter((l) => l.startsWith("routes "))).toEqual(["routes web: app/opengraph-image.tsx is a metadata image route, served at a path Next.js generates; it is not read"]);
  });

  it("serves the files of public/ and the metadata files of app/ as GET and HEAD with no handler", () => {
    const rows: Array<[string, string | undefined]> = [
      ["public/favicon.ico", "/favicon.ico"],
      ["public/images/a b.png", "/images/a b.png"],
      // public/ stays at the project's root when the code is under src/.
      ["src/public/x.png", undefined],
      ["app/favicon.ico", "/favicon.ico"],
      ["src/app/robots.txt", "/robots.txt"],
      ["app/manifest.json", "/manifest.json"],
      ["app/(docs)/docs/sitemap.xml", "/docs/sitemap.xml"],
      // Only the root of app/ holds a favicon; an image's path is generated.
      ["app/blog/favicon.ico", undefined],
      ["app/icon.png", undefined],
      ["app/_private/sitemap.xml", undefined],
    ];
    expect(rows.map(([file]) => nextStaticFile(file, ""))).toEqual(rows.map(([, path]) => path));
    expect(nextStaticFile("apps/web/public/logo.svg", "apps/web")).toBe("/logo.svg");
    expect(nextStaticFile("public/logo.svg", "apps/web")).toBeUndefined();
    const { config, graph } = app({
      "public/favicon.ico": "",
      "public/fonts/inter.woff2": "",
      "app/[...slug]/page.tsx": "export default function Page() { return null; }",
      "app/layout.tsx": 'export const metadata = { icons: { icon: "/favicon.ico" } };\nexport default function Root({ children }) { return <html><head><link rel="preload" href="/fonts/inter.woff2" /></head><body>{children}</body></html>; }',
    }, { publicSurfaces: ["web|GET /{slug}/**"] });
    // Next.js serves public files before any dynamic route, so neither reaches the catch-all.
    expect(targets(graph, "/favicon.ico")).toEqual(["web|GET /favicon.ico"]);
    expect(targets(graph, "/fonts/inter.woff2")).toEqual(["web|GET /fonts/inter.woff2"]);
    expect(graph.surfaces.filter((s) => s.path === "/favicon.ico").map((s) => `${s.id} ${s.implicit} ${s.at.file}:${s.at.line}`)).toEqual([
      "web|GET /favicon.ico true public/favicon.ico:1",
      "web|HEAD /favicon.ico true public/favicon.ico:1",
    ]);
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
    expect(targets(graph, "/editor/{}")).toEqual(["web|GET /editor/new", "web|GET /editor/{id}"]);
    expect(targets(graph, "/editor/n{}")).toEqual(["web|GET /editor/new", "web|GET /editor/{id}"]);
    // Two segments under /editor fit only the catch-all.
    expect(targets(graph, "/editor/{}/{}")).toEqual(["web|GET /{slug}/**"]);
    expect(targets(graph, "/docs/{}")).toEqual(["web|GET /docs/{*slug}"]);
    // A public file is served before the route handler of the dynamic segment.
    expect(targets(graph, "/files/{}")).toEqual(["web|GET /files/report.pdf", "web|GET /files/{name}"]);
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
});
