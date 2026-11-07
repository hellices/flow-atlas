"""Asks Starlette which routes the application serves: Starlette dispatches a request through the application's route
table, trying each route in turn, and through the route table of each Mount it enters, so each Route there, under the
paths of the Mounts it sits in, is a route the application serves."""

import json
import re
from importlib.metadata import version

from starlette.endpoints import HTTPEndpoint
from starlette.routing import BaseRoute, Mount, Route
from starlette.staticfiles import StaticFiles

from app.main import app

PARAM = re.compile(r"\{([^{}:]+)(?::[^{}]+)?\}")


def canonical(raw: str, convertors: dict) -> list[str]:
    # A parameter whose convertor's regex takes a slash takes the rest of the path; the path before it as well where
    # that regex takes nothing (`path`, `.*`). Any other parameter takes one segment's text.
    rest = []

    def param(m: re.Match) -> str:
        regex = convertors[m.group(1)].regex
        if re.fullmatch(regex, "a/b"):
            rest.append(re.fullmatch(regex, "") is not None)
            return "{**}"
        return "{}"

    path = PARAM.sub(param, raw).rstrip("/") or "/"
    if path.endswith("/{**}") and rest and rest[-1]:
        return [path[: -len("/{**}")] or "/", path]
    return [path]


def methods(route: Route) -> list[str]:
    if route.methods:
        return sorted(route.methods)
    # A route to a class hands it every request; an HTTPEndpoint answers the methods it defines, as it lists them.
    if isinstance(route.endpoint, type) and issubclass(route.endpoint, HTTPEndpoint):
        return sorted(route.endpoint({"type": "http"}, None, None)._allowed_methods)
    return ["*"]


def walk(routes: list[BaseRoute], prefix: str, convertors: dict, out: list[dict]) -> list[dict]:
    for route in routes:
        if isinstance(route, Mount):
            here = {**convertors, **route.param_convertors}
            if route.routes:
                walk(route.routes, prefix + route.path, here, out)
            else:
                # An ASGI application with no route table of its own takes every path under the mount; StaticFiles
                # answers GET and HEAD there, anything else a 405.
                raw = prefix + route.path + "/{path:path}"
                answered = ["GET", "HEAD"] if isinstance(route.app, StaticFiles) else ["*"]
                for method in answered:
                    out.extend({"method": method, "path": p, "raw": raw} for p in canonical(raw, here))
        elif isinstance(route, Route):
            # WebSocketRoute and Host are left out: a WebSocket is no HTTP request, and hosts are not in the form.
            raw = prefix + route.path
            for method in methods(route):
                out.extend({"method": method, "path": p, "raw": raw} for p in canonical(raw, {**convertors, **route.param_convertors}))
    return out


print(json.dumps({"framework": "starlette", "version": version("starlette"), "routes": walk(app.routes, "", {}, [])}))
