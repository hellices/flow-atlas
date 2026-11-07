# The routes of Starlette's routing guide (starlette.dev/routing/): routes with path parameters and convertors, a custom
# convertor, several methods on one route, HTTPEndpoint classes, Mounts of route lists, nested, a Router and a
# Starlette application mounted, static files, and a WebSocket route, which serves no HTTP request.
from starlette.applications import Starlette
from starlette.convertors import register_url_convertor
from starlette.responses import PlainTextResponse
from starlette.routing import Mount, Route, Router, WebSocketRoute
from starlette.staticfiles import StaticFiles

from . import api
from .convertors import DateTimeConvertor
from .endpoints import Item, ItemList

register_url_convertor("datetime", DateTimeConvertor())


async def homepage(request):
    return PlainTextResponse("Homepage")


async def about(request):
    return PlainTextResponse("About")


async def current_user(request):
    return PlainTextResponse("me")


async def user(request):
    return PlainTextResponse(f"user {request.path_params['username']}")


async def users(request):
    return PlainTextResponse("users")


async def account(request):
    return PlainTextResponse(f"account {request.path_params['account_id']}")


async def floating_point(request):
    return PlainTextResponse(str(request.path_params["number"]))


async def uploaded(request):
    return PlainTextResponse(request.path_params["rest_of_path"])


async def order(request):
    return PlainTextResponse(str(request.path_params["order_id"]))


async def history(request):
    return PlainTextResponse(str(request.path_params["date"]))


async def dashboard(request):
    return PlainTextResponse("dashboard")


async def audit(request):
    return PlainTextResponse("audit")


async def health(request):
    return PlainTextResponse("ok")


async def websocket_index(websocket):
    await websocket.accept()
    await websocket.send_text("Hello, websocket!")
    await websocket.close()


admin = Router(
    routes=[
        Route("/", dashboard),
        Route("/audit", audit, methods=["GET", "DELETE"]),
    ]
)

reports = Starlette(routes=[Route("/summary", lambda request: PlainTextResponse("summary"))])

routes = [
    Route("/", endpoint=homepage),
    Route("/about", endpoint=about),
    Route("/users/me", current_user),
    Route("/users/{username}", user),
    Route("/accounts/{account_id:int}", account, methods=["GET", "POST"]),
    Route("/floating-point/{number:float}", floating_point),
    Route("/uploaded/{rest_of_path:path}", uploaded),
    Route("/orders/{order_id:uuid}", order),
    Route("/history/{date:datetime}", history),
    Route("/items", ItemList),
    Route("/items/{item_id:int}", Item),
    Mount(
        "/teams",
        name="teams",
        routes=[
            Route("/", users, methods=["GET", "POST"], name="team_list"),
            Route("/{username}", user, name="team_detail"),
        ],
    ),
    Mount("/api", routes=api.routes),
    Mount("/admin", app=admin),
    Mount("/reports", app=reports),
    Mount("/static", app=StaticFiles(directory="app/static"), name="static"),
    WebSocketRoute("/ws", endpoint=websocket_index),
]

app = Starlette(routes=routes)
app.add_route("/health", health, methods=["GET"])
