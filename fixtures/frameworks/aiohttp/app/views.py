# Route decorators on a route table (docs.aiohttp.org/en/stable/web_quickstart.html#resources-and-routes), and a
# class-based view: a route to a `web.View` takes any method, which the view answers where it defines it.
from aiohttp import web

routes = web.RouteTableDef()


@routes.get("/users")
async def list_users(request: web.Request) -> web.Response:
    return web.json_response([])


@routes.post("/users")
async def create_user(request: web.Request) -> web.Response:
    return web.json_response({}, status=201)


@routes.get("/users/{name}")
async def user(request: web.Request) -> web.Response:
    return web.json_response({"name": request.match_info["name"]})


@routes.view("/items/{item_id:\\d+}")
class ItemView(web.View):
    async def get(self) -> web.Response:
        return web.json_response({"id": self.request.match_info["item_id"]})

    async def put(self) -> web.Response:
        return web.json_response({})

    async def delete(self) -> web.Response:
        return web.Response(status=204)
