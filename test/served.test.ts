import { describe, expect, it } from "vitest";
import { normalizeConfig } from "../src/config.js";
import { extractRoutes } from "../src/extract/routes.js";
import { Constants } from "../src/extract/constants.js";
import { djb2, metadataSuffix, nextPageMethods } from "../src/extract/next.js";
import { Reach } from "../src/extract/reach.js";
import { matchCalls, rankedComponents } from "../src/match.js";
import type { Call, Surface } from "../src/model.js";
import { scan } from "../src/scan.js";
import type { Source } from "../src/source.js";

/** The routes a framework serves by itself, with no handler in the application's code (#48), and Next.js's page methods (#49). */
const memory = (files: Record<string, string>): Source => ({
  ref: "WORKTREE",
  list: () => Object.keys(files),
  read: (p) => files[p],
  asOf: () => "2026-11-01T00:00:00Z",
});
const lines = (...l: string[]) => l.join("\n");

/** Every surface a component's entry reads, with what marks it, and every limit. */
const read = (files: Record<string, string>, entry: Record<string, unknown>, path = "api") => {
  const limits: string[] = [];
  const config = normalizeConfig({ components: [{ name: "api", path }], routes: [{ component: "api", files: [path ? `${path}/**` : "**"], ...entry }] });
  const surfaces = extractRoutes(memory(files), config, undefined, [], limits);
  const mark = (s: Surface) => `${s.method} ${s.path}${s.implicit ? " (implicit)" : ""}${s.convention ? ` [${s.convention}]` : ""}`;
  return { surfaces: surfaces.map(mark), limits, raw: surfaces };
};

describe("FastAPI's own documentation routes", () => {
  const fastapi = { styles: ["fastapi"] };
  const docs = (prefix = "", line = 2) =>
    [
      ["openapi.json", "openapi_url"],
      ["docs", "docs_url"],
      ["docs/oauth2-redirect", "swagger_ui_oauth2_redirect_url"],
      ["redoc", "redoc_url"],
    ].flatMap(([path, setting]) => [`GET ${prefix}/${path} (implicit) [fastapi ${setting}]`, `HEAD ${prefix}/${path} (implicit) [fastapi ${setting}]`].map((s) => `${s} @${line}`));
  const at = (r: ReturnType<typeof read>) => r.raw.map((s) => `${s.method} ${s.path}${s.implicit ? " (implicit)" : ""}${s.convention ? ` [${s.convention}]` : ""} @${s.at.line}`);

  it("serves the document, Swagger UI with its OAuth2 redirect and ReDoc at their defaults, before the app's own routes, under where the app is mounted", () => {
    const main = lines("from fastapi import FastAPI", "app = FastAPI()", "sub = FastAPI()", '@app.get("/docs")', "def mine(): ...", 'app.mount("/sub", sub)');
    const r = read({ "api/main.py": main }, fastapi);
    expect(at(r)).toEqual([...docs("", 2), ...docs("/sub", 3)]);
    expect(r.limits).toEqual([]);
    // FastAPI adds them as it makes the application, before any route of the code: Swagger UI answers GET /docs, and the
    // code's own route there is never reached.
    expect(r.raw.find((s) => s.method === "GET" && s.path === "/docs")).toMatchObject({ implicit: true, convention: "fastapi docs_url", at: { file: "api/main.py", line: 2 } });
  });

  it("turns a route off where its setting is None or empty, and takes the paths the file spells out", () => {
    const app = (args: string) => read({ "api/main.py": lines("from fastapi import FastAPI", `app = FastAPI(${args})`) }, fastapi);
    expect(app("openapi_url=None")).toMatchObject({ surfaces: [], limits: [] });
    expect(app('openapi_url=""')).toMatchObject({ surfaces: [], limits: [] });
    expect(app("docs_url=None, redoc_url=None")).toMatchObject({ surfaces: ["GET /openapi.json (implicit) [fastapi openapi_url]", "HEAD /openapi.json (implicit) [fastapi openapi_url]"], limits: [] });
    expect(app("swagger_ui_oauth2_redirect_url=None, redoc_url=None")).toMatchObject({
      limits: [],
      surfaces: [
        "GET /openapi.json (implicit) [fastapi openapi_url]",
        "HEAD /openapi.json (implicit) [fastapi openapi_url]",
        "GET /docs (implicit) [fastapi docs_url]",
        "HEAD /docs (implicit) [fastapi docs_url]",
      ],
    });
    // The redirect keeps its own default whatever docs_url is.
    expect(app('openapi_url="/api/v1/openapi.json", docs_url="/api/docs", redoc_url=None')).toMatchObject({
      limits: [],
      surfaces: [
        "GET /api/v1/openapi.json (implicit) [fastapi openapi_url]",
        "HEAD /api/v1/openapi.json (implicit) [fastapi openapi_url]",
        "GET /api/docs (implicit) [fastapi docs_url]",
        "HEAD /api/docs (implicit) [fastapi docs_url]",
        "GET /docs/oauth2-redirect (implicit) [fastapi swagger_ui_oauth2_redirect_url]",
        "HEAD /docs/oauth2-redirect (implicit) [fastapi swagger_ui_oauth2_redirect_url]",
      ],
    });
  });

  it("reads none of them where a setting is not spelled out, and says so", () => {
    const app = (args: string) => read({ "api/main.py": lines("from fastapi import FastAPI", `app = FastAPI(${args})`) }, fastapi);
    expect(app('openapi_url=f"{settings.API_V1_STR}/openapi.json"')).toMatchObject({
      surfaces: [],
      limits: [
        'routes api: api/main.py:2 creates the FastAPI application app with openapi_url the file does not spell out as a path (f"{settings.API_V1_STR}/openapi.json"); the routes FastAPI serves by itself for it (its OpenAPI document, Swagger UI and ReDoc) are not read',
      ],
    });
    expect(app("**settings").limits).toEqual([
      "routes api: api/main.py:2 creates the FastAPI application app with openapi_url the file does not spell out as a path (**settings); the routes FastAPI serves by itself for it (its OpenAPI document, Swagger UI and ReDoc) are not read",
    ]);
    expect(app('docs_url="docs"')).toMatchObject({
      surfaces: [],
      limits: ['routes api: api/main.py:2 creates the FastAPI application app with docs_url the file does not spell out as a path ("docs"); the routes FastAPI serves by itself for it (its OpenAPI document, Swagger UI and ReDoc) are not read'],
    });
  });

  it("reads none for an application made twice with other settings, and its own routes all the same", () => {
    const r = read({ "api/main.py": lines("from fastapi import FastAPI", "if PROD:", "    app = FastAPI(docs_url=None)", "else:", "    app = FastAPI()", '@app.get("/items")', "def items(): ...") }, fastapi);
    expect(r).toMatchObject({
      surfaces: ["GET /items"],
      limits: ["routes api: api/main.py:3 creates the FastAPI application app with documentation settings that differ where the file makes it twice; the routes FastAPI serves by itself for it (its OpenAPI document, Swagger UI and ReDoc) are not read"],
    });
  });

  it("asks only for the settings of the routes that are served", () => {
    const app = (args: string) => read({ "api/main.py": lines("from fastapi import FastAPI", `app = FastAPI(${args})`) }, fastapi);
    expect(app("openapi_url=None, docs_url=DOCS, redoc_url=REDOC")).toMatchObject({ surfaces: [], limits: [] });
    expect(app("docs_url=None, redoc_url=None, swagger_ui_oauth2_redirect_url=REDIRECT")).toMatchObject({
      surfaces: ["GET /openapi.json (implicit) [fastapi openapi_url]", "HEAD /openapi.json (implicit) [fastapi openapi_url]"],
      limits: [],
    });
  });

  it("keeps the document route where an included router of another file has the same path, as FastAPI dispatches it", () => {
    const r = read(
      {
        "api/a_routes.py": lines("from fastapi import APIRouter", "router = APIRouter()", '@router.get("/docs")', "def mine(): ..."),
        "api/main.py": lines("from fastapi import FastAPI", "from .a_routes import router", "app = FastAPI(redoc_url=None)", "app.include_router(router)"),
      },
      fastapi,
    );
    expect(r.raw.filter((s) => s.method === "GET" && s.path === "/docs")).toMatchObject([{ implicit: true, convention: "fastapi docs_url", at: { file: "api/main.py", line: 3 } }]);
    expect(r.limits).toEqual([]);
  });

  it("reads them only for an application served where atlas reads it", () => {
    const r = read({ "api/main.py": lines("from fastapi import FastAPI", "sub = FastAPI(docs_url=None, redoc_url=None)", "app = FastAPI(openapi_url=None)", "app.mount(PREFIX, sub)") }, fastapi);
    expect(r).toMatchObject({
      surfaces: [],
      limits: ["routes api: api/main.py:4 mounts sub at a path the file does not spell out (PREFIX); the routes of api/main.py (sub) are not read (declare where it is served in mounts)"],
    });
  });
});

describe("the route @fastify/static registers", () => {
  const express = { styles: ["express"] };
  const pkg = JSON.stringify({ dependencies: { fastify: "^5.6.0", "@fastify/static": "^10.1.0" } });
  const plugin = (register: string, head = 'import fastifyStatic from "@fastify/static";') =>
    read({ "api/package.json": pkg, "api/app.js": lines(head, "export default async function app(fastify) {", `  ${register}`, "}"), "api/server.js": lines('import Fastify from "fastify";', 'import app from "./app.js";', "const fastify = Fastify();", "fastify.register(app);") }, express);
  const served = (path: string) => [`GET ${path} (implicit) [@fastify/static]`, `HEAD ${path} (implicit) [@fastify/static]`];

  it("serves GET and HEAD under its prefix, with a / added unless prefixAvoidTrailingSlash", () => {
    expect(plugin('fastify.register(fastifyStatic, { root: "/srv", prefix: "/public/" });')).toMatchObject({ surfaces: served("/public/**"), limits: [] });
    expect(plugin('fastify.register(fastifyStatic, { root: "/srv", prefix: "/assets" });')).toMatchObject({ surfaces: served("/assets/**"), limits: [] });
    expect(plugin('fastify.register(fastifyStatic, { root: "/srv" });')).toMatchObject({ surfaces: served("/**"), limits: [] });
    // With redirect, the prefix as written redirects to the one with the `/`.
    expect(plugin('fastify.register(fastifyStatic, { root: "/srv", prefix: "/assets", redirect: true });')).toMatchObject({ surfaces: [...served("/assets/**"), "GET /assets (implicit) [@fastify/static]"], limits: [] });
    expect(plugin('fastify.register(fastifyStatic, { root: "/srv", prefix: "/assets/", redirect: true });')).toMatchObject({ surfaces: served("/assets/**"), limits: [] });
  });

  it("knows the plugin by any name it is imported, required or loaded under, and its options held in a const", () => {
    for (const [head, name] of [
      ['import serve from "@fastify/static";', "serve"],
      ['import { fastifyStatic as files } from "@fastify/static";', "files"],
      ['import * as statics from "@fastify/static";', "statics.default"],
      ['const files = require("@fastify/static");', "files"],
      ['const { fastifyStatic: files } = require("@fastify/static");', "files"],
      ["", 'import("@fastify/static")'],
      ["", 'require("@fastify/static")'],
    ]) {
      expect(plugin(`fastify.register(${name}, { root: "/srv", prefix: "/files" });`, head)).toMatchObject({ surfaces: served("/files/**"), limits: [] });
    }
    expect(plugin('const options = { root: "/srv", prefix: "/files" };\n  fastify.register(fastifyStatic, options);')).toMatchObject({ surfaces: served("/files/**"), limits: [] });
    // Another plugin is not it.
    expect(plugin('fastify.register(fastifyStatic, { prefix: "/x" });', 'import fastifyStatic from "@fastify/other";')).toMatchObject({ surfaces: [], limits: [] });
  });

  it("registers none with serve: false, and says where its route is not read", () => {
    expect(plugin('fastify.register(fastifyStatic, { root: "/srv", serve: false });')).toMatchObject({ surfaces: [], limits: [] });
    expect(plugin('fastify.register(fastifyStatic, { root: "/srv", wildcard: false });')).toMatchObject({
      surfaces: [],
      limits: ["routes api: api/app.js:3 registers @fastify/static with wildcard: false, under which it registers a route for each file under its root as the server starts; the route it serves its files at is not read"],
    });
    expect(plugin('fastify.register(fastifyStatic, { root: "/srv", prefix: PREFIX });')).toMatchObject({
      surfaces: [],
      limits: ["routes api: api/app.js:3 registers @fastify/static with prefix the file does not spell out; the route it serves its files at is not read"],
    });
    expect(plugin("fastify.register(fastifyStatic, { ...options });")).toMatchObject({
      surfaces: [],
      limits: ["routes api: api/app.js:3 registers @fastify/static with serve and wildcard and prefix and prefixAvoidTrailingSlash and redirect the file does not spell out; the route it serves its files at is not read"],
    });
    expect(plugin("fastify.register(fastifyStatic, options);")).toMatchObject({
      surfaces: [],
      limits: ["routes api: api/app.js:3 registers @fastify/static with options the file does not spell out (options); the route it serves its files at is not read"],
    });
  });

  it("says once where the path syntax of the Fastify it runs on is not read", () => {
    const r = read({ "api/app.js": lines('import Fastify from "fastify";', 'import fastifyStatic from "@fastify/static";', "const fastify = Fastify();", 'fastify.register(fastifyStatic, { root: "/srv", prefix: "/files/" });') }, express);
    expect(r).toMatchObject({
      surfaces: [],
      limits: ["routes api: api/app.js:4 registers /files/*, a path not read: no package.json above it gives one major version of fastify, whose path syntax differs between versions"],
    });
  });

  it("serves it under the prefix of the plugin it is registered in", () => {
    const r = read(
      {
        "api/package.json": pkg,
        "api/app.js": lines(
          'import Fastify from "fastify";',
          'import fastifyStatic from "@fastify/static";',
          "const fastify = Fastify();",
          'fastify.register(async (api) => { api.register(fastifyStatic, { root: "/srv", prefix: "/files/" }); }, { prefix: "/v1" });',
        ),
      },
      express,
    );
    expect(r).toMatchObject({ surfaces: served("/v1/files/**"), limits: [] });
  });
});

/** A Next.js app at `web/`, read as `scan` reads it: its surfaces, each with what marks it, and every limit about routes. */
const next = (files: Record<string, string>, more: Record<string, string> = {}) => {
  const config = normalizeConfig({
    components: [{ name: "web", path: "web" }],
    routes: [{ component: "web", files: ["web/app/**/*.{ts,tsx,js,jsx}", "web/pages/**/*.{ts,tsx,js,jsx}", "web/src/**/*.{ts,tsx}"], styles: ["next"] }],
  });
  const all = { "web/package.json": JSON.stringify({ dependencies: { next: "^16.4.0" } }), ...Object.fromEntries(Object.entries(files).map(([f, t]) => [`web/${f}`, t])), ...more };
  const graph = scan(memory(all), config);
  const mark = (s: Surface) => `${s.method} ${s.path}${s.implicit ? " (implicit)" : ""}${s.convention ? ` [${s.convention}]` : ""}`;
  return { surfaces: graph.surfaces.map(mark).sort(), limits: graph.limits.filter((l) => l.startsWith("routes ")), graph };
};
const page = (body = "return null;") => `export default function Page() { ${body} }`;
/** A page Next.js surely prerenders, whatever it renders. */
const prerendered = `export const dynamic = "force-static";\n${page()}`;
const home = ["GET /", "HEAD / (implicit)"];
const builtins = ["GET /_next/static/{file}/** (implicit) [next build assets]", "HEAD /_next/static/{file}/** (implicit) [next build assets]", "* /_next/image (implicit) [next image optimizer]"];
const assumed = (...files: string[]) =>
  `routes web: Next.js prerenders a page at build unless rendering it calls a request-time API (cookies(), headers(), connection(), searchParams, a fetch with no-store); atlas sees one only in the code it follows from the page and its layouts, not in packages or in modules imported by another path than a relative one, so these pages, where it sees none, are read as taking GET alone: ${files.join(", ")}`;

describe("what Next.js serves by itself", () => {
  it("serves the build's files and the image optimizer under basePath, where package.json names next", () => {
    expect(next({})).toMatchObject({ surfaces: [...builtins].sort(), limits: ["routes web: the configured files match nothing"] });
    const at = next({}).graph.surfaces.find((s) => s.path === "/_next/image")!;
    expect(at).toMatchObject({ at: { file: "web/package.json", line: 1 }, evidence: "declared" });
    expect(next({ "next.config.mjs": 'export default { basePath: "/docs" };' })).toMatchObject({ surfaces: ["* /docs/_next/image (implicit) [next image optimizer]", "GET /docs/_next/static/{file}/** (implicit) [next build assets]", "HEAD /docs/_next/static/{file}/** (implicit) [next build assets]"], limits: ["routes web: the configured files match nothing"] });
    // A package.json that does not name next, and no configuration, bring none in.
    expect(next({}, { "web/package.json": "{}" })).toMatchObject({ surfaces: [], limits: ["routes web: the configured files match nothing"] });
  });

  it("serves no image optimizer without the default loader, with unoptimized images or as a static export", () => {
    const without = builtins.slice(0, 2);
    for (const config of [
      "export default { images: { unoptimized: true } };",
      'export default { images: { loader: "custom", loaderFile: "./loader.js" } };',
      'export default { images: { loader: "cloudinary", path: "https://x/" } };',
      'export default { output: "export" };',
      'const images = { unoptimized: true };\nexport default { images };',
    ]) {
      expect(next({ "next.config.mjs": config, "app/page.tsx": prerendered })).toMatchObject({ surfaces: [...without, ...home].sort(), limits: [] });
    }
    expect(next({ "next.config.mjs": "export default { images: { unoptimized: false, loader: 'default' } };" })).toMatchObject({ surfaces: [...builtins].sort(), limits: ["routes web: the configured files match nothing"] });
  });

  it("says where the configuration they depend on is not read", () => {
    expect(next({ "next.config.mjs": "export default withPlugin({});", "app/page.tsx": prerendered })).toMatchObject({
      surfaces: home,
      limits: [
        'routes web: web/next.config.mjs exports withPlugin({}), not an object it spells out, so whether it builds a static export (output: "export"), where Next.js prerenders every page, or turns on cacheComponents or partial prerendering, under which it prerenders a shell even of a page that reads the request is not read; which pages Next.js refuses methods other than GET for is then not read, and each page is read as if it did not',
        "routes web: web/next.config.mjs exports withPlugin({}), not an object it spells out, so the basePath Next.js serves its build's files (/_next/static) and image optimizer (/_next/image) under is not read; they are not read",
        "routes web: web/next.config.mjs exports withPlugin({}), not an object it spells out; whether Next.js redirects a request with or without a trailing / is not read, so a call is matched to its route either way",
      ],
    });
    expect(next({ "next.config.mjs": "export default { basePath: process.env.BASE };", "app/page.tsx": prerendered }).limits).toEqual([
      "routes web: web/next.config.mjs sets basePath to a value it does not spell out as a path, so where Next.js serves its build's files (/_next/static) and image optimizer (/_next/image) is not read; they are not read",
    ]);
    expect(next({ "next.config.mjs": "export default { images: { ...shared } };", "app/page.tsx": prerendered })).toMatchObject({
      surfaces: [...builtins.slice(0, 2), ...home].sort(),
      limits: ["routes web: web/next.config.mjs sets images.loader and images.loaderFile and images.unoptimized to a value it does not spell out, so whether Next.js serves its image optimizer (/_next/image) is not read; it is not read"],
    });
  });

  it("serves the image metadata files of app/ at their names in any segment, with the suffix a group or a slot gives", () => {
    const r = next({ "app/apple-icon.png": "", "app/blog/opengraph-image.jpg": "", "app/[lang]/icon1.svg": "", "app/(site)/about/twitter-image.gif": "", "app/apple-icon.gif": "", "app/_x/icon.png": "" });
    const suffix = djb2("/(site)/about").toString(36).slice(0, 6);
    expect(r.surfaces.filter((s) => s.includes("metadata"))).toEqual(
      [
        ...["/apple-icon.png", "/blog/opengraph-image.jpg", "/{lang}/icon1.svg", `/about/twitter-image-${suffix}.gif`].flatMap((p) => ["GET", "HEAD", "OPTIONS"].map((m) => `${m} ${p} (implicit) [next metadata file]`)),
      ].sort(),
    );
    expect([metadataSuffix(["blog"]), metadataSuffix(["@modal", "x"]).length, metadataSuffix(["@children"])]).toEqual(["", 7, ""]);
    // Next.js's djb2Hash over UTF-16 code units, kept to 32 bits.
    expect([djb2(""), djb2("a"), djb2("/(site)"), suffix]).toEqual([5381, 177670, 2338041434, "1ycygp"]);
  });
});

describe("the methods a Next.js page answers", () => {
  /** Each page's surfaces, but what Next.js serves by itself. */
  const pages = (files: Record<string, string>, more: Record<string, string> = {}) => {
    const r = next(files, more);
    return { surfaces: r.surfaces.filter((s) => !s.includes("_next/")), limits: r.limits };
  };
  const get = (path: string) => [`GET ${path}`, `HEAD ${path} (implicit)`];

  it("reads a page under a dynamic segment as any method, Next.js never prerendering its route", () => {
    expect(pages({ "app/blog/[slug]/page.tsx": page(), "app/docs/[[...slug]]/page.tsx": page(), "app/shop/[...all]/page.tsx": page() })).toEqual({
      surfaces: ["* /blog/{slug}", "* /docs/{*slug}", "* /shop/{all}/**"],
      limits: [],
    });
    // generateStaticParams prerenders some paths, but the route itself is still none Next.js refuses other methods at.
    expect(pages({ "app/blog/[slug]/page.tsx": `export async function generateStaticParams() { return [{ slug: "a" }]; }\n${page()}` })).toMatchObject({ surfaces: ["* /blog/{slug}"], limits: [] });
  });

  it("reads the segment config of the page and the layouts above it, the nearer force-static winning over revalidate = 0", () => {
    expect(pages({ "app/layout.tsx": `export const dynamic = "force-dynamic";\n${page()}`, "app/a/page.tsx": page() })).toMatchObject({ surfaces: ["* /a"], limits: [] });
    expect(pages({ "app/a/page.tsx": `export const revalidate = 0;\n${page()}` })).toMatchObject({ surfaces: ["* /a"], limits: [] });
    expect(pages({ "app/layout.tsx": `export const dynamic = "force-static";\n${page()}`, "app/a/page.tsx": `export const revalidate = 0;\n${page()}` })).toEqual({ surfaces: get("/a"), limits: [] });
    // force-static above is undone by auto below it.
    expect(pages({ "app/layout.tsx": `export const dynamic = "force-static";\n${page()}`, "app/a/page.tsx": `export const dynamic = "auto";\nexport const revalidate = 0;\n${page()}` })).toMatchObject({ surfaces: ["* /a"], limits: [] });
    // A page that must stay static fails the build where it reads the request: what it renders is not looked at.
    expect(pages({ "app/a/page.tsx": `import { cookies } from "next/headers";\nexport const dynamic = "error";\n${page("cookies(); return null;")}` })).toEqual({ surfaces: get("/a"), limits: [] });
    expect(pages({ "app/a/page.tsx": `import { dynamic } from "./config";\nexport { dynamic };\n${page()}` })).toEqual({
      surfaces: get("/a"),
      limits: [
        "routes web: web/app/a/page.tsx exports dynamic as a value it does not spell out; whether Next.js renders the page on each request, answering any method, is not read, and it is read as GET",
        assumed("web/app/a/page.tsx"),
      ],
    });
  });

  it("reads a page that calls a request-time API in what renders it as any method, under any name it imports it by", () => {
    for (const [head, call] of [
      ['import { cookies } from "next/headers";', "cookies()"],
      ['import { headers as h } from "next/headers";', "h()"],
      ['import * as nh from "next/headers";', "nh.cookies()"],
      ['import { connection } from "next/server";', "connection()"],
      ['import { unstable_noStore } from "next/cache";', "unstable_noStore()"],
      ["", 'fetch("https://x", { cache: "no-store" })'],
      ["", 'fetch("https://x", { next: { revalidate: 0 } })'],
    ]) {
      expect(pages({ "app/a/page.tsx": `${head}\nexport default async function Page() { await ${call}; return null; }` })).toEqual({ surfaces: ["* /a"], limits: [] });
    }
    expect(pages({ "app/a/page.tsx": 'export default async function Page() { await fetch("https://x", { cache: "no-cache" }); return null; }' })).toEqual({ surfaces: ["* /a"], limits: [] });
    // Where cache and revalidate disagree, Next.js unsets both, and what the fetch does depends on its cache.
    for (const options of ['{ cache: "no-store", next: { revalidate: 60 } }', '{ cache: "no-store", next: { revalidate: false } }', '{ cache: "force-cache", next: { revalidate: 0 } }']) {
      expect(pages({ "app/a/page.tsx": `export default async function Page() { await fetch("https://x", ${options}); return null; }` })).toEqual({ surfaces: get("/a"), limits: [assumed("web/app/a/page.tsx")] });
    }
    // In a component it renders from a relative import, or in a layout above it.
    expect(pages({ "app/a/page.tsx": 'import { Nav } from "../nav";\nexport default function Page() { return <Nav />; }', "app/nav.tsx": 'import { cookies } from "next/headers";\nexport function Nav() { cookies(); return null; }' })).toMatchObject({ surfaces: ["* /a"], limits: [] });
    expect(pages({ "app/layout.tsx": 'import { headers } from "next/headers";\nexport default async function Root({ children }) { await headers(); return children; }', "app/a/page.tsx": page() })).toMatchObject({ surfaces: ["* /a"], limits: [] });
    expect(pages({ "app/a/page.tsx": 'import { cookies } from "next/headers";\nexport async function generateMetadata() { await cookies(); return {}; }\nexport default function Page() { return null; }' })).toMatchObject({ surfaces: ["* /a"], limits: [] });
    // Not in a client component, a fetch Next.js may cache, a local function of that name, or a handler it renders for later.
    const client = { "app/a/page.tsx": 'import { Box } from "../box";\nexport default function Page() { return <Box />; }', "app/box.tsx": '"use client";\nimport { cookies } from "next/headers";\nexport function Box() { cookies(); return null; }' };
    expect(pages(client)).toMatchObject({ surfaces: get("/a"), limits: [assumed("web/app/a/page.tsx")] });
    expect(pages({ "app/a/page.tsx": 'export default async function Page() { await fetch("https://x", { cache: "force-cache" }); return null; }' })).toMatchObject({ surfaces: get("/a"), limits: [assumed("web/app/a/page.tsx")] });
    expect(pages({ "app/a/page.tsx": "const cookies = () => 1;\nexport default function Page() { cookies(); return null; }" })).toMatchObject({ surfaces: get("/a"), limits: [assumed("web/app/a/page.tsx")] });
    expect(pages({ "app/a/page.tsx": 'import { cookies } from "next/headers";\nexport default function Page() { return <button onClick={() => cookies()} />; }' })).toMatchObject({ surfaces: get("/a"), limits: [assumed("web/app/a/page.tsx")] });
  });

  it("reads a page that reads its searchParams as any method, and names one that hands them on", () => {
    expect(pages({ "app/a/page.tsx": "export default async function Page({ searchParams }) { const { q } = await searchParams; return q; }" })).toMatchObject({ surfaces: ["* /a"], limits: [] });
    expect(pages({ "app/a/page.tsx": "export default async function Page(props) { const q = (await props.searchParams).q; return q; }" })).toMatchObject({ surfaces: ["* /a"], limits: [] });
    expect(pages({ "app/a/page.tsx": "export default async function Page({ searchParams: sp }) { return sp.q; }" })).toMatchObject({ surfaces: ["* /a"], limits: [] });
    expect(pages({ "app/a/page.tsx": 'export default async function Page(props) { const { q } = await props["searchParams"]; return q; }' })).toEqual({ surfaces: ["* /a"], limits: [] });
    expect(pages({ "app/a/page.tsx": "export default async function Page(props) { const sp = props.searchParams; return (await sp).q; }" })).toEqual({ surfaces: ["* /a"], limits: [] });
    // Taking the value alone reads nothing; handing it on is not followed.
    expect(pages({ "app/a/page.tsx": "export default function Page(props) { const unused = props.searchParams; props.searchParams; return null; }" })).toEqual({ surfaces: get("/a"), limits: [assumed("web/app/a/page.tsx")] });
    expect(pages({ "app/a/page.tsx": "export default function Page(props) { return <List q={props.searchParams} />; }" })).toEqual({ surfaces: get("/a"), limits: [assumed("web/app/a/page.tsx")] });
    expect(pages({ "app/a/page.tsx": "export default async function Page({ params }) { return (await params).id; }" })).toEqual({ surfaces: get("/a"), limits: [assumed("web/app/a/page.tsx")] });
    expect(pages({ "app/a/page.tsx": "export default function Page({ searchParams }) { return <List searchParams={searchParams} />; }" })).toEqual({ surfaces: get("/a"), limits: [assumed("web/app/a/page.tsx")] });
  });

  it("reads the Pages Router's data functions: getServerSideProps and getInitialProps render on each request, getStaticProps not", () => {
    expect(
      pages({
        "pages/a.tsx": `export async function getServerSideProps() { return { props: {} }; }\n${page()}`,
        "pages/b.tsx": `export const getStaticProps = async () => ({ props: {} });\n${page()}`,
        "pages/c.tsx": "function Page() { return null; }\nPage.getInitialProps = async () => ({});\nexport default Page;",
        "pages/d.tsx": "export default class D extends React.Component { static async getInitialProps() { return {}; } render() { return null; } }",
        "pages/e.tsx": page(),
        "pages/f.tsx": 'export { default, getServerSideProps } from "../lib/f";',
      }),
    ).toEqual({ surfaces: ["* /a", ...get("/b"), "* /c", "* /d", ...get("/e"), "* /f"].sort(), limits: [] });
    // getInitialProps on the class or function the default export names, and on no other.
    expect(
      pages({
        "pages/g.tsx": "class G extends React.Component { static getInitialProps() { return {}; } render() { return null; } }\nexport default G;",
        "pages/h.tsx": "const H = class { static ['getInitialProps']() { return {}; } render() { return null; } };\nexport { H as default };",
        "pages/i.tsx": "function Helper() {}\nHelper.getInitialProps = () => ({});\nexport default function () { return null; }",
        "pages/j.tsx": "function Page() { return null; }\nfunction Other() {}\nOther.getInitialProps = () => ({});\nexport default Page;",
      }),
    ).toEqual({ surfaces: ["* /g", "* /h", ...get("/i"), ...get("/j")].sort(), limits: [] });
    const classApp = "class App extends React.Component { static async getInitialProps() { return {}; } render() { return null; } }\nexport default App;";
    expect(pages({ "pages/_app.tsx": classApp, "pages/a.tsx": page() })).toEqual({ surfaces: ["* /a"], limits: [] });
    // A custom App's getInitialProps renders every page without getStaticProps on each request.
    const app = "function App({ Component }) { return <Component />; }\nApp.getInitialProps = async () => ({});\nexport default App;";
    expect(pages({ "pages/_app.tsx": app, "pages/a.tsx": page(), "pages/b.tsx": `export function getStaticProps() { return { props: {} }; }\n${page()}` })).toMatchObject({ surfaces: ["* /a", ...get("/b")], limits: [] });
    expect(pages({ "pages/a.tsx": `export * from "../lib/a";\n${page()}` })).toEqual({
      surfaces: get("/a"),
      limits: ["routes web: web/pages/a.tsx re-exports everything another module exports (export *), which may give getServerSideProps; whether Next.js renders the page on each request, answering any method, is not read, and it is read as GET"],
    });
  });

  it("reads POST beside GET where a Server Action may post to a prerendered page", () => {
    const post = "POST /a (implicit) [next server action]";
    const inline = 'export default function Page() { async function save() { "use server"; } return <form action={save} />; }';
    expect(pages({ "app/a/page.tsx": inline })).toEqual({ surfaces: [...get("/a"), post].sort(), limits: [assumed("web/app/a/page.tsx")] });
    // From a module marked "use server", imported through a client component, by a tsconfig path.
    const files = {
      "app/a/page.tsx": 'import { Form } from "@/components/form";\nexport default function Page() { return <Form />; }',
      "components/form.tsx": '"use client";\nimport { save } from "@/lib/actions";\nexport function Form() { return <form action={save} />; }',
      "lib/actions.ts": '"use server";\nexport async function save() {}',
      "tsconfig.json": JSON.stringify({ compilerOptions: { paths: { "@/*": ["./*"] } } }),
    };
    expect(pages(files)).toMatchObject({ surfaces: [...get("/a"), post].sort(), limits: [assumed("web/app/a/page.tsx")] });
    // From a layout above it; none where the page imports no action.
    expect(pages({ "app/layout.tsx": 'import { save } from "./actions";\nexport default function Root({ children }) { return children; }', "app/actions.ts": '"use server";\nexport async function save() {}', "app/a/page.tsx": page() })).toMatchObject({ surfaces: [...get("/a"), post].sort(), limits: [assumed("web/app/a/page.tsx")] });
    // A type-only import or re-export is erased: the module it names is not loaded.
    for (const head of ['import type { Save } from "../actions";', 'import { type Save } from "../actions";', 'export type { Save } from "../actions";', 'export { type Save } from "../actions";']) {
      expect(pages({ "app/a/page.tsx": `${head}\nexport default function Page() { return null; }`, "app/actions.ts": '"use server";\nexport type Save = () => void;\nexport async function save() {}' })).toEqual({ surfaces: get("/a"), limits: [assumed("web/app/a/page.tsx")] });
    }
    expect(pages({ "app/a/page.tsx": 'import { type Save, save } from "../actions";\nexport default function Page() { return null; }', "app/actions.ts": '"use server";\nexport async function save() {}' })).toEqual({ surfaces: [...get("/a"), post].sort(), limits: [assumed("web/app/a/page.tsx")] });
    expect(pages({ "app/a/page.tsx": 'import { util } from "../util";\nexport default function Page() { return null; }', "app/util.ts": "export const util = 1;" })).toMatchObject({ surfaces: get("/a"), limits: [assumed("web/app/a/page.tsx")] });
  });

  it("names the pages it reads as prerendered once, sorted, and reads none of it under cacheComponents", () => {
    expect(pages({ "app/page.tsx": page(), "app/b/page.tsx": page(), "app/a/page.tsx": page() }).limits).toEqual([assumed("web/app/a/page.tsx", "web/app/b/page.tsx", "web/app/page.tsx")]);
    expect(pages({ "app/page.tsx": page(), "next.config.ts": "export default { cacheComponents: true };" }).limits).toEqual([
      "routes web: web/next.config.ts turns on cacheComponents or partial prerendering, under which it prerenders a shell even of a page that reads the request; which pages Next.js refuses methods other than GET for is then not read, and each page is read as if it did not",
      assumed("web/app/page.tsx"),
    ]);
    // A setting not spelled out may turn it on, or build a static export.
    expect(pages({ "app/page.tsx": page(), "next.config.ts": "export default { cacheComponents: flag, output: process.env.OUT };" }).limits).toEqual([
      'routes web: web/next.config.ts sets a value it does not spell out, so whether it builds a static export (output: "export"), where Next.js prerenders every page, or turns on cacheComponents or partial prerendering, under which it prerenders a shell even of a page that reads the request is not read; which pages Next.js refuses methods other than GET for is then not read, and each page is read as if it did not',
      assumed("web/app/page.tsx"),
      "routes web: web/next.config.ts sets output to a value it does not spell out, so whether Next.js serves its image optimizer (/_next/image) is not read; it is not read",
    ]);
    // Before Next.js 14 there was no partial prerendering to turn on.
    const old = { "web/package.json": JSON.stringify({ dependencies: { next: "13.4.0" } }) };
    expect(pages({ "app/page.tsx": page(), "next.config.mjs": "export default plugin({});" }, old).limits).not.toContainEqual(expect.stringContaining("cacheComponents"));
  });

  it("reads the methods of every page at one path together, as the slots a layout renders", () => {
    const source = memory({ "app/d/page.tsx": page(), "app/d/@team/page.tsx": `export const dynamic = "force-dynamic";\n${page()}` });
    const r = nextPageMethods(
      [
        { file: "app/d/page.tsx", path: "/d", app: "app" },
        { file: "app/d/@team/page.tsx", path: "/d", app: "app" },
      ],
      { component: "web", root: "", config: {}, source, reach: new Reach(source), constants: new Constants(source), limits: [] },
    );
    expect([...r].map(([f, m]) => `${f} ${m.methods.join(",")} ${m.why}`)).toEqual(['app/d/page.tsx * dynamic = "force-dynamic" in app/d/@team/page.tsx', 'app/d/@team/page.tsx * dynamic = "force-dynamic" in app/d/@team/page.tsx']);
  });
});

describe("what Spring Boot serves by itself", () => {
  const spring = { styles: ["spring"] };
  const dependency = (group: string, artifact: string) => `    <dependency><groupId>${group}</groupId><artifactId>${artifact}</artifactId></dependency>`;
  const pom = (version: string, ...starters: string[]) =>
    lines(
      "<project>",
      `  <parent><groupId>org.springframework.boot</groupId><artifactId>spring-boot-starter-parent</artifactId><version>${version}</version></parent>`,
      "  <dependencies>",
      ...starters.map((s) => (s.includes(":") ? dependency(s.split(":")[0]!, s.split(":")[1]!) : dependency("org.springframework.boot", s))),
      "  </dependencies>",
      "</project>",
    );
  const controller = lines("package com.example;", "@RestController", "class Owners {", '  @GetMapping("/owners") List<Owner> list() { return null; }', "}");
  const app = (files: Record<string, string>, version = "4.1.2", ...starters: string[]) => {
    const r = read({ "api/pom.xml": pom(version, ...(starters.length ? starters : ["spring-boot-starter-webmvc"])), "api/src/main/java/com/example/Owners.java": controller, ...files }, spring);
    // The controller's own route, which is not the subject here.
    return { surfaces: r.surfaces.filter((s) => s !== "GET /owners"), limits: r.limits, raw: r.raw };
  };
  const resources = "api/src/main/resources";
  const file = (path: string) => [`GET ${path} (implicit) [spring-boot static resources]`, `HEAD ${path} (implicit) [spring-boot static resources]`];
  const webjars = (pattern = "/webjars/**") => [`GET ${pattern} (implicit) [spring-boot webjars]`, `HEAD ${pattern} (implicit) [spring-boot webjars]`];
  const error = (path = "/error") => `* ${path} (implicit) [spring-boot error]`;
  const actuator = (base = "/actuator") => [`GET ${base} (implicit) [spring-boot actuator]`, `GET ${base}/health (implicit) [spring-boot actuator health]`, `GET ${base}/health/** (implicit) [spring-boot actuator health]`];
  const props = (text: string) => ({ [`${resources}/application.properties`]: text });
  const statics = { [`${resources}/static/css/site.css`]: "", [`${resources}/public/a b.txt`]: "", [`${resources}/META-INF/resources/x.js`]: "", [`${resources}/templates/home.html`]: "" };

  it("serves the error page and each file of the static locations of a Spring MVC application, where its build brings the starter", () => {
    const r = app(statics);
    expect(r).toMatchObject({ surfaces: [error(), ...file("/x.js"), ...file("/css/site.css"), ...file("/a%20b.txt")], limits: [] });
    expect(r.raw.find((s) => s.path === "/error")).toMatchObject({ at: { file: "api/pom.xml", line: 4 }, evidence: "declared", dispatch: { slashes: "strict" } });
    expect(r.raw.find((s) => s.path === "/css/site.css")).toMatchObject({ at: { file: `${resources}/static/css/site.css`, line: 1 }, evidence: "static", dispatch: { slashes: "strict" } });
    expect(app({}, "3.5.0", "spring-boot-starter-web")).toMatchObject({ surfaces: [error()], limits: [] });
    // WebFlux has no error page route; with both starters Spring Boot runs Spring MVC.
    expect(app(statics, "4.1.2", "spring-boot-starter-webflux")).toMatchObject({ surfaces: [...file("/x.js"), ...file("/css/site.css"), ...file("/a%20b.txt")], limits: [] });
    expect(app({}, "4.1.2", "spring-boot-starter-webflux", "spring-boot-starter-webmvc")).toMatchObject({ surfaces: [error()], limits: [] });
    // Without a web starter of its own, the module serves none.
    expect(app({ "api/pom.xml": pom("4.1.2", "spring-boot-starter-data-jpa") })).toMatchObject({ surfaces: [], limits: [] });
  });

  it("serves the WebJars only where the build brings one in", () => {
    expect(app({}, "4.1.2", "spring-boot-starter-webmvc", "org.webjars:bootstrap")).toMatchObject({ surfaces: [error(), ...webjars()], limits: [] });
    expect(app({}, "4.1.2", "spring-boot-starter-webmvc", "org.webjars.npm:htmx.org").raw.find((s) => s.path === "/webjars/**")).toMatchObject({ at: { file: "api/pom.xml", line: 5 }, evidence: "declared" });
    expect(app({ "api/build.gradle": "plugins { id 'org.springframework.boot' version '3.5.0' }\ndependencies {\n  implementation 'org.springframework.boot:spring-boot-starter-web'\n  runtimeOnly 'org.webjars:jquery:3.7.1'\n}\n", "api/pom.xml": "" })).toMatchObject({
      surfaces: [error(), ...webjars()],
      limits: [],
    });
    expect(app(props("spring.mvc.webjars-path-pattern=/libs/**"), "4.1.2", "spring-boot-starter-webmvc", "org.webjars:bootstrap")).toMatchObject({ surfaces: [error(), ...webjars("/libs/**")], limits: [] });
  });

  it("reads the error path each version binds, and the locations and pattern the settings give", () => {
    expect(app(props("spring.web.error.path=/oops"))).toMatchObject({ surfaces: [error("/oops")], limits: [] });
    // Spring Boot 4 binds spring.web.error.path, 3 server.error.path; error.path in both, where the other is not set.
    expect(app(props("server.error.path=/oops"))).toMatchObject({ surfaces: [error()], limits: [] });
    expect(app(props("server.error.path=/oops"), "3.4.0")).toMatchObject({ surfaces: [error("/oops")], limits: [] });
    expect(app(props("error.path=/failed"))).toMatchObject({ surfaces: [error("/failed")], limits: [] });
    // A placeholder the setting in force hides is not read, and does not matter.
    expect(app(props("server.error.path=/oops\nerror.path=${IGNORED}"), "3.4.0")).toMatchObject({
      surfaces: [error("/oops")],
      limits: [`routes api: ${resources}/application.properties:2 sets error.path to \${IGNORED}, resolved at run time; the routes Spring Boot serves by itself that depend on it are not read`],
    });
    expect(app({ ...statics, [`${resources}/application.yml`]: "spring:\n  mvc:\n    static-path-pattern: /static/**\n" })).toMatchObject({
      surfaces: [error(), ...file("/static/x.js"), ...file("/static/css/site.css"), ...file("/static/a%20b.txt")],
      limits: [],
    });
    expect(app({ ...statics, ...props("spring.web.resources.static-locations=classpath:/templates/,file:/srv/www/") })).toMatchObject({
      surfaces: [error(), ...file("/home.html")],
      limits: [`routes api: ${resources}/application.properties:1 sets spring.web.resources.static-locations to file:/srv/www/ among others, a location whose files atlas does not list; the static resources there are not read`],
    });
    expect(app({ ...statics, ...props("spring.mvc.static-path-pattern=/assets/*.css") })).toMatchObject({
      surfaces: [error()],
      limits: [`routes api: ${resources}/application.properties:1 sets spring.mvc.static-path-pattern to /assets/*.css, a pattern atlas does not read; the static resources Spring Boot serves there are not read`],
    });
    expect(app({ "api/src/main/webapp/index.jsp": "" })).toMatchObject({
      surfaces: [error()],
      limits: ["routes api: api/src/main/webapp/ holds files a Servlet application serves from its servlet context where it is packed as a war; they are not read"],
    });
  });

  it("serves no static resources where they are turned off or the code takes the web configuration over, and no error page beside the code's own", () => {
    expect(app({ ...statics, ...props("spring.web.resources.add-mappings=false") })).toMatchObject({ surfaces: [error()], limits: [] });
    expect(app({ ...statics, "api/src/main/java/com/example/Web.java": "@Configuration\n@EnableWebMvc\nclass Web implements WebMvcConfigurer {}" })).toMatchObject({ surfaces: [error()], limits: [] });
    expect(app({ "api/src/main/java/com/example/Errors.java": "@Controller\nclass Errors implements ErrorController {}" })).toMatchObject({
      surfaces: [],
      limits: ["routes api: api/src/main/java/com/example/Errors.java:2 names an ErrorController of the code's, which takes the place of the one Spring Boot maps its error page with; that page is not read"],
    });
    // A class merely named like one is not one.
    expect(app({ "api/src/main/java/com/example/Advice.java": "@ControllerAdvice\nclass GlobalErrorController {}" })).toMatchObject({ surfaces: [error()], limits: [] });
  });

  it("serves the actuator's discovery page and health where the starter brings it, as its exposure, base path and access say", () => {
    const starters = ["spring-boot-starter-webmvc", "spring-boot-starter-actuator"];
    const with_ = (text: string, version = "4.1.2") => app(props(text), version, ...starters);
    expect(app({}, "4.1.2", ...starters)).toMatchObject({ surfaces: [error(), ...actuator()], limits: [] });
    expect(with_("management.endpoints.web.base-path=/manage/")).toMatchObject({ surfaces: [error(), ...actuator("/manage")], limits: [] });
    // Under a base path of / Spring Boot registers no discovery page.
    expect(with_("management.endpoints.web.base-path=/")).toMatchObject({ surfaces: [error(), "GET /health (implicit) [spring-boot actuator health]", "GET /health/** (implicit) [spring-boot actuator health]"], limits: [] });
    expect(with_("management.endpoints.web.exposure.exclude=health")).toMatchObject({ surfaces: [error(), actuator()[0]], limits: [] });
    expect(with_("management.endpoints.web.discovery.enabled=false")).toMatchObject({ surfaces: [error(), ...actuator().slice(1)], limits: [] });
    // A discovery switch resolved at run time leaves the discovery page out, not health.
    expect(with_("management.endpoints.web.discovery.enabled=${DISCOVERY}")).toMatchObject({
      surfaces: [error(), ...actuator().slice(1)],
      limits: [`routes api: ${resources}/application.properties:1 sets management.endpoints.web.discovery.enabled to \${DISCOVERY}, resolved at run time; the routes Spring Boot serves by itself that depend on it are not read`],
    });
    // access came with Spring Boot 3.4; before it, only the enabled switches count.
    expect(with_("management.endpoint.health.access=none")).toMatchObject({ surfaces: [error(), actuator()[0]], limits: [] });
    expect(with_("management.endpoint.health.access=none", "3.4.0")).toMatchObject({ surfaces: [error(), actuator()[0]], limits: [] });
    expect(with_("management.endpoint.health.access=none", "3.3.5")).toMatchObject({ surfaces: [error(), ...actuator()], limits: [] });
    expect(with_("management.endpoint.health.enabled=false", "3.3.5")).toMatchObject({ surfaces: [error(), actuator()[0]], limits: [] });
    expect(with_("management.endpoints.access.max-permitted=none")).toMatchObject({ surfaces: [error(), actuator()[0]], limits: [] });
    expect(with_("management.endpoints.web.exposure.include=health,info")).toMatchObject({
      surfaces: [error(), ...actuator()],
      limits: [`routes api: ${resources}/application.properties:1 exposes the actuator endpoints info over HTTP, which exist where the classpath and the code give them; their routes are not read`],
    });
    expect(app({ [`${resources}/application.yml`]: "management:\n  endpoints:\n    web:\n      exposure:\n        include: ['*']\n" }, "4.1.2", ...starters)).toMatchObject({
      surfaces: [error(), ...actuator()],
      limits: [`routes api: ${resources}/application.yml:5 exposes every actuator endpoint over HTTP (*); which endpoints there are depends on the classpath and the code, so of them only the discovery page and health are read`],
    });
    expect(with_("management.server.port=8081")).toMatchObject({
      surfaces: [error()],
      limits: [`routes api: ${resources}/application.properties:1 serves the actuator on its own port (management.server.port); its endpoints are not read`],
    });
  });

  it("reads none where a prefix, a version, the stack or a setting is not read, and says so", () => {
    expect(app(props("server.servlet.context-path=/api"))).toMatchObject({
      surfaces: [],
      limits: [`routes api: ${resources}/application.properties:1 sets server.servlet.context-path, which atlas does not put before routes; the routes Spring Boot serves by itself are not read`],
    });
    expect(app({}, "2.7.18")).toMatchObject({
      surfaces: [],
      limits: ["routes api: api/pom.xml:4 brings in Spring Boot's web stack, version 2, whose auto-configuration atlas does not read; the routes Spring Boot serves by itself (its error page, static resources, WebJars and actuator) are not read"],
    });
    expect(app({ "api/src/main/java/com/example/App.java": "@SpringBootApplication(exclude = ErrorMvcAutoConfiguration.class)\nclass App {}" })).toMatchObject({
      surfaces: [],
      limits: ["routes api: api/src/main/java/com/example/App.java:1 excludes auto-configuration that makes them; the routes Spring Boot serves by itself are not read"],
    });
    expect(app({ "api/src/main/java/com/example/App.java": "@SpringBootApplication(exclude = EXCLUDED)\nclass App {}" })).toMatchObject({
      surfaces: [],
      limits: ["routes api: api/src/main/java/com/example/App.java:1 excludes auto-configuration that it does not spell out; the routes Spring Boot serves by itself are not read"],
    });
    expect(app(props("spring.autoconfigure.exclude=${EXCLUDED}"))).toMatchObject({
      surfaces: [],
      limits: [
        `routes api: ${resources}/application.properties:1 sets spring.autoconfigure.exclude to \${EXCLUDED}, resolved at run time; the routes Spring Boot serves by itself that depend on it are not read`,
        `routes api: ${resources}/application.properties:1 excludes auto-configuration that it does not spell out; the routes Spring Boot serves by itself are not read`,
      ],
    });
    // An exclusion of another auto-configuration leaves them.
    expect(app({ "api/src/main/java/com/example/App.java": "@SpringBootApplication(exclude = { DataSourceAutoConfiguration.class })\nclass App {}" })).toMatchObject({ surfaces: [error()], limits: [] });
    expect(app(props("spring.autoconfigure.exclude=org.springframework.boot.jdbc.autoconfigure.DataSourceAutoConfiguration"))).toMatchObject({ surfaces: [error()], limits: [] });
    // A stack forced against the starters starts no web server of that kind.
    expect(app(props("spring.main.web-application-type=servlet"), "4.1.2", "spring-boot-starter-webflux")).toMatchObject({
      surfaces: [],
      limits: [`routes api: ${resources}/application.properties:1 sets spring.main.web-application-type to servlet, whose starter the build does not bring in; the routes Spring Boot serves by itself are not read`],
    });
    expect(app(props("spring.main.web-application-type=reactive"), "4.1.2", "spring-boot-starter-webflux", "spring-boot-starter-webmvc")).toMatchObject({ surfaces: [], limits: [] });
    expect(app({ [`${resources}/application-dev.properties`]: "spring.web.error.path=/dev-error" })).toMatchObject({
      surfaces: [error()],
      limits: [`routes api: ${resources}/application-dev.properties:1 sets spring.web.error.path for the profile dev, which is chosen at launch; it is not read`],
    });
    expect(app(props("spring.web.error.path=${ERRORS}"))).toMatchObject({
      surfaces: [],
      limits: [
        `routes api: ${resources}/application.properties:1 sets spring.web.error.path to \${ERRORS}, resolved at run time; the routes Spring Boot serves by itself that depend on it are not read`,
        `routes api: ${resources}/application.properties:1 sets spring.web.error.path to \${ERRORS}, which is not read as a path; the error page Spring Boot serves is not read`,
      ],
    });
  });

  it("serves them for no component alone where the configuration splits one application into several", () => {
    const limits: string[] = [];
    const config = normalizeConfig({
      components: [{ name: "a", path: "api" }, { name: "b", path: "api" }],
      routes: [
        { component: "a", files: ["api/src/main/java/com/example/a/**"], styles: ["spring"] },
        { component: "b", files: ["api/src/main/java/com/example/b/**"], styles: ["spring"] },
      ],
    });
    const files = { "api/pom.xml": pom("4.1.2", "spring-boot-starter-webmvc"), "api/src/main/java/com/example/a/A.java": controller, "api/src/main/java/com/example/b/B.java": controller };
    expect(extractRoutes(memory(files), config, undefined, [], limits).filter((s) => s.convention)).toEqual([]);
    expect(limits).toEqual(["routes a, b: their route files are one application (api), whose routes Spring Boot serves by itself belong to none of them alone; they are not read"]);
  });

  it("takes a request for a file to it, and leaves one for a path no file has to no route", () => {
    const config = normalizeConfig({ components: [{ name: "api", path: "api" }], routes: [{ component: "api", files: ["api/**"], styles: ["spring"] }] });
    const files = { "api/pom.xml": pom("4.1.2", "spring-boot-starter-webmvc"), [`${resources}/static/app.js`]: "", "api/src/main/java/com/example/Teams.java": lines("@RestController", "class Teams {", '  @GetMapping("/teams/{id}") T one() { return null; }', '  @GetMapping("/teams/**") T rest() { return null; }', "}") };
    const surfaces = extractRoutes(memory(files), config, undefined, [], []);
    const call = (path: string): Call => ({ id: `w->api|GET ${path}@a.ts:1`, from: "w", to: "api", method: "GET", path, based: false, at: { file: "a.ts", line: 1 }, evidence: "static" });
    const calls = ["/app.js", "/nowhere", "/teams/{}"].map(call);
    const { targetsOf } = matchCalls({ surfaces, calls }, rankedComponents(config));
    expect(calls.map((c, i) => `${c.path} -> ${(targetsOf.get(i) ?? []).map((s) => s.path).join(" ")}`)).toEqual(["/app.js -> /app.js", "/nowhere -> ", "/teams/{} -> /teams/{id} /teams/**"]);
  });
});
