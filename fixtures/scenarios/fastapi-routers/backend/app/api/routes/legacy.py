from fastapi import APIRouter

# No longer included anywhere: FastAPI serves none of these.
router = APIRouter(prefix="/legacy")


@router.get("/items")
def legacy_items():
    ...
