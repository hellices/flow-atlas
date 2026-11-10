# The routes of Litestar's routing guide (docs.litestar.dev/latest/usage/routing/): handlers registered on the
# application, with path parameters of each type and one handler on several paths, `@route` with several methods,
# routers and controllers (app/api.py, app/orders.py), a route registered later with `app.register`, a mounted ASGI
# application, static files, and a WebSocket handler, which serves no HTTP request. Litestar serves its OpenAPI
# document and pages under /schema by itself.
from decimal import Decimal
from pathlib import Path

from litestar import HttpMethod, Litestar, MediaType, WebSocket, asgi, get, post, route, websocket
from litestar.static_files import create_static_files_router
from litestar.types import Receive, Scope, Send

from .api import api


@get("/")
async def index() -> str:
    return "index"


@get(["/books", "/books/{book_id:int}"])
async def books(book_id: int | None = None) -> dict:
    return {"book": book_id}


@post("/books")
async def create_book(data: dict) -> dict:
    return data


@get("/users/{username:str}")
async def user(username: str) -> dict:
    return {"username": username}


@get("/prices/{amount:decimal}")
async def price(amount: Decimal) -> dict:
    return {"amount": str(amount)}


@get("/ratios/{ratio:float}")
async def ratio(ratio: float) -> dict:
    return {"ratio": ratio}


@get("/files/{file_path:path}")
async def file(file_path: Path) -> dict:
    return {"path": str(file_path)}


@route("/ping", http_method=[HttpMethod.GET, HttpMethod.POST])
async def ping() -> str:
    return "pong"


@get("/health", media_type=MediaType.TEXT)
async def health() -> str:
    return "ok"


@asgi("/legacy", is_mount=True)
async def legacy(scope: Scope, receive: Receive, send: Send) -> None:
    await send({"type": "http.response.start", "status": 200, "headers": [(b"content-type", b"text/plain")]})
    await send({"type": "http.response.body", "body": scope["path"].encode()})


@websocket("/ws")
async def socket(socket: WebSocket) -> None:
    await socket.accept()
    await socket.close()


app = Litestar(
    route_handlers=[
        index,
        books,
        create_book,
        user,
        price,
        ratio,
        file,
        ping,
        legacy,
        socket,
        api,
        create_static_files_router(path="/static", directories=[Path(__file__).parent / "static"]),
    ]
)
app.register(health)
