# The routes of Django Ninja's guides (django-ninja.dev/guide/operations/, /path-params/, /routers/, /versioning/):
# operations on the API for each method and for several at once, path parameters typed and with Django's converters,
# routers mounted by object and by import path, nested routers, a router prefix with its own parameters, the same
# router mounted twice, and one API per version sharing a router.
import uuid

from ninja import NinjaAPI, Path, Router

from blogs.api import router as blogs_router
from events.api import router as events_router

api = NinjaAPI()


@api.get("/hello")
def get_hello(request):
    return {"message": "hello"}


@api.post("/hello")
def post_hello(request):
    return {"message": "hello"}


@api.put("/hello/{id}")
def put_hello(request, id: int):
    return {"message": "hello"}


@api.patch("/hello/{id}")
def patch_hello(request, id: int):
    return {"message": "hello"}


@api.delete("/hello/{id}")
def delete_hello(request, id: int):
    return {"message": "hello"}


@api.get("/tasks")
def list_tasks(request):
    return []


@api.api_operation(["HEAD", "OPTIONS"], "/tasks")
def tasks_meta(request):
    return {}


@api.api_operation(["POST", "PATCH"], "/tasks/{task_id}")
def upsert_task(request, task_id: int):
    return {"task_id": task_id}


@api.get("/items/{int:item_id}")
def read_item(request, item_id: int):
    return {"item_id": item_id}


@api.get("/dir/{path:value}")
def read_path(request, value: str):
    return value


@api.get("/tokens/{uuid:token}")
def read_token(request, token: uuid.UUID):
    return {"token": str(token)}


@api.get("/slugs/{slug:slug}")
def read_slug(request, slug: str):
    return {"slug": slug}


@api.get("/events/{year}/{month}/{day}")
def events_on(request, year: int, month: int, day: int):
    return {"date": [year, month, day]}


api.add_router("/events/", events_router)
api.add_router("/news/", "news.api.router")
api.add_router("l1", blogs_router)

calc = Router()


@api.get("/add/{a}/{b}")
def add(request, a: int, b: int):
    return {"result": a + b}


@calc.get("/multiply/{c}")
def multiply(request, c: int, a: int = Path(...), b: int = Path(...)):
    return {"result": (a + b) * c}


api.add_router("add/{a}/{b}", calc)

things = Router()


@things.get("/")
def list_things(request):
    return []


@things.delete("/{int:thing_id}", response={204: None})
def delete_thing(request, thing_id: int):
    return 204, None


api.add_router("/v1/things/", things)
api.add_router("/v2/things/", things, url_name_prefix="things_v2")

shared = Router()


@shared.get("/items")
def list_items(request):
    return [{"id": 1, "name": "Widget"}]


api_v1 = NinjaAPI(version="1.0.0", urls_namespace="api-v1")
api_v2 = NinjaAPI(version="2.0.0", urls_namespace="api-v2", docs_url=None)

api_v1.add_router("/", shared)
api_v2.add_router("/", shared)


@api_v2.get("/hello")
def hello_v2(request):
    return {"message": "Hello from V2"}
