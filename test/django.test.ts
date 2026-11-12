import { describe, expect, it } from "vitest";
import { loadConfig, normalizeConfig } from "../src/config.js";
import { chainPaths, DJANGO_CONVERTERS } from "../src/extract/djangopaths.js";
import { extractRoutes } from "../src/extract/routes.js";
import { inventory } from "../src/inventory.js";
import { matchCalls, rankedComponents, redirectedLimits } from "../src/match.js";
import type { Call, Surface } from "../src/model.js";
import { scan } from "../src/scan.js";
import { validate } from "../src/schema.js";
import { WorktreeSource, type Source } from "../src/source.js";

/** Django's URLconfs and Django REST framework's routers (#51): what each pattern serves, and where Django dispatches a request. */
const memory = (files: Record<string, string>): Source => ({
  ref: "WORKTREE",
  list: () => Object.keys(files),
  read: (p) => files[p],
  asOf: () => "2026-11-01T00:00:00Z",
});
const lines = (...l: string[]) => l.join("\n");

const COMMON = '"django.middleware.common.CommonMiddleware"';
/** A settings module that names `proj/urls.py` the root URLconf, with CommonMiddleware, and `extra` settings after. */
const settings = (...extra: string[]) => lines('ROOT_URLCONF = "proj.urls"', `MIDDLEWARE = [${COMMON}]`, ...extra);
/** A root URLconf: its imports, then `urlpatterns` as given. */
const urls = (...body: string[]) => lines("from django.urls import include, path, re_path", "from . import views", ...body);

const config = (entry: Record<string, unknown> = {}) =>
  normalizeConfig({ components: [{ name: "api", path: "" }], routes: [{ component: "api", files: ["**/*.py"], styles: ["django"], ...entry }] });

/** Every surface the files give, `METHOD /path`, implicit ones marked, with the limits. */
const read = (files: Record<string, string>, entry: Record<string, unknown> = {}) => {
  const limits: string[] = [];
  const surfaces = extractRoutes(memory(files), config(entry), undefined, [], limits);
  const mark = (s: Surface) => `${s.method} ${s.path}${s.implicit ? " (implicit)" : ""}`;
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

/** What each request reaches: `METHOD /path` of each target, and `redirect /path/: ...` where Django redirects it. */
const reach = (files: Record<string, string>, requests: string[]) => {
  const limits: string[] = [];
  const surfaces = extractRoutes(memory(files), config(), undefined, [], limits);
  const calls = requests.map(call);
  const m = matchCalls({ surfaces, calls }, rankedComponents(config()));
  const out: Record<string, string[]> = {};
  requests.forEach((r, i) => {
    const redirected = m.redirected.get(i);
    out[r] = [
      ...(m.targetsOf.get(i) ?? []).map((s) => `${s.method} ${s.path}`).sort(),
      ...(redirected ? [`redirect ${redirected.path}/: ${redirected.surfaces.map((s) => `${s.method} ${s.path}`).join(", ")}`] : []),
    ];
  });
  return { reached: out, limits, matched: redirectedLimits({ calls }, m.redirected) };
};

describe("the root URLconf and its includes", () => {
  it("reads the URLconf ROOT_URLCONF names, and the URLconfs it includes under their prefixes, the same one twice", () => {
    const files = {
      "proj/settings.py": settings(),
      "proj/urls.py": urls('urlpatterns = [path("", views.home), path("blog/", include("blog.urls")), path("authors/", include("blog.urls", namespace="authors"))]'),
      "proj/views.py": "def home(request): ...",
      "blog/urls.py": lines("from django.urls import path", "from . import views", 'app_name = "blog"', 'urlpatterns = [path("posts/", views.posts)]'),
      "blog/views.py": "def posts(request): ...",
    };
    expect(read(files)).toMatchObject({ surfaces: ["* /", "* /blog/posts", "* /authors/posts"], limits: [] });
  });

  it("reads a settings module through its star import, and a setting only where every settings module agrees", () => {
    const files = {
      "proj/settings/base.py": settings("DEBUG = False"),
      "proj/settings/dev.py": lines("from .base import *", "DEBUG = True"),
      "proj/urls.py": lines("from django.conf import settings", "from django.conf.urls.static import static", "from django.urls import path", "from . import views", 'urlpatterns = [path("", views.home)] + static("/media/", document_root="m")'),
      "proj/views.py": "def home(request): ...",
    };
    const { surfaces, limits } = read(files);
    expect(surfaces).toEqual(["* /"]);
    expect(limits).toEqual(['routes api: proj/urls.py:5: static(), which serves files only while DEBUG, and DEBUG is set to false and true by the settings files; its routes are not read']);
  });

  it("names a missing ROOT_URLCONF in a limit, and reads a URLconf mounts declares", () => {
    const files = {
      "proj/urls.py": urls('urlpatterns = [path("x/", views.x)]'),
      "proj/views.py": "def x(request): ...",
    };
    expect(read(files).limits).toEqual([
      "routes api: no settings module among the files read sets ROOT_URLCONF, so the URLconf Django dispatches requests by is not known; the routes it serves are not read (declare a URLconf's path in mounts)",
    ]);
    const mounted = read(files, { mounts: { "proj/urls.py": "/api" } });
    expect(mounted.surfaces).toEqual(["* /api/x"]);
    expect(mounted.limits).toEqual([
      "routes api: whether CommonMiddleware redirects a request without a trailing / to the path with it (APPEND_SLASH) is not read: no settings module among the files read sets ROOT_URLCONF; such a request is matched to no route either way",
    ]);
  });

  it("includes a list, a module imported, a (patterns, app_name) pair and lists joined with +, +=, append and extend", () => {
    const files = {
      "proj/settings.py": settings(),
      "proj/urls.py": lines(
        "from django.urls import include, path",
        "from blog import urls as blog_urls",
        "import blog.urls",
        "from . import views",
        'extra = [path("a/", views.a)]',
        'urlpatterns = [path("list/", include(extra)), path("mod/", include(blog_urls)), path("pair/", include((extra, "x"), namespace="y")), path("dotted/", include(blog.urls))]',
        'urlpatterns += [path("b/", views.a)]',
        'urlpatterns.append(path("c/", views.a))',
        'urlpatterns.extend([path("d/", views.a)])',
        'urlpatterns = urlpatterns + [path("e/", views.a)]',
        'urlpatterns.insert(0, path("f/", views.a))',
      ),
      "proj/views.py": "def a(request): ...",
      "blog/urls.py": lines("from django.urls import path", "from proj import views", 'urlpatterns = [path("p/", views.a)]'),
    };
    expect(read(files)).toMatchObject({ surfaces: ["* /f", "* /list/a", "* /mod/p", "* /pair/a", "* /dotted/p", "* /b", "* /c", "* /d", "* /e"], limits: [] });
  });

  it("reads the patterns added under `if settings.DEBUG:` by the setting, and names those under any other condition", () => {
    const files = (debug: string) => ({
      "proj/settings.py": settings(`DEBUG = ${debug}`),
      "proj/urls.py": lines(
        "from django.conf import settings",
        "from django.urls import path",
        "from . import views",
        'urlpatterns = [path("a/", views.a)]',
        "if settings.DEBUG:",
        '    urlpatterns += [path("debug/", views.a)]',
        "else:",
        '    urlpatterns += [path("live/", views.a)]',
        "try:",
        "    import debug_toolbar",
        '    urlpatterns += [path("tb/", views.a)]',
        "except ImportError:",
        "    pass",
        "if not settings.DEBUG:",
        '    urlpatterns += [path("prod/", views.a)]',
        'if FLAG: urlpatterns += [path("flag/", views.a)]',
      ),
      "proj/views.py": "def a(request): ...",
    });
    const changes = (line: number) => `routes api: proj/urls.py:${line} changes urlpatterns under a condition atlas does not read; what it adds is not read`;
    expect(read(files("True"))).toMatchObject({ surfaces: ["* /a", "* /debug"], limits: [changes(11), changes(16)] });
    expect(read(files("False"))).toMatchObject({ surfaces: ["* /a", "* /live", "* /prod"], limits: [changes(11), changes(16)] });
    expect(read(files('env("DEBUG")')).limits).toEqual([changes(6), changes(8), changes(11), changes(15), changes(16)]);
  });

  it("reads Django's names under any name they are imported as, and string literals Python joins", () => {
    const files = {
      "proj/settings.py": settings(),
      "proj/urls.py": lines("import django.urls as u", "from django.urls import path as p", "from . import views", 'urlpatterns = [p("a" "b/", views.a), u.re_path(r"^c/$", views.a), p(f"{X}/", views.a)]'),
      "proj/views.py": "def a(request): ...",
    };
    expect(read(files)).toMatchObject({ surfaces: ["* /ab", "* /c"], limits: ["routes api: proj/urls.py:4: a route the file does not spell out; its routes are not read"] });
  });

  it("names an include cycle, a URLconf not among the files, and patterns a library builds in limits", () => {
    const files = {
      "proj/settings.py": settings(),
      "proj/urls.py": lines(
        "from django.contrib import admin",
        "from django.urls import include, path",
        "from ninja import NinjaAPI",
        "api = NinjaAPI()",
        'urlpatterns = [path("self/", include("proj.urls")), path("x/", include("other.urls")), path("admin/", admin.site.urls), path("api/", api.urls)]',
      ),
    };
    expect(read(files).limits).toEqual([
      "routes api: proj/urls.py:5 includes proj/urls.py within itself; it is not read again",
      'routes api: proj/urls.py:5 (under "x/"): include("other.urls"), a URLconf that is not among the files read; its routes are not read',
      "routes api: proj/urls.py:5: \"admin/\" includes the admin site's patterns (admin.site.urls): which models they serve depends on every installed app's admin module, their pages take <path:object_id> before more segments, and their methods the signed-in user; its routes are not read",
      'routes api: proj/urls.py:5: "api/" includes api.urls, patterns a library builds (Django Ninja\'s and the like), which atlas does not read; its routes are not read',
    ]);
  });

  it("reads Django's and DRF's own URLconfs, placed at the include", () => {
    const files = {
      "proj/settings.py": settings(),
      "proj/urls.py": urls('urlpatterns = [path("auth/", include("django.contrib.auth.urls")), path("api-auth/", include("rest_framework.urls"))]'),
    };
    const { explicit, raw, limits } = read(files);
    expect(limits).toEqual([]);
    expect(explicit).toEqual([
      "GET /auth/login",
      "POST /auth/login",
      "PUT /auth/login",
      "POST /auth/logout",
      "GET /auth/password_change",
      "POST /auth/password_change",
      "PUT /auth/password_change",
      "GET /auth/password_change/done",
      "GET /auth/password_reset",
      "POST /auth/password_reset",
      "PUT /auth/password_reset",
      "GET /auth/password_reset/done",
      "GET /auth/reset/{uidb64}/{token}",
      "POST /auth/reset/{uidb64}/{token}",
      "PUT /auth/reset/{uidb64}/{token}",
      "GET /auth/reset/done",
      "GET /api-auth/login",
      "POST /api-auth/login",
      "PUT /api-auth/login",
      "POST /api-auth/logout",
    ]);
    expect(new Set(raw.map((s) => `${s.at.file}:${s.at.line}`))).toEqual(new Set(["proj/urls.py:3"]));
  });

  it("reads files with CRLF line breaks, and a class whose string runs across lines back to the margin", () => {
    const files = {
      "proj/settings.py": settings("DEBUG = True", 'MEDIA_URL = "media/"'),
      "proj/views.py": lines("from django.views import View", "class V(View):", '    tpl = """', "hi", '"""', "    def get(self, request): ..."),
      "proj/urls.py": lines(
        "from django.conf import settings",
        "from django.conf.urls.static import static",
        "from django.urls import path",
        "from . import views",
        "urlpatterns = \\",
        '    [path("x/", views.V.as_view())] + static(settings.MEDIA_URL)',
      ),
    };
    const crlf = Object.fromEntries(Object.entries(files).map(([f, t]) => [f, t.replace(/\n/g, "\r\n")]));
    for (const each of [files, crlf]) {
      expect(read(each)).toMatchObject({ surfaces: ["GET /x", "HEAD /x (implicit)", "OPTIONS /x (implicit)", "* /media/**"], limits: [] });
    }
  });
});

describe("path() routes and re_path() regexes", () => {
  it("reads each converter's regex as the parameter's pattern, `path` at the end as the rest of the path", () => {
    const files = {
      "proj/settings.py": settings(),
      "proj/urls.py": urls('urlpatterns = [path("a/<int:id>/<slug:s>/<uuid:u>/<name>/", views.a), path("f/<path:rest>", views.a), path("c/<int:constructor>/", views.a)]'),
      "proj/views.py": "def a(request, **kw): ...",
    };
    const { raw, limits } = read(files);
    expect(limits).toEqual([]);
    expect(raw.map((s) => [s.path, s.patterns ?? {}, s.dispatch?.trailing])).toEqual([
      ["/a/{id}/{s}/{u}/{name}", { id: "[0-9]+", s: "[\\-a-zA-Z0-9_]+", u: DJANGO_CONVERTERS.uuid!.regex }, "slash"],
      ["/f/{rest}/**", {}, undefined],
      ["/c/{constructor}", { constructor: "[0-9]+" }, "slash"],
    ]);
    expect(Object.hasOwn(raw[2]!.patterns!, "constructor")).toBe(true);
  });

  it("reads a converter the files register, its values unread where its to_python may refuse one", () => {
    const files = {
      "proj/settings.py": settings(),
      "proj/converters.py": lines(
        "from django.urls.converters import StringConverter",
        "class Year:",
        '    regex = "[0-9]{4}"',
        "    def to_python(self, value):",
        "        return int(value)",
        "class Date:",
        '    regex = r"\\d{4}-\\d{2}-\\d{2}"',
        "    def to_python(self, value):",
        "        return datetime.strptime(value, '%Y-%m-%d')",
        "class Code(StringConverter):",
        '    regex = "[A-Z]{3}"',
        "class Slashed:",
        '    regex = "[a-z/]+"',
      ),
      "proj/urls.py": lines(
        "from django.urls import path, register_converter",
        "from . import converters, views",
        'register_converter(converters.Year, "yyyy")',
        'register_converter(converters.Date, "date")',
        'register_converter(converters.Code, "code")',
        'register_converter(converters.Slashed, "slashed")',
        'urlpatterns = [path("y/<yyyy:y>/", views.a), path("d/<date:d>/", views.a), path("c/<code:c>/", views.a), path("s/<slashed:s>/", views.a), path("d2/<date:d>.json", views.a), path("n/<nope:n>/", views.a)]',
      ),
      "proj/views.py": "def a(request, **kw): ...",
    };
    const { raw, limits } = read(files);
    expect(raw.map((s) => [s.path, s.patterns ?? {}])).toEqual([
      ["/y/{y}", { y: "[0-9]{4}" }],
      ["/d/{d:date}", {}],
      ["/c/{c}", { c: "[A-Z]{3}" }],
    ]);
    expect(limits).toEqual([
      'routes api: proj/urls.py:7 serves a pattern atlas does not read: "s/<slashed:s>/" has a parameter s whose regex takes some slashes, which atlas\'s path form does not hold; its routes are not read',
      'routes api: proj/urls.py:7 serves a pattern atlas does not read: "d2/<date:d>.json" has a parameter d whose converter date may refuse a value, beside other text in its segment; its routes are not read',
      'routes api: proj/urls.py:7 serves a pattern atlas does not read: the route "n/<nope:n>/" names the converter nope, which is neither Django\'s nor one the files register; its routes are not read',
    ]);
  });

  it("reads a regex's named and unnamed groups, its optional parts and an optional / at its end", () => {
    const files = {
      "proj/settings.py": settings(),
      "proj/urls.py": urls(
        "urlpatterns = [",
        '    re_path(r"^archive/(?P<year>[0-9]{4})/$", views.a),',
        '    re_path(r"^comments/(?:page-(?P<page>\\d+)/)?$", views.a),',
        '    re_path(r"^old/(\\d+)/(\\w+)\\Z", views.a),',
        '    re_path(r"^colou?r/$", views.a),',
        '    re_path(r"^(?:en|fr)/home/?$", views.a),',
        '    re_path(r"^media/(?P<path>.*)$", views.a),',
        "]",
      ),
      "proj/views.py": "def a(request, *a, **kw): ...",
    };
    const { raw, limits } = read(files);
    expect(limits).toEqual([]);
    expect(raw.map((s) => [s.path, s.patterns ?? {}, s.dispatch?.trailing])).toEqual([
      ["/archive/{year}", { year: "[0-9]{4}" }, "slash"],
      ["/comments/page-{page}", { page: "\\d+" }, "slash"],
      ["/comments", {}, "slash"],
      ["/old/{_0}/{_1}", { _0: "\\d+", _1: "\\w+" }, undefined],
      ["/colour", {}, "slash"],
      ["/color", {}, "slash"],
      ["/en/home", {}, "both"],
      ["/fr/home", {}, "both"],
      ["/media/**", {}, "slash"],
    ]);
  });

  it("names a regex whose shape atlas cannot settle in a limit", () => {
    const files = {
      "proj/settings.py": settings(),
      "proj/urls.py": urls(
        "urlpatterns = [",
        '    re_path(r"x/$", views.a),',
        '    re_path(r"^y/", views.a),',
        '    re_path(r"^a/\\d+/$", views.a),',
        '    re_path(r"^b/$|^c/$", views.a),',
        '    re_path(r"^(?P<p>.+)/edit/$", views.a),',
        '    re_path(r"^(?P<p>[a-z/]+)$", views.a),',
        '    re_path(r"^(?=x)y/$", views.a),',
        '    re_path(r"^(?P<n>\\d*)/$", views.a),',
        '    re_path(r"^w/(?P<v>\\w+)/", include([path("x/", views.a)])),',
        '    re_path(r"^z/(?P<v>\\w+)", include([path("x/", views.a)])),',
        "]",
      ),
      "proj/views.py": "def a(request, *a, **kw): ...",
    };
    const unread = (line: number, why: string) => `routes api: proj/urls.py:${line} serves a pattern atlas does not read: ${why}; its routes are not read`;
    expect(read(files)).toMatchObject({
      surfaces: ["* /w/{v}/x"],
      limits: [
        unread(4, 'the regex "x/$" does not start with ^, so Django finds it anywhere in the path'),
        unread(5, 'the regex "^y/" does not end with $ or \\Z, so it takes any text after it'),
        unread(6, 'the regex "^a/\\\\d+/$" has a repeat outside a group, which atlas does not read as text or a parameter'),
        unread(7, 'the regex "^b/$|^c/$" has a | outside a group, which takes any of its sides as the whole path'),
        unread(8, 'r"^(?P<p>.+)/edit/$" has a parameter p that takes slashes before its end or beside other text, which atlas\'s path form does not hold'),
        unread(9, 'r"^(?P<p>[a-z/]+)$" has a parameter p whose regex takes some slashes, which atlas\'s path form does not hold'),
        unread(10, 'the regex "^(?=x)y/$" has a group atlas does not read ((?=x...)'),
        unread(11, 'r"^(?P<n>\\\\d*)/$" has a parameter n that takes an empty segment, which atlas\'s path form does not hold'),
        unread(13, 'r"^z/(?P<v>\\\\w+)" + "x/" includes patterns after a parameter v, which Django matches before the patterns it includes, and never again, so it may take what they would'),
      ],
    });
  });

  it("reads an include's pattern only where the text it matches is the one the joined regex would take", () => {
    const converter = (name: string) => DJANGO_CONVERTERS[name];
    const paths = (...pieces: Array<[string, "route" | "regex"]>) => {
      const read = chainPaths(pieces.map(([text, type]) => ({ type, text })), converter);
      return "why" in read ? read.why : read.map((f) => f.path);
    };
    const after = (what: string, part: string) => `${what} includes patterns after ${part}, which Django matches before the patterns it includes, and never again, so it may take what they would`;
    // It matches up to its last `/`, however its parameters split the text before it.
    expect(paths(["^w/(?P<slug>[\\w-]+)-(?P<id>\\w+)/", "regex"], ["x/", "route"])).toEqual(["/w/{slug}-{id}/x"]);
    expect(paths(["^(?:en|fr)/", "regex"], ["x/", "route"])).toEqual(["/en/x", "/fr/x"]);
    // A parameter that stops at a character it does not take.
    expect(paths(["^w/(?P<v>\\w+)", "regex"], ["/x/", "route"])).toEqual(["/w/{v}/x"]);
    expect(paths(["^w/(?P<v>[\\w-]+)", "regex"], ["-x/", "route"])).toBe(after('r"^w/(?P<v>[\\\\w-]+)" + "-x/"', "a parameter v"));
    // Python takes the first alternative that matches, and the included patterns never make it try another.
    expect(paths(["^(?:api|api/v2)/", "regex"], ["users/", "route"])).toBe(after('r"^(?:api|api/v2)/" + "users/"', "a part that may be left out or written otherwise"));
    expect(paths(["^(?P<ver>v1|v1beta)", "regex"], ["/users/", "route"])).toBe(after('r"^(?P<ver>v1|v1beta)" + "/users/"', "a parameter ver"));
    expect(paths(["^(?:en/)?", "regex"], ["x/", "route"])).toBe(after('r"^(?:en/)?" + "x/"', "a part that may be left out or written otherwise"));
    expect(paths(["<int:a>", "route"], ["", "route"])).toBe(after('"<int:a>" + ""', "a parameter a"));
  });

  it("stops at 64 forms of one pattern", () => {
    const regex = `^${Array.from({ length: 7 }, (_, i) => `(?:x${i})?`).join("")}$`;
    expect(chainPaths([{ type: "regex", text: regex }], () => undefined)).toEqual({ why: `r${JSON.stringify(regex)} stands for more than 64 paths` });
  });
});

describe("the methods each view takes", () => {
  it("takes any method in a function view, unless require_http_methods and its kin say otherwise", () => {
    const files = {
      "proj/settings.py": settings(),
      "proj/views.py": lines(
        "from django.contrib.auth.decorators import login_required",
        "from django.views.decorators.http import require_GET, require_http_methods, require_POST, require_safe",
        "from django.views.decorators import http as h",
        "def any_(request): ...",
        "@require_GET",
        "def get(request): ...",
        "@login_required",
        "@require_POST",
        "async def post(request): ...",
        "@require_safe",
        "def safe(request): ...",
        '@h.require_http_methods(["GET", "post", "PUT"])',
        "def listed(request): ...",
        "@my_cache",
        "def custom(request): ...",
      ),
      "proj/urls.py": urls(
        'urlpatterns = [path("any/", views.any_), path("get/", views.get), path("post/", views.post), path("safe/", views.safe), path("listed/", views.listed), path("custom/", views.custom), path("l/", lambda r: None)]',
      ),
    };
    const { surfaces, limits } = read(files);
    expect(surfaces).toEqual(["* /any", "GET /get", "POST /post", "GET /safe", "HEAD /safe", "GET /listed", "PUT /listed", "* /l"]);
    expect(limits).toEqual(['routes api: proj/urls.py:3 serves "custom/" with the view custom, decorated with @my_cache, which atlas does not read; its routes are not read']);
  });

  it("reads a decorator called on a view in the URLconf", () => {
    const files = {
      "proj/settings.py": settings(),
      "proj/views.py": "def a(request): ...",
      "proj/urls.py": lines(
        "from django.urls import path",
        "from django.views.decorators.cache import cache_page",
        "from django.views.decorators.csrf import csrf_exempt",
        "from django.views.decorators.http import require_http_methods, require_POST",
        "from . import views",
        'urlpatterns = [path("a/", csrf_exempt(views.a)), path("b/", cache_page(60)(require_POST(views.a))), path("c/", require_http_methods(["PUT"])(views.a)), path("d/", other(views.a))]',
      ),
    };
    const { surfaces, limits } = read(files);
    expect(surfaces).toEqual(["* /a", "POST /b", "PUT /c"]);
    expect(limits).toEqual(['routes api: proj/urls.py:6 serves "d/" with the view other(views.a), a decorator atlas does not read; its routes are not read']);
  });

  it("reads a class-based view's handlers within its http_method_names, HEAD beside GET, and its bases' and Django's generic views'", () => {
    const files = {
      "proj/settings.py": settings(),
      "proj/views.py": lines(
        "from django.contrib.auth.mixins import LoginRequiredMixin",
        "from django.utils.decorators import method_decorator",
        "from django.views import View, generic",
        "from django.views.decorators.http import require_POST",
        "from mylib import Mixin",
        "class Base(View):",
        "    def get(self, request): ...",
        "class Child(LoginRequiredMixin, Base):",
        "    def post(self, request): ...",
        "class Narrow(Child):",
        '    http_method_names = ["get", "post", "options"]',
        "class Form(generic.UpdateView): ...",
        '@method_decorator(require_POST, name="dispatch")',
        "class Posted(Child): ...",
        "class Foreign(Mixin, View): ...",
      ),
      "proj/urls.py": lines(
        "from django.urls import path",
        "from django.views.generic import RedirectView, TemplateView",
        "from . import views",
        "urlpatterns = [",
        '    path("child/", views.Child.as_view()),',
        '    path("narrow/", views.Narrow.as_view()),',
        '    path("form/", views.Form.as_view()),',
        '    path("posted/", views.Posted.as_view()),',
        '    path("t/", TemplateView.as_view(template_name="t.html")),',
        '    path("r/", RedirectView.as_view(url="/")),',
        '    path("only/", views.Child.as_view(http_method_names=["post"])),',
        '    path("foreign/", views.Foreign.as_view()),',
        '    path("cls/", views.Child),',
        "]",
      ),
    };
    const { surfaces, limits } = read(files);
    expect(surfaces).toEqual([
      "GET /child",
      "POST /child",
      "HEAD /child (implicit)",
      "OPTIONS /child (implicit)",
      "GET /narrow",
      "POST /narrow",
      "OPTIONS /narrow (implicit)",
      "GET /form",
      "POST /form",
      "PUT /form",
      "HEAD /form (implicit)",
      "OPTIONS /form (implicit)",
      "POST /posted",
      "GET /t",
      "HEAD /t (implicit)",
      "OPTIONS /t (implicit)",
      "GET /r",
      "POST /r",
      "PUT /r",
      "PATCH /r",
      "DELETE /r",
      "HEAD /r (implicit)",
      "OPTIONS /r (implicit)",
      "POST /only",
    ]);
    expect(limits).toEqual([
      'routes api: proj/urls.py:12 serves "foreign/" with the view of a class atlas does not read (Foreign derives from Mixin, which atlas does not trace to a class of the files read, Django\'s or DRF\'s); its routes are not read',
      'routes api: proj/urls.py:13 serves "cls/" with the view views.Child, a class given without as_view(); its routes are not read',
    ]);
  });

  it("reads DRF's APIView, generic views and @api_view, with the OPTIONS APIView answers", () => {
    const files = {
      "proj/settings.py": settings(),
      "proj/views.py": lines(
        "from rest_framework import generics",
        "from rest_framework.decorators import api_view, permission_classes",
        "from rest_framework.views import APIView",
        "class Stats(APIView):",
        "    def get(self, request): ...",
        "class Items(generics.ListCreateAPIView): ...",
        '@api_view(["GET", "POST"])',
        "@permission_classes([])",
        "def ping(request): ...",
        "@api_view()",
        "def hello(request): ...",
        "@api_view",
        "def bare(request): ...",
      ),
      "proj/urls.py": urls('urlpatterns = [path("stats/", views.Stats.as_view()), path("items/", views.Items.as_view()), path("ping/", views.ping), path("hello/", views.hello), path("bare/", views.bare)]'),
    };
    const { surfaces, limits } = read(files);
    expect(surfaces).toEqual([
      "GET /stats",
      "HEAD /stats (implicit)",
      "OPTIONS /stats (implicit)",
      "GET /items",
      "POST /items",
      "HEAD /items (implicit)",
      "OPTIONS /items (implicit)",
      "GET /ping",
      "POST /ping",
      "OPTIONS /ping (implicit)",
      "GET /hello",
      "OPTIONS /hello (implicit)",
    ]);
    expect(limits).toEqual(['routes api: proj/urls.py:3 serves "bare/" with the view bare, decorated with @api_view, which atlas does not read; its routes are not read']);
  });
});

describe("Django REST framework's routers", () => {
  const viewsets = lines(
    "from rest_framework import mixins, viewsets",
    "from rest_framework.decorators import action",
    "class Items(viewsets.ModelViewSet):",
    '    @action(detail=True, methods=["post"], url_path="set-status")',
    "    def set_status(self, request, pk=None): ...",
    "    @action(detail=False)",
    "    def recent(self, request): ...",
    '    @action(detail=False, methods=["get"])',
    "    def archive(self, request): ...",
    "    @archive.mapping.delete",
    "    def clear_archive(self, request): ...",
    "class Accounts(viewsets.ViewSet):",
    '    lookup_value_regex = "[0-9]+"',
    "    def list(self, request): ...",
    "    def retrieve(self, request, pk=None): ...",
    "class Notes(mixins.ListModelMixin, mixins.DestroyModelMixin, viewsets.GenericViewSet):",
    '    lookup_field = "note_id"',
    '    lookup_value_converter = "uuid"',
    '    http_method_names = ["get", "delete"]',
  );

  it("serves a ViewSet's list and detail routes and its extra actions, by the actions it has, with a DefaultRouter's root and format suffixes", () => {
    const files = {
      "proj/settings.py": settings(),
      "proj/views.py": viewsets,
      "proj/urls.py": lines(
        "from django.urls import include, path",
        "from rest_framework import routers as r",
        "from . import views",
        "router = r.DefaultRouter()",
        'router.register(r"items", views.Items)',
        'router.register("accounts", views.Accounts, basename="account")',
        "v2 = r.SimpleRouter(trailing_slash=False, use_regex_path=False)",
        'v2.register("notes", views.Notes, basename="note")',
        'urlpatterns = [path("api/", include(router.urls)), path("v2/", include(v2.urls))]',
      ),
    };
    const { explicit, raw, limits } = read(files);
    expect(limits).toEqual([]);
    expect(explicit).toEqual([
      "GET /api/items",
      "POST /api/items",
      "GET /api/items.{format}",
      "POST /api/items.{format}",
      "GET /api/items/archive",
      "DELETE /api/items/archive",
      "GET /api/items/archive.{format}",
      "DELETE /api/items/archive.{format}",
      "GET /api/items/recent",
      "GET /api/items/recent.{format}",
      "GET /api/items/{pk}",
      "PUT /api/items/{pk}",
      "PATCH /api/items/{pk}",
      "DELETE /api/items/{pk}",
      "GET /api/items/{pk}.{format}",
      "PUT /api/items/{pk}.{format}",
      "PATCH /api/items/{pk}.{format}",
      "DELETE /api/items/{pk}.{format}",
      "POST /api/items/{pk}/set-status",
      "POST /api/items/{pk}/set-status.{format}",
      "GET /api/accounts",
      "GET /api/accounts.{format}",
      "GET /api/accounts/{pk}",
      "GET /api/accounts/{pk}.{format}",
      "GET /api",
      "GET /api/{format}",
      "GET /v2/notes",
      "DELETE /v2/notes/{note_id}",
    ]);
    const one = (key: string) => raw.find((s) => `${s.method} ${s.path}` === key)!;
    expect([one("GET /api/accounts/{pk}").patterns, one("GET /api/items.{format}").dispatch?.trailing, one("GET /api/{format}").patterns, one("DELETE /v2/notes/{note_id}").patterns]).toEqual([
      { pk: "[0-9]+" },
      "both",
      { format: "\\.[a-z0-9]+" },
      { note_id: "[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}" },
    ]);
    expect(one("GET /v2/notes").dispatch?.trailing).toBeUndefined();
    expect(one("GET /api/items/recent").at).toEqual({ file: "proj/urls.py", line: 5 });
  });

  it("reads only the ViewSets registered before the router's urls are read, and names what it does not read", () => {
    const files = {
      "proj/settings.py": settings(),
      "proj/views.py": viewsets,
      "proj/routers.py": lines("from rest_framework.routers import SimpleRouter", "shared = SimpleRouter()"),
      "proj/urls.py": lines(
        "from django.urls import include, path",
        "from rest_framework.routers import SimpleRouter",
        "from . import views",
        "from .routers import shared",
        "router = SimpleRouter()",
        'router.register("accounts", views.Accounts)',
        'urlpatterns = [path("", include(router.urls))]',
        'router.register("late", views.Accounts)',
        'shared.register("notes", views.Notes)',
        "other = SimpleRouter(trailing_slash=SLASH)",
        "urlpatterns += other.urls",
        "odd = SimpleRouter()",
        "odd.trailing_slash = '/?'",
        'odd.register(PREFIX, views.Accounts)',
        'odd.register("plain", views.Plain)',
        'odd.register("acc", views.Accounts)',
        "urlpatterns += odd.urls",
      ),
    };
    const { explicit, limits } = read(files);
    expect(explicit).toEqual(["GET /accounts", "GET /accounts/{pk}", "GET /acc", "GET /acc/{pk}"]);
    expect(limits).toEqual([
      "routes api: proj/urls.py:9 registers a ViewSet on shared, a router another file makes, whose patterns that file may read before this runs; it is not read",
      "routes api: proj/urls.py:10: the router made with trailing_slash=SLASH, which atlas does not read; its routes are not read",
      "routes api: proj/urls.py:14: it registers a ViewSet under a prefix the file does not spell out; its routes are not read",
      "routes api: proj/urls.py:15: it registers views.Plain, which atlas does not trace to a class of the files read, Django's or DRF's; its routes are not read",
    ]);
    const { raw } = read(files);
    expect(raw.find((s) => s.path === "/acc")?.dispatch?.trailing).toBe("both");
  });

  it("reads format_suffix_patterns on a URLconf's own patterns, with its allowed suffixes", () => {
    const files = {
      "proj/settings.py": settings(),
      "proj/views.py": "def a(request): ...",
      "proj/urls.py": lines(
        "from django.urls import path",
        "from rest_framework.urlpatterns import format_suffix_patterns",
        "from . import views",
        'urlpatterns = format_suffix_patterns([path("a/", views.a)], allowed=["json", "html"])',
        'urlpatterns += format_suffix_patterns([path("b/", views.a)], suffix_required=True)',
      ),
    };
    const { raw, limits } = read(files);
    expect(limits).toEqual([]);
    expect(raw.map((s) => [s.path, s.patterns ?? {}, s.dispatch?.trailing])).toEqual([
      ["/a", {}, "slash"],
      ["/a{format}", { format: "\\.(?:json|html)" }, "both"],
      ["/b{format}", { format: "\\.[a-z0-9]+" }, "both"],
    ]);
  });
});

describe("where Django dispatches a request", () => {
  const files = {
    "proj/settings.py": settings(),
    "proj/views.py": lines(
      "from django.views.decorators.common import no_append_slash",
      "from django.views.decorators.http import require_GET, require_POST",
      "@require_GET",
      "def recent(request): ...",
      "@require_POST",
      "def item(request, pk): ...",
      "@no_append_slash",
      "def quiet(request): ...",
      "def files(request, rest): ...",
    ),
    "proj/urls.py": urls(
      'urlpatterns = [path("items/recent/", views.recent), path("items/<pk>/", views.item), path("quiet/", views.quiet), re_path(r"^media/(?P<rest>.*)$", views.files)]',
    ),
  };

  it("dispatches a request to the first pattern its path fits, whatever its method, which refuses another method", () => {
    expect(reach(files, ["GET /items/recent/", "POST /items/recent/", "POST /items/1/", "GET /items/1/"]).reached).toEqual({
      "GET /items/recent/": ["GET /items/recent"],
      "POST /items/recent/": [],
      "POST /items/1/": ["POST /items/{pk}"],
      "GET /items/1/": [],
    });
  });

  it("redirects a request without its / that no pattern takes as written to the path with it, where the first pattern that takes that appends it", () => {
    const { reached, matched } = reach(files, ["GET /items/recent", "GET /quiet", "GET /media", "GET /media/a/b", "POST /items/1"]);
    expect(reached).toEqual({
      "GET /items/recent": ["redirect /items/recent/: GET /items/recent"],
      "GET /quiet": [],
      "GET /media": ["redirect /media/: * /media/**"],
      "GET /media/a/b": ["* /media/**"],
      "POST /items/1": ["redirect /items/1/: POST /items/{pk}"],
    });
    expect(matched[0]).toBe("calls web->api: GET /items/recent at x:1 is answered with a redirect to /items/recent/, which GET /items/recent serves; it reaches that route only as its client follows the redirect, so it is matched to none");
  });

  it("serves the path as the pattern writes it, without a redirect where CommonMiddleware or APPEND_SLASH is off", () => {
    for (const s of ["MIDDLEWARE = []", "APPEND_SLASH = False"]) {
      const off = { ...files, "proj/settings.py": lines(settings(), s) };
      const surfaces = extractRoutes(memory(off), config(), undefined, [], []);
      expect(new Set(surfaces.map((x) => x.dispatch?.slashes))).toEqual(new Set(["strict"]));
      expect(reach(off, ["GET /items/recent"]).reached).toEqual({ "GET /items/recent": [] });
    }
  });
});

describe("the review of #82", () => {
  it("keeps a pattern whose view takes no method from the requests it takes, and reads a repeated pattern at its first place", () => {
    const files = {
      "proj/settings.py": settings(),
      "proj/views.py": lines(
        "from django.views.decorators.http import require_http_methods, require_GET, require_POST",
        '@require_http_methods(["get"])',
        "def none(request): ...",
        "@require_GET",
        "def get(request, **kw): ...",
        "@require_POST",
        "def post(request): ...",
      ),
      "proj/urls.py": urls('urlpatterns = [path("x/", views.none), path("x/", views.get), path("y/<int:n>/", views.none), path("y/<int:n>/", views.get), path("y/<str:n>/", views.get), path("z/", views.get), path("z/", views.post), path("z/", views.get)]'),
    };
    const { surfaces, limits } = read(files);
    expect(surfaces).toEqual(["GET /y/{n}", "GET /z", "POST /z"]);
    expect(limits).toEqual([
      'routes api: proj/urls.py:3 serves "x/" with a view that takes no method, which Django answers every request to with 405; no route is read for it, a later pattern whose every request it takes is left out, and one that shares only some may be matched to those',
      'routes api: proj/urls.py:3 serves "x/", whose requests proj/urls.py:3 serves "x/" takes first, with a view that takes no method; its routes are not read',
      'routes api: proj/urls.py:3 serves "y/<int:n>/" with a view that takes no method, which Django answers every request to with 405; no route is read for it, a later pattern whose every request it takes is left out, and one that shares only some may be matched to those',
      'routes api: proj/urls.py:3 serves "y/<int:n>/", whose requests proj/urls.py:3 serves "y/<int:n>/" takes first, with a view that takes no method; its routes are not read',
    ]);
    // `/y/{n}` is the `str` pattern's, which the `int` one leaves the values that are not digits.
    expect(read(files).raw.find((s) => s.path === "/y/{n}")?.patterns).toBeUndefined();
    expect(reach(files, ["GET /x/", "POST /z/", "GET /z/"]).reached).toEqual({ "GET /x/": [], "POST /z/": [], "GET /z/": ["GET /z"] });
  });

  it("sees a list an include holds changed after it, by append, extend, insert and +=", () => {
    const files = {
      "proj/settings.py": settings(),
      "proj/views.py": "def a(request): ...",
      "proj/urls.py": urls(
        "extra = []",
        "alias = extra",
        'urlpatterns = [path("api/", include(extra))]',
        'extra.append(path("a/", views.a))',
        'alias.extend([path("b/", views.a)])',
        'extra.insert(0, path("c/", views.a))',
        'alias += [path("d/", views.a)]',
        'copy = extra + [path("e/", views.a)]',
        'gone = [path("f/", views.a)]',
        'urlpatterns += [path("g/", include(gone))]',
        "gone.clear()",
      ),
    };
    expect(read(files)).toMatchObject({
      surfaces: ["* /api/c", "* /api/a", "* /api/b", "* /api/d"],
      limits: ['routes api: proj/urls.py:13 (under "g/"): gone, changed at proj/urls.py:13 in a way atlas does not read; its routes are not read'],
    });
  });

  it("reads a converter registered only where its call runs, and a to_python it does not read as one that may refuse", () => {
    const files = (debug: string) => ({
      "proj/settings.py": settings(`DEBUG = ${debug}`),
      "proj/converters.py": lines(
        "from django.urls.converters import IntConverter",
        "class Code:",
        '    regex = "[A-Z]+"',
        "    to_python = str",
        "class Year(IntConverter):",
        '    regex = "[0-9]{4}"',
        "class Prefixed(IntConverter):",
        '    regex = "x[0-9]+"',
      ),
      "proj/urls.py": lines(
        "from django.conf import settings",
        "from django.urls import path, register_converter",
        "from . import converters, views",
        'register_converter(converters.Code, "code")',
        'register_converter(converters.Year, "yyyy")',
        'register_converter(converters.Prefixed, "xint")',
        "if settings.DEBUG:",
        '    register_converter(converters.Year, "dbg")',
        "def ready():",
        '    register_converter(converters.Year, "late")',
        'urlpatterns = [path("c/<code:c>/", views.a), path("y/<yyyy:y>/", views.a), path("x/<xint:x>/", views.a), path("d/<dbg:d>/", views.a), path("l/<late:l>/", views.a)]',
      ),
      "proj/views.py": "def a(request, **kw): ...",
    });
    const on = read(files("True"));
    expect(on.raw.map((s) => [s.path, s.patterns ?? {}])).toEqual([
      ["/c/{c:code}", {}],
      ["/y/{y}", { y: "[0-9]{4}" }],
      ["/x/{x:xint}", {}],
      ["/d/{d}", { d: "[0-9]{4}" }],
    ]);
    expect(on.limits).toEqual([
      'routes api: proj/urls.py:11 serves a pattern atlas does not read: the route "l/<late:l>/" names the converter late: the converter late is registered at proj/urls.py:10 in a function or class, which runs only when it is called; its routes are not read',
    ]);
    expect(read(files("False")).limits).toContain(
      'routes api: proj/urls.py:11 serves a pattern atlas does not read: the route "d/<dbg:d>/" names the converter dbg, which is neither Django\'s nor one the files register; its routes are not read',
    );
    expect(read(files("env()")).limits).toContain(
      'routes api: proj/urls.py:11 serves a pattern atlas does not read: the route "d/<dbg:d>/" names the converter dbg: the converter dbg is registered at proj/urls.py:8 under a condition atlas does not read; its routes are not read',
    );
  });

  it("reads a router without regexes as DRF builds it, lookup_value_regex standing as a converter Django refuses", () => {
    const files = {
      "proj/settings.py": settings(),
      "proj/views.py": lines("from rest_framework import viewsets", "class Notes(viewsets.ViewSet):", '    lookup_value_regex = "[0-9]+"', "    def retrieve(self, request, pk=None): ..."),
      "proj/urls.py": lines("from rest_framework.routers import SimpleRouter", "from . import views", "router = SimpleRouter(use_regex_path=False)", 'router.register("notes", views.Notes)', "urlpatterns = router.urls"),
    };
    expect(read(files).limits).toEqual([
      'routes api: proj/urls.py:4 serves a pattern atlas does not read: the route "notes/<[0-9]+:pk>/" names the converter [0-9]+, which is neither Django\'s nor one the files register; its routes are not read',
    ]);
  });

  it("writes Python's \\s as the characters it takes, and reads a character beyond U+FFFF whole", () => {
    const files = {
      "proj/settings.py": settings(),
      "proj/views.py": "def a(request, **kw): ...",
      "proj/urls.py": urls('urlpatterns = [re_path(r"^s/(?P<x>a\\s)/$", views.a), re_path(r"^e/(?P<x>😀?)/$", views.a), re_path(r"^f/(?P<x>😀+)/$", views.a), re_path(r"^n/(?P<x>[\\Sa])/$", views.a)]'),
    };
    const { raw, limits } = read(files);
    const s = raw.find((r) => r.path === "/s/{x}")!.patterns!.x!;
    expect(["a\x1c", "a\x85", "a\ufeff"].map((v) => new RegExp(`^(?:${s})$`).test(v))).toEqual([true, true, false]);
    expect(new RegExp(`^(?:${raw.find((r) => r.path === "/f/{x}")!.patterns!.x!})$`).test("😀😀")).toBe(true);
    expect(limits).toEqual([
      'routes api: proj/urls.py:3 serves a pattern atlas does not read: r"^e/(?P<x>😀?)/$" has a parameter x that takes an empty segment, which atlas\'s path form does not hold; its routes are not read',
      'routes api: proj/urls.py:3 serves a pattern atlas does not read: the regex "^n/(?P<x>[\\\\Sa])/$" has \\S inside a class, which JavaScript does not write there; its routes are not read',
    ]);
  });

  it("redirects a request without its / by any method, naming no route where the view refuses the method", () => {
    const files = {
      "proj/settings.py": settings(),
      "proj/views.py": lines("from django.views.decorators.http import require_POST", "@require_POST", "def submit(request): ..."),
      "proj/urls.py": urls('urlpatterns = [path("submit/", views.submit)]'),
    };
    const { reached, matched } = reach(files, ["GET /submit", "POST /submit"]);
    expect(reached).toEqual({ "GET /submit": ["redirect /submit/: "], "POST /submit": ["redirect /submit/: POST /submit"] });
    expect(matched[0]).toBe("calls web->api: GET /submit at x:1 is answered with a redirect to /submit/, where the route the path reaches does not take GET; it is matched to none");
  });
});

describe("the django style in a scan", () => {
  it("offers the django style for the files that import Django or DRF and register patterns", () => {
    const files = {
      "api/urls.py": urls('urlpatterns = [path("a/", views.a), re_path(r"^b/$", views.a)]'),
      "api/routers.py": lines("from rest_framework.routers import DefaultRouter", "router = DefaultRouter()", 'router.register(r"items", ItemViewSet)'),
      "api/other.py": lines("import os", 'p = os.path.join("a", "b")', 'path("x/", y)'),
    };
    expect(inventory(memory(files), []).routes.map((r) => `${r.file} ${r.style} ${r.count}`)).toEqual(["api/urls.py django 2", "api/routers.py django 1"]);
  });

  it("writes the routes of the Django fixture as the model's schema says", () => {
    const dir = "fixtures/frameworks/django";
    const graph = scan(new WorktreeSource(dir), loadConfig(`${dir}/atlas.config.yaml`), { root: dir, requested: "WORKTREE" });
    // Every route the fixture's gaps.yaml does not list is read (test/frameworks.test.ts compares them one by one).
    expect(graph.surfaces.filter((s) => !s.implicit).length).toBe(95);
    expect(graph.surfaces.every((s) => s.dispatch?.byPath && s.dispatch.picks === "registration")).toBe(true);
    expect(graph.limits.filter((l) => l.startsWith("routes app:"))).toEqual([
      "routes app: project/urls.py:17: \"admin/\" includes the admin site's patterns (admin.site.urls): which models they serve depends on every installed app's admin module, their pages take <path:object_id> before more segments, and their methods the signed-in user; its routes are not read",
    ]);
    expect(validate("graph", JSON.parse(JSON.stringify(graph)))).toEqual([]);
  });
});
