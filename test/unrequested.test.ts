import { describe, expect, it } from "vitest";
import { normalizeConfig } from "../src/config.js";
import { callsFromText, callsFromTypeScript, extractCalls, type Passed } from "../src/extract/calls.js";
import type { Place } from "../src/model.js";
import type { Source } from "../src/source.js";

const memory = (files: Record<string, string>): Source => ({
  ref: "WORKTREE",
  list: () => Object.keys(files),
  read: (p) => files[p],
  asOf: () => "2026-11-01T00:00:00Z",
});

const shown = (c: { method: string; path: string; based: boolean }) => `${c.method} ${c.path}${c.based ? " based" : ""}`;

/**
 * One file read alone, as a parsed file of the call source: the calls, then what the reader left unread to be named in
 * a limit (a path handed on after a function's first argument, another host, a base held in a value).
 */
const read = (code: string, file = "a.tsx") => {
  const context = { passed: [] as Passed[], elsewhere: [] as Array<{ host: string; at: Place }>, unbased: [] as Place[] };
  const calls = callsFromTypeScript(file, code, { from: "a", to: "b", files: [] }, context).map(shown);
  return [
    ...calls,
    ...context.passed.map((p) => `passed to ${p.callee} @ ${p.at.line}`),
    ...context.elsewhere.map((e) => `elsewhere ${e.host} @ ${e.at.line}`),
    ...context.unbased.map((p) => `unbased @ ${p.line}`),
  ];
};

/** Files of a repository, `a.tsx` (or the files named) the call source's; the calls and the limits read. */
function repository(files: Record<string, string>, callFiles = ["a.tsx"], origins: Record<string, string> = {}) {
  const config = normalizeConfig({ components: [{ name: "app", path: "" }, { name: "api", path: "" }], calls: [{ from: "app", to: "api", files: callFiles }], origins });
  const limits: string[] = [];
  const calls = extractCalls(memory(files), config, [], undefined, limits).map((c) => `${shown(c)} @ ${c.at.file}:${c.at.line}`);
  return { calls, limits };
}

const RR5 = 'import { Redirect, Route, Switch, matchPath, useHistory, useRouteMatch, generatePath } from "react-router-dom";\n';

describe("React Router 5", () => {
  it("reads no request in a Redirect, a history's push and replace, or the paths matchPath, useRouteMatch and generatePath take", () => {
    const rows: Array<[string, string[]]> = [
      ['<Switch><Redirect exact from="/share/:shareId" to="/s/:shareId" /></Switch>;', []],
      ["const R = () => <Redirect to={`/doc/${slug}`} />;", []],
      ['function A() { const history = useHistory(); history.push("/home"); history.replace({ pathname: "/trash" }); }', []],
      ['function A() { const { push } = useHistory(); push("/home"); }', []],
      ['useHistory().push("/home");', []],
      ['const m = matchPath(location.pathname, { path: "/doc/:id" }) ?? useRouteMatch({ path: "/home", exact: true });', []],
      ['const p = generatePath("/doc/:id", { id });', []],
    ];
    expect(rows.map(([code]) => read(RR5 + code))).toEqual(rows.map(([, calls]) => calls));
  });

  it("reads a history only where React Router gives it, and an aliased import by the name it is exported as", () => {
    // Another library's history, an array's push and a history that is called are no navigation of React Router's.
    expect(read('import { createBrowserHistory } from "history";\nconst history = createBrowserHistory();\nhistory.push("/home");')).toEqual(["* /home"]);
    expect(read(RR5 + 'const list = [];\nlist.push("/home");')).toEqual(["* /home"]);
    expect(read(RR5 + 'const history = useHistory();\nhistory("/home");')).toEqual(["* /home"]);
    expect(read('import { Redirect as Go, useHistory as useH } from "react-router-dom";\n<Go to="/home" />;\nuseH().replace("/trash");')).toEqual([]);
    // A Redirect of another module is its own component.
    expect(read('import { Redirect } from "./ui";\n<Redirect to="/home" />;')).toEqual(["* /home"]);
  });
});

describe("a router's component passed on by a module of the repository", () => {
  const profiled = [
    'import * as Sentry from "@sentry/react";',
    'import { Route } from "react-router-dom";',
    "let Component;",
    "if (dsn) {",
    "  Component = Sentry.withSentryRouting(Route);",
    "} else {",
    "  Component = Route;",
    "}",
    "export default Component as typeof Route;",
  ].join("\n");

  it("reads outline's ProfiledRoute, React Router's Route wrapped by Sentry or not, as the Route it is", () => {
    const app = 'import Route from "./components/ProfiledRoute";\nexport const A = () => <Route exact path="/doc/new" component={New} />;';
    expect(repository({ "a.tsx": app, "components/ProfiledRoute.ts": profiled })).toEqual({ calls: [], limits: [] });
  });

  it("follows a re-export, a const and Sentry's wrapper imported by name, through modules", () => {
    const app = (name: string) => `import { ${name} } from "./routes";\nexport const A = () => <${name} path="/doc/new" />;`;
    const files = {
      "routes.ts": 'export { Route } from "react-router-dom";\nexport { Wrapped as Tracked } from "./wrapped";\nexport * from "./more";',
      "wrapped.ts": 'import { withSentryRouting as wrap } from "@sentry/react";\nimport { Route } from "react-router-dom";\nexport const Wrapped = wrap(Route);',
      "more.ts": 'import { Link } from "react-router-dom";\nexport const Plain = Link;',
    };
    for (const name of ["Route", "Tracked", "Plain"]) expect(repository({ ...files, "a.tsx": app(name) })).toEqual({ calls: [], limits: [] });
  });

  it("reads as before a module's own component, a value written otherwise, another wrapper and a cycle of modules", () => {
    const app = 'import Route from "./route";\nexport const A = () => <Route path="/doc/new" />;';
    const cases = [
      'export default function Route(props) { return <a href={props.path} />; }',
      'import { Route, Link } from "react-router-dom";\nlet C = Route;\nif (x) C = Link;\nexport default C;',
      'import { Route } from "react-router-dom";\nlet C = Route;\nC ??= other;\nexport default C;',
      'import { Route } from "react-router-dom";\nimport { wrap } from "./wrap";\nexport default wrap(Route);',
      'import { withSentryRouting } from "./sentry";\nimport { Route } from "react-router-dom";\nexport default withSentryRouting(Route);',
      'export { default } from "./route";',
    ];
    for (const route of cases) {
      expect(repository({ "a.tsx": app, "route.tsx": route })).toEqual({ calls: ["* /doc/new @ a.tsx:2"], limits: [] });
    }
  });
});

describe("text for people", () => {
  it("reads no request in an attribute that holds text for people, on an element or a component", () => {
    const rows: Array<[string, string[]]> = [
      ['<input placeholder="/my-route" />;', []],
      ['<SettingsTextInput placeholder="/my-route" title="/a" />;', []],
      ['<img alt="/logo" src="/logo.svg" aria-label="/b" />;', []],
      ['<div aria-description={"/c"} />;', []],
      // An attribute that may hold a URL is still read.
      ['<a href="/docs" title="/docs">Docs</a>;', ["GET /docs"]],
      ['<Input label="/x" />;', ["* /x"]],
    ];
    expect(rows.map(([code]) => read(code))).toEqual(rows.map(([, calls]) => calls));
  });

  it("reads no request in a message given to one of Lingui's macros, imported by name or from useLingui", () => {
    const rows: Array<[string, string[]]> = [
      ['import { t } from "@lingui/core/macro";\nconst a = t`/month`;\nconst b = t`/month for ${n} seats`;', []],
      ['import { msg, defineMessage as dm } from "@lingui/macro";\nconst a = msg`/year`;\nconst b = dm({ message: "/year" });', []],
      ['import { plural } from "@lingui/core/macro";\nconst a = plural(n, { one: "/seat", other: "/seats" });', []],
      ['import { useLingui } from "@lingui/react/macro";\nfunction A() { const { t } = useLingui(); return t`/month`; }', []],
      // Another tag or translate function, or `t` from another module, is not Lingui's.
      ['import { t } from "i18next";\nconst a = t("/month");', ["* /month"]],
      ['import { useLingui } from "@lingui/react";\nfunction A() { const { t } = useLingui(); return t`/month`; }', ["* /month"]],
      ["const a = String.raw`/raw`;", ["* /raw"]],
    ];
    expect(rows.map(([code]) => read(code))).toEqual(rows.map(([, calls]) => calls));
  });
});

describe("a value followed to where the code takes it", () => {
  it("follows a local const to its uses: no request where every use is none, read where any may be one", () => {
    const rows: Array<[string, string[]]> = [
      [RR5 + 'const HOME = "/home";\n<Route path={HOME} />;\nconst at = location.pathname === HOME;', []],
      [RR5 + "const to = ready ? `/home/${tab}` : undefined;\nconst x = !to && (to ? <Redirect to={to} /> : null);", []],
      // Its method is read only where every use requesting it states one.
      [RR5 + 'const HOME = "/home";\n<Route path={HOME} />;\nfetch(HOME);', ["* /home"]],
      // Exported, unused, or a `let`: other code, no code, or another write may take it anywhere.
      [RR5 + 'export const HOME = "/home";\n<Route path={HOME} />;', ["* /home"]],
      ['const HOME = "/home";', ["* /home"]],
      [RR5 + 'let HOME = "/home";\n<Route path={HOME} />;', ["* /home"]],
      // A test made on it, or its length, gives none of its text.
      ['const P = "/api";\nconst a = url.startsWith(P) && P.length > 1 && P.endsWith("/");', []],
    ];
    expect(rows.map(([code]) => read(code))).toEqual(rows.map(([, calls]) => calls));
  });

  it("follows an array's elements to its tests and to the functions its iterations hand them to", () => {
    const rows: Array<[string, string[]]> = [
      ['const ok = !["/", "/create", "/home"].includes(path);', []],
      ['const prefixes = ["/api", "/settings"];\nconst splittable = !prefixes.some((prefix) => path === prefix || path.startsWith(`${prefix}/`));', []],
      ['const prefixes = ["/api", "/settings"] as const;\nfor (const p of prefixes) if (path.startsWith(p)) skip();', []],
      [
        RR5 + 'const LEGACY = [{ suffix: "/apis/new", to: A }, { ["suffix"]: "/webhooks/new", to: B }] as const;\nconst r = LEGACY.map(({ suffix, to }) => <Route key={suffix} path={`${PREFIX}${suffix}`} />);',
        [],
      ],
      // An element given back, an element found, a third parameter, a rest element or a use not followed may be a request.
      ['const paths = ["/a"];\nconst urls = paths.map((p) => p);', ["* /a"]],
      ['const paths = ["/a"];\nfetch(paths.find((p) => p.startsWith(x)));', ["* /a"]],
      ['const paths = ["/a"];\npaths.forEach((p, i, all) => fetch(all[i]));', ["* /a"]],
      ['const items = [{ path: "/a" }];\nitems.forEach(({ ...rest }) => fetch(rest.path));', ["* /a"]],
      ['const paths = ["/a"];\nexport default paths;', ["* /a"]],
      ['const paths = ["/a"];\npaths.forEach(function (p) { fetch(arguments[0]); });', ["* /a"]],
      // A prototype key sets no property.
      [RR5 + 'const items = [{ __proto__: "/a" }];\nitems.map(({ __proto__ }) => <Route path={__proto__} />);', ["* /a"]],
    ];
    expect(rows.map(([code]) => read(code))).toEqual(rows.map(([, calls]) => calls));
  });

  it("follows a property of an object held in a local const to each read of it", () => {
    const rows: Array<[string, string[]]> = [
      [RR5 + 'const PATHS = { home: "/home", api: "/api/items" };\n<Route path={PATHS.home} />;\nfetch(PATHS.api);', ["* /api/items"]],
      [RR5 + 'const PATHS = { home: "/home" };\n<Route path={PATHS["home"]} />;', []],
      [RR5 + 'const PATHS = { home: "/home" };\n<Route path={PATHS[key]} />;', ["* /home"]],
      [RR5 + 'const PATHS = { home: "/home" };\n<Route path={PATHS.home} />;\nsend(PATHS);', ["* /home"]],
    ];
    expect(rows.map(([code]) => read(code))).toEqual(rows.map(([, calls]) => calls));
  });

  it("follows an argument into the function the file declares, through its parameter", () => {
    const rows: Array<[string, string[]]> = [
      ['function isActive(path) { return location.pathname === path; }\nisActive("/home");', []],
      ['const isActive = ({ path }) => location.pathname.startsWith(path);\nisActive({ path: "/home" });', []],
      ['const go = (opts) => opts.label === current;\ngo({ label: "/home", url: "/api/items" });', ["* /api/items"]],
      ['function load(path) { return fetch(path); }\nload("/api/items");', ["* /api/items"]],
      // A rest parameter, `arguments`, or a function that calls itself.
      ['function f(...paths) { return paths[0] === x; }\nf("/home");', ["* /home"]],
      ['function f(path) { return arguments[0] === x || path === x; }\nf("/home");', ["* /home"]],
      ['function f(path) { return f(path); }\nf("/home");', ["* /home"]],
    ];
    expect(rows.map(([code]) => read(code))).toEqual(rows.map(([, calls]) => calls));
  });

  it("follows an argument into a function another module of the repository exports, to a URL on another host", () => {
    const files = {
      "a.tsx": 'import { getDocumentationUrl } from "./docs";\nopen(getDocumentationUrl({ locale, path: "/developers/cli" }));',
      "docs.ts": 'import { DOCS } from "./constants";\nexport const getDocumentationUrl = ({ locale, path = "/" }) => (locale ? `${DOCS}/${locale}${path}` : `${DOCS}${path}`);',
      "constants.ts": 'export const DOCS = "https://docs.example.com";',
    };
    expect(repository(files)).toEqual({ calls: [], limits: [] });
    // Read in the call files too, the module's own URLs are to that host, which a limit names.
    expect(repository(files, ["a.tsx", "docs.ts"])).toEqual({
      calls: [],
      limits: ["calls app->api: URLs to docs.example.com (docs.ts:2) are not read as requests to api; set origins.api if that is its host"],
    });
    // The target's own origin is a request.
    expect(repository(files, ["a.tsx"], { api: "https://docs.example.com" })).toEqual({ calls: ["* /developers/cli @ a.tsx:2"], limits: [] });
  });
});

describe("new URL(path, base)", () => {
  const rows: Array<[string, string[], string[]]> = [
    // The page's own address: the path is read as a relative one.
    ['fetch(new URL("/status", location.origin));', ["GET /status @ a.tsx:1"], []],
    ['fetch(new URL("/status", document.baseURI));', ["GET /status @ a.tsx:1"], []],
    ['fetch(new URL("/status", origin));', ["GET /status @ a.tsx:1"], []],
    // A base the code spells out: its host, from the root of it.
    ['fetch(new URL("/status", "http://localhost:3000/api/"));', ["GET /status based @ a.tsx:1"], []],
    ['const PAY = "https://pay.example.com";\nfetch(new URL(`/api/v1/activate/${key}`, PAY).href);', [], ["calls app->api: URLs to pay.example.com (a.tsx:2) are not read as requests to api; set origins.api if that is its host"]],
    // A base held in a value names a host the code does not state.
    [
      'import { PAY_HOST } from "$env/static/public";\nfetch(new URL(`/api/v1/activate/${key}`, PAY_HOST).href);',
      [],
      ["calls app->api: URLs resolved against a base held in a value (new URL(path, base)), whose host the code does not state, are not read: a.tsx:2"],
    ],
    // An absolute URL takes no base; a URL with no base is read as before.
    ['fetch(new URL("http://localhost:3000/status", base));', ["GET /status based @ a.tsx:1"], []],
    ['fetch(new URL("/status"));', ["GET /status @ a.tsx:1"], []],
  ];
  it("reads the path from the root of the base's host, where the code states it", () => {
    for (const [code, calls, limits] of rows) expect(repository({ "a.tsx": code })).toEqual({ calls, limits });
  });

  it("reads a Next.js handler's own request as the base its redirect is resolved against", () => {
    const code = 'export function middleware(req) { return Response.redirect(new URL("/login", req.nextUrl.origin)); }';
    expect(repository({ "middleware.ts": code }, ["middleware.ts"])).toEqual({ calls: ["* /login @ middleware.ts:1"], limits: [] });
    expect(repository({ "app/api/x/route.ts": 'export function GET(request) { return Response.redirect(new URL("/login", request.url)); }' }, ["app/api/x/route.ts"])).toEqual({
      calls: ["* /login @ app/api/x/route.ts:1"],
      limits: [],
    });
    // Elsewhere, a parameter's `url` is a value.
    expect(repository({ "a.tsx": 'export function go(req) { return fetch(new URL("/login", req.url)); }' }).calls).toEqual([]);
  });
});

describe("in code read as text", () => {
  // The calls, then the paths left unread as an exception's label, which a limit names.
  const text = (file: string, code: string) => {
    const labels: Passed[] = [];
    const calls = callsFromText(file, code, { from: "a", to: "b", files: [] }, undefined, labels).map(shown);
    return [...calls, ...labels.map((l) => `label of ${l.callee} @ ${l.at.line}`)];
  };

  it("reads no request in an argument of a method that tests or cuts text, on any receiver", () => {
    const rows: Array<[string, string, string[]]> = [
      ["a.dart", "final endpoint = serverUrl.endsWith('/api') ? serverUrl : '$serverUrl/api';", ["* /api based"]],
      ["a.dart", "final e = ref.read(p).get(.serverEndpoint).replaceFirst('/api', '');", []],
      ["a.dart", "if (path.contains('/trash') || path.startsWith('/photos')) return;", []],
      ["A.kt", 'val bare = url.removePrefix("/api/v1").substringBefore("/items")', []],
      ["A.java", 'if (uri.startsWith("/admin") || uri.equals("/login")) return;', []],
      ["a.py", 'if request.path.startswith("/api") or p.endswith("/raw"): pass', []],
      ["A.cs", 'if (path.StartsWith("/api")) return path.Replace("/api", "");', []],
      ["a.go", 'if strings.HasPrefix(p, "/api") { p = strings.TrimPrefix(p, "/api") }', []],
      ["A.swift", 'let bare = path.replacingOccurrences(of: "/api", with: "")', []],
      // A request made inside the test's arguments is still read; a call that is not a method on a receiver is too.
      ["a.dart", "if (url.startsWith(await http.get('/prefix'))) {}", ["GET /prefix"]],
      ["A.kt", 'val r = contains("/orders")', ["* /orders"]],
    ];
    expect(rows.map(([file, code]) => text(file, code))).toEqual(rows.map(([, , calls]) => calls));
  });

  it("reads no request in a text property of Flutter's InputDecoration", () => {
    const rows: Array<[string, string[]]> = [
      ["decoration: InputDecoration(\n  hintText: 'x',\n  prefixText: slug.isNotEmpty ? '/s/' : null,\n),", []],
      ["InputDecoration(labelText: '/name', helperText: '/help')", []],
      // Another class's parameter of that name is its own, as is an argument given no name.
      ["Chip(prefixText: '/s/')", ["* /s"]],
      ["InputDecoration(icon: link('/s/'))", ["* /s"]],
    ];
    expect(rows.map(([code]) => text("a.dart", code))).toEqual(rows.map(([, calls]) => calls));
  });

  it("reads no request in the paths ASP.NET Core serves or re-executes at, and the request a forwarder makes", () => {
    const code = [
      'app.UseExceptionHandler("/Error");',
      'app.UseStatusCodePagesWithReExecute("/Status/{0}");',
      'app.MapGet("/items/{id}", Handler);',
      'var api = app.MapGroup("/api/v1");',
      'app.MapForwarder("/product-images/{id}", "https+http://catalog-api", "/api/catalog/items/{id}/pic");',
      'app.MapFallbackToFile("/index.html");',
      'app.MapFallbackToPage("/fallback/{*path}", "/Index");',
    ].join("\n");
    expect(text("Program.cs", code)).toEqual(["* /api/catalog/items/{}/pic"]);
    // In another language, a method of that name is its own.
    expect(text("a.kt", 'router.MapGet("/items")')).toEqual(["* /items"]);
  });

  it("reads a path ending in .log as a file's", () => {
    expect(text("a.dart", "final filePath = '${tempDir.path}/Immich_log_$dateTime.log';")).toEqual([]);
  });
});
