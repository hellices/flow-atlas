"""Asks FastAPI which routes the application serves: Starlette dispatches a request through the application's route
table, so each route there, and each one of the applications mounted under it, is a route the application serves."""

import asyncio
import json
import re
import warnings

import fastapi
from starlette.convertors import CONVERTOR_TYPES
from starlette.routing import BaseRoute, Mount, Route, WebSocketRoute

from app.main import app

try:
    # FastAPI 0.16x keeps an included router as one entry and yields its routes under their prefixes here.
    from fastapi.routing import iter_route_contexts
except ImportError:  # an earlier FastAPI copies the routes of an included router into the application's table

    def iter_route_contexts(routes):
        return routes

# `/ping` takes GET and POST under one operation id, which FastAPI warns of while it writes the document served below.
warnings.filterwarnings("ignore", message="Duplicate Operation ID")

PARAM = re.compile(r"\{([^{}:]+)(?::([^{}]+))?\}")


def canonical(path: str) -> list[str]:
    # The `path` convertor takes the rest of the path, slashes included, or none of it (`.*`): the path before it is
    # dispatched there too. Any other parameter takes one segment's text.
    rest = path.endswith(":path}")
    path = PARAM.sub(lambda m: "{**}" if m.group(2) == "path" else "{}", path).rstrip("/") or "/"
    return [path[: -len("/{**}")] or "/", path] if rest else [path]


def walk(routes: list[BaseRoute], prefix: str, out: list[dict], answered_by: list) -> list[dict]:
    # answered_by: beside each entry of out, what Starlette puts in the request's scope as the `endpoint` of the route
    # that takes it, the function of a Route or the application of a Mount.
    for context in iter_route_contexts(routes):
        route = getattr(context, "route", context)
        if isinstance(route, WebSocketRoute):
            continue
        if isinstance(route, Mount):
            mounted = route.routes
            if mounted:
                walk(mounted, prefix + context.path, out, answered_by)
            else:
                # An ASGI application with no route table of its own (StaticFiles) takes every path under the mount.
                raw = prefix + context.path + "/{path:path}"
                for method in ("GET", "HEAD"):
                    for path in canonical(raw):
                        out.append({"method": method, "path": path, "raw": raw})
                        answered_by.append(route.app)
        elif isinstance(route, Route):
            raw = prefix + context.path
            for method in sorted(getattr(context, "methods", None) or route.methods or ["*"]):
                for path in canonical(raw):
                    out.append({"method": method, "path": path, "raw": raw})
                    answered_by.append(context.endpoint)
    return out


endpoints: list = []
routes = walk(app.routes, "", [], endpoints)


def sample(entry: dict) -> str:
    # A concrete path the route takes: each parameter a value its convertor's regex takes, the rest of the path for
    # `path`, which the path before it (`/files`) leaves out.
    raw = entry["raw"]
    if raw.endswith(":path}") and not entry["path"].endswith("/{**}"):
        raw = raw[: raw.rindex("/{")]

    def value(m: re.Match) -> str:
        if m.group(2) == "path":
            return "rest/of/it"
        regex = CONVERTOR_TYPES[m.group(2) or "str"].regex
        return next(v for v in ("value1", "1", "1.5", "00000000-0000-0000-0000-000000000001") if re.fullmatch(regex, v))

    return PARAM.sub(value, raw).rstrip("/") or "/"


def takes(path: str, request: str) -> bool:
    regex = re.escape(path).replace(re.escape("{**}"), ".+").replace(re.escape("{}"), "[^/]+")
    return re.fullmatch(regex, request.rstrip("/") or "/") is not None


async def endpoint_of(method: str, path: str):
    """The status FastAPI answers the request with, and the endpoint of the route Starlette dispatched it to."""
    scope = {
        "type": "http",
        "asgi": {"version": "3.0"},
        "http_version": "1.1",
        "method": method,
        "scheme": "http",
        "server": ("testserver", 80),
        "client": ("testclient", 50000),
        "root_path": "",
        "path": path,
        "raw_path": path.encode(),
        "query_string": b"",
        "headers": [(b"host", b"testserver"), (b"content-type", b"application/json")],
    }
    status = []

    async def receive():
        return {"type": "http.request", "body": b"{}", "more_body": False}

    async def send(message):
        if message["type"] == "http.response.start":
            status.append(message["status"])

    await app(scope, receive, send)
    return status[0], scope.get("endpoint")


# Sample requests, and the route Starlette dispatched each to: every route's sample path, also with a trailing `/`, and
# a path no route takes, each with every method a route registers. A route is told by the `endpoint` Starlette's router
# writes into the request's scope when it hands the request to that route (a mounted application's route overwrites
# its Mount's); its path is the one of its paths that takes the request. A 405 is no route's: Starlette answers it for
# a route that matched the path but not the method. A route's own answer is its, a 404 of StaticFiles for a file not
# there included.
# A path no route takes, but would with its trailing `/` added or removed, is answered by the router itself with a 307
# to that path (`redirect_slashes`, on by default), which writes no endpoint: Starlette and FastAPI document it as a
# redirect to the other path, not as the route that path reaches, so the request is no route's.
# HEAD and OPTIONS only where a route registers them on their own: the compared form leaves out the HEAD beside a GET
# and the OPTIONS beside another method of the same path, which the framework answers by itself.
methods_at: dict[str, set[str]] = {}
for r in routes:
    methods_at.setdefault(r["path"], set()).add(r["method"])
methods = sorted(
    {
        r["method"]
        for r in routes
        if r["method"] != "*"
        and not (r["method"] == "HEAD" and "GET" in methods_at[r["path"]])
        and not (r["method"] == "OPTIONS" and len(methods_at[r["path"]]) > 1)
    }
)
samples = {sample(r) for r in routes}
probes = sorted(samples | {s if s == "/" else s + "/" for s in samples} | {"/nowhere/value1"})
keys = {f"{r['method']} {r['path']}" for r in routes}
requests = []
for path in probes:
    for method in methods:
        status, endpoint = asyncio.run(endpoint_of(method, path))
        owned = [r for r, e in zip(routes, endpoints) if e is endpoint and e is not None]
        if not owned or status == 405:
            requests.append({"method": method, "path": path, "route": None})
            continue
        any_method = any(r["method"] == "*" for r in owned)
        taken = sorted({f"{'*' if any_method else method} {r['path']}" for r in owned if takes(r["path"], path)})
        if len(taken) != 1 or taken[0] not in keys:
            raise SystemExit(f"{method} {path} is answered by {endpoint}, whose routes {owned} give {taken}")
        requests.append({"method": method, "path": path, "route": taken[0]})


print(json.dumps({"framework": "fastapi", "version": fastapi.__version__, "routes": routes, "requests": requests}))
