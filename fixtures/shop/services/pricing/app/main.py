from fastapi import APIRouter, FastAPI

router = APIRouter()


@router.get("/quotes")
def quotes():
    return []


@router.post("/discounts")
def discounts():
    return {}


app = FastAPI()
app.include_router(router)
