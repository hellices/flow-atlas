import uuid

from fastapi import APIRouter

router = APIRouter(prefix="/items", tags=["items"])


@router.get("/")
def read_items(skip: int = 0, limit: int = 100):
    ...


@router.get("/{id}")
def read_item(id: uuid.UUID):
    ...


@router.post("/")
def create_item():
    ...


@router.put("/{id}")
def update_item(id: uuid.UUID):
    ...


@router.delete("/{id}")
def delete_item(id: uuid.UUID):
    ...
