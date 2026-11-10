"""Asks aiohttp which routes the application serves: `app.router.routes()` is the route table the router resolves a
request with, a nested application's routes included under its prefix, each route with its method (`*` for any, the
HEAD aiohttp adds beside a GET included). A route to a class-based view takes any method and the view answers those it
defines, as `web.View` lists them in its 405. Whether a parameter takes slashes, and whether one that does takes
nothing as well, the resource's own pattern says; the path before such a parameter is a route where the router resolves
it there (the request for that path with its final `/`)."""

import asyncio
import inspect
import json
import re

import aiohttp
from aiohttp import hdrs, web
from aiohttp.test_utils import make_mocked_request

from app.main import app

PARAM = re.compile(r"\{([^{}]+)\}")


async def resolves_to(path: str, resource) -> bool:
    match = await app.router.resolve(make_mocked_request("GET", path, app=app))
    return getattr(match.route, "resource", None) is resource


def canonical(resource) -> tuple[str, str]:
    info = resource.get_info()
    if "path" in info:
        return info["path"], info["path"].rstrip("/") or "/"
    if "prefix" in info:
        # Static files: every path under the prefix names a file.
        return info["prefix"], info["prefix"] + "/{**}"
    raw, pattern = info["formatter"], info["pattern"]
    names = PARAM.findall(raw)

    def takes_slash(name: str) -> bool:
        return pattern.fullmatch(raw.format_map({n: "a/b" if n == name else "a" for n in names})) is not None

    return raw, PARAM.sub(lambda m: "{**}" if takes_slash(m.group(1)) else "{}", raw).rstrip("/") or "/"


def methods(route) -> list[str]:
    if route.method == hdrs.METH_ANY and inspect.isclass(route.handler) and issubclass(route.handler, web.View):
        return sorted(m for m in hdrs.METH_ALL if hasattr(route.handler, m.lower()))
    return [route.method]


async def main() -> list[dict]:
    out = []
    for route in app.router.routes():
        raw, path = canonical(route.resource)
        paths = [path]
        if path.endswith("/{**}"):
            parent = path[: -len("/{**}")] or "/"
            if await resolves_to(parent.rstrip("/") + "/", route.resource):
                paths.insert(0, parent)
        for method in methods(route):
            out.extend({"method": method, "path": p, "raw": raw} for p in paths)
    return out


print(json.dumps({"framework": "aiohttp", "version": aiohttp.__version__, "routes": asyncio.run(main())}))
