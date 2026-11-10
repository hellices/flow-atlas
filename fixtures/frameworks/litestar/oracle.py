"""Asks Litestar which routes the application serves: `app.routes` is the route table Litestar builds its router from,
each HTTP route with the methods its handlers answer (the OPTIONS handler Litestar adds included), and each ASGI route
with the application it hands every method to. A path parameter of type `path` takes the rest of the path; whether it
takes nothing as well, Litestar's own router says (`asgi_router.handle_routing`), asked for the path before it.

A mounted ASGI application (`@asgi(..., is_mount=True)`) takes its path and every path under it; Litestar matches a
mount's path as a prefix of the request's, so it also takes `/legacyx`, which no route in the form expresses."""

import json
import re
from importlib.metadata import version

from litestar.exceptions import NotFoundException
from litestar.routes import ASGIRoute, HTTPRoute

from app.main import app

PARAM = re.compile(r"\{([^{}:]+)(?::([^{}]+))?\}")


def dispatched(path: str, handlers: list) -> bool:
    try:
        return app.asgi_router.handle_routing(path, None)[1] in handlers
    except NotFoundException:
        return False


def canonical(raw: str, handlers: list, mount: bool = False) -> list[str]:
    path = PARAM.sub(lambda m: "{**}" if m.group(2) == "path" else "{}", raw).rstrip("/") or "/"
    if mount:
        path = path.rstrip("/") + "/{**}"
    if not path.endswith("/{**}"):
        return [path]
    parent = path[: -len("/{**}")] or "/"
    # Asked as Litestar receives it, the request for the parent with its final `/`.
    return [parent, path] if dispatched(parent.rstrip("/") + "/", handlers) else [path]


routes = []
for route in app.routes:
    if isinstance(route, HTTPRoute):
        for method in sorted(route.methods):
            routes.extend({"method": method, "path": p, "raw": route.path} for p in canonical(route.path, route.route_handlers))
    elif isinstance(route, ASGIRoute):
        handler = route.route_handler
        routes.extend({"method": "*", "path": p, "raw": route.path} for p in canonical(route.path, [handler], handler.is_mount))
    # A WebSocket route serves no HTTP request.

print(json.dumps({"framework": "litestar", "version": version("litestar"), "routes": routes}))
