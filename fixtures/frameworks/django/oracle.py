"""Asks Django which routes the application serves: Django dispatches each request through the URL resolver of
ROOT_URLCONF (`get_resolver()`), whose patterns, included URLconfs and routers' patterns among them, are walked here.

The path of a route is the regex Django matches, joined as Django joins it for `reverse()` and written out by Django's
own `normalize()`, one path for each form an optional group allows. A parameter whose regex takes a slash (the `path`
converter, `.+`, `.*`) is `{**}`, any other `{}`; one ending the path that also takes nothing (`.*`, so `media/` is
dispatched to the route too) gives the path before its `/` as well.

Its methods are the ones the view answers:
- a Django REST framework ViewSet: the methods its router bound to actions (`as_view(actions)`);
- a class-based view (Django's `View`, DRF's `APIView` and `@api_view`): the methods the class answers, as Django
  lists them in `Allow` (`_allowed_methods()`);
- a function view: the methods it does not refuse with 405 when called with each, anonymous; `*` when it refuses none,
  since Django leaves a function's methods to the function (the admin's views, which send an anonymous user to the
  login page, are `*`, though its logout takes only POST from a signed-in user).
A view is called as Django's handler calls it: on a path its patterns match, with the arguments its resolver passes
(each converter's `to_python()` applied, the extra options added), and an `async def` view run to its response.
"""

import json
import logging
import os
import re
import re._parser as sre
from importlib import import_module
from importlib.metadata import version

import django
from asgiref.sync import async_to_sync, iscoroutinefunction

os.environ.setdefault("DJANGO_SETTINGS_MODULE", "project.settings")

django.setup()
logging.disable(logging.WARNING)  # Django logs each 405 the function views answer below

from django.conf import settings
from django.contrib.auth.models import AnonymousUser
from django.http import Http404
from django.test import RequestFactory
from django.urls import URLResolver, get_resolver
from django.utils.regex_helper import normalize

METHODS = ["GET", "HEAD", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"]
SLASHED = ["a/b", "1/2", "a-b/c-d", "/", "a/"]
VALUES = ["1", "2020", "a", "abc", "a-b", "00000000-0000-0000-0000-000000000001", ".json", "a/b"]
factory = RequestFactory()


def group_regex(regex: str, name: str) -> str:
    """The text of the capturing group `name` (or `_<n>`, the nth unnamed one, as normalize names it) in regex."""
    if name.startswith("_") and name[1:].isdigit():
        starts = [m.start() for m in re.finditer(r"(?<!\\)\((?!\?)", regex)]
        start, body = starts[int(name[1:])], starts[int(name[1:])] + 1
    else:
        start = regex.index(f"(?P<{name}>")
        body = start + len(f"(?P<{name}>")
    depth, i, in_class = 0, start, False
    while i < len(regex):
        ch = regex[i]
        if ch == "\\":
            i += 2
            continue
        if in_class:
            in_class = ch != "]"
        elif ch == "[":
            in_class = True
        elif ch == "(":
            depth += 1
        elif ch == ")":
            depth -= 1
            if depth == 0:
                return regex[body:i]
        i += 1
    raise ValueError(f"unbalanced group {name} in {regex}")


def witness(regex: str) -> str:
    """A shortest text the regex matches, from its parse: the first branch, each repeat its least times."""

    def text(items) -> str:
        out = ""
        for op, av in items:
            name = str(op)
            if name == "LITERAL":
                out += chr(av)
            elif name in ("ANY", "NOT_LITERAL"):
                out += "a" if name == "ANY" or av != ord("a") else "b"
            elif name == "IN":
                own = [chr(v) for o, v in av if str(o) == "LITERAL"] + [chr(v[0]) for o, v in av if str(o) == "RANGE"]
                out += next(c for c in [*own, *"1a-_.A~", *map(chr, range(33, 127))] if re.fullmatch(sre_class(av), c))
            elif name == "BRANCH":
                out += text(av[1][0])
            elif name == "SUBPATTERN":
                out += text(av[3])
            elif name in ("MAX_REPEAT", "MIN_REPEAT", "POSSESSIVE_REPEAT"):
                out += text(av[2]) * av[0]
            elif name == "ATOMIC_GROUP":
                out += text(av)
        return out

    return text(sre.parse(regex))


CATEGORIES = {
    "CATEGORY_DIGIT": r"\d",
    "CATEGORY_NOT_DIGIT": r"\D",
    "CATEGORY_SPACE": r"\s",
    "CATEGORY_NOT_SPACE": r"\S",
    "CATEGORY_WORD": r"\w",
    "CATEGORY_NOT_WORD": r"\W",
}


def sre_class(items) -> str:
    """The character class a parsed `[...]` stands for, written back as a regex."""
    parts, negate = [], False
    for op, av in items:
        name = str(op)
        if name == "NEGATE":
            negate = True
        elif name == "LITERAL":
            parts.append(re.escape(chr(av)))
        elif name == "RANGE":
            parts.append(f"{re.escape(chr(av[0]))}-{re.escape(chr(av[1]))}")
        elif name == "CATEGORY":
            parts.append(CATEGORIES[str(av)])
    return f"[{'^' if negate else ''}{''.join(parts)}]"


def value(regex: str, name: str) -> str:
    """A value the parameter's regex takes: a usual one when it takes one, else the shortest its regex matches."""
    group = group_regex(regex, name)
    return next((v for v in VALUES if re.fullmatch(group, v)), None) or witness(group)


def paths(regex: str) -> list[tuple[str, str]]:
    """Each path the regex stands for, in the compared form, with a path Django matches with it."""
    forms = normalize(regex)
    if forms == [("", [])] and re.sub(r"\\Z|\$", "", regex):
        raise ValueError(f"Django cannot write out {regex}")  # a `|` outside a group
    out = []
    for text, params in forms:
        values = {p: "{**}" if any(re.fullmatch(group_regex(regex, p), s) for s in SLASHED) else "{}" for p in params}
        samples = {p: value(regex, p) for p in params}
        path = ("/" + text % values).rstrip("/") or "/"
        out.append((path, text % samples))
        if path.endswith("/{**}") and re.fullmatch(group_regex(regex, params[-1]), ""):
            out.append((path.removesuffix("/{**}") or "/", text % {**samples, params[-1]: ""}))
    return out


def anonymous(method: str, path: str):
    request = factory.generic(method, path)
    request.user = AnonymousUser()
    request.session = import_module(settings.SESSION_ENGINE).SessionStore()
    request._dont_enforce_csrf_checks = True
    return request


def methods(callback, path: str, args: tuple, kwargs: dict) -> list[str]:
    if getattr(callback, "actions", None):
        allowed = callback.cls.http_method_names
        return sorted(m.upper() for m in callback.actions if m in allowed)
    if hasattr(callback, "view_class"):
        view = callback.view_class(**callback.view_initkwargs)
        view.setup(anonymous("GET", path), *args, **kwargs)
        return sorted(view._allowed_methods())
    # As Django's handler runs a view (BaseHandler._get_response): an async one to completion.
    call = async_to_sync(callback) if iscoroutinefunction(callback) else callback
    answered = []
    for method in METHODS:
        try:
            status = call(anonymous(method, path), *args, **kwargs).status_code
        except Http404:
            status = 404
        if status != 405:
            answered.append(method)
    return ["*"] if answered == METHODS else answered


def arguments(chain: list, path: str) -> tuple[tuple, dict]:
    """
    The arguments Django's resolver passes the view of the last pattern in chain for path: each pattern matches its part
    of the path, converting what it captures (`to_python()`), and adds its extra options, as URLResolver.resolve does.
    """
    rest, args, kwargs = path, (), {}
    for pattern in chain:
        match = pattern.pattern.match(rest)
        if match is None:
            raise ValueError(f"{path!r} is no path of {chain[-1]!r}")
        rest, captured_args, captured = match
        extra = pattern.default_kwargs if isinstance(pattern, URLResolver) else pattern.default_args
        args, kwargs = args + captured_args, {**kwargs, **captured, **extra}
    return (() if kwargs else args), kwargs


def walk(patterns, chain: list, out: list[dict]) -> list[dict]:
    for pattern in patterns:
        if isinstance(pattern, URLResolver):
            walk(pattern.url_patterns, [*chain, pattern], out)
            continue
        regex = "".join(p.pattern.regex.pattern.removeprefix("^") for p in [*chain, pattern])
        for path, sample in paths(regex):
            args, kwargs = arguments([*chain, pattern], sample)
            for method in methods(pattern.callback, "/" + sample, args, kwargs):
                out.append({"method": method, "path": path, "raw": "^" + regex})
    return out


routes = walk(get_resolver().url_patterns, [], [])
served_by = f"{version('django')}, djangorestframework {version('djangorestframework')}"
print(json.dumps({"framework": "django", "version": served_by, "routes": routes}))
