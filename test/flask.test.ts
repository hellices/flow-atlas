import { describe, expect, it } from "vitest";
import { loadConfig, normalizeConfig } from "../src/config.js";
import { extractRoutes } from "../src/extract/routes.js";
import { inventory } from "../src/inventory.js";
import { matchCalls, rankedComponents, redirectedLimits } from "../src/match.js";
import type { Call, Surface } from "../src/model.js";
import { scan } from "../src/scan.js";
import { validate } from "../src/schema.js";
import { WorktreeSource, type Source } from "../src/source.js";

/** Flask's and Quart's routes (#50): what each registers, under its blueprints, and where Werkzeug dispatches a request. */
const memory = (files: Record<string, string>): Source => ({
  ref: "WORKTREE",
  list: () => Object.keys(files),
  read: (p) => files[p],
  asOf: () => "2026-11-01T00:00:00Z",
});
const lines = (...l: string[]) => l.join("\n");

/** Every surface the files give, `METHOD /path`, implicit ones and conventions marked, with the limits. */
const read = (files: Record<string, string>, entry: Record<string, unknown> = {}) => {
  const limits: string[] = [];
  const config = normalizeConfig({ components: [{ name: "api", path: "api" }], routes: [{ component: "api", files: ["api/**"], styles: ["flask"], ...entry }] });
  const surfaces = extractRoutes(memory(files), config, undefined, [], limits);
  const mark = (s: Surface) => `${s.method} ${s.path}${s.implicit ? " (implicit)" : ""}${s.convention ? ` [${s.convention}]` : ""}`;
  return { surfaces: surfaces.map(mark), explicit: surfaces.filter((s) => !s.implicit).map(mark), limits, raw: surfaces };
};

/** A call to `api` as a sample request is written: `METHOD /path`, a `/` at its end kept as the call's `slash`. */
const call = (request: string, i = 0): Call => {
  const [method, raw] = request.split(" ") as [string, string];
  return {
    id: `web->api|${request}@x:${i + 1}`,
    from: "web",
    to: "api",
    method,
    path: raw.replace(/\/+$/, "") || "/",
    based: false,
    ...(raw.length > 1 && raw.endsWith("/") ? { slash: true as const } : {}),
    at: { file: "x", line: i + 1 },
    evidence: "text",
  };
};

/** What each request reaches: `METHOD /path` of each target, and `redirect /path/: ...` where Werkzeug redirects it. */
const reach = (files: Record<string, string>, requests: string[], entry: Record<string, unknown> = {}) => {
  const config = normalizeConfig({ components: [{ name: "api", path: "api" }], routes: [{ component: "api", files: ["api/**"], styles: ["flask"], ...entry }] });
  const limits: string[] = [];
  const surfaces = extractRoutes(memory(files), config, undefined, [], limits);
  const calls = requests.map(call);
  const m = matchCalls({ surfaces, calls }, rankedComponents(config));
  const out: Record<string, string[]> = {};
  requests.forEach((r, i) => {
    const redirected = m.redirected.get(i);
    out[r] = [
      ...(m.targetsOf.get(i) ?? []).map((s) => `${s.method} ${s.path}`).sort(),
      ...(redirected ? [`redirect ${redirected.path}${redirected.slash ? "/" : ""}: ${redirected.surfaces.map((s) => `${s.method} ${s.path}`).join(", ")}`] : []),
    ];
  });
  return { reached: out, limits, matched: redirectedLimits({ calls }, m.redirected) };
};

const app = (...body: string[]) => lines("from flask import Flask", "", "app = Flask(__name__, static_folder=None)", ...body);

describe("Flask's route registrations", () => {
  it("reads route, its method shortcuts and add_url_rule, with the HEAD Werkzeug adds beside GET and the OPTIONS Flask adds", () => {
    const files = {
      "api/app.py": app(
        '@app.route("/")',
        "def index(): ...",
        '@app.route("/login", methods=["GET", "post"])',
        "def login(): ...",
        '@app.put("/user/<name>")',
        "def put(name): ...",
        '@app.route("/options", methods=("GET", "OPTIONS"))',
        "def options(): ...",
        '@app.get("/plain", provide_automatic_options=False)',
        "def plain(): ...",
        "def health(): ...",
        'app.add_url_rule("/health", view_func=health)',
        'app.add_url_rule("/raw", "raw", health, methods={"DELETE"})',
        'app.route("/called", methods=["PATCH"])(health)',
        'requests.get("/not/a/route")(x)',
      ),
    };
    const { surfaces, limits } = read(files);
    expect(surfaces).toEqual([
      "GET /",
      "HEAD / (implicit)",
      "OPTIONS / (implicit)",
      "GET /login",
      "POST /login",
      "HEAD /login (implicit)",
      "OPTIONS /login (implicit)",
      "PUT /user/{name}",
      "OPTIONS /user/{name} (implicit)",
      "GET /options",
      "OPTIONS /options",
      "HEAD /options (implicit)",
      "GET /plain",
      "HEAD /plain (implicit)",
      "PATCH /called",
      "OPTIONS /called (implicit)",
      "GET /health",
      "HEAD /health (implicit)",
      "OPTIONS /health (implicit)",
      "DELETE /raw",
      "OPTIONS /raw (implicit)",
    ]);
    expect(limits).toEqual([]);
  });

  it("reads the methods of a MethodView, inherited ones included, and those a View lists", () => {
    const files = {
      "api/views.py": lines(
        "from flask.views import MethodView, View",
        "",
        "class Base(MethodView):",
        "    def get(self): ...",
        "",
        "class Items(Base):",
        "    def post(self): ...",
        "    async def head(self): ...",
        "",
        "class Counter(View):",
        '    methods = ["GET", "PUT"]',
        "    provide_automatic_options = False",
        "",
        "    def dispatch_request(self): ...",
        "",
        "class Plain(View):",
        "    def dispatch_request(self): ...",
      ),
      "api/app.py": app(
        "from . import views",
        "from .views import Counter, Items as Things",
        'app.add_url_rule("/items", view_func=Things.as_view("items"))',
        'app.add_url_rule("/counter", view_func=Counter.as_view("counter"))',
        'app.add_url_rule("/plain", view_func=views.Plain.as_view("plain"))',
      ),
    };
    const { surfaces, limits } = read(files);
    expect(surfaces).toEqual([
      "GET /items",
      "POST /items",
      "HEAD /items",
      "OPTIONS /items (implicit)",
      "GET /counter",
      "PUT /counter",
      "HEAD /counter (implicit)",
      "GET /plain",
      "HEAD /plain (implicit)",
      "OPTIONS /plain (implicit)",
    ]);
    expect(limits).toEqual([]);
  });

  it("names the registrations whose methods, rule or view are not spelled out, and reads none of their routes", () => {
    const files = {
      "api/app.py": app(
        "from .mixins import Mixin",
        "from flask.views import MethodView",
        "class Mixed(MethodView, Mixin):",
        "    def get(self): ...",
        "def view(): ...",
        "view.methods = ['POST']",
        "METHODS = ['GET']",
        "PATH = '/p'",
        '@app.route("/a", methods=METHODS)',
        "def a(): ...",
        '@app.route("/b", methods=("GET"))',
        "def b(): ...",
        '@app.post("/c", methods=["POST"])',
        "def c(): ...",
        "@app.route(PATH)",
        "def p(): ...",
        '@app.route("/d", **options)',
        "def d(): ...",
        'app.add_url_rule("/e", view_func=Mixed.as_view("e"))',
        'app.add_url_rule("/f", view_func=view)',
        'app.add_url_rule("/g", view_func=lambda: "g")',
        '@app.route("/h", subdomain="admin")',
        "def h(): ...",
      ),
    };
    const { surfaces, limits } = read(files);
    expect(surfaces).toEqual([]);
    expect(limits).toEqual([
      "routes api: api/app.py:12 registers /a with methods the file does not spell out (METHODS); its routes are not read",
      'routes api: api/app.py:14 registers /b with methods given as a string (("GET")), which Flask refuses; its routes are not read',
      "routes api: api/app.py:16 registers /c with methods given to post, which Flask refuses; its routes are not read",
      "routes api: api/app.py:18 registers a rule the file does not spell out (PATH); its routes are not read",
      "routes api: api/app.py:20 registers /d with options the file does not spell out (**options); its routes are not read",
      'routes api: api/app.py:25 registers /h with a subdomain ("admin"), which atlas does not read; its routes are not read',
      "routes api: api/app.py:22 registers /e with a view whose methods are not read (Mixed derives from Mixin, which atlas does not read); its routes are not read",
      "routes api: api/app.py:23 registers /f with the view view, whose methods atlas does not read; its routes are not read",
      'routes api: api/app.py:24 registers /g with the view lambda: "g", whose methods atlas does not read; its routes are not read',
    ]);
  });

  it("knows Flask, Quart and Blueprint by any name they are imported under, and nothing else that has a route method", () => {
    const files = {
      "api/a.py": lines("import flask as fl", "a = fl.Flask(__name__, static_folder=None)", '@a.get("/a")', "def a_(): ..."),
      "api/b.py": lines("from quart import Quart as Q", "b = Q(__name__, static_folder=None)", '@b.get("/b")', "async def b_(): ..."),
      "api/c.py": lines("import flask", "c = flask.Flask(__name__, static_folder=None)", "bp = flask.Blueprint('bp', __name__, url_prefix='/bp')", '@bp.get("/c")', "def c_(): ...", "c.register_blueprint(bp)"),
      "api/d.py": lines("from mylib import Flask", "d = Flask(__name__)", '@d.get("/d")', "def d_(): ..."),
    };
    const { surfaces, limits } = read(files);
    expect(surfaces.filter((s) => !s.includes("(implicit)"))).toEqual(["GET /a", "GET /b", "GET /bp/c"]);
    expect(limits).toEqual(["routes api: api/d.py registers routes on d, which atlas does not trace to a Flask or Quart application or Blueprint of the route files; they are not read"]);
  });

  it("reads routes registered in an application factory, and none on an application a function takes as a parameter", () => {
    const files = {
      "api/__init__.py": lines(
        "from flask import Flask",
        "def create_app():",
        "    app = Flask(__name__, static_folder=None)",
        '    @app.get("/made")',
        "    def made(): ...",
        "    register(app)",
        "    return app",
        "def register(app):",
        '    @app.get("/given")',
        "    def given(): ...",
      ),
    };
    const { explicit, limits } = read(files);
    expect(explicit).toEqual(["GET /made"]);
    expect(limits).toEqual(["routes api: api/__init__.py registers routes on app, which atlas does not trace to a Flask or Quart application or Blueprint of the route files; they are not read"]);
  });

  it("names the settings it does not read: hosts, converters, automatic OPTIONS and strict slashes not spelled out", () => {
    const files = {
      "api/app.py": lines(
        "from flask import Flask",
        "from .settings import STRICT, AUTO, NAME, Converter",
        "hosts = Flask('hosts', host_matching=True, static_host='static.example.com')",
        "static = Flask('static', static_host='static.example.com')",
        "app = Flask(__name__, static_folder=None)",
        "app.url_map.converters[NAME] = Converter",
        "app.config['PROVIDE_AUTOMATIC_OPTIONS'] = AUTO",
        '@hosts.get("/h")',
        "def h(): ...",
        '@app.get("/s", strict_slashes=STRICT)',
        "def s(): ...",
        '@app.get("/o", provide_automatic_options=AUTO)',
        "def o(): ...",
        '@app.get("/build", build_only=True)',
        "def build(): ...",
      ),
    };
    const { surfaces, raw, limits } = read(files);
    expect(surfaces).toEqual(["GET /s", "HEAD /s (implicit)", "GET /o", "HEAD /o (implicit)"]);
    // A route whose strict_slashes is not read takes a request with or without the `/`.
    expect(raw[0]!.dispatch).toEqual({ picks: "werkzeug", parts: ["s"] });
    expect(limits).toEqual([
      "routes api: api/app.py:6 registers URL converters the file does not spell out; a rule's converter is read as Werkzeug's own or one the files register by name",
      "routes api: api/app.py names PROVIDE_AUTOMATIC_OPTIONS; the OPTIONS Flask answers by itself beside each rule is not read",
      'routes api: api/app.py:4 makes static with a static_host ("static.example.com"), whose route only that host serves; the static files route Flask serves for it is not read',
      "routes api: api/app.py:10 sets strict_slashes to a value the file does not spell out; whether its route takes a request whose trailing / differs is not read",
      "routes api: api/app.py:12 sets provide_automatic_options to a value the file does not spell out; the OPTIONS of its route is not read",
      "routes api: hosts in api/app.py matches rules by host (host_matching True), which atlas does not read; its routes are not read",
    ]);
  });

  it("reads no rule Werkzeug answers with a redirect, nor one whose // it may keep, and says so", () => {
    const files = {
      "api/app.py": app(
        "def view(): ...",
        'app.add_url_rule("/old", "old", redirect_to="/new")',
        '@app.route("/legacy/<int:id>", redirect_to="/new")',
        "def legacy(id): ...",
        'app.add_url_rule("/main", "v", view)',
        'app.add_url_rule("/alt", "v", view, alias=True)',
        '@app.route("/a//b", merge_slashes=False)',
        "def kept(): ...",
        '@app.route("/c//d")',
        "def merged(): ...",
      ),
    };
    const { explicit, limits } = read(files);
    expect(explicit).toEqual(["GET /c/d", "GET /main"]);
    expect(limits).toEqual([
      'routes api: api/app.py:6 registers /legacy/<int:id>, a rule Werkzeug answers with a redirect (redirect_to "/new"); it is not read',
      "routes api: api/app.py:10 registers /a//b, whose // Werkzeug may keep (merge_slashes), which atlas's path form does not hold; the route is not read",
      'routes api: api/app.py:5 registers /old, a rule Werkzeug answers with a redirect (redirect_to "/new"); it is not read',
      "routes api: api/app.py:9 registers /alt, an alias, which Werkzeug answers with a redirect to its view's main rule; it is not read",
    ]);
  });

  it("says where a Quart route answers only a WebSocket handshake, and reads none for it", () => {
    const files = {
      "api/app.py": lines("from quart import Quart", "app = Quart(__name__, static_folder=None)", '@app.websocket("/ws")', "async def ws(): ...", 'app.add_url_rule("/raw", view_func=ws, websocket=True)'),
    };
    const { surfaces, limits } = read(files);
    expect(surfaces).toEqual([]);
    expect(limits).toEqual([
      "routes api: api/app.py:3 registers /ws, a WebSocket route, which answers only a WebSocket handshake; it is not read",
      "routes api: api/app.py:5 registers /raw, a WebSocket route, which answers only a WebSocket handshake; it is not read",
    ]);
  });
});

describe("Flask's blueprints", () => {
  const bp = (name: string, ...args: string[]) => `${name} = Blueprint(${[`"${name}"`, "__name__", ...args].join(", ")})`;

  it("serves a blueprint's rules under each registration's url_prefix, else its own, nested ones joined to their parents' as text", () => {
    const files = {
      "api/users.py": lines("from flask import Blueprint", bp("users", 'url_prefix="/users"'), '@users.get("/")', "def all(): ...", '@users.get("")', "def bare(): ...", '@users.get("/<int:id>")', "def one(id): ..."),
      "api/api.py": lines(
        "from flask import Blueprint",
        "from .users import users",
        bp("api", 'url_prefix="/api/"'),
        bp("v1", 'url_prefix="v1"'),
        bp("v2"),
        "v1.register_blueprint(users)",
        'v2.register_blueprint(users, url_prefix="/accounts", name="accounts")',
        "api.register_blueprint(v1)",
        "api.register_blueprint(v2, url_prefix=None)",
      ),
      "api/app.py": app("from .api import api", "app.register_blueprint(api)", 'app.register_blueprint(api, url_prefix="", name="root")'),
    };
    const { explicit, raw, limits } = read(files);
    expect(explicit).toEqual([
      "GET /api/v1/users",
      "GET /v1/users",
      "GET /api/accounts",
      "GET /accounts",
      "GET /api/v1/users/{id}",
      "GET /v1/users/{id}",
      "GET /api/accounts/{id}",
      "GET /accounts/{id}",
    ]);
    // `/users` and `/` are `/users/`; `/users` and `` are `/users`: one path, served with and without the `/`.
    expect(raw.find((s) => s.path === "/api/v1/users" && s.method === "GET")?.dispatch?.trailing).toBe("both");
    expect(limits).toEqual([]);
  });

  it("names a blueprint registered nowhere, into itself, on what atlas does not trace, or with a prefix or subdomain not spelled out", () => {
    const files = {
      "api/bps.py": lines(
        "from flask import Blueprint",
        "from .config import PREFIX",
        bp("lost"),
        bp("a"),
        bp("b"),
        bp("dyn", "url_prefix=PREFIX"),
        bp("sub", 'subdomain="admin"'),
        bp("given"),
        "a.register_blueprint(b)",
        "b.register_blueprint(a)",
        '@lost.get("/x")',
        "def x(): ...",
        '@a.get("/a")',
        "def a_(): ...",
        '@b.get("/b")',
        "def b_(): ...",
        '@dyn.get("/d")',
        "def d(): ...",
        '@sub.get("/s")',
        "def s(): ...",
        '@given.get("/g")',
        "def g(): ...",
        "def setup(app):",
        "    app.register_blueprint(given)",
      ),
      "api/app.py": app("from .bps import a, dyn, sub", "app.register_blueprint(a)", "app.register_blueprint(dyn)", "app.register_blueprint(sub)"),
    };
    const { surfaces, limits } = read(files);
    expect(surfaces).toEqual([]);
    expect(limits).toEqual([
      "routes api: lost in api/bps.py is registered nowhere in the route files; its routes are not read (declare where it is served in mounts)",
      "routes api: a in api/bps.py is registered into itself; its routes and those of api/bps.py (b) are not read (declare where it is served in mounts)",
      "routes api: dyn in api/bps.py has a url_prefix the file does not spell out (PREFIX); its routes are not read (declare where it is served in mounts)",
      'routes api: sub in api/bps.py has a subdomain ("admin"), which atlas does not read; its routes are not read (declare where it is served in mounts)',
      "routes api: api/bps.py:24 registers given on app, which atlas does not trace to an application or Blueprint; the routes of api/bps.py (given) are not read (declare where it is served in mounts)",
    ]);
  });

  it("serves a blueprint where mounts declares its file, in place of its registrations", () => {
    const files = { "api/bps.py": lines("from flask import Blueprint", bp("b", 'url_prefix="/own"'), '@b.get("/")', "def r(): ...", '@b.get("/x")', "def x(): ...") };
    expect(read(files, { mounts: { "api/bps.py": "/served" } }).explicit).toEqual(["GET /served", "GET /served/x"]);
  });

  it("stops at a blueprint served under more prefixes than it reads, and says so", () => {
    const names = ["b0", "b1", "b2", "b3", "b4", "b5", "b6"];
    const files = {
      "api/app.py": app(
        "from flask import Blueprint",
        ...names.map((n) => bp(n)),
        ...names.flatMap((n, i) => (i === 0 ? ['app.register_blueprint(b0, url_prefix="/x")', 'app.register_blueprint(b0, url_prefix="/y", name="y")'] : [`${names[i - 1]}.register_blueprint(${n}, url_prefix="/x")`, `${names[i - 1]}.register_blueprint(${n}, url_prefix="/y", name="y")`])),
        '@b6.get("/leaf")',
        "def leaf(): ...",
        '@b5.get("/five")',
        "def five(): ...",
      ),
    };
    const { explicit, limits } = read(files);
    expect(explicit).toHaveLength(64);
    expect(limits).toEqual(["routes api: b6 in api/app.py is served under more than 64 prefixes; its routes are not read (declare where it is served in mounts)"]);
  });
});

describe("Werkzeug's rules and converters", () => {
  const rule = (path: string, extra = "") => [`@app.route("${path}"${extra})`, "def f(): ..."];

  it("reads each built-in converter's regex as the parameter's pattern, and a path one at the end as the rest of the path", () => {
    const files = {
      "api/app.py": app(
        ...rule("/a/<int:id>"),
        ...rule("/b/<int(signed=True):n>"),
        ...rule("/c/<int(4):year>"),
        ...rule("/d/<float:x>"),
        ...rule("/e/<uuid:token>"),
        ...rule("/f/<any(news, 'a.b', sport):topic>"),
        ...rule("/g/<string(length=2):lang>"),
        ...rule("/h/<string:s>/<x>"),
        ...rule("/i/<path:rest>"),
        ...rule("/j/<int:id>.json"),
        ...rule("/k/<int:constructor>"),
      ),
    };
    const { raw, limits } = read(files);
    expect(raw.filter((s) => s.method === "GET").map((s) => [s.path, s.patterns])).toEqual([
      ["/a/{id}", { id: "[0-9]+" }],
      ["/b/{n}", { n: "-?[0-9]+" }],
      ["/c/{year}", { year: "[0-9]{4}" }],
      ["/d/{x}", { x: "[0-9]+\\.[0-9]+" }],
      ["/e/{token}", { token: "[A-Fa-f0-9]{8}-[A-Fa-f0-9]{4}-[A-Fa-f0-9]{4}-[A-Fa-f0-9]{4}-[A-Fa-f0-9]{12}" }],
      ["/f/{topic}", { topic: "(?:news|a\\.b|sport)" }],
      ["/g/{lang}", { lang: "[^/]{2}" }],
      ["/h/{s}/{x}", undefined],
      ["/i/{rest}/**", undefined],
      ["/j/{id}.json", { id: "[0-9]+" }],
      ["/k/{constructor}", { constructor: "[0-9]+" }],
    ]);
    expect(Object.hasOwn(raw.find((s) => s.path === "/k/{constructor}")!.patterns!, "constructor")).toBe(true);
    expect(limits).toEqual([]);
    const { reached } = reach(files, ["GET /a/12", "GET /a/x", "GET /b/-3", "GET /c/123", "GET /c/2024", "GET /d/1", "GET /d/1.5", "GET /f/a.b", "GET /f/axb", "GET /g/en", "GET /g/eng", "GET /i", "GET /i/x/y/", "GET /j/7.json", "GET /k/1"]);
    expect(reached).toEqual({
      "GET /a/12": ["GET /a/{id}"],
      "GET /a/x": [],
      "GET /b/-3": ["GET /b/{n}"],
      "GET /c/123": [],
      "GET /c/2024": ["GET /c/{year}"],
      "GET /d/1": [],
      "GET /d/1.5": ["GET /d/{x}"],
      "GET /f/a.b": ["GET /f/{topic}"],
      "GET /f/axb": [],
      "GET /g/en": ["GET /g/{lang}"],
      "GET /g/eng": [],
      "GET /i": [],
      "GET /i/x/y/": ["GET /i/{rest}/**"],
      "GET /j/7.json": ["GET /j/{id}.json"],
      "GET /k/1": ["GET /k/{constructor}"],
    });
  });

  it("reads a converter the code registers as one whose values are not read, and names the rules it cannot read", () => {
    const files = {
      "api/converters.py": lines(
        "from werkzeug.routing import BaseConverter",
        "class ListConverter(BaseConverter):",
        "    def to_python(self, value): return value.split(',')",
        "class Slashes(BaseConverter):",
        "    regex = '[^/]+/[^/]+'",
        "class Weighted(BaseConverter):",
        "    weight = 10",
        "class Unknown(BaseConverter):",
        "    regex = PATTERN",
      ),
      "api/app.py": app(
        "from .converters import ListConverter, Slashes, Unknown",
        "from . import converters",
        'app.url_map.converters["list"] = ListConverter',
        'app.url_map.converters["two"] = Slashes',
        'app.url_map.converters["w"] = converters.Weighted',
        'app.url_map.converters["unknown"] = Unknown',
        'app.url_map.converters["int"] = ListConverter',
        ...rule("/tags/<list:names>"),
        ...rule("/two/<two:pair>"),
        ...rule("/w/<w:x>"),
        ...rule("/u/<unknown:x>"),
        ...rule("/i/<int:x>"),
        ...rule("/m/<list:names>.json"),
        ...rule("/n/<nowhere:x>"),
        ...rule("/r/<float(max=9.5):x>"),
        ...rule("/p/<path:p>/edit"),
        ...rule("/q/x<path:p>"),
        ...rule("/s/{literal}"),
        ...rule("relative"),
      ),
    };
    const { explicit, raw, limits } = read(files);
    expect(explicit).toEqual(["GET /tags/{names:list}", "GET /w/{x:w}"]);
    expect(raw.find((s) => s.path === "/w/{x:w}")?.dispatch?.parts?.[1]).toMatchObject({ weight: [0, -1, 10] });
    expect(limits).toEqual([
      "routes api: api/app.py:13 registers /two/<two:pair> has <two:pair>, a converter the code registers that takes slashes; the route is not read",
      "routes api: api/app.py:17 registers /u/<unknown:x> has <unknown:x>, a converter whose regex atlas does not read, so not which segments it takes; the route is not read",
      "routes api: api/app.py:19 registers /i/<int:x> has <int:x>, a converter the code registers under a name atlas reads as a built-in converter's; the route is not read",
      "routes api: api/app.py:21 registers /m/<list:names>.json has a converter the code registers beside other text in a segment ({names:list}.json), whose values atlas reads only where it is a segment whole; the route is not read",
      "routes api: api/app.py:23 registers /n/<nowhere:x> names the converter nowhere, which is neither Werkzeug's nor one the files read register; the route is not read",
      "routes api: api/app.py:25 registers /r/<float(max=9.5):x> has <float(max=9.5):x>: its converter float(max=9.5) checks the value it takes, which atlas does not read; the route is not read",
      "routes api: api/app.py:27 registers /p/<path:p>/edit has text after a variable that takes slashes; the route is not read",
      "routes api: api/app.py:29 registers /q/x<path:p> has text before <path:p>, a variable that takes slashes; the route is not read",
      "routes api: api/app.py:31 registers /s/{literal} has text atlas's path form would read as a parameter ({literal}); the route is not read",
      'routes api: api/app.py:33 registers the rule "relative" does not start with a /, which Werkzeug refuses',
    ]);
    // A converter whose values are not read takes any segment, and covers no call with a value in it.
    expect(reach(files, ["GET /tags/a,b"]).reached).toEqual({ "GET /tags/a,b": ["GET /tags/{names:list}"] });
  });

  it("serves the static files route of an application and of a blueprint with a static folder, under each registration", () => {
    const files = {
      "api/app.py": lines(
        "from flask import Flask, Blueprint",
        "app = Flask(__name__)",
        "assets = Flask('assets', static_url_path='/assets/')",
        "public = Flask('public', static_folder='web/public')",
        "root = Flask('root', static_url_path='')",
        "none = Flask('none', static_folder=None)",
        "admin = Blueprint('admin', __name__, url_prefix='/admin', static_folder='static')",
        "plain = Blueprint('plain', __name__)",
        "app.register_blueprint(admin)",
        "app.register_blueprint(plain)",
        "from .settings import FOLDER",
        "unread = Flask('unread', static_folder=FOLDER)",
      ),
    };
    const { surfaces, limits } = read(files);
    expect(surfaces.filter((s) => s.startsWith("GET"))).toEqual([
      "GET /static/{filename}/** (implicit) [flask static]",
      "GET /assets/{filename}/** (implicit) [flask static]",
      "GET /public/{filename}/** (implicit) [flask static]",
      "GET /{filename}/** (implicit) [flask static]",
      "GET /admin/static/{filename}/** (implicit) [flask static]",
    ]);
    expect(surfaces.filter((s) => s.includes("/static/{filename}/**") && !s.includes("admin"))).toEqual([
      "GET /static/{filename}/** (implicit) [flask static]",
      "HEAD /static/{filename}/** (implicit) [flask static]",
      "OPTIONS /static/{filename}/** (implicit) [flask static]",
    ]);
    expect(limits).toEqual(["routes api: api/app.py:12 makes unread with static settings the file does not spell out (FOLDER); the static files route Flask serves for it is not read"]);
  });

  it("names the rules registered before another of the same view with defaults Werkzeug redirects to", () => {
    const files = {
      "api/app.py": app(
        '@app.route("/docs/<page>")',
        '@app.route("/docs/", defaults={"page": "index"})',
        "def docs(page): ...",
        '@app.route("/", defaults={"page": "index"})',
        '@app.route("/<page>")',
        "def pages(page): ...",
      ),
    };
    expect(read(files).limits).toEqual([
      'routes api: api/app.py:4 registers /docs/<page> after /docs/ (api/app.py:5), which gives defaults for page; Werkzeug redirects a request to /docs/<page> whose values equal them to /docs/ (redirect_defaults), which atlas does not tell apart',
    ]);
  });
});

describe("where Werkzeug dispatches a request", () => {
  it("tries a segment's static text before a variable, and variables by weight, whatever the order", () => {
    const files = {
      "api/app.py": app(
        '@app.get("/u/<name>")',
        "def name(name): ...",
        '@app.get("/u/me")',
        "def me(): ...",
        '@app.get("/n/<x>")',
        "def text(x): ...",
        '@app.get("/n/<int:x>")',
        "def number(x): ...",
        '@app.get("/f/<path:rest>")',
        "def rest(rest): ...",
        '@app.get("/f/<x>")',
        "def one(x): ...",
        '@app.get("/j/<x>")',
        "def j(x): ...",
        '@app.get("/j/<int:x>.json")',
        "def json(x): ...",
        '@app.delete("/u/<name>")',
        "def delete(name): ...",
      ),
    };
    const { reached, limits } = reach(files, ["GET /u/me", "GET /u/you", "DELETE /u/me", "GET /n/1", "GET /n/x", "GET /f/a", "GET /f/a/b", "GET /j/1.json", "GET /j/x"]);
    expect(limits).toEqual([]);
    expect(reached).toEqual({
      "GET /u/me": ["GET /u/me"],
      "GET /u/you": ["GET /u/{name}"],
      "DELETE /u/me": ["DELETE /u/{name}"],
      "GET /n/1": ["GET /n/{x}"],
      "GET /n/x": ["GET /n/{x}"],
      "GET /f/a": ["GET /f/{x}"],
      "GET /f/a/b": ["GET /f/{rest}/**"],
      "GET /j/1.json": ["GET /j/{x}.json"],
      "GET /j/x": ["GET /j/{x}"],
    });
  });

  it("keeps both routes where two variables of one weight with other regexes meet, their order being the order they were added", () => {
    const files = { "api/app.py": app('@app.get("/a/<string(length=2):x>")', "def two(x): ...", '@app.get("/a/<y>")', "def any(y): ...") };
    expect(reach(files, ["GET /a/en"]).reached).toEqual({ "GET /a/en": ["GET /a/{x}", "GET /a/{y}"] });
  });

  it("redirects a request without a / to a route written with one, unless a route of that path or one tried before takes it", () => {
    const files = {
      "api/app.py": app(
        '@app.route("/items/", methods=["GET", "POST"])',
        "def items(): ...",
        '@app.get("/about")',
        "def about(): ...",
        '@app.get("/both")',
        "def both(): ...",
        '@app.get("/both/")',
        "def both_slash(): ...",
        '@app.get("/docs/")',
        "def docs(): ...",
        '@app.get("/<page>")',
        "def page(page): ...",
        '@app.get("/x/<a>/")',
        "def a(a): ...",
        '@app.get("/x/b")',
        "def b(): ...",
        '@app.get("/lax/", strict_slashes=False)',
        "def lax(): ...",
      ),
    };
    const { reached, matched, limits } = reach(files, ["GET /items", "POST /items", "DELETE /items", "GET /items/", "GET /about/", "GET /both", "GET /both/", "GET /docs", "GET /other", "GET /x/c", "GET /x/b", "GET /lax", "GET /lax/"]);
    expect(reached).toEqual({
      "GET /items": ["redirect /items/: GET /items"],
      "POST /items": ["redirect /items/: POST /items"],
      "DELETE /items": [],
      "GET /items/": ["GET /items"],
      "GET /about/": [],
      "GET /both": ["GET /both"],
      "GET /both/": ["GET /both"],
      // `/docs` reaches the state of `docs` first, where `/docs/` asks for a `/`: `/<page>` is not tried.
      "GET /docs": ["redirect /docs/: GET /docs"],
      "GET /other": ["GET /{page}"],
      "GET /x/c": ["redirect /x/c/: GET /x/{a}"],
      "GET /x/b": ["GET /x/b"],
      "GET /lax": ["GET /lax"],
      "GET /lax/": ["GET /lax"],
    });
    expect(limits).toEqual([]);
    expect(matched[0]).toBe("calls web->api: GET /items at x:1 is answered with a redirect to /items/, which GET /items serves; it reaches that route only as its client follows the redirect, so it is matched to none");
  });

  it("serves either form where url_map.strict_slashes is False, and keeps every route either way where it is not spelled out", () => {
    const files = (value: string) => ({ "api/app.py": app(`app.url_map.strict_slashes = ${value}`, '@app.get("/items/")', "def items(): ...", '@app.get("/about")', "def about(): ...") });
    expect(reach(files("False"), ["GET /items", "GET /about/"]).reached).toEqual({ "GET /items": ["GET /items"], "GET /about/": ["GET /about"] });
    expect(reach(files("STRICT"), ["GET /items", "GET /about/"]).reached).toEqual({ "GET /items": ["GET /items"], "GET /about/": ["GET /about"] });
    expect(read(files("STRICT")).limits).toEqual(["routes api: url_map.strict_slashes is set to STRICT (api/app.py:4); whether a route takes a request whose trailing / differs is not read"]);
  });
});

describe("the flask style in a scan", () => {
  it("reads no route registration of a Python file that is also a call file as a request", () => {
    const files = {
      "api/app.py": app('@app.get("/users/me")', "def me(): ...", "import requests", "def other():", '    return requests.get("/users/1")'),
    };
    const config = (styles: string[]) =>
      normalizeConfig({
        components: [
          { name: "api", path: "api" },
          { name: "svc", path: "svc" },
        ],
        routes: [{ component: "api", files: ["api/**"], styles }],
        calls: [{ from: "api", to: "svc", files: ["api/**"] }],
      });
    const calls = (styles: string[]) => scan(memory(files), config(styles), { root: ".", requested: "WORKTREE" }).calls.map((c) => `${c.method} ${c.path}`);
    expect(calls(["flask"])).toEqual(["GET /users/1"]);
    // Without the style, the decorator reads as a client's `get`.
    expect(calls([])).toEqual(["GET /users/me", "GET /users/1"]);
  });

  it("offers the flask style for the files that import Flask or Quart, and FastAPI's for the others", () => {
    const files = {
      "api/a.py": app('@app.get("/a")', "def a(): ...", 'app.add_url_rule("/b", view_func=a)'),
      "api/q.py": lines("from quart import Blueprint", "bp = Blueprint('bp', __name__)", '@bp.route("/q")', "async def q(): ..."),
      "api/f.py": lines("from fastapi import FastAPI", "app = FastAPI()", '@app.get("/f")', "def f(): ..."),
    };
    expect(inventory(memory(files), []).routes.map((r) => `${r.file} ${r.style} ${r.count}`)).toEqual(["api/a.py flask 2", "api/q.py flask 1", "api/f.py fastapi 1"]);
  });

  it("writes the routes of the Flask fixture as the model's schema says", () => {
    const dir = "fixtures/frameworks/flask";
    const graph = scan(new WorktreeSource(dir), loadConfig(`${dir}/atlas.config.yaml`), { root: dir, requested: "WORKTREE" });
    expect(graph.surfaces.some((s) => s.dispatch?.picks === "werkzeug" && s.dispatch.parts?.some((p) => typeof p === "object"))).toBe(true);
    expect(validate("graph", JSON.parse(JSON.stringify(graph)))).toEqual([]);
  });
});
