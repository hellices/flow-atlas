# The routes of Flask's guide (flask.palletsprojects.com/en/stable/quickstart/#routing, /blueprints/, /views/):
# variable rules and converters, a custom converter, several methods on one rule, trailing slashes, `add_url_rule`,
# class-based views, blueprints with url prefixes, registered twice and nested, and the static files Flask serves.
from flask import Flask, request

from .admin import admin
from .api import api
from .converters import ListConverter
from .pages import pages
from .spa import spa
from .views import Counter, ItemAPI, ItemsAPI


def health():
    return "ok"


def create_app():
    app = Flask(__name__)  # serves app/static at /static/<path:filename>
    app.url_map.converters["list"] = ListConverter

    @app.route("/")
    def index():
        return "Index Page"

    @app.route("/projects/")
    def projects():
        return "The project page"

    @app.route("/about")
    def about():
        return "The about page"

    @app.route("/login", methods=["GET", "POST"])
    def login():
        return "logged in" if request.method == "POST" else "the login form"

    @app.get("/user/<username>")
    def show_user(username):
        return f"User {username}"

    @app.put("/user/<username>")
    def update_user(username):
        return f"updated {username}"

    @app.delete("/user/<username>")
    def delete_user(username):
        return f"deleted {username}"

    # Added after `/user/<username>`, and still matched first: Werkzeug tries a static part before a variable in the
    # same position, whatever order the rules were added in.
    @app.get("/user/me")
    def show_current_user():
        return "the signed-in user"

    @app.route("/post/<int:post_id>")
    def show_post(post_id):
        return f"Post {post_id}"

    @app.route("/path/<path:subpath>")
    def show_subpath(subpath):
        return f"Subpath {subpath}"

    @app.route("/price/<float:amount>")
    def show_price(amount):
        return f"Price {amount}"

    @app.route("/token/<uuid:token>")
    def show_token(token):
        return f"Token {token}"

    @app.route("/topics/<any(news, sport, weather):topic>")
    def show_topic(topic):
        return f"Topic {topic}"

    @app.route("/tags/<list:names>")
    def show_tags(names):
        return ", ".join(names)

    app.add_url_rule("/health", view_func=health)
    app.add_url_rule("/items/", view_func=ItemsAPI.as_view("items"))
    app.add_url_rule("/items/<int:id>", view_func=ItemAPI.as_view("item"))
    app.add_url_rule("/counter", view_func=Counter.as_view("counter"))

    app.register_blueprint(pages, url_prefix="/docs")
    app.register_blueprint(pages, url_prefix="/guide", name="guide")
    app.register_blueprint(api)
    app.register_blueprint(admin)
    app.register_blueprint(spa, url_prefix="/app")
    return app
