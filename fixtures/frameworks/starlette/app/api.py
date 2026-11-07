# A routing table in its own module, mounted by the application, with a version mounted in it.
from starlette.responses import JSONResponse
from starlette.routing import Mount, Route


async def list_products(request):
    return JSONResponse([])


async def create_product(request):
    return JSONResponse({}, status_code=201)


async def product(request):
    return JSONResponse({"id": request.path_params["product_id"]})


async def status(request):
    return JSONResponse({"status": "ok"})


routes = [
    Route("/status", status),
    Mount(
        "/v1",
        routes=[
            Route("/products", list_products),
            Route("/products", create_product, methods=["POST"]),
            Route("/products/{product_id}", product, methods=["GET", "PATCH"]),
        ],
    ),
]
