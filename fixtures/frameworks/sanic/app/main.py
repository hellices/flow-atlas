# The routes of Sanic's routing guide (sanic.dev/en/guide/basics/routing.html): `add_route` and the method decorators,
# several methods on one route, typed path parameters, `path` and `ext` parameters, a versioned route, static files,
# blueprints, nested in a group, and a class-based view (app/blueprints.py), and a WebSocket route, which serves no HTTP
# request.
from pathlib import Path

from sanic import Sanic, json, text

from .blueprints import admin, store

app = Sanic("Fixture")


async def index(request):
    return text("index")


app.add_route(index, "/")


@app.route("/test", methods=["POST", "PUT"])
async def test(request):
    return text("OK")


@app.get("/tag/<tag>")
async def tag(request, tag: str):
    return text(tag)


@app.get("/numbers/<number:float>")
async def number(request, number: float):
    return json({"number": number})


@app.get("/letters/<letters:alpha>")
async def letters(request, letters: str):
    return text(letters)


@app.get("/files/<file_path:path>")
async def file(request, file_path: str):
    return text(file_path)


@app.get("/images/<name:ext=png>")
async def image(request, name: str, ext: str):
    return text(f"{name}.{ext}")


@app.get("/stats", version=3)
async def stats(request):
    return json({})


@app.route("/any", methods=["GET", "POST", "PUT", "PATCH", "DELETE"])
async def anything(request):
    return text(request.method)


@app.websocket("/feed")
async def feed(request, ws):
    await ws.send("hello")


app.static("/static", Path(__file__).parent / "static", name="static")
app.blueprint(store)
app.blueprint(admin)
