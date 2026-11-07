# Nested routers (django-ninja.dev/guide/routers/#nested-routers): each serves under the prefixes of the routers it is
# mounted in.
from ninja import Router

router = Router()
second_router = Router()
third_router = Router()


@router.get("/add")
def add_l1(request, a: int, b: int):
    return {"result": a + b}


@second_router.get("/add")
def add_l2(request, a: int, b: int):
    return {"result": a + b}


@third_router.get("/add")
def add_l3(request, a: int, b: int):
    return {"result": a + b}


second_router.add_router("l3", third_router)
router.add_router("l2", second_router)
