"""Asks FastAPI which routes the application serves: Starlette dispatches a request through the application's route
table, so each route there, and each one of the applications mounted under it, is a route the application serves."""

import json
import re

import fastapi
from starlette.routing import BaseRoute, Mount, Route, WebSocketRoute

from app.main import app

try:
    # FastAPI 0.16x keeps an included router as one entry and yields its routes under their prefixes here.
    from fastapi.routing import iter_route_contexts
except ImportError:  # an earlier FastAPI copies the routes of an included router into the application's table

    def iter_route_contexts(routes):
        return routes

PARAM = re.compile(r"\{([^{}:]+)(?::([^{}]+))?\}")


def canonical(path: str) -> list[str]:
    # The `path` convertor takes the rest of the path, slashes included, or none of it (`.*`): the path before it is
    # dispatched there too. Any other parameter takes one segment's text.
    rest = path.endswith(":path}")
    path = PARAM.sub(lambda m: "{**}" if m.group(2) == "path" else "{}", path).rstrip("/") or "/"
    return [path[: -len("/{**}")] or "/", path] if rest else [path]


def walk(routes: list[BaseRoute], prefix: str, out: list[dict]) -> list[dict]:
    for context in iter_route_contexts(routes):
        route = getattr(context, "route", context)
        if isinstance(route, WebSocketRoute):
            continue
        if isinstance(route, Mount):
            mounted = route.routes
            if mounted:
                walk(mounted, prefix + route.path, out)
            else:
                # An ASGI application with no route table of its own (StaticFiles) takes every path under the mount.
                raw = prefix + route.path + "/{path:path}"
                for method in ("GET", "HEAD"):
                    out.extend({"method": method, "path": path, "raw": raw} for path in canonical(raw))
        elif isinstance(route, Route):
            raw = prefix + context.path
            for method in sorted(getattr(context, "methods", None) or route.methods or ["*"]):
                out.extend({"method": method, "path": path, "raw": raw} for path in canonical(raw))
    return out


print(json.dumps({"framework": "fastapi", "version": fastapi.__version__, "routes": walk(app.routes, "", [])}))
