# A catch-all for a single-page application: the root through a default, the rest of the path through `path`.
from flask import Blueprint

spa = Blueprint("spa", __name__)


@spa.route("/", defaults={"path": ""})
@spa.route("/<path:path>")
def catch_all(path):
    return f"app at /{path}"
