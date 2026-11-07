# HTTPEndpoint classes (starlette.dev/endpoints/): a route to a class answers the methods the class defines.
from starlette.endpoints import HTTPEndpoint
from starlette.responses import PlainTextResponse


class ItemList(HTTPEndpoint):
    async def get(self, request):
        return PlainTextResponse("items")

    async def post(self, request):
        return PlainTextResponse("created", status_code=201)


class Item(HTTPEndpoint):
    async def get(self, request):
        return PlainTextResponse(f"item {request.path_params['item_id']}")

    async def put(self, request):
        return PlainTextResponse("replaced")

    async def delete(self, request):
        return PlainTextResponse("deleted")
