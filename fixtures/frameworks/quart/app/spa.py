# A catch-all for a single-page application: the root through a default, the rest of the path through `path`.
from quart import Blueprint

spa = Blueprint("spa", __name__)


@spa.route("/", defaults={"path": ""})
@spa.route("/<path:path>")
async def catch_all(path):
    return f"app at /{path}"
