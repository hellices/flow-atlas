# The routes of FastAPI's tutorial (fastapi.tiangolo.com/tutorial/): path parameters and converters, APIRouters with
# prefixes, included and nested, a route for several methods, a sub-application and static files mounted.
from fastapi import FastAPI
from fastapi.staticfiles import StaticFiles

from .routers import items, users
from .internal import admin

app = FastAPI()


@app.get("/")
async def root():
    return {"message": "Hello Bigger Applications!"}


@app.get("/files/{file_path:path}")
async def read_file(file_path: str):
    return {"file_path": file_path}


@app.get("/models/{model_id:int}")
async def read_model(model_id: int):
    return {"model_id": model_id}


@app.api_route("/ping", methods=["GET", "POST"])
async def ping():
    return "pong"


@app.get("/hidden", include_in_schema=False)
async def hidden():
    return "not in the document, still served"


def health():
    return "ok"


app.add_api_route("/health", health, methods=["GET"])

app.include_router(users.router)
app.include_router(items.router, prefix="/v1")
app.include_router(admin.router, prefix="/admin", tags=["admin"])

subapi = FastAPI()


@subapi.get("/sub")
def read_sub():
    return {"message": "Hello World from sub API"}


app.mount("/subapi", subapi)
app.mount("/static", StaticFiles(directory="app/static"), name="static")
