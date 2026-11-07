"""Asks Django and Django Ninja which routes the application serves: Django dispatches each request through the URL
resolver of ROOT_URLCONF (`get_resolver()`), in which each `NinjaAPI` is included (`api.urls`) with a pattern for each
operation of its routers' `path_operations`, under the routers' `add_router` prefixes, and its OpenAPI document and
docs page. Those patterns are walked here.

The path of a route is the regex Django matches, joined as Django joins it for `reverse()` and written out by Django's
own `normalize()`. A parameter whose converter takes a slash (`path`) is `{**}`, any other `{}`.

Its methods are, for a Ninja operation, the methods of every operation of its path (Ninja gives each operation its own
pattern, and the first of them takes the request and dispatches on the method among them all); for another view, the
methods it does not refuse with 405, `*` where it refuses none. A view that answers every method with 404 (the API's
root, kept only for `reverse()`) serves nothing.

Each route is confirmed by requests through Django's test client: Django resolves a path the pattern takes to that
pattern's view (or, for a Ninja operation, to its path's), and Ninja answers 405 exactly to the methods none of the
path's operations takes.
"""

import contextlib
import inspect
import json
import logging
import os
import re

from importlib.metadata import version

import django

os.environ.setdefault("DJANGO_SETTINGS_MODULE", "project.settings")

django.setup()
logging.disable(logging.WARNING)  # Django logs each 404 and 405 the requests below get

from django.test import Client
from django.urls import URLResolver, get_resolver, resolve
from django.utils.regex_helper import normalize
from ninja.operation import PathView

METHODS = ["GET", "HEAD", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"]
# Values tried for a parameter, the first its converter takes standing in the requests; "a/b" tells one taking a slash.
SAMPLES = ["1", "x", "a-b", "0f8fad5b-d9cb-469f-a165-70867728950e", "a/b"]
client = Client()


def group_regex(regex: str, name: str) -> str:
    """The text of the named group `name` in regex."""
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


def written(regex: str) -> tuple[str, str]:
    """The canonical path of a pattern's regex and a path it takes."""
    forms = normalize(regex)
    if len(forms) != 1:
        raise ValueError(f"{regex} has {len(forms)} forms")
    text, params = forms[0]
    canonical, sample = {}, {}
    for p in params:
        group = re.compile(group_regex(regex, p))
        canonical[p] = "{**}" if group.fullmatch("a/b") else "{}"
        sample[p] = next(s for s in SAMPLES if group.fullmatch(s))
    path = ("/" + text % canonical).rstrip("/") or "/"
    return path, "/" + text % sample


def path_view(callback) -> PathView | None:
    """The PathView a Ninja operation's view dispatches through (`PathView.get_view()` closes over it)."""
    owner = inspect.getclosurevars(callback).nonlocals.get("self") if inspect.isfunction(callback) else None
    return owner if isinstance(owner, PathView) else None


def answered(path: str) -> list[str]:
    statuses = {m: client.generic(m, path).status_code for m in METHODS}
    if all(s == 404 for s in statuses.values()):
        return []
    served = [m for m, s in statuses.items() if s != 405]
    return ["*"] if served == METHODS else served


def walk(patterns, prefix: str, out: list[dict]) -> list[dict]:
    for pattern in patterns:
        piece = pattern.pattern.regex.pattern.removeprefix("^")
        if isinstance(pattern, URLResolver):
            walk(pattern.url_patterns, prefix + piece, out)
            continue
        regex = prefix + piece
        path, sample = written(regex)
        view = path_view(pattern.callback)
        taken = resolve(sample).func
        if (path_view(taken) or taken) is not (view or pattern.callback):
            continue  # an earlier pattern of the same path takes its requests (another operation of the path)
        methods = answered(sample)
        if view is not None:
            operations = sorted({m for op in view.operations for m in op.methods})
            if sorted(methods) != operations:
                raise AssertionError(f"{sample} answers {methods}, its operations take {operations}")
        for method in methods:
            out.append({"method": method, "path": path, "raw": "^" + regex})
    return out


# Ninja prints a warning to stdout for each operation id the router mounted twice repeats in the OpenAPI document.
with open(os.devnull, "w") as devnull, contextlib.redirect_stdout(devnull):
    routes = walk(get_resolver().url_patterns, "", [])
served_by = f"{version('django-ninja')}, django {version('django')}"
print(json.dumps({"framework": "django-ninja", "version": served_by, "routes": routes}))
