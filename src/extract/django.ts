import type { Dispatch } from "../model.js";
import { lineOf } from "../source.js";
import { chainPaths, DJANGO_CONVERTERS, mayTake, parseRegex, type Converter, type Piece } from "./djangopaths.js";
import { assignment, moduleFiles, plainImports, pythonBindings, pythonImports, submodule, type Imports } from "./python.js";
import { closingParen, pythonArg, pythonArgStarts, pythonCode, pythonStrings } from "./routes.js";

/**
 * The routes Django serves, as Django 6.1 and Django REST framework 3.18 build and dispatch them: the URLconf
 * `ROOT_URLCONF` names, its `path()` and `re_path()` patterns and the URLconfs they `include()` (a module, a list, a
 * router's `urls`), each pattern's view and the methods it answers, and DRF's routers, which build a pattern for each
 * route of each ViewSet they register. A request is dispatched to the first pattern its path fits, whatever its method
 * (`URLResolver.resolve`); that pattern's view refuses a method it does not take.
 */

export interface DjangoRoute {
  method: string;
  path: string;
  patterns?: Record<string, string>;
  file: string;
  line: number;
  implicit?: true;
  dispatch: Dispatch;
}

/** The HTTP method names of `View.http_method_names`, the default every view keeps unless it sets its own. */
const HTTP = ["get", "post", "put", "patch", "delete", "head", "options", "trace"];

/**
 * The classes of Django and Django REST framework a view may derive from, by their module's name: the attributes they
 * define that atlas reads (handlers, ViewSet actions), their `http_method_names` where they set it, whether they are a
 * view (`View`) and a ViewSet (`ViewSetMixin`). From django/views/generic/*.py, django/contrib/auth/views.py and
 * mixins.py, django/views/i18n.py, and rest_framework/views.py, generics.py, mixins.py and viewsets.py.
 */
interface Known {
  members: string[];
  http?: string[];
  view?: true;
  viewset?: true;
}
const view = (...members: string[]): Known => ({ members, view: true });
const mixin = (...members: string[]): Known => ({ members });
const FORM = ["get", "post", "put", "options"];
const KNOWN: Record<string, Known> = {
  "django.views.generic.base.View": view("options"),
  "django.views.generic.base.TemplateView": view("get", "options"),
  "django.views.generic.base.RedirectView": view("get", "head", "post", "options", "delete", "put", "patch"),
  "django.views.generic.base.ContextMixin": mixin(),
  "django.views.generic.base.TemplateResponseMixin": mixin(),
  "django.views.generic.list.MultipleObjectMixin": mixin(),
  "django.views.generic.list.MultipleObjectTemplateResponseMixin": mixin(),
  "django.views.generic.list.BaseListView": view("get", "options"),
  "django.views.generic.list.ListView": view("get", "options"),
  "django.views.generic.detail.SingleObjectMixin": mixin(),
  "django.views.generic.detail.SingleObjectTemplateResponseMixin": mixin(),
  "django.views.generic.detail.BaseDetailView": view("get", "options"),
  "django.views.generic.detail.DetailView": view("get", "options"),
  "django.views.generic.edit.FormMixin": mixin(),
  "django.views.generic.edit.ModelFormMixin": mixin(),
  "django.views.generic.edit.ProcessFormView": view(...FORM),
  "django.views.generic.edit.BaseFormView": view(...FORM),
  "django.views.generic.edit.FormView": view(...FORM),
  "django.views.generic.edit.BaseCreateView": view(...FORM),
  "django.views.generic.edit.CreateView": view(...FORM),
  "django.views.generic.edit.BaseUpdateView": view(...FORM),
  "django.views.generic.edit.UpdateView": view(...FORM),
  "django.views.generic.edit.DeletionMixin": mixin("delete", "post"),
  "django.views.generic.edit.BaseDeleteView": view("get", "post", "delete", "options"),
  "django.views.generic.edit.DeleteView": view("get", "post", "delete", "options"),
  ...Object.fromEntries(["YearMixin", "MonthMixin", "DayMixin", "WeekMixin", "DateMixin"].map((n) => [`django.views.generic.dates.${n}`, mixin()])),
  ...Object.fromEntries(
    ["BaseDateListView", "BaseArchiveIndexView", "ArchiveIndexView", "BaseYearArchiveView", "YearArchiveView", "BaseMonthArchiveView", "MonthArchiveView", "BaseWeekArchiveView", "WeekArchiveView", "BaseDayArchiveView", "DayArchiveView", "BaseTodayArchiveView", "TodayArchiveView", "BaseDateDetailView", "DateDetailView"].map((n) => [
      `django.views.generic.dates.${n}`,
      view("get", "options"),
    ]),
  ),
  "django.views.i18n.JavaScriptCatalog": view("get", "options"),
  "django.views.i18n.JSONCatalog": view("get", "options"),
  "django.contrib.auth.views.RedirectURLMixin": mixin(),
  "django.contrib.auth.views.PasswordContextMixin": mixin(),
  "django.contrib.auth.views.LoginView": view(...FORM),
  "django.contrib.auth.views.LogoutView": { ...view("get", "post", "options"), http: ["post", "options"] },
  "django.contrib.auth.views.PasswordResetView": view(...FORM),
  "django.contrib.auth.views.PasswordResetDoneView": view("get", "options"),
  "django.contrib.auth.views.PasswordResetConfirmView": view(...FORM),
  "django.contrib.auth.views.PasswordResetCompleteView": view("get", "options"),
  "django.contrib.auth.views.PasswordChangeView": view(...FORM),
  "django.contrib.auth.views.PasswordChangeDoneView": view("get", "options"),
  ...Object.fromEntries(["AccessMixin", "LoginRequiredMixin", "PermissionRequiredMixin", "UserPassesTestMixin"].map((n) => [`django.contrib.auth.mixins.${n}`, mixin()])),
  "django.contrib.messages.views.SuccessMessageMixin": mixin(),
  "rest_framework.views.APIView": view("options"),
  "rest_framework.generics.GenericAPIView": view("options"),
  "rest_framework.generics.CreateAPIView": view("post", "options", "create"),
  "rest_framework.generics.ListAPIView": view("get", "options", "list"),
  "rest_framework.generics.RetrieveAPIView": view("get", "options", "retrieve"),
  "rest_framework.generics.DestroyAPIView": view("delete", "options", "destroy"),
  "rest_framework.generics.UpdateAPIView": view("put", "patch", "options", "update", "partial_update"),
  "rest_framework.generics.ListCreateAPIView": view("get", "post", "options", "list", "create"),
  "rest_framework.generics.RetrieveUpdateAPIView": view("get", "put", "patch", "options", "retrieve", "update", "partial_update"),
  "rest_framework.generics.RetrieveDestroyAPIView": view("get", "delete", "options", "retrieve", "destroy"),
  "rest_framework.generics.RetrieveUpdateDestroyAPIView": view("get", "put", "patch", "delete", "options", "retrieve", "update", "partial_update", "destroy"),
  "rest_framework.mixins.CreateModelMixin": mixin("create"),
  "rest_framework.mixins.ListModelMixin": mixin("list"),
  "rest_framework.mixins.RetrieveModelMixin": mixin("retrieve"),
  "rest_framework.mixins.UpdateModelMixin": mixin("update", "partial_update"),
  "rest_framework.mixins.DestroyModelMixin": mixin("destroy"),
  "rest_framework.viewsets.ViewSetMixin": { members: [], viewset: true },
  "rest_framework.viewsets.ViewSet": { ...view("options"), viewset: true },
  "rest_framework.viewsets.GenericViewSet": { ...view("options"), viewset: true },
  "rest_framework.viewsets.ReadOnlyModelViewSet": { ...view("options", "list", "retrieve"), viewset: true },
  "rest_framework.viewsets.ModelViewSet": { ...view("options", "create", "retrieve", "update", "partial_update", "destroy", "list"), viewset: true },
};
/** The other names a class is imported under: `django.views.View`, and what django/views/generic/__init__.py exports. */
const ALIASES: Record<string, string> = {
  "django.views.View": "django.views.generic.base.View",
  ...Object.fromEntries(
    ["base.View", "base.TemplateView", "base.RedirectView", "dates.ArchiveIndexView", "dates.DateDetailView", "dates.DayArchiveView", "dates.MonthArchiveView", "dates.TodayArchiveView", "dates.WeekArchiveView", "dates.YearArchiveView", "detail.DetailView", "edit.CreateView", "edit.DeleteView", "edit.FormView", "edit.UpdateView", "list.ListView"].map((n) => [
      `django.views.generic.${n.slice(n.indexOf(".") + 1)}`,
      `django.views.generic.${n}`,
    ]),
  ),
};
const known = (name: string | undefined): string | undefined => {
  if (name === undefined) return undefined;
  const canonical = ALIASES[name] ?? name;
  return Object.hasOwn(KNOWN, canonical) ? canonical : undefined;
};

/** Function views of Django's that take any method: they check none (django/views/static.py, contrib/staticfiles/views.py). */
const ANY_METHOD_VIEWS = new Set(["django.views.static.serve", "django.contrib.staticfiles.views.serve"]);

/**
 * Decorators of Django and DRF that leave the methods a view takes as they are: they check a user, a CSRF token, set
 * headers or a cache, or a DRF policy (django/views/decorators/*.py, django/contrib/auth/decorators.py,
 * django/contrib/admin/views/decorators.py, rest_framework/decorators.py); `condition` and its kin answer 304 or 412,
 * not 405.
 */
const TRANSPARENT = new Set([
  ...["cache_page", "cache_control", "never_cache"].map((n) => `django.views.decorators.cache.${n}`),
  ...["xframe_options_deny", "xframe_options_sameorigin", "xframe_options_exempt"].map((n) => `django.views.decorators.clickjacking.${n}`),
  ...["csrf_protect", "requires_csrf_token", "ensure_csrf_cookie", "csrf_exempt"].map((n) => `django.views.decorators.csrf.${n}`),
  ...["sensitive_variables", "sensitive_post_parameters"].map((n) => `django.views.decorators.debug.${n}`),
  "django.views.decorators.gzip.gzip_page",
  ...["conditional_page", "condition", "etag", "last_modified"].map((n) => `django.views.decorators.http.${n}`),
  ...["vary_on_headers", "vary_on_cookie"].map((n) => `django.views.decorators.vary.${n}`),
  ...["csp_override", "csp_report_only_override"].map((n) => `django.views.decorators.csp.${n}`),
  ...["login_required", "login_not_required", "permission_required", "user_passes_test"].map((n) => `django.contrib.auth.decorators.${n}`),
  "django.contrib.admin.views.decorators.staff_member_required",
  ...["renderer_classes", "parser_classes", "authentication_classes", "throttle_classes", "throttle_scope", "permission_classes", "content_negotiation_class", "metadata_class", "versioning_class", "schema"].map(
    (n) => `rest_framework.decorators.${n}`,
  ),
]);
/** `require_GET` and its kin (django/views/decorators/http.py): `require_http_methods` with these methods. */
const REQUIRE: Record<string, string[]> = {
  "django.views.decorators.http.require_GET": ["GET"],
  "django.views.decorators.http.require_POST": ["POST"],
  "django.views.decorators.http.require_safe": ["GET", "HEAD"],
};
const REQUIRE_METHODS = "django.views.decorators.http.require_http_methods";
const NO_APPEND_SLASH = "django.views.decorators.common.no_append_slash";
const API_VIEW = "rest_framework.decorators.api_view";
const ACTION = "rest_framework.decorators.action";
const METHOD_DECORATOR = "django.utils.decorators.method_decorator";

/**
 * URLconfs of Django and DRF a project includes by their module's name, restated from django/contrib/auth/urls.py and
 * rest_framework/urls.py: read as the files are, their routes placed at the `include()` that names them.
 */
const LIBRARY_URLCONFS: Record<string, string> = {
  "rest_framework.urls": [
    "from django.contrib.auth import views",
    "from django.urls import path",
    "urlpatterns = [",
    '    path("login/", views.LoginView.as_view()),',
    '    path("logout/", views.LogoutView.as_view()),',
    "]",
  ].join("\n"),
  "django.contrib.auth.urls": [
    "from django.contrib.auth import views",
    "from django.urls import path",
    "urlpatterns = [",
    '    path("login/", views.LoginView.as_view()),',
    '    path("logout/", views.LogoutView.as_view()),',
    '    path("password_change/", views.PasswordChangeView.as_view()),',
    '    path("password_change/done/", views.PasswordChangeDoneView.as_view()),',
    '    path("password_reset/", views.PasswordResetView.as_view()),',
    '    path("password_reset/done/", views.PasswordResetDoneView.as_view()),',
    '    path("reset/<uidb64>/<token>/", views.PasswordResetConfirmView.as_view()),',
    '    path("reset/done/", views.PasswordResetCompleteView.as_view()),',
    "]",
  ].join("\n"),
};
const library = (module: string) => `<${module}>`;

/** A logical line of a file's code: where it starts (after its indentation) and ends, and how deep it is indented. */
interface Line {
  at: number;
  end: number;
  indent: number;
}

/** A decorator: the expression after its `@`, and where that starts. */
interface Deco {
  text: string;
  at: number;
}

interface Member {
  kind: "def" | "attr";
  at: number;
  /** The text an attribute is assigned. */
  value?: string;
  decorators: Deco[];
  /** A function's body, in the file's code. */
  body?: [number, number];
}

/** A function or class defined at a file's top level. */
interface Def {
  kind: "def" | "class";
  name: string;
  at: number;
  decorators: Deco[];
  body: [number, number];
  bases: Array<{ text: string; at: number }>;
  members: Map<string, Member>;
}

interface FileInfo {
  file: string;
  text: string;
  code: string;
  lines: Line[];
  imports: Imports;
  plain: Set<string>;
  /** Top-level definitions by name; null where a name is defined twice. */
  defs: Map<string, Def | null>;
  /** A URLconf of a library, restated, whose routes are placed where it is included. */
  library?: true;
}

const width = (s: string) => s.replace(/\t/g, "        ").length;

/**
 * Where the strings of a file's text are: for each offset, whether it is inside a string literal (its quotes
 * excluded), found as `pythonCode` finds them.
 */
function stringMask(text: string): boolean[] {
  const mask = new Array<boolean>(text.length).fill(false);
  let i = 0;
  while (i < text.length) {
    if (text[i] === "#") {
      while (i < text.length && text[i] !== "\n") i++;
      continue;
    }
    const m = /[A-Za-z_]/.test(text[i - 1] ?? "") ? null : /^(?:[rRbBuUfF]{0,2})("""|'''|"|')/.exec(text.slice(i, i + 5));
    if (!m) {
      i++;
      continue;
    }
    const quote = m[1]!;
    let j = i + m[0].length;
    while (j < text.length && !text.startsWith(quote, j)) {
      if (text[j] === "\\") j++;
      else if (quote.length === 1 && text[j] === "\n") break;
      j++;
    }
    for (let k = i + m[0].length; k < Math.min(j, text.length); k++) mask[k] = true;
    i = j + quote.length;
  }
  return mask;
}

/**
 * The logical lines of blanked code: a line outside brackets, with the lines a bracket, a `\` or a string written
 * across lines (`"""..."""`) continues it onto. A line break may be CRLF.
 */
function logicalLines(code: string, inString: boolean[]): Line[] {
  const out: Line[] = [];
  let i = 0;
  while (i < code.length) {
    let j = i;
    while (j < code.length && (code[j] === " " || code[j] === "\t")) j++;
    if (j >= code.length) break;
    if (code[j] === "\n" || code[j] === "\r") {
      i = j + 1;
      continue;
    }
    let depth = 0;
    let k = j;
    for (; k < code.length; k++) {
      const c = code[k]!;
      if ("([{".includes(c)) depth++;
      else if (")]}".includes(c)) depth = Math.max(0, depth - 1);
      else if (c === "\n" && !depth && !inString[k] && code[code[k - 1] === "\r" ? k - 2 : k - 1] !== "\\") break;
    }
    out.push({ at: j, end: k, indent: width(code.slice(i, j)) });
    i = k + 1;
  }
  return out;
}

/** The index of the first line after line `k` that is indented no deeper than it: where its block ends. */
const blockEnd = (lines: Line[], k: number, to = lines.length): number => {
  let m = k + 1;
  while (m < to && lines[m]!.indent > lines[k]!.indent) m++;
  return m;
};

/** Positional arguments before a keyword one, by position; keyword ones by name. Undefined where not given. */
type Arg = { at: number; end: number } | "spread" | undefined;
function argAt(text: string, code: string, from: number, name: string, position?: number): Arg {
  const close = closingParen(code, from);
  const starts = pythonArgStarts(code, from).filter((s) => s < close && pythonArg(text, code, s));
  const span = (at: number) => ({ at, end: at + pythonArg(text, code, at).length });
  for (const s of starts) {
    const m = new RegExp(`^${name}\\s*=(?!=)\\s*`).exec(code.slice(s));
    if (m) return span(s + m[0].length);
  }
  const positional: number[] = [];
  for (const s of starts) {
    if (/^[A-Za-z_]\w*\s*=(?!=)/.test(code.slice(s)) || code.startsWith("**", s)) break;
    if (code.startsWith("*", s)) return "spread";
    positional.push(s);
  }
  if (position !== undefined && positional[position] !== undefined) return span(positional[position]);
  return starts.some((s) => code.startsWith("**", s)) ? "spread" : undefined;
}

/** A string literal spanning exactly `[at, end)`, or undefined. */
function literalAt(text: string, at: number, end: number): string | undefined {
  while (end > at && /\s/.test(text[end - 1]!)) end--;
  const s = pythonStrings(text.slice(at, end));
  return s && s.length === end - at ? s.value : undefined;
}

/** The elements of a list, tuple or set literal whose bracket is at `open`: each one's span. */
function elements(text: string, code: string, open: number): Array<{ at: number; end: number }> {
  const close = closingParen(code, open + 1);
  return pythonArgStarts(code, open + 1)
    .filter((s) => s < close && pythonArg(text, code, s))
    .map((s) => ({ at: s, end: s + pythonArg(text, code, s).length }));
}

/** The string literals a list or tuple literal at `[at, end)` holds, or undefined where it holds anything else. */
function stringList(text: string, code: string, at: number, end: number): string[] | undefined {
  while (end > at && /\s/.test(text[end - 1]!)) end--;
  if (!"[(".includes(code[at] ?? "") || closingParen(code, at + 1) !== end - 1) return undefined;
  const items = elements(text, code, at);
  // `("GET")` is a string, not a tuple.
  if (code[at] === "(" && items.length === 1 && !/,\s*\)$/.test(code.slice(at, end))) return undefined;
  const out = items.map((e) => literalAt(text, e.at, e.end));
  return out.every((s): s is string => s !== undefined) ? out : undefined;
}

function fileInfo(file: string, text: string, isLibrary = false): FileInfo {
  const code = pythonCode(text);
  const lines = logicalLines(code, stringMask(text));
  const defs = new Map<string, Def | null>();
  const decoratorsBefore = (k: number): Deco[] => {
    const out: Deco[] = [];
    for (let j = k - 1; j >= 0 && lines[j]!.indent === lines[k]!.indent && code[lines[j]!.at] === "@"; j--) {
      const at = lines[j]!.at + 1 + (/^\s*/.exec(code.slice(lines[j]!.at + 1))?.[0].length ?? 0);
      out.unshift({ text: text.slice(at, lines[j]!.end).trim(), at });
    }
    return out;
  };
  lines.forEach((line, k) => {
    if (line.indent !== 0) return;
    const m = /^(?:async[ \t]+)?(def|class)[ \t]+([A-Za-z_]\w*)[ \t]*(\(?)/.exec(code.slice(line.at, line.end));
    if (!m) return;
    const open = line.at + m[0].length;
    const bases =
      m[1] === "class" && m[3]
        ? pythonArgStarts(code, open)
            .filter((s) => s < closingParen(code, open) && pythonArg(text, code, s) && !/^[A-Za-z_]\w*\s*=(?!=)/.test(code.slice(s)) && !code.startsWith("*", s))
            .map((s) => ({ text: pythonArg(text, code, s), at: s }))
        : [];
    const end = blockEnd(lines, k);
    const body: [number, number] = [line.end, end < lines.length ? lines[end]!.at : code.length];
    const members = new Map<string, Member>();
    if (m[1] === "class") {
      const inner = lines.slice(k + 1, end);
      const indent = inner[0]?.indent;
      inner.forEach((l, i) => {
        if (l.indent !== indent) return;
        const statement = code.slice(l.at, l.end);
        const def = /^(?:async[ \t]+)?def[ \t]+([A-Za-z_]\w*)/.exec(statement);
        if (def) {
          const stop = blockEnd(lines, k + 1 + i, end);
          members.set(def[1]!, { kind: "def", at: l.at, decorators: decoratorsBefore(k + 1 + i), body: [l.end, stop < lines.length ? lines[stop]!.at : code.length] });
          return;
        }
        const attr = /^([A-Za-z_]\w*)[ \t]*(?::[^=\n]+)?=(?!=)[ \t]*/.exec(statement);
        if (attr) members.set(attr[1]!, { kind: "attr", at: l.at, value: text.slice(l.at + attr[0].length, l.end).trim(), decorators: [] });
      });
    }
    const def: Def = { kind: m[1] as "def" | "class", name: m[2]!, at: line.at, decorators: decoratorsBefore(k), body, bases, members };
    defs.set(def.name, defs.has(def.name) ? null : def);
  });
  return { file, text, code, lines, imports: pythonImports(code), plain: plainImports(code), defs, ...(isLibrary ? { library: true as const } : {}) };
}

/** The fully qualified name an expression names through a file's imports, for a module outside the files read. */
function qualify(info: Pick<FileInfo, "imports" | "plain">, expr: string): string | undefined {
  const [head, ...rest] = expr.replace(/\s+/g, "").split(".");
  const imported = info.imports.get(head!);
  if (imported) {
    if (imported.module.startsWith(".")) return undefined;
    return [imported.member ? `${imported.module}.${imported.member}` : imported.module, ...rest].join(".");
  }
  return info.plain.has(head!) ? [head, ...rest].join(".") : undefined;
}

/** Python's `re.escape` (3.7 and later): a backslash before each of its special characters. */
const pyEscape = (s: string) => s.replace(/[()[\]{}?*+\-|^$\\.&~# \t\n\r\v\f]/g, "\\$&");

/** Whether `urlsplit` finds a host in a prefix: `//host/...` or `scheme://host/...`. */
const hasNetloc = (prefix: string) => /^(?:[A-Za-z][A-Za-z0-9+.-]*:)?\/\/[^/?#]/.test(prefix);

interface Place {
  file: string;
  at: number;
}

/** A method a view answers, `implicit` where Django or DRF answers it by itself (HEAD beside GET, OPTIONS). */
type Methods = { methods: Array<{ method: string; implicit: boolean }>; appendSlash: boolean };
type Why = { why: string };

/** The format suffix `format_suffix_patterns` adds after each pattern: as a regex, and as a route with its converter. */
interface Suffix {
  regex: string;
  route: string;
  required: boolean;
}

/** An element of a list of URL patterns: a view's pattern, an `include()`, or one atlas does not read. */
type Item =
  | { kind: "view"; piece: Piece; place: Place; view: Methods | Why }
  | { kind: "include"; piece: Piece; place: Place; target: Target }
  | { kind: "unread"; why: string; place: Place };
type Target = ({ items: Item[] } | { module: string }) & { suffixes?: Suffix[] };

interface Registration {
  prefix: string | Why;
  viewset: { info: FileInfo; at: number; end: number };
  place: Place;
}

/** A DRF router: `SimpleRouter` or `DefaultRouter`, its options and the ViewSets registered on it so far. */
interface Router {
  kind: "simple" | "default";
  place: Place;
  trailingSlash: string | Why;
  regex: boolean | Why;
  rootView: boolean | Why;
  suffixes: boolean | Why;
  registrations: Registration[];
  why?: string;
}

type Value = { kind: "patterns"; items: Item[] } | { kind: "router"; router: Router } | { kind: "module"; file: string } | { kind: "unread"; why: string };

/** A setting's value as a settings file writes it: a string, a boolean, a list of strings; `unread` where it is not spelled out. */
type Setting = string | boolean | string[] | { unread: string } | undefined;

/** A ViewSet's or view class's attributes, read along its method resolution order. */
interface ClassView {
  name: string;
  /** Whether a class of its MRO defines the attribute. */
  has: (name: string) => boolean;
  /** Whether a class of the files read defines it (not one of Django's or DRF's). */
  own: (name: string) => boolean;
  /** The text a class of the files read assigns the attribute, or a known class's value; undefined where none sets it. */
  attr: (name: string) => string | string[] | undefined;
  view: boolean;
  viewset: boolean;
  /** The local classes of its MRO, nearest first. */
  locals: Array<{ info: FileInfo; def: Def }>;
}

const LIMIT_LEAVES = 10000;
const LIMIT_DEPTH = 32;

/** Django's converter classes (django/urls/converters.py): their regex, and what their `to_python` does with a value. */
const CONVERTER_CLASSES: Record<string, { regex: string; toPython: "int" | "uuid" | "str" }> = {
  "django.urls.converters.IntConverter": { regex: "[0-9]+", toPython: "int" },
  "django.urls.converters.StringConverter": { regex: "[^/]+", toPython: "str" },
  "django.urls.converters.UUIDConverter": { regex: "[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}", toPython: "uuid" },
  "django.urls.converters.SlugConverter": { regex: "[-a-zA-Z0-9_]+", toPython: "str" },
  "django.urls.converters.PathConverter": { regex: ".+", toPython: "str" },
};
for (const name of Object.keys(CONVERTER_CLASSES)) KNOWN[name] = mixin();

/** Django's defaults (django/conf/global_settings.py) for the settings atlas reads. */
const DEFAULTS: Record<string, Setting> = { DEBUG: false, APPEND_SLASH: true, MIDDLEWARE: [], MEDIA_URL: "", STATIC_URL: undefined };

export function djangoRoutes(
  texts: Map<string, string>,
  component: string,
  declared: Record<string, string> = {},
): { routes: DjangoRoute[]; limits: string[]; spans: Array<{ file: string; start: number; end: number }> } {
  const infos = new Map<string, FileInfo>();
  for (const [file, text] of texts) if (file.endsWith(".py")) infos.set(file, fileInfo(file, text));
  for (const [module, text] of Object.entries(LIBRARY_URLCONFS)) infos.set(library(module), fileInfo(library(module), text, true));
  const realFiles = [...infos.keys()].filter((f) => !f.startsWith("<"));
  const moduleFile = moduleFiles(realFiles);
  const imports = new Map([...infos].map(([file, info]) => [file, info.imports]));
  const defs = pythonBindings(imports, (file, name) => !!infos.get(file)?.defs.has(name));
  const routes: DjangoRoute[] = [];
  const limits = new Set<string>();
  const spans: Array<{ file: string; start: number; end: number }> = [];
  const where = (p: Place) => `${p.file}:${lineOf(infos.get(p.file)!.text, p.at)}`;
  const limit = (text: string) => limits.add(`routes ${component}: ${text}`);
  const fileOf = (key: string) => key.slice(0, key.lastIndexOf("#"));
  const nameOf = (key: string) => key.slice(key.lastIndexOf("#") + 1);
  /** The file a module names from `from`: one of the files read, or a library's URLconf atlas restates. */
  const resolveModule = (from: string, module: string): string | undefined =>
    (from.startsWith("<") && !module.startsWith(".") ? undefined : moduleFile(from, module)) ?? (Object.hasOwn(LIBRARY_URLCONFS, module) ? library(module) : undefined);

  /**
   * Walks the top-level statements of a file in order, with whether each runs: true, false, or undefined where a
   * condition atlas does not read decides it (`if` on another setting, `try`, `for`, `with`); `def` and `class` bodies
   * are passed over. `cond` reads an `if` condition.
   */
  const statements = (info: FileInfo, visit: (line: Line, runs: boolean | undefined) => void, cond: (text: string) => boolean | undefined) => {
    const both = (a: boolean | undefined, b: boolean | undefined) => (a === false || b === false ? false : a === undefined || b === undefined ? undefined : true);
    const block = (from: number, to: number, runs: boolean | undefined) => {
      let prior: boolean | undefined | null = null;
      for (let k = from; k < to; ) {
        const line = info.lines[k]!;
        const end = blockEnd(info.lines, k, to);
        const statement = info.code.slice(line.at, line.end);
        const header = /^(if|elif|else|try|except|finally|with|for|while|async|def|class|match)\b([^]*):\s*$/.exec(statement);
        if (statement.startsWith("@") || (header && /^(def|class|async)$/.test(header[1]!))) {
          prior = null;
        } else if (header && (header[1] === "if" || header[1] === "elif" || header[1] === "else")) {
          let own: boolean | undefined;
          if (header[1] === "if") own = cond(header[2]!.trim());
          else if (prior === null) own = undefined;
          else if (header[1] === "elif") own = prior === true ? false : prior === undefined ? undefined : cond(header[2]!.trim());
          else own = prior === true ? false : prior === undefined ? undefined : true;
          // Whether a branch of the chain so far was taken: true, false, or not known.
          prior = header[1] === "else" ? null : header[1] === "if" ? own : prior === true ? true : prior === undefined || own === undefined ? undefined : own;
          block(k + 1, end, both(runs, own));
        } else if (header) {
          prior = null;
          block(k + 1, end, runs === false ? false : undefined);
        } else {
          prior = null;
          visit(line, runs);
        }
        k = end;
      }
    };
    block(0, info.lines.length, true);
  };

  // Settings: each file that sets ROOT_URLCONF, itself or through a `from x import *` of one that does, is a settings
  // module DJANGO_SETTINGS_MODULE may name; a setting is read where every one of them gives it the same value.
  const literal = (info: FileInfo, at: number, end: number): Setting => {
    const s = literalAt(info.text, at, end);
    if (s !== undefined) return s;
    const t = info.text.slice(at, end).trim();
    if (t === "True" || t === "False") return t === "True";
    return stringList(info.text, info.code, at, end) ?? { unread: t.replace(/\s+/g, " ") };
  };
  const settingMemo = new Map<string, Setting | null>();
  const settingIn = (file: string, name: string, seen = new Set<string>()): Setting => {
    const key = `${file}#${name}`;
    if (settingMemo.has(key)) return settingMemo.get(key) ?? undefined;
    const info = infos.get(file);
    if (!info || seen.has(file)) return undefined;
    let value: Setting;
    statements(
      info,
      (line, runs) => {
        const statement = info.code.slice(line.at, line.end);
        const star = /^from[ \t]+(\.*[\w.]*)[ \t]+import[ \t]+\*/.exec(statement);
        if (star) {
          const from = resolveModule(file, star[1]!);
          const v = from ? settingIn(from, name, new Set([...seen, file])) : { unread: `from ${star[1]} import *` };
          if (runs === false || v === undefined) return;
          value = runs === undefined ? { unread: `set under a condition (${star[1]})` } : v;
          return;
        }
        // `if x: NAME = ...` on one line: set under a condition.
        if (/^(?:if|elif|else|try|except|finally|with|for|while)\b/.test(statement) && new RegExp(`(?<![\\w.])${name}[ \\t]*(?:\\+?=(?!=)|\\.)`).test(statement)) {
          if (runs !== false) value = { unread: "set under a condition" };
          return;
        }
        const m = new RegExp(`^${name}[ \\t]*(?::[^=\\n]+)?(\\+=|=(?!=))[ \\t]*`).exec(statement);
        const call = new RegExp(`^${name}\\.(\\w+)\\(`).exec(statement);
        if ((!m && !call) || runs === false) return;
        if (runs === undefined) {
          value = { unread: "set under a condition" };
          return;
        }
        if (m) {
          const v = literal(info, line.at + m[0].length, line.end);
          if (m[1] === "=") value = v;
          else value = Array.isArray(value) && Array.isArray(v) ? [...value, ...v] : { unread: `${name} += ...` };
          return;
        }
        // MIDDLEWARE.append("x"), .insert(0, "x"), .remove("x") on a list the file spells out.
        const from = line.at + call![0].length;
        const arg = argAt(info.text, info.code, from, "", call![1] === "insert" ? 1 : 0);
        const item = arg && arg !== "spread" ? literalAt(info.text, arg.at, arg.end) : undefined;
        if (!Array.isArray(value) || item === undefined || !["append", "insert", "remove"].includes(call![1]!)) value = { unread: `${name}.${call![1]}(...)` };
        else value = call![1] === "remove" ? value.filter((v) => v !== item) : [...value, item];
      },
      () => undefined,
    );
    settingMemo.set(key, value ?? null);
    return value;
  };
  const settingsFiles = realFiles.filter((f) => typeof settingIn(f, "ROOT_URLCONF") === "string");
  /** A setting every settings module gives the same value: undefined where none sets it, `unread` where they differ. */
  const setting = (name: string): Setting => {
    if (!settingsFiles.length) return { unread: "not known: no settings module among the files read sets ROOT_URLCONF" };
    const values = settingsFiles.map((f) => settingIn(f, name));
    const first = JSON.stringify(values[0] ?? null);
    if (values.some((v) => typeof v === "object" && !Array.isArray(v))) return values.find((v): v is { unread: string } => typeof v === "object" && !Array.isArray(v));
    const shown = (v: Setting) => (v === undefined ? "Django's default" : JSON.stringify(v));
    return values.every((v) => JSON.stringify(v ?? null) === first) ? values[0] : { unread: `set to ${[...new Set(values.map(shown))].join(" and ")} by the settings files` };
  };
  const shownSetting = (v: Setting) => (typeof v === "object" && !Array.isArray(v) ? v.unread : JSON.stringify(v));
  /** The value of `settings.NAME` (django.conf.settings) an expression names, or undefined where it names none. */
  const settingRef = (info: FileInfo, expr: string): { name: string; value: Setting } | undefined => {
    const m = /^([A-Za-z_][\w.]*)\.([A-Z][A-Z0-9_]*)$/.exec(expr.replace(/\s+/g, ""));
    if (!m || qualify(info, m[1]!) !== "django.conf.settings") return undefined;
    const value = setting(m[2]!);
    return { name: m[2]!, value: value === undefined ? DEFAULTS[m[2]!] : value };
  };
  /** An `if` condition on a boolean setting (`settings.DEBUG`, `not settings.DEBUG`); undefined for any other. */
  const condition = (info: FileInfo) => (text: string) => {
    const m = /^(not\s+)?\(?\s*([A-Za-z_][\w.]*)\s*\)?$/.exec(text);
    const ref = m && settingRef(info, m[2]!);
    return ref && typeof ref.value === "boolean" ? ref.value !== !!m[1] : undefined;
  };

  /** A class an expression names: one the files define (`file#Name`), or one of Django's or DRF's. */
  type ClassRef = { local: string } | { known: string } | Why;
  const classRef = (info: FileInfo, expr: string): ClassRef => {
    const e = expr.replace(/\s+/g, "");
    const key = defs.reference(info.file, e);
    if (key) {
      const def = infos.get(fileOf(key))!.defs.get(nameOf(key));
      if (def === null) return { why: `${e} is defined twice in ${fileOf(key)}` };
      return def?.kind === "class" ? { local: key } : { why: `${e} is not a class` };
    }
    const k = known(qualify(info, e));
    return k ? { known: k } : { why: `${e}, which atlas does not trace to a class of the files read, Django's or DRF's` };
  };

  /** A class's method resolution order (C3, as Python computes it), each of Django's or DRF's classes taken whole. */
  type Node = { info: FileInfo; def: Def } | { known: Known; name: string };
  const mroMemo = new Map<string, string[] | Why>();
  const mro = (id: string, seen = new Set<string>()): string[] | Why => {
    if (id.startsWith("K:")) return [id];
    const memo = mroMemo.get(id);
    if (memo) return memo;
    if (seen.has(id)) return { why: `${nameOf(id)} derives from itself` };
    const key = id.slice(2);
    const info = infos.get(fileOf(key))!;
    const def = info.defs.get(nameOf(key))!;
    const bases: string[] = [];
    for (const b of def.bases) {
      const ref = classRef(info, b.text);
      if ("why" in ref) return { why: `${def.name} derives from ${ref.why}` };
      bases.push("local" in ref ? `L:${ref.local}` : `K:${ref.known}`);
    }
    const seqs: string[][] = [];
    for (const b of bases) {
      const lin = mro(b, new Set([...seen, id]));
      if ("why" in lin) return lin;
      seqs.push([...lin]);
    }
    seqs.push([...bases]);
    const out = [id];
    for (;;) {
      const live = seqs.filter((s) => s.length);
      if (!live.length) break;
      const head = live.map((s) => s[0]!).find((h) => !live.some((s) => s.indexOf(h) > 0));
      if (!head) return { why: `${def.name} has no consistent method resolution order` };
      out.push(head);
      for (const s of live) if (s[0] === head) s.shift();
    }
    mroMemo.set(id, out);
    return out;
  };
  const classView = (ref: ClassRef): ClassView | Why => {
    if ("why" in ref) return ref;
    const order = mro("local" in ref ? `L:${ref.local}` : `K:${ref.known}`);
    if ("why" in order) return order;
    const nodes: Node[] = order.map((id) => {
      if (id.startsWith("K:")) return { known: KNOWN[id.slice(2)]!, name: id.slice(2) };
      const info = infos.get(fileOf(id.slice(2)))!;
      return { info, def: info.defs.get(nameOf(id.slice(2)))! };
    });
    const defines = (n: Node, name: string) => ("known" in n ? n.known.members.includes(name) || (name === "http_method_names" && !!n.known.http) : n.def.members.has(name));
    return {
      name: "local" in ref ? nameOf(ref.local) : ref.known,
      has: (name) => nodes.some((n) => defines(n, name)),
      own: (name) => nodes.some((n) => !("known" in n) && n.def.members.has(name)),
      attr: (name) => {
        const n = nodes.find((x) => defines(x, name));
        if (!n) return undefined;
        if ("known" in n) return name === "http_method_names" ? n.known.http : undefined;
        const m = n.def.members.get(name)!;
        return m.kind === "attr" ? m.value : `a method ${name}`;
      },
      view: nodes.some((n) => "known" in n && !!n.known.view),
      viewset: nodes.some((n) => "known" in n && !!n.known.viewset),
      locals: nodes.filter((n): n is { info: FileInfo; def: Def } => !("known" in n)),
      nodes,
    } as ClassView & { nodes: Node[] };
  };
  /** A string attribute a class sets (`lookup_field = "slug"`): undefined where unset or None. */
  const stringAttr = (cv: ClassView, name: string): string | undefined | Why => {
    const v = cv.attr(name);
    if (v === undefined || v === "None") return undefined;
    if (Array.isArray(v)) return { why: `${cv.name} sets ${name} to a list` };
    const s = pythonStrings(v);
    return s && s.length === v.length ? s.value : { why: `${cv.name} sets ${name} to ${v}, which atlas does not read` };
  };
  /** `http_method_names` of a class: the list it or a base sets, else View's. */
  const httpNames = (cv: ClassView): string[] | Why => {
    const v = cv.attr("http_method_names");
    if (v === undefined) return HTTP;
    if (Array.isArray(v)) return v;
    const list = stringList(v, pythonCode(v), 0, v.length);
    return list ?? { why: `${cv.name}, whose http_method_names are ${v}, which atlas does not read` };
  };

  // Converters `register_converter` registers, by name, anywhere in the files: Django keeps one registry for the process.
  const registered = new Map<string, Converter | Why>();
  for (const [file, info] of infos) {
    if (info.library) continue;
    for (const m of info.code.matchAll(/(?<![\w.])([A-Za-z_][\w.]*)\s*\(\s*/g)) {
      if (qualify(info, m[1]!) !== "django.urls.register_converter" && qualify(info, m[1]!) !== "django.urls.converters.register_converter") continue;
      const from = (m.index ?? 0) + m[0].length;
      const cls = argAt(info.text, info.code, from, "converter", 0);
      const name = argAt(info.text, info.code, from, "type_name", 1);
      const place = where({ file, at: m.index ?? 0 });
      const typeName = name && name !== "spread" ? literalAt(info.text, name.at, name.end) : undefined;
      if (!cls || cls === "spread" || typeName === undefined) {
        limit(`${place} registers a URL converter the file does not spell out; a route that names it is not read`);
        continue;
      }
      if (Object.hasOwn(DJANGO_CONVERTERS, typeName)) continue;
      const read = converterClass(classView(classRef(info, info.text.slice(cls.at, cls.end))), typeName);
      const before = registered.get(typeName);
      registered.set(typeName, before === undefined ? read : { why: `the converter ${typeName} is registered twice, which Django refuses` });
    }
  }
  /**
   * A converter class's regex (the `regex` it or a base sets), and whether its `to_python` may refuse a value, which
   * makes Django try the next pattern: not where it returns the value, `str(value)`, or `int(value)` of digits only.
   */
  function converterClass(cv: ClassView | Why, name: string): Converter | Why {
    if ("why" in cv) return { why: `the converter ${name} is ${cv.why}` };
    const nodes = (cv as ClassView & { nodes: Node[] }).nodes;
    const definer = (member: string) => nodes.find((n) => ("known" in n ? Object.hasOwn(CONVERTER_CLASSES, n.name) : n.def.members.has(member)));
    const regexOwner = definer("regex");
    let regex: string | undefined;
    if (!regexOwner) return { why: `the converter ${name} sets no regex` };
    if ("known" in regexOwner) regex = CONVERTER_CLASSES[regexOwner.name]!.regex;
    else {
      const v = regexOwner.def.members.get("regex")!.value ?? "";
      const s = pythonStrings(v);
      if (!s || s.length !== v.length) return { why: `the converter ${name} sets regex to ${v || "a method"}, which atlas does not read` };
      regex = s.value;
    }
    const parsed = parseRegex(regex);
    const digits = !("why" in parsed) && [...Array(95).keys()].every((k) => /[0-9]/.test(String.fromCharCode(32 + k)) || !mayTake(parsed.alts, String.fromCharCode(32 + k))) && !mayTake(parsed.alts, "é");
    const owner = definer("to_python");
    let refuses: boolean;
    if (!owner) refuses = true;
    else if ("known" in owner) {
      const t = CONVERTER_CLASSES[owner.name]!.toPython;
      refuses = t === "int" ? !digits : t === "uuid" ? regex !== DJANGO_CONVERTERS.uuid!.regex : false;
    } else {
      const member = owner.def.members.get("to_python")!;
      const head = owner.info.code.slice(member.at, member.body![0]).replace(/\s+/g, " ");
      const arg = /def to_python ?\( ?self ?, ?([A-Za-z_]\w*) ?\)/.exec(head)?.[1];
      const body = owner.info.code.slice(member.body![0], member.body![1]).replace(/\s+/g, " ").trim();
      refuses = !arg || !(body === `return ${arg}` || body === `return str(${arg})` || (digits && body === `return int(${arg})`));
    }
    return { regex, refuses };
  }
  const converter = (name: string): Converter | undefined => {
    if (Object.hasOwn(DJANGO_CONVERTERS, name)) return DJANGO_CONVERTERS[name];
    const c = registered.get(name);
    if (c && "why" in c) return undefined;
    return c;
  };
  const converterWhy = (name: string): string | undefined => {
    const c = registered.get(name);
    return c && "why" in c ? c.why : undefined;
  };

  /**
   * What a decorator does to the methods a view takes: nothing (`TRANSPARENT`), only those listed
   * (`require_http_methods`, compared with the request's method as written, so a lower-case name takes none), DRF's
   * `api_view`, or no slash redirect to it (`no_append_slash`). Why not, for any other.
   */
  type Effect = { restrict?: string[]; api?: string[]; noAppendSlash?: true };
  const effectOf = (info: FileInfo, callee: string, argsFrom: number | undefined): Effect | Why => {
    const q = qualify(info, callee);
    if (q && TRANSPARENT.has(q)) return {};
    if (q && Object.hasOwn(REQUIRE, q)) return { restrict: REQUIRE[q]! };
    if (q === NO_APPEND_SLASH) return { noAppendSlash: true };
    if (q === REQUIRE_METHODS || q === API_VIEW) {
      const arg = argsFrom === undefined ? undefined : argAt(info.text, info.code, argsFrom, q === API_VIEW ? "http_method_names" : "request_method_list", 0);
      if (q === API_VIEW && argsFrom === undefined) return { why: callee };
      if (q === API_VIEW && (arg === undefined || (arg !== "spread" && info.text.slice(arg.at, arg.end) === "None"))) return { api: ["GET"] };
      const list = arg && arg !== "spread" ? stringList(info.text, info.code, arg.at, arg.end) : undefined;
      if (!list) return { why: `${callee}() with methods the file does not spell out` };
      return q === API_VIEW ? { api: [...new Set(list.map((m) => m.toUpperCase()))] } : { restrict: list.filter((m) => m === m.toUpperCase()) };
    }
    return { why: callee };
  };
  /** A decorator as written (`@name`, `@name(args)`): its effect. */
  const decoratorEffect = (info: FileInfo, d: Deco): Effect | Why => {
    const m = /^([A-Za-z_][\w.]*)\s*(\()?/.exec(info.code.slice(d.at));
    if (!m) return { why: d.text };
    const effect = effectOf(info, m[1]!, m[2] ? d.at + m[0].length : undefined);
    return "why" in effect ? { why: d.text } : effect;
  };
  const restricted = (methods: Methods["methods"], to: string[] | undefined) => (to ? methods.filter((m) => m.method === "*" || to.includes(m.method)).flatMap((m) => (m.method === "*" ? to.map((x) => ({ method: x, implicit: false })) : [m])) : methods);
  const ANY: Methods = { methods: [{ method: "*", implicit: false }], appendSlash: true };

  /** The methods a function view takes: any, unless a decorator says otherwise. */
  const functionView = (info: FileInfo, def: Def): Methods | Why => {
    let out: Methods = { methods: [...ANY.methods], appendSlash: true };
    for (const d of [...def.decorators].reverse()) {
      const e = decoratorEffect(info, d);
      if ("why" in e) return { why: `the view ${def.name}, decorated with @${e.why}, which atlas does not read` };
      if (e.api) {
        // `api_view` makes an APIView whose `http_method_names` are the methods given and OPTIONS, which APIView answers.
        const inner = out.methods.some((m) => m.method === "*") ? e.api : e.api.filter((m) => out.methods.some((x) => x.method === m));
        out = { ...out, methods: [...inner.map((method) => ({ method, implicit: false })), ...(e.api.includes("OPTIONS") ? [] : [{ method: "OPTIONS", implicit: true }])] };
      }
      out = { methods: restricted(out.methods, e.restrict), appendSlash: out.appendSlash && !e.noAppendSlash };
    }
    return out;
  };

  /** The restrictions a class view's decorators set on its `dispatch` (`method_decorator(..., name="dispatch")`). */
  const dispatchEffects = (cv: ClassView): Effect | Why => {
    let restrict: string[] | undefined;
    let noAppendSlash = false;
    const apply = (info: FileInfo, dec: { at: number; end: number }, name: string | undefined): Why | undefined => {
      const decs = "[(".includes(info.code[dec.at] ?? "") ? elements(info.text, info.code, dec.at) : [dec];
      for (const one of decs) {
        const m = /^([A-Za-z_][\w.]*)\s*(\()?/.exec(info.code.slice(one.at, one.end));
        const e = m ? effectOf(info, m[1]!, m[2] ? one.at + m[0].length : undefined) : { why: info.text.slice(one.at, one.end) };
        if ("why" in e || e.api) return { why: `the view of ${cv.name}, decorated with ${info.text.slice(one.at, one.end)}, which atlas does not read` };
        if (e.restrict && name !== "dispatch") return { why: `the view of ${cv.name}, whose ${name ?? "?"} handler alone is decorated to take some methods` };
        if (e.restrict) restrict = restrict ? restrict.filter((x) => e.restrict!.includes(x)) : e.restrict;
        if (e.noAppendSlash && name === "dispatch") noAppendSlash = true;
      }
      return undefined;
    };
    for (const { info, def } of cv.locals) {
      for (const d of def.decorators) {
        const m = /^([A-Za-z_][\w.]*)\s*\(/.exec(info.code.slice(d.at));
        if (!m || qualify(info, m[1]!) !== METHOD_DECORATOR) return { why: `the view of ${cv.name}, decorated with @${d.text}, which atlas does not read` };
        const from = d.at + m[0].length;
        const dec = argAt(info.text, info.code, from, "decorator", 0);
        const named = argAt(info.text, info.code, from, "name", 1);
        const name = named && named !== "spread" ? literalAt(info.text, named.at, named.end) : undefined;
        if (!dec || dec === "spread" || name === undefined) return { why: `the view of ${cv.name}, decorated with @${d.text}, which atlas does not read` };
        const why = apply(info, dec, name);
        if (why) return why;
      }
      for (const d of def.members.get("dispatch")?.decorators ?? []) {
        const m = /^([A-Za-z_][\w.]*)\s*\(/.exec(info.code.slice(d.at));
        const dec = m && qualify(info, m[1]!) === METHOD_DECORATOR ? argAt(info.text, info.code, d.at + m[0].length, "decorator", 0) : undefined;
        if (!dec || dec === "spread") return { why: `the view of ${cv.name}, whose dispatch is decorated with @${d.text}, which atlas does not read` };
        const why = apply(info, dec, "dispatch");
        if (why) return why;
      }
    }
    return { ...(restrict ? { restrict } : {}), ...(noAppendSlash ? { noAppendSlash: true as const } : {}) };
  };

  /**
   * The methods a class-based view takes (`View._allowed_methods`): each of its `http_method_names` it has a handler
   * for, HEAD where it has `get` (`View.setup`); those Django or DRF answer by themselves (HEAD from `get`, `options`)
   * are implicit.
   */
  const classMethods = (cv: ClassView, http: string[], effects: Effect): Methods => {
    const methods: Methods["methods"] = [];
    for (const m of new Set(http)) {
      if (!cv.has(m) && !(m === "head" && cv.has("get"))) continue;
      methods.push({ method: m.toUpperCase(), implicit: (m === "head" && !cv.own("head")) || (m === "options" && !cv.own("options")) });
    }
    return { methods: restricted(methods, effects.restrict), appendSlash: !effects.noAppendSlash };
  };

  /**
   * The methods a ViewSet's view takes for a mapping of methods to actions (`ViewSetMixin.as_view`): each method mapped,
   * HEAD where GET is, a handler the class defines itself, and `options`, which APIView answers; of its
   * `http_method_names` (`APIView.dispatch`).
   */
  const viewsetMethods = (cv: ClassView, http: string[], mapping: Array<[string, string]>, effects: Effect): Methods => {
    const methods: Methods["methods"] = [];
    const mapped = new Set(mapping.map(([m]) => m));
    const add = (m: string, implicit: boolean) => {
      if (http.includes(m) && !methods.some((x) => x.method === m.toUpperCase())) methods.push({ method: m.toUpperCase(), implicit });
    };
    for (const [m] of mapping) add(m, false);
    if (mapped.has("get") && !mapped.has("head")) add("head", true);
    for (const m of HTTP) if (!mapped.has(m) && cv.has(m)) add(m, m === "options" && !cv.own("options"));
    return { methods: restricted(methods, effects.restrict), appendSlash: !effects.noAppendSlash };
  };

  /** A dict literal of strings (`{"get": "list"}`) at `[at, end)`. */
  const stringDict = (info: FileInfo, at: number, end: number): Array<[string, string]> | undefined => {
    if (info.code[at] !== "{" || closingParen(info.code, at + 1) !== end - 1) return undefined;
    const out: Array<[string, string]> = [];
    for (const e of elements(info.text, info.code, at)) {
      const key = pythonStrings(info.text.slice(e.at, e.end));
      if (!key) return undefined;
      const colon = /^\s*:\s*/.exec(info.text.slice(e.at + key.length, e.end));
      const value = colon ? literalAt(info.text, e.at + key.length + colon[0].length, e.end) : undefined;
      if (value === undefined) return undefined;
      out.push([key.value, value]);
    }
    return out;
  };

  /** `View.as_view(**initkwargs)` or a ViewSet's `as_view(actions)`: the methods its view takes. */
  const asView = (info: FileInfo, cls: string, argsFrom: number): Methods | Why => {
    const cv = classView(classRef(info, cls));
    if ("why" in cv) return { why: `the view of a class atlas does not read (${cv.why})` };
    if (!cv.view) return { why: `the view of ${cls}, which is not a View` };
    const effects = dispatchEffects(cv);
    if ("why" in effects) return effects;
    let http = httpNames(cv);
    const given = argAt(info.text, info.code, argsFrom, "http_method_names");
    if (given === "spread") return { why: `${cls}.as_view() given arguments the file does not spell out` };
    if (given) http = stringList(info.text, info.code, given.at, given.end) ?? { why: `${cls}.as_view() given http_method_names the file does not spell out` };
    if ("why" in http) return http;
    if (!cv.viewset) return classMethods(cv, http, effects);
    const actions = argAt(info.text, info.code, argsFrom, "actions", 0);
    const mapping = actions && actions !== "spread" ? stringDict(info, actions.at, actions.end) : undefined;
    if (!mapping) return { why: `${cls}.as_view() given actions the file does not spell out` };
    return viewsetMethods(cv, http, mapping, effects);
  };

  /**
   * The methods the view an expression gives takes: a function of the files read, a class's `as_view()`, a decorator
   * called on a view (`csrf_exempt(view)`, `cache_page(60)(view)`), a lambda, or a view of Django's that takes any.
   */
  const viewAt = (info: FileInfo, at: number, end: number): Methods | Why => {
    const { text, code } = info;
    while (code[at] === "(" && closingParen(code, at + 1) === end - 1) {
      at += 1 + (/^\s*/.exec(code.slice(at + 1))?.[0].length ?? 0);
      end = at + pythonArg(text, code, at).length;
    }
    const written = text.slice(at, end).replace(/\s+/g, " ");
    if (/^lambda\b/.test(code.slice(at))) return ANY;
    const call = /^([A-Za-z_][\w.]*)\s*\(/.exec(code.slice(at, end));
    if (call) {
      const open = at + call[0].length;
      const close = closingParen(code, open);
      const as = /^(.*?)\s*\.\s*as_view$/.exec(call[1]!.replace(/\s+/g, ""));
      if (as && close === end - 1) return asView(info, as[1]!, open);
      // A decorator called on a view, or a decorator made by a call and then called on it.
      const then = /^\s*\(\s*/.exec(code.slice(close + 1, end));
      const inner = close === end - 1 ? open : then && closingParen(code, close + 1 + then[0].length) === end - 1 ? close + 1 + then[0].length : undefined;
      if (inner === undefined) return { why: `the view ${written}, which atlas does not read` };
      const effect = effectOf(info, call[1]!, close === end - 1 ? undefined : open);
      if ("why" in effect || effect.api) return { why: `the view ${written}, a decorator atlas does not read` };
      const arg = argAt(text, code, inner, "view_func", 0) ?? argAt(text, code, inner, "func", 0);
      if (!arg || arg === "spread") return { why: `the view ${written}, which atlas does not read` };
      const wrapped = viewAt(info, arg.at, arg.end);
      if ("why" in wrapped) return wrapped;
      return { methods: restricted(wrapped.methods, effect.restrict), appendSlash: wrapped.appendSlash && !effect.noAppendSlash };
    }
    if (!/^[A-Za-z_][\w.]*$/.test(written)) return { why: `the view ${written}, which atlas does not read` };
    const key = defs.reference(info.file, written.replace(/\s+/g, ""));
    if (key) {
      const def = infos.get(fileOf(key))!.defs.get(nameOf(key));
      if (def === null) return { why: `the view ${written}, defined twice in ${fileOf(key)}` };
      if (def?.kind === "def") return functionView(infos.get(fileOf(key))!, def);
      return { why: `the view ${written}, a class given without as_view()` };
    }
    if (ANY_METHOD_VIEWS.has(qualify(info, written) ?? "")) return ANY;
    return { why: `the view ${written}, which atlas does not trace to a function or class of the files read` };
  };

  /** An extra action of a ViewSet (`@action`): its name, `detail`, `url_path` and methods mapped to handlers. */
  interface Action {
    name: string;
    detail: boolean;
    urlPath: string;
    mapping: Array<[string, string]>;
  }
  /**
   * The extra actions of a ViewSet, as `get_extra_actions` lists them (`inspect.getmembers`, by name): each attribute
   * whose owner along the MRO decorates it with `@action`, its methods mapped to it, and any `@<action>.mapping.<method>`
   * that maps one more method to another handler.
   */
  const extraActions = (cv: ClassView): Action[] | Why => {
    const nodes = (cv as ClassView & { nodes: Node[] }).nodes;
    const names = [...new Set(cv.locals.flatMap((l) => [...l.def.members.keys()]))].sort();
    const out: Action[] = [];
    for (const name of names) {
      const owner = nodes.find((n) => ("known" in n ? n.known.members.includes(name) : n.def.members.has(name)));
      if (!owner || "known" in owner) continue;
      const member = owner.def.members.get(name)!;
      const info = owner.info;
      const deco = member.decorators.find((d) => {
        const m = /^([A-Za-z_][\w.]*)\s*\(/.exec(info.code.slice(d.at));
        return m && qualify(info, m[1]!) === ACTION;
      });
      if (!deco) continue;
      const what = `the action ${cv.name}.${name}`;
      if (["list", "create", "retrieve", "update", "partial_update", "destroy"].includes(name)) return { why: `${what}, which DRF refuses: it is one of the router's own` };
      const from = deco.at + /^[A-Za-z_][\w.]*\s*\(/.exec(info.code.slice(deco.at))![0].length;
      const detail = argAt(info.text, info.code, from, "detail", 1);
      const detailText = detail && detail !== "spread" ? info.text.slice(detail.at, detail.end) : undefined;
      if (detailText !== "True" && detailText !== "False") return { why: `${what} has a detail the file does not spell out` };
      const methodsArg = argAt(info.text, info.code, from, "methods", 0);
      if (methodsArg === "spread") return { why: `${what} has methods the file does not spell out` };
      const methods = !methodsArg || info.text.slice(methodsArg.at, methodsArg.end) === "None" ? ["get"] : stringList(info.text, info.code, methodsArg.at, methodsArg.end)?.map((m) => m.toLowerCase());
      if (!methods) return { why: `${what} has methods the file does not spell out` };
      const pathArg = argAt(info.text, info.code, from, "url_path", 2);
      if (pathArg === "spread") return { why: `${what} has a url_path the file does not spell out` };
      const given = pathArg && info.text.slice(pathArg.at, pathArg.end) !== "None" ? literalAt(info.text, pathArg.at, pathArg.end) : null;
      if (given === undefined) return { why: `${what} has a url_path the file does not spell out` };
      const mapping: Array<[string, string]> = methods.map((m) => [m, name]);
      for (const [other, m] of owner.def.members) {
        for (const d of m.decorators) {
          const mapped = new RegExp(`^${name}\\s*\\.\\s*mapping\\s*\\.\\s*(get|post|put|patch|delete|head|options|trace)$`).exec(d.text);
          if (mapped && !mapping.some(([x]) => x === mapped[1])) mapping.push([mapped[1]!, other]);
        }
      }
      out.push({ name, detail: detailText === "True", urlPath: given || name, mapping });
    }
    return out;
  };

  const DEFAULT_SUFFIX: Suffix = { regex: "\\.(?P<format>[a-z0-9]+)/?$", route: "<drf_format_suffix:format>", required: false };
  registered.set("drf_format_suffix", { regex: "\\.[a-z0-9]+/?", refuses: false });
  /** `format_suffix_patterns` (rest_framework/urlpatterns.py): each view's pattern, then the same with `.<format>` after it. */
  const suffixed = (items: Item[], suffix: Suffix): Item[] =>
    items.flatMap((item): Item[] => {
      if (item.kind === "include") return [{ ...item, target: { ...item.target, suffixes: [...(item.target.suffixes ?? []), suffix] } }];
      if (item.kind !== "view") return [item];
      const bare = item.piece.text.replace(/\$+$/, "").replace(/\/+$/, "");
      const added: Item = { ...item, piece: { type: item.piece.type, text: bare + (item.piece.type === "regex" ? suffix.regex : suffix.route) } };
      return suffix.required ? [added] : [item, added];
    });

  /**
   * The patterns a DRF router builds (`SimpleRouter.get_urls`, `DefaultRouter.get_urls`): for each ViewSet registered,
   * in order, its list route, its extra list actions, its detail route and its extra detail actions, each where the
   * ViewSet has an action it maps; then, for a DefaultRouter, its API root view, and each pattern with a format suffix.
   */
  const routerItems = (router: Router): Item[] => {
    if (router.why) return [{ kind: "unread", why: router.why, place: router.place }];
    for (const option of [router.trailingSlash, router.regex, router.rootView, router.suffixes]) {
      if (typeof option === "object") return [{ kind: "unread", why: option.why, place: router.place }];
    }
    const regex = router.regex as boolean;
    const slash = router.trailingSlash as string;
    let items: Item[] = [];
    for (const reg of router.registrations) {
      if (typeof reg.prefix === "object") {
        items.push({ kind: "unread", why: reg.prefix.why, place: reg.place });
        continue;
      }
      const vsText = reg.viewset.info.text.slice(reg.viewset.at, reg.viewset.end);
      const cv = classView(classRef(reg.viewset.info, vsText));
      const fail = (why: string) => items.push({ kind: "unread", why: `it registers ${why}`, place: reg.place });
      if ("why" in cv) {
        fail(cv.why);
        continue;
      }
      if (!cv.viewset) {
        fail(`${vsText}, which is not a ViewSet`);
        continue;
      }
      const http = httpNames(cv);
      const effects = dispatchEffects(cv);
      const actions = extraActions(cv);
      const field = stringAttr(cv, "lookup_field");
      const kwarg = stringAttr(cv, "lookup_url_kwarg");
      const valueRegex = stringAttr(cv, "lookup_value_regex");
      const valueConverter = stringAttr(cv, "lookup_value_converter");
      const unread = [http, effects, actions, field, kwarg, valueRegex, valueConverter].find((x): x is Why => typeof x === "object" && x !== null && "why" in x);
      if (unread) {
        fail(`${vsText}: ${unread.why}`);
        continue;
      }
      const name = (kwarg as string | undefined) || ((field as string | undefined) ?? "pk");
      const lookup = regex ? `(?P<${name}>${(valueRegex as string | undefined) ?? "[^/.]+"})` : `<${(valueConverter as string | undefined) ?? (valueRegex as string | undefined) ?? "str"}:${name}>`;
      const routes: Array<{ url: string; urlPath?: string; mapping: Array<[string, string]> }> = [
        { url: "{prefix}{trailing_slash}", mapping: [["get", "list"], ["post", "create"]] },
        ...(actions as Action[]).filter((a) => !a.detail).map((a) => ({ url: "{prefix}/{url_path}{trailing_slash}", urlPath: a.urlPath, mapping: a.mapping })),
        { url: "{prefix}/{lookup}{trailing_slash}", mapping: [["get", "retrieve"], ["put", "update"], ["patch", "partial_update"], ["delete", "destroy"]] },
        ...(actions as Action[]).filter((a) => a.detail).map((a) => ({ url: "{prefix}/{lookup}/{url_path}{trailing_slash}", urlPath: a.urlPath, mapping: a.mapping })),
      ];
      for (const route of routes) {
        const mapping = route.mapping.filter(([, action]) => cv.has(action));
        if (!mapping.length) continue;
        // One pass, as `str.format` fills the template: a value's own braces stay as written.
        const values: Record<string, string> = { prefix: reg.prefix, lookup, trailing_slash: slash, url_path: route.urlPath ?? "" };
        let text = route.url.replace(/\{(prefix|lookup|trailing_slash|url_path)\}/g, (_, k: string) => values[k]!);
        if (regex) text = `^${text}$`;
        // A router with no prefix is included under the project's own: no `/` before its routes (`get_urls`).
        if (!reg.prefix) text = regex ? text.replace(/^\^\//, "^") : text.replace(/^\//, "");
        items.push({ kind: "view", piece: { type: regex ? "regex" : "route", text }, place: reg.place, view: viewsetMethods(cv, http as string[], mapping, effects as Effect) });
      }
    }
    if (router.kind === "default" && router.rootView) {
      items.push({ kind: "view", piece: { type: "route", text: "" }, place: router.place, view: { methods: [{ method: "GET", implicit: false }, { method: "HEAD", implicit: true }, { method: "OPTIONS", implicit: true }], appendSlash: true } });
    }
    if (router.kind === "default" && router.suffixes) items = suffixed(items, DEFAULT_SUFFIX);
    return items;
  };

  // Each module's names, as its top-level statements leave them when it is imported.
  const modules = new Map<string, Map<string, Value>>();
  const evaluating = new Set<string>();
  const unreadValue = (why: string): Value => ({ kind: "unread", why });

  /** The value a name or dotted name has in a file: its own, or one it imports from a file read. */
  const nameValue = (info: FileInfo, env: Map<string, Value>, expr: string): Value => {
    const [head, ...parts] = expr.split(".");
    let rest = parts;
    let value: Value | undefined = env.get(head!);
    if (!value && info.plain.has(head!) && !info.imports.has(head!)) {
      // `import blog.urls` binds `blog`, and `blog.urls` is that module.
      for (let k = parts.length; k >= 0 && !value; k--) {
        const file = resolveModule(info.file, [head, ...parts.slice(0, k)].join("."));
        if (file) {
          value = { kind: "module", file };
          rest = parts.slice(k);
        }
      }
    }
    if (!value) {
      const imported = info.imports.get(head!);
      if (imported?.member) {
        const sub = resolveModule(info.file, submodule(imported.module, imported.member));
        const from = sub ? undefined : resolveModule(info.file, imported.module);
        value = sub ? { kind: "module", file: sub } : from ? (evalModule(from).get(imported.member) ?? unreadValue(`${expr}, which ${from} does not bind to patterns atlas reads`)) : undefined;
      } else if (imported) {
        const file = resolveModule(info.file, imported.module);
        if (file) value = { kind: "module", file };
      }
    }
    if (!value) return unreadValue(`${expr}, which atlas does not trace to patterns of the files read`);
    for (const attr of rest) {
      if (value.kind !== "module") return unreadValue(`${expr}, which atlas does not read`);
      const own = evalModule(value.file).get(attr);
      // A package's submodule, which an import of it binds there.
      const sub: string | undefined = !own && value.file.endsWith("/__init__.py") ? [`${value.file.slice(0, -"__init__.py".length)}${attr}.py`, `${value.file.slice(0, -"__init__.py".length)}${attr}/__init__.py`].find((f) => infos.has(f)) : undefined;
      value = own ?? (sub ? { kind: "module", file: sub } : unreadValue(`${expr}, which ${value.file} does not bind to patterns atlas reads`));
    }
    return value;
  };

  /** The operands of the `+` outside brackets in `[from, to)`. */
  const operands = (code: string, from: number, to: number): Array<[number, number]> => {
    const out: Array<[number, number]> = [];
    let depth = 0;
    let start = from;
    for (let i = from; i < to; i++) {
      const c = code[i]!;
      if ("([{".includes(c)) depth++;
      else if (")]}".includes(c)) depth--;
      else if (c === "+" && !depth) {
        out.push([start, i]);
        start = i + 1;
      }
    }
    out.push([start, to]);
    // Spaces, and a `\` that continues the line, around each.
    const blank = (i: number) => /\s/.test(code[i]!) || (code[i] === "\\" && /^\r?\n/.test(code.slice(i + 1, i + 3)));
    return out.map(([a, b]) => {
      while (a < b && blank(a)) a++;
      while (b > a && blank(b - 1)) b--;
      return [a, b];
    });
  };

  const join = (a: Value, b: Value, place: Place): Value => {
    const items = (v: Value): Item[] => (v.kind === "patterns" ? v.items : [{ kind: "unread", why: v.kind === "unread" ? v.why : "a router or module where patterns are expected", place }]);
    return { kind: "patterns", items: [...items(a), ...items(b)] };
  };

  /** The value of an expression in a file, with the names `env` binds so far. */
  const evalExpr = (info: FileInfo, env: Map<string, Value>, from: number, to: number): Value => {
    const parts = operands(info.code, from, to);
    if (parts.length > 1) return parts.map(([a, b]) => evalExpr(info, env, a, b)).reduce((x, y) => join(x, y, { file: info.file, at: from }));
    const [at, end] = parts[0]!;
    const { text, code } = info;
    const written = text.slice(at, end).replace(/\s+/g, " ");
    const place = { file: info.file, at };
    if ("[(".includes(code[at] ?? "") && closingParen(code, at + 1) === end - 1) {
      const list = elements(text, code, at);
      if (code[at] === "(" && list.length === 1 && !/,\s*\)$/.test(code.slice(at, end))) return evalExpr(info, env, list[0]!.at, list[0]!.end);
      const items: Item[] = [];
      for (const e of list) {
        if (code[e.at] === "*" && code[e.at + 1] !== "*") {
          const v = evalExpr(info, env, e.at + 1, e.end);
          items.push(...(v.kind === "patterns" ? v.items : [{ kind: "unread" as const, why: v.kind === "unread" ? v.why : `${text.slice(e.at, e.end)}, which atlas does not read`, place: { file: info.file, at: e.at } }]));
        } else items.push(patternItem(info, env, e.at, e.end));
      }
      return { kind: "patterns", items };
    }
    const call = /^([A-Za-z_][\w.]*)\s*\(/.exec(code.slice(at, end));
    if (call && closingParen(code, at + call[0].length) === end - 1) {
      const open = at + call[0].length;
      const callee = call[1]!.replace(/\s+/g, "");
      const q = qualify(info, callee);
      if (q === "django.conf.urls.static.static" || q === "django.contrib.staticfiles.urls.staticfiles_urlpatterns") return staticItems(info, place, open, q.endsWith("staticfiles_urlpatterns"));
      if (q === "rest_framework.urlpatterns.format_suffix_patterns") return suffixPatterns(info, env, place, open);
      if (q === "django.conf.urls.i18n.i18n_patterns") return unreadValue(`i18n_patterns(), which puts the active language's code before its patterns`);
      if (q === "rest_framework.routers.DefaultRouter" || q === "rest_framework.routers.SimpleRouter") return { kind: "router", router: newRouter(info, q.endsWith("DefaultRouter") ? "default" : "simple", place, open) };
      if ((callee === "list" || callee === "tuple") && !info.imports.has(callee) && !env.has(callee)) {
        const arg = argAt(text, code, open, "", 0);
        return arg && arg !== "spread" ? evalExpr(info, env, arg.at, arg.end) : unreadValue(`${written}, which atlas does not read`);
      }
      return unreadValue(`${written}, which atlas does not read`);
    }
    if (/^[A-Za-z_][\w.]*$/.test(written.replace(/\s+/g, ""))) {
      const expr = written.replace(/\s+/g, "");
      const urls = /^(.*)\.urls$/.exec(expr);
      if (urls) {
        const q = qualify(info, urls[1]!);
        if (q === "django.contrib.admin.site" || q === "django.contrib.admin.sites.site") {
          return unreadValue(`the admin site's patterns (${expr}): which models they serve depends on every installed app's admin module, their pages take <path:object_id> before more segments, and their methods the signed-in user`);
        }
        const base = nameValue(info, env, urls[1]!);
        if (base.kind === "router") return { kind: "patterns", items: routerItems(base.router) };
        // A module named `urls` (`import blog.urls`), or a name a module binds.
        const whole = nameValue(info, env, expr);
        if (whole.kind !== "unread") return whole;
        if (base.kind === "module") return whole;
        return unreadValue(`${expr}, patterns a library builds (Django Ninja's and the like), which atlas does not read`);
      }
      return nameValue(info, env, expr);
    }
    return unreadValue(`${written}, which atlas does not read`);
  };

  /** A `SimpleRouter(trailing_slash=True, use_regex_path=True)` or `DefaultRouter(...)` made at `place`. */
  const newRouter = (info: FileInfo, kind: Router["kind"], place: Place, open: number): Router => {
    const flag = (name: string, position: number, fallback: boolean): boolean | Why => {
      const arg = argAt(info.text, info.code, open, name, position);
      if (arg === undefined) return fallback;
      const t = arg === "spread" ? "**" : info.text.slice(arg.at, arg.end);
      // `trailing_slash` is read by its truth: `'/' if trailing_slash else ''`.
      if (t === "True" || t === "False") return t === "True";
      const s = arg !== "spread" ? literalAt(info.text, arg.at, arg.end) : undefined;
      return s !== undefined && name === "trailing_slash" ? s !== "" : { why: `the router made with ${name}=${t}, which atlas does not read` };
    };
    const trailing = flag("trailing_slash", 0, true);
    return {
      kind,
      place,
      trailingSlash: typeof trailing === "object" ? trailing : trailing ? "/" : "",
      regex: flag("use_regex_path", 1, true),
      rootView: true,
      suffixes: true,
      registrations: [],
    };
  };

  /** `static(prefix, view=serve)` (django/conf/urls/static.py): a pattern for the files under prefix, only while DEBUG. */
  const staticItems = (info: FileInfo, place: Place, open: number, staticfiles: boolean): Value => {
    const arg = argAt(info.text, info.code, open, "prefix", 0);
    let prefix: Setting;
    if (arg === undefined && staticfiles) prefix = setting("STATIC_URL") ?? DEFAULTS.STATIC_URL;
    else if (arg && arg !== "spread") {
      const t = info.text.slice(arg.at, arg.end);
      prefix = literalAt(info.text, arg.at, arg.end) ?? settingRef(info, t)?.value ?? (t === "None" && staticfiles ? (setting("STATIC_URL") ?? DEFAULTS.STATIC_URL) : { unread: t });
    } else prefix = { unread: "a prefix the file does not spell out" };
    if (typeof prefix !== "string") return unreadValue(`static() with the prefix ${prefix === undefined ? "None" : shownSetting(prefix)}, which atlas does not read`);
    const debug = setting("DEBUG") ?? DEFAULTS.DEBUG;
    if (!prefix) return unreadValue("static() with an empty prefix, which Django refuses");
    if (typeof debug !== "boolean") return unreadValue(`static(), which serves files only while DEBUG, and DEBUG is ${shownSetting(debug)}`);
    if (!debug || hasNetloc(prefix)) return { kind: "patterns", items: [] };
    const viewArg = argAt(info.text, info.code, open, "view", 1);
    const v = viewArg === "spread" ? { why: "a view the file does not spell out" } : viewArg ? viewAt(info, viewArg.at, viewArg.end) : ANY;
    spans.push({ file: info.file, start: open, end: closingParen(info.code, open) });
    return { kind: "patterns", items: [{ kind: "view", piece: { type: "regex", text: `^${pyEscape(prefix.replace(/^\/+/, ""))}(?P<path>.*)$` }, place, view: v }] };
  };

  /** `format_suffix_patterns(urlpatterns, suffix_required=False, allowed=None)`. */
  const suffixPatterns = (info: FileInfo, env: Map<string, Value>, place: Place, open: number): Value => {
    const arg = argAt(info.text, info.code, open, "urlpatterns", 0);
    if (!arg || arg === "spread") return unreadValue("format_suffix_patterns() with patterns the file does not spell out");
    const patterns = evalExpr(info, env, arg.at, arg.end);
    if (patterns.kind !== "patterns") return patterns.kind === "unread" ? patterns : unreadValue("format_suffix_patterns() of a router or module");
    const requiredArg = argAt(info.text, info.code, open, "suffix_required", 1);
    const required = requiredArg && requiredArg !== "spread" ? info.text.slice(requiredArg.at, requiredArg.end) : "False";
    const allowedArg = argAt(info.text, info.code, open, "allowed", 2);
    const allowedText = allowedArg && allowedArg !== "spread" ? info.text.slice(allowedArg.at, allowedArg.end) : "None";
    const allowed = allowedText === "None" ? [] : allowedArg && allowedArg !== "spread" ? stringList(info.text, info.code, allowedArg.at, allowedArg.end) : undefined;
    if ((required !== "True" && required !== "False") || !allowed) return unreadValue("format_suffix_patterns() with options the file does not spell out");
    if (!allowed.length) return { kind: "patterns", items: suffixed(patterns.items, { ...DEFAULT_SUFFIX, required: required === "True" }) };
    const pattern = allowed.length === 1 ? allowed[0]! : `(${allowed.join("|")})`;
    const name = `drf_format_suffix_${allowed.join("_")}`;
    const converterPattern = allowed.length === 1 ? allowed[0]! : `(?:${allowed.join("|")})`;
    registered.set(name, { regex: `\\.${converterPattern}/?`, refuses: false });
    return { kind: "patterns", items: suffixed(patterns.items, { regex: `\\.(?P<format>${pattern})/?$`, route: `<${name}:format>`, required: required === "True" }) };
  };

  /** An element of a list of patterns: a `path()` or `re_path()`. */
  const patternItem = (info: FileInfo, env: Map<string, Value>, at: number, end: number): Item => {
    const { text, code } = info;
    const place = { file: info.file, at };
    const call = /^([A-Za-z_][\w.]*)\s*\(/.exec(code.slice(at, end));
    const q = call && closingParen(code, at + call[0].length) === end - 1 ? qualify(info, call[1]!) : undefined;
    const type = q === "django.urls.path" || q === "django.urls.conf.path" ? "route" : q === "django.urls.re_path" || q === "django.urls.conf.re_path" ? "regex" : undefined;
    if (!type) return { kind: "unread", why: `${text.slice(at, end).replace(/\s+/g, " ")}, which atlas does not read as a pattern`, place };
    const open = at + call![0].length;
    spans.push({ file: info.file, start: open, end: closingParen(code, open) });
    const routeArg = argAt(text, code, open, "route", 0);
    const route = routeArg && routeArg !== "spread" ? literalAt(text, routeArg.at, routeArg.end) : undefined;
    if (route === undefined) return { kind: "unread", why: `a ${type === "route" ? "route" : "regex"} the file does not spell out`, place };
    const piece: Piece = { type, text: route };
    const viewArg = argAt(text, code, open, "view", 1);
    if (!viewArg || viewArg === "spread") return { kind: "unread", why: `${JSON.stringify(route)} with a view the file does not spell out`, place };
    const viewCode = code.slice(viewArg.at, viewArg.end);
    const include = /^([A-Za-z_][\w.]*)\s*\(/.exec(viewCode);
    const iq = include && closingParen(code, viewArg.at + include[0].length) === viewArg.end - 1 ? qualify(info, include[1]!) : undefined;
    if (iq === "django.urls.include" || iq === "django.urls.conf.include" || iq === "django.conf.urls.include") return { kind: "include", piece, place, target: includeTarget(info, env, viewArg.at + include![0].length) };
    // A view that is a list or tuple is an include's result (`admin.site.urls`, a library's patterns).
    const listed = viewCode[0] === "[" || (viewCode[0] === "(" && closingParen(code, viewArg.at + 1) === viewArg.end - 1 && (elements(text, code, viewArg.at).length !== 1 || /,\s*\)$/.test(viewCode)));
    const dotted = viewCode.replace(/\s+/g, "");
    if ((/\.urls$/.test(dotted) && !defs.reference(info.file, dotted)) || listed) {
      const v = evalExpr(info, env, viewArg.at, viewArg.end);
      return { kind: "unread", why: `${JSON.stringify(route)} includes ${v.kind === "unread" ? v.why : "a value atlas does not read"}`, place };
    }
    return { kind: "view", piece, place, view: viewAt(info, viewArg.at, viewArg.end) };
  };

  /** What `include(arg)` includes: a module named by a string or imported, a list of patterns, a `(patterns, app_name)` pair. */
  const includeTarget = (info: FileInfo, env: Map<string, Value>, open: number): Target => {
    const arg = argAt(info.text, info.code, open, "arg", 0);
    const place = { file: info.file, at: open };
    const unread = (why: string): Target => ({ items: [{ kind: "unread", why, place }] });
    if (!arg || arg === "spread") return unread("include() of a URLconf the file does not spell out");
    let { at, end } = arg;
    const pair = info.code[at] === "(" && closingParen(info.code, at + 1) === end - 1 ? elements(info.text, info.code, at) : undefined;
    if (pair && pair.length === 2) ({ at, end } = pair[0]!);
    const named = literalAt(info.text, at, end);
    if (named !== undefined) {
      // `include()` imports a string as an absolute module name (`import_module`).
      const file = named.startsWith(".") ? undefined : resolveModule(info.file, named);
      return file ? { module: file } : unread(`include(${JSON.stringify(named)}), a URLconf that is not among the files read`);
    }
    const v = evalExpr(info, env, at, end);
    if (v.kind === "patterns") return { items: v.items };
    if (v.kind === "module") return { module: v.file };
    return unread(v.kind === "unread" ? `include() of ${v.why}` : "include() of a router, which Django refuses");
  };

  /** Each name a module binds, from its top-level statements in order (`urlpatterns = [...]`, `+=`, `.append`, `router.register`). */
  function evalModule(file: string): Map<string, Value> {
    const memo = modules.get(file);
    if (memo) return memo;
    const env = new Map<string, Value>();
    const info = infos.get(file);
    if (!info || evaluating.has(file)) return env;
    evaluating.add(file);
    const changed = (name: string, line: Line) => {
      const v = env.get(name);
      if (name === "urlpatterns" || v?.kind === "patterns" || v?.kind === "router") {
        limit(`${where({ file, at: line.at })} changes ${name} under a condition atlas does not read; what it adds is not read`);
      }
    };
    statements(
      info,
      (line, runs) => {
        const statement = info.code.slice(line.at, line.end);
        const star = /^from[ \t]+(\.*[\w.]*)[ \t]+import[ \t]+\*/.exec(statement);
        if (star) {
          const from = resolveModule(file, star[1]!);
          if (from && runs) for (const [k, v] of evalModule(from)) env.set(k, v);
          return;
        }
        // A compound statement written on one line (`if x: urlpatterns += [...]`), a subscript or a `del`: what it
        // changes is not read.
        const inline = /^(?:if|elif|else|try|except|finally|with|for|while)\b/.test(statement);
        const other = inline ? statement : /^(?:del[ \t]+)?[A-Za-z_]\w*[ \t]*\[/.test(statement) ? statement : "";
        for (const m of other.matchAll(/(?<![\w.])([A-Za-z_]\w*)[ \t]*(?:\+=|=(?!=)|\[|\.[ \t]*(?:append|extend|insert|register|remove|pop|clear)[ \t]*\()/g)) {
          const v = env.get(m[1]!);
          if (runs === false || !(m[1] === "urlpatterns" || v?.kind === "patterns" || v?.kind === "router")) continue;
          if (inline || runs === undefined) changed(m[1]!, line);
          else env.set(m[1]!, unreadValue(`${m[1]}, changed at ${where({ file, at: line.at })} in a way atlas does not read`));
        }
        if (other) return;
        const assign = /^([A-Za-z_]\w*)[ \t]*(?::[^=\n]+)?(\+=|=(?!=))[ \t]*/.exec(statement);
        if (assign) {
          const asg = assignment(info.code, line.at);
          if (runs === false) return;
          if (runs === undefined) return changed(assign[1]!, line);
          if (asg && asg.targets.length > 1) {
            for (const t of asg.targets) if (/^[A-Za-z_]\w*$/.test(t)) env.set(t, unreadValue(`${t}, assigned in a chain atlas does not read`));
            return;
          }
          const value = evalExpr(info, env, line.at + assign[0].length, line.end);
          if (assign[2] === "=") env.set(assign[1]!, value);
          else env.set(assign[1]!, join(env.get(assign[1]!) ?? nameValue(info, env, assign[1]!), value, { file, at: line.at }));
          return;
        }
        const method = /^([A-Za-z_]\w*)[ \t]*\.[ \t]*(\w+)[ \t]*\(\s*/.exec(statement);
        const attr = /^([A-Za-z_]\w*)[ \t]*\.[ \t]*(\w+)[ \t]*=(?!=)[ \t]*/.exec(statement);
        const registry = /^([A-Za-z_]\w*)[ \t]*\.[ \t]*registry\b/.exec(statement);
        const name = (method ?? attr ?? registry)?.[1];
        const current = name === undefined ? undefined : env.get(name);
        if (!current && method?.[2] === "register" && runs !== false && nameValue(info, env, name!).kind === "router") {
          limit(`${where({ file, at: line.at })} registers a ViewSet on ${name}, a router another file makes, whose patterns that file may read before this runs; it is not read`);
          return;
        }
        if (!current || runs === false) return;
        if (runs === undefined) return changed(name!, line);
        const place = { file, at: line.at };
        if (current.kind === "patterns" && method) {
          const open = line.at + method[0].length;
          const op = method[2]!;
          const arg = argAt(info.text, info.code, open, "", op === "insert" ? 1 : 0);
          if ((op === "append" || op === "extend" || op === "insert") && arg && arg !== "spread") {
            const added = op === "extend" ? evalExpr(info, env, arg.at, arg.end) : { kind: "patterns" as const, items: [patternItem(info, env, arg.at, arg.end)] };
            const index = op === "insert" ? argAt(info.text, info.code, open, "", 0) : undefined;
            const at = index && index !== "spread" && /^\d+$/.test(info.text.slice(index.at, index.end)) ? Number(info.text.slice(index.at, index.end)) : undefined;
            if (op === "insert" && at === undefined) env.set(name!, unreadValue(`${name}, changed at ${where(place)} in a way atlas does not read`));
            else if (op === "insert") {
              const inserted = join({ kind: "patterns", items: [] }, added, place);
              env.set(name!, { kind: "patterns", items: [...current.items.slice(0, at), ...(inserted.kind === "patterns" ? inserted.items : []), ...current.items.slice(at)] });
            }
            else env.set(name!, join(current, added, place));
          } else env.set(name!, unreadValue(`${name}, changed at ${where(place)} in a way atlas does not read`));
          return;
        }
        if (current.kind === "router") {
          const router = current.router;
          if (method?.[2] === "register") {
            const open = line.at + method[0].length;
            spans.push({ file, start: open, end: closingParen(info.code, open) });
            const prefixArg = argAt(info.text, info.code, open, "prefix", 0);
            const vs = argAt(info.text, info.code, open, "viewset", 1);
            const prefix = prefixArg && prefixArg !== "spread" ? literalAt(info.text, prefixArg.at, prefixArg.end) : undefined;
            if (!vs || vs === "spread") router.registrations.push({ prefix: { why: "it registers a ViewSet the file does not spell out" }, viewset: { info, at: open, end: open }, place });
            else router.registrations.push({ prefix: prefix ?? { why: "it registers a ViewSet under a prefix the file does not spell out" }, viewset: { info, at: vs.at, end: vs.end }, place });
          } else if (attr && !method) {
            const value = info.text.slice(line.at + attr[0].length, line.end).trim();
            const key = attr[2]!;
            const bool = value === "True" ? true : value === "False" ? false : { why: `${name}.${key} is set to ${value}, which atlas does not read` };
            if (key === "include_root_view") router.rootView = bool;
            else if (key === "include_format_suffixes") router.suffixes = bool;
            else if (key === "trailing_slash") {
              const s = literalAt(info.text, line.at + attr[0].length, line.end);
              router.trailingSlash = s ?? { why: `${name}.trailing_slash is set to ${value}, which atlas does not read` };
            }
          } else if (registry || method?.[2] === "extend") router.why = `${name} is changed at ${where(place)}, which atlas does not read`;
        }
      },
      condition(info),
    );
    evaluating.delete(file);
    modules.set(file, env);
    return env;
  }

  // The root URLconf, and whether CommonMiddleware redirects a request to the path with a `/` appended (APPEND_SLASH).
  const COMMON = "django.middleware.common.CommonMiddleware";
  // Each settings module's own: CommonMiddleware in its MIDDLEWARE, and APPEND_SLASH; read where they all agree.
  const appendIn = (file: string): boolean | string => {
    const middleware = settingIn(file, "MIDDLEWARE") ?? DEFAULTS.MIDDLEWARE;
    const append = settingIn(file, "APPEND_SLASH") ?? DEFAULTS.APPEND_SLASH;
    if (Array.isArray(middleware) && !middleware.includes(COMMON)) return false;
    if (append === false) return false;
    if (Array.isArray(middleware) && append === true) return true;
    return `${file} sets ${Array.isArray(middleware) ? `APPEND_SLASH to ${shownSetting(append)}` : `MIDDLEWARE to ${shownSetting(middleware)}`}`;
  };
  const appends = settingsFiles.map(appendIn);
  const appendSlash = appends.length && appends.every((a) => a === appends[0]) && typeof appends[0] === "boolean" ? appends[0] : undefined;
  const declaredFiles = new Map<string, string>();
  for (const [file, at] of Object.entries(declared)) if (infos.has(file)) declaredFiles.set(file, at);
  const root = setting("ROOT_URLCONF");
  const roots: Array<{ file: string; prefix: Piece[] }> = [];
  if (typeof root === "string") {
    const file = resolveModule(settingsFiles[0]!, root);
    if (!file) limit(`ROOT_URLCONF is ${root}, a module that is not among the files read; the routes it serves are not read`);
    else if (!declaredFiles.has(file)) roots.push({ file, prefix: [] });
  } else if (!declaredFiles.size) {
    const unreadRoot = realFiles.map((f) => settingIn(f, "ROOT_URLCONF")).find((v) => v !== undefined);
    const what = settingsFiles.length ? `ROOT_URLCONF is ${shownSetting(root)}` : unreadRoot !== undefined ? `ROOT_URLCONF is set to ${shownSetting(unreadRoot)}, which atlas does not read` : "no settings module among the files read sets ROOT_URLCONF";
    limit(`${what}, so the URLconf Django dispatches requests by is not known; the routes it serves are not read (declare a URLconf's path in mounts)`);
  }
  for (const [file, at] of declaredFiles) {
    const prefix = at.replace(/^\/+/, "").replace(/\/*$/, "/");
    roots.push({ file, prefix: prefix === "/" ? [] : [{ type: "route", text: prefix }] });
  }
  if (roots.length && appendSlash === undefined) {
    const why = !appends.length ? "no settings module among the files read sets ROOT_URLCONF" : appends.some((a) => typeof a === "string") ? appends.filter((a) => typeof a === "string").join(", ") : "the settings modules turn it on and off";
    limit(`whether CommonMiddleware redirects a request without a trailing / to the path with it (APPEND_SLASH) is not read: ${why}; such a request is matched to no route either way`);
  }

  let leaves = 0;
  const chainText = (chain: Piece[]) => chain.map((p) => (p.type === "route" ? JSON.stringify(p.text) : `r${JSON.stringify(p.text)}`)).join(" + ");
  const walk = (items: Item[], chain: Piece[], stack: string[], router: string, override: Place | undefined) => {
    for (const item of items) {
      if (leaves > LIMIT_LEAVES) {
        limit(`${stack[0]} serves more than ${LIMIT_LEAVES} patterns; those after are not read`);
        return;
      }
      const place = override ?? item.place;
      const under = chain.length ? ` (under ${chainText(chain)})` : "";
      if (item.kind === "unread") {
        limit(`${where(place)}${under}: ${item.why}; its routes are not read`);
        continue;
      }
      if (item.kind === "view") {
        const index = leaves++;
        const whole = [...chain, item.piece];
        if ("why" in item.view) {
          limit(`${where(place)} serves ${chainText(whole)} with ${item.view.why}; its routes are not read`);
          continue;
        }
        const read = chainPaths(whole, converter);
        if ("why" in read) {
          const named = /names the converter (\S+), which is neither/.exec(read.why);
          const because = named && converterWhy(named[1]!) ? `${read.why.slice(0, named.index)}names the converter ${named[1]}: ${converterWhy(named[1]!)}` : read.why;
          limit(`${where(place)} serves a pattern atlas does not read: ${because}; its routes are not read`);
          continue;
        }
        const slashes = appendSlash && item.view.appendSlash ? ("append-slash" as const) : ("strict" as const);
        for (const form of read) {
          for (const m of item.view.methods) {
            routes.push({
              method: m.method,
              path: form.path,
              ...(form.patterns.size ? { patterns: Object.fromEntries(form.patterns) } : {}),
              file: place.file,
              line: lineOf(infos.get(place.file)!.text, place.at),
              ...(m.implicit ? { implicit: true as const } : {}),
              dispatch: { picks: "registration", byPath: true, order: [{ router, at: index }], slashes, ...(form.trailing ? { trailing: form.trailing } : {}) },
            });
          }
        }
        continue;
      }
      const target = item.target;
      let sub: Item[];
      let next = stack;
      let placed = override;
      if ("module" in target) {
        if (stack.includes(target.module)) {
          limit(`${where(place)} includes ${target.module} within itself; it is not read again`);
          continue;
        }
        if (declaredFiles.has(target.module)) continue;
        if (stack.length >= LIMIT_DEPTH) {
          limit(`${where(place)} includes ${target.module} more than ${LIMIT_DEPTH} URLconfs deep; it is not read`);
          continue;
        }
        const patterns = evalModule(target.module).get("urlpatterns");
        if (patterns?.kind !== "patterns") {
          const why = patterns?.kind === "unread" ? patterns.why : "no urlpatterns atlas reads";
          limit(`${where(place)} includes ${target.module.replace(/^<(.*)>$/, "$1")}, whose urlpatterns are ${why}; its routes are not read`);
          continue;
        }
        sub = patterns.items;
        next = [...stack, target.module];
        if (infos.get(target.module)?.library) placed = place;
      } else sub = target.items;
      for (const s of target.suffixes ?? []) sub = suffixed(sub, s);
      walk(sub, [...chain, item.piece], next, router, placed);
    }
  };
  for (const r of roots) {
    const patterns = evalModule(r.file).get("urlpatterns");
    if (patterns?.kind !== "patterns") {
      limit(`${r.file} is the root URLconf, whose urlpatterns are ${patterns?.kind === "unread" ? patterns.why : "not found"}; its routes are not read`);
      continue;
    }
    const items: Item[] = r.prefix.length ? [{ kind: "include", piece: r.prefix[0]!, place: { file: r.file, at: 0 }, target: { items: patterns.items } }] : patterns.items;
    walk(items, [], [r.file], `django:${r.file}`, undefined);
  }
  return { routes, limits: [...limits], spans };
}
