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
"""

import json
import logging
import os
import re
from importlib import import_module
from importlib.metadata import version

import django

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


def paths(regex: str) -> list[str]:
    forms = normalize(regex)
    if forms == [("", [])] and re.sub(r"\\Z|\$", "", regex):
        raise ValueError(f"Django cannot write out {regex}")  # a `|` outside a group
    out = []
    for text, params in forms:
        values = {p: "{**}" if any(re.fullmatch(group_regex(regex, p), s) for s in SLASHED) else "{}" for p in params}
        path = ("/" + text % values).rstrip("/") or "/"
        out.append(path)
        if path.endswith("/{**}") and re.fullmatch(group_regex(regex, params[-1]), ""):
            out.append(path.removesuffix("/{**}") or "/")
    return out


def anonymous(method: str, path: str):
    request = factory.generic(method, path)
    request.user = AnonymousUser()
    request.session = import_module(settings.SESSION_ENGINE).SessionStore()
    request._dont_enforce_csrf_checks = True
    return request


def methods(callback, path: str, kwargs: dict) -> list[str]:
    if getattr(callback, "actions", None):
        allowed = callback.cls.http_method_names
        return sorted(m.upper() for m in callback.actions if m in allowed)
    if hasattr(callback, "view_class"):
        view = callback.view_class(**callback.view_initkwargs)
        view.setup(anonymous("GET", path), **kwargs)
        return sorted(view._allowed_methods())
    answered = []
    for method in METHODS:
        try:
            status = callback(anonymous(method, path), **kwargs).status_code
        except Http404:
            status = 404
        if status != 405:
            answered.append(method)
    return ["*"] if answered == METHODS else answered


def walk(patterns, prefix: str, defaults: dict, out: list[dict]) -> list[dict]:
    for pattern in patterns:
        piece = pattern.pattern.regex.pattern.removeprefix("^")
        if isinstance(pattern, URLResolver):
            walk(pattern.url_patterns, prefix + piece, {**defaults, **pattern.default_kwargs}, out)
            continue
        regex = prefix + piece
        for path in paths(regex):
            sample = path.replace("{**}", "x").replace("{}", "1")
            params = {p: "1" for _, ps in normalize(regex) for p in ps if not p.startswith("_")}
            for method in methods(pattern.callback, sample, {**params, **defaults, **pattern.default_args}):
                out.append({"method": method, "path": path, "raw": "^" + regex})
    return out


routes = walk(get_resolver().url_patterns, "", {}, [])
served_by = f"{version('django')}, djangorestframework {version('djangorestframework')}"
print(json.dumps({"framework": "django", "version": served_by, "routes": routes}))
