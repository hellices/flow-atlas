# Blueprints (sanic.dev/en/guide/best-practices/blueprints.html): a blueprint's url_prefix and version come before the
# paths of its routes, and a group's url_prefix and version before those of the blueprints in it; a class-based view
# (sanic.dev/en/guide/advanced/class-based-views.html) answers the methods it defines.
from sanic import Blueprint, json
from sanic.views import HTTPMethodView

products = Blueprint("products", url_prefix="/products")


@products.get("/")
async def list_products(request):
    return json([])


@products.post("/")
async def create_product(request):
    return json({}, status=201)


@products.route("/<product_id:int>", methods=["GET", "PATCH"])
async def product(request, product_id: int):
    return json({"id": product_id})


reviews = Blueprint("reviews", url_prefix="/reviews", version=2)


@reviews.get("/<review_id:uuid>")
async def review(request, review_id):
    return json({"id": str(review_id)})


class CartView(HTTPMethodView):
    async def get(self, request):
        return json({})

    async def put(self, request):
        return json({})

    async def delete(self, request):
        return json({}, status=204)


carts = Blueprint("carts", url_prefix="/carts")
carts.add_route(CartView.as_view(), "/<cart_id:slug>")

store = Blueprint.group(products, reviews, carts, url_prefix="/store", version=1)

admin = Blueprint("admin", url_prefix="/admin")


@admin.get("/")
async def dashboard(request):
    return json({})


@admin.route("/audit", methods=["GET", "DELETE"])
async def audit(request):
    return json({})
