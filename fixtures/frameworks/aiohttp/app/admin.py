# A nested application (docs.aiohttp.org/en/stable/web_advanced.html#nested-applications): `add_subapp` serves its
# routes under the prefix.
from aiohttp import web


async def dashboard(request: web.Request) -> web.Response:
    return web.Response(text="dashboard")


async def audit(request: web.Request) -> web.Response:
    return web.Response(text="audit")


async def purge(request: web.Request) -> web.Response:
    return web.Response(status=204)


def create_admin() -> web.Application:
    admin = web.Application()
    admin.add_routes(
        [
            web.get("/", dashboard),
            web.get("/audit", audit),
            web.delete("/audit", purge),
        ]
    )
    return admin
