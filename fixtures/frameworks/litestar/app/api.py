# Routers (docs.litestar.dev/latest/usage/routing/overview.html#routers): a router's path comes before the paths of what
# it registers, routers nest, and one controller registered on two routers serves under each.
from datetime import date

from litestar import Router, get, post

from .orders import OrderController


@get("/status")
async def status() -> dict:
    return {"status": "ok"}


@get("/reports/{day:date}")
async def report(day: date) -> dict:
    return {"day": day.isoformat()}


@post("/reports")
async def create_report(data: dict) -> dict:
    return data


v1 = Router(path="/v1", route_handlers=[OrderController, report, create_report])
v2 = Router(path="/v2", route_handlers=[OrderController])

api = Router(path="/api", route_handlers=[status, v1, v2])
