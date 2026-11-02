from fastapi import APIRouter

router = APIRouter()


@router.get("/quotes")
def quotes():
    return []


@router.post("/discounts")
def discounts():
    return {}
