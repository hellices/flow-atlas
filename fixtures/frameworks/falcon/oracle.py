"""Asks Falcon which routes the application serves: `falcon.inspect.inspect_routes` lists the routes of the router
Falcon dispatches with, each with its responders; a method is served where the responder is the resource's own or the
OPTIONS responder Falcon adds, and not where it is Falcon's `method_not_allowed`. A field with the `path` converter
takes the rest of the path; the path before it is a route where the router finds it there (`find`, asked for that path
with its final `/`). Static routes (`inspect_static_routes`) take every path under their prefix, the prefix's own `/`
included where the static route matches it; a request for a file under one is answered whatever its method (`*`) when
every method of HTTP Falcon knows is, else for the methods that are not refused.
Sinks take what a regex prefix matches, which the form does not express; the application has none."""

import json
import re
from pathlib import Path

import falcon
import falcon.inspect
from falcon import testing

from app.main import app

FIELD = re.compile(r"\{([^{}:]+)(?::([A-Za-z_]+)[^{}]*)?\}")
METHODS = sorted(falcon.constants.HTTP_METHODS)


def found(path: str, resource_class: str) -> bool:
    match = app._router.find(path)
    return match is not None and type(match[0]).__name__ == resource_class


routes = []
for route in falcon.inspect.inspect_routes(app):
    path = FIELD.sub(lambda m: "{**}" if m.group(2) == "path" else "{}", route.path).rstrip("/") or "/"
    paths = [path]
    if path.endswith("/{**}"):
        parent = path[: -len("/{**}")] or "/"
        if found(parent.rstrip("/") + "/", route.class_name):
            paths.insert(0, parent)
    for method in sorted({m.method for m in route.methods if m.function_name != "method_not_allowed"} - {"WEBSOCKET"}):
        routes.extend({"method": method, "path": p, "raw": route.path} for p in paths)



def status(method: str, path: str) -> int:
    # A request straight to the WSGI application: Falcon's test client lints the environ and refuses CONNECT and TRACE.
    answer = []
    app(testing.create_environ(path=path, method=method), lambda status, headers, *_: answer.append(status))
    return int(answer[0].split()[0])


for static, (route, _, _) in zip(falcon.inspect.inspect_static_routes(app), app._static_routes):
    prefix = static.prefix.rstrip("/")
    sample = next(p for p in Path(static.directory).rglob("*") if p.is_file()).relative_to(static.directory).as_posix()
    paths = ([prefix or "/"] if route.match(prefix + "/") else []) + [prefix + "/{**}"]
    answered = [m for m in METHODS if status(m, f"{prefix}/{sample}") != 405]
    for method in ["*"] if answered == METHODS else answered:
        routes.extend({"method": method, "path": p, "raw": static.prefix} for p in paths)

print(json.dumps({"framework": "falcon", "version": falcon.__version__, "routes": routes}))
