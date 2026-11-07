from fastapi import APIRouter

router = APIRouter(prefix="/{item_id}/reviews")


@router.get("")
async def list_reviews(item_id: str):
    return []


@router.post("")
async def add_review(item_id: str):
    return {}
