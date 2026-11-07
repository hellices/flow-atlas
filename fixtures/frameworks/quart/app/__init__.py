# The routes of Quart's guides (quart.palletsprojects.com/en/latest/how_to_guides/routing/, /blueprints/,
# /websockets/): static and dynamic rules, the converters and a custom one, default values, a catch-all, several methods
# on one rule, `add_url_rule`, class-based views, blueprints with url prefixes, registered twice and nested, websocket
# routes beside HTTP ones, and the static files Quart serves.
from quart import Quart, request, websocket

from .api import api
from .converters import ListConverter
from .spa import spa
from .store import store
from .views import Counter, ItemAPI, ItemsAPI


async def health():
    return "ok"


def create_app():
    app = Quart(__name__)  # serves app/static at /static/<path:filename>
    app.url_map.converters["list"] = ListConverter

    @app.route("/")
    async def index():
        return "index"

    @app.route("/about")
    async def about():
        return "about"

    @app.route("/page", defaults={"page_no": 1})
    @app.route("/page/<int:page_no>")
    async def page(page_no):
        return f"page {page_no}"

    @app.route("/login", methods=["GET", "POST"])
    async def login():
        return "logged in" if request.method == "POST" else "the login form"

    @app.get("/user/<username>")
    async def show_user(username):
        return f"User {username}"

    @app.put("/user/<username>")
    async def update_user(username):
        return f"updated {username}"

    @app.delete("/user/<username>")
    async def delete_user(username):
        return f"deleted {username}"

    @app.route("/price/<float:amount>")
    async def show_price(amount):
        return f"Price {amount}"

    @app.route("/token/<uuid:token>")
    async def show_token(token):
        return f"Token {token}"

    @app.route("/files/<path:subpath>")
    async def show_file(subpath):
        return f"File {subpath}"

    @app.route("/tags/<list:names>")
    async def show_tags(names):
        return ", ".join(names)

    @app.websocket("/ws")
    async def ws():
        while True:
            data = await websocket.receive()
            await websocket.send(data)

    @app.route("/chat")
    async def chat_page():
        return "A HTTP request"

    @app.websocket("/chat")
    async def chat():
        await websocket.accept()

    @app.route("/<path:path>")
    async def catch_all(path):
        return f"nothing else at /{path}"

    app.add_url_rule("/health", view_func=health)
    app.add_url_rule("/items/", view_func=ItemsAPI.as_view("items"))
    app.add_url_rule("/items/<int:id>", view_func=ItemAPI.as_view("item"))
    app.add_url_rule("/counter", view_func=Counter.as_view("counter"))

    app.register_blueprint(store, url_prefix="/store")
    app.register_blueprint(store, url_prefix="/shop", name="shop")
    app.register_blueprint(api)
    app.register_blueprint(spa, url_prefix="/app")
    return app
