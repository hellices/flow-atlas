"""Asks Sanic which routes the application serves: `app.router.routes` is the route table Sanic's router dispatches
with, blueprints' and groups' prefixes and versions applied, each route with the methods it answers (a class-based
view's those it defines, static files' GET and HEAD). Whether a parameter takes slashes its type's pattern says; the
path before one that does is a route where the router dispatches it there (`app.router.get`, asked for that path with
its final `/`)."""

import json
import re

import sanic
from sanic.exceptions import NotFound

from app.main import app

PARAM = re.compile(r"<([^<>:]+)(?::[^<>]+)?>")

app.router.finalize()


def dispatched(path: str, method: str, route) -> bool:
    try:
        return app.router.get(path, method, None)[0] is route
    except NotFound:
        return False


routes = []
for route in app.router.routes:
    if getattr(route.extra, "websocket", False):
        continue  # a WebSocket serves no HTTP request
    params = {p.name: p for p in route.params.values()}
    raw = "/" + route.path
    path = PARAM.sub(lambda m: "{**}" if params[m.group(1)].pattern.fullmatch("a/b") else "{}", raw).rstrip("/") or "/"
    for method in sorted(route.methods):
        paths = [path]
        if path.endswith("/{**}"):
            parent = path[: -len("/{**}")] or "/"
            if dispatched(parent.rstrip("/") + "/", method, route):
                paths.insert(0, parent)
        routes.extend({"method": method, "path": p, "raw": raw} for p in paths)

print(json.dumps({"framework": "sanic", "version": sanic.__version__, "routes": routes}))
