# The routes of aiohttp's server guides (docs.aiohttp.org/en/stable/web_quickstart.html, web_advanced.html): routes
# added with `add_routes` and with the router's `add_get`/`add_post`, a route table of decorators (app/views.py), variable
# resources with a regex (`{id:\d+}`, `{tail:.*}`), parameters within a segment, a route for any method, a
# class-based view, a resource with several methods, a nested application (app/admin.py), and static files.
from pathlib import Path

from aiohttp import web

from .admin import create_admin
from .views import routes


async def index(request: web.Request) -> web.Response:
    return web.Response(text="index")


async def health(request: web.Request) -> web.Response:
    return web.Response(text="ok")


async def ping(request: web.Request) -> web.Response:
    return web.Response(text=request.method)


async def report(request: web.Request) -> web.Response:
    return web.json_response(dict(request.match_info))


async def download(request: web.Request) -> web.Response:
    return web.Response(text=request.match_info["tail"])


async def flight(request: web.Request) -> web.Response:
    return web.json_response(dict(request.match_info))


async def create_order(request: web.Request) -> web.Response:
    return web.json_response({}, status=201)


async def order(request: web.Request) -> web.Response:
    return web.json_response({"id": request.match_info["order_id"]})


async def update_order(request: web.Request) -> web.Response:
    return web.json_response({})


def create_app() -> web.Application:
    app = web.Application()
    app.add_routes(
        [
            web.get("/", index),
            web.route("*", "/ping", ping),
            web.get("/reports/{year:\\d{4}}/{name}", report),
            web.get("/downloads/{tail:.*}", download),
            web.get("/flights/{origin}-{destination}", flight),
            web.post("/orders", create_order),
        ]
    )
    app.add_routes(routes)
    app.router.add_get("/health", health, allow_head=False)
    resource = app.router.add_resource("/orders/{order_id}", name="order")
    resource.add_route("GET", order)
    resource.add_route("PATCH", update_order)
    app.router.add_static("/static", Path(__file__).parent / "static", name="static")
    app.add_subapp("/admin/", create_admin())
    return app


app = create_app()
