from fastapi import APIRouter

from . import reviews

router = APIRouter(prefix="/items", tags=["items"])


@router.get("/")
async def read_items():
    return {}


@router.get("/{item_id}")
async def read_item(item_id: str):
    return {"item_id": item_id}


@router.put("/{item_id}")
async def update_item(item_id: str):
    return {"item_id": item_id}


@router.delete("/{item_id}", status_code=204)
async def delete_item(item_id: str):
    return None


router.include_router(reviews.router)
