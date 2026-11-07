# The blueprint of Quart's guide, with its own static folder served under its url prefix.
from quart import Blueprint

store = Blueprint("store", __name__, static_folder="static")


@store.route("/")
async def index():
    return "store"


@store.route("/products/<int:product_id>", methods=["GET", "PUT", "DELETE"])
async def product(product_id):
    return {"id": product_id}
