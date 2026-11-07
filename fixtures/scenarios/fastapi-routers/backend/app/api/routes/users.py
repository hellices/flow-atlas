import uuid

from fastapi import APIRouter

router = APIRouter(prefix="/users", tags=["users"])


@router.get("/")
def read_users():
    ...


@router.post("/")
def create_user():
    ...


@router.get("/me")
def read_user_me():
    ...


@router.patch("/me")
def update_user_me():
    ...


@router.delete("/me")
def delete_user_me():
    ...


@router.post("/signup")
def register_user():
    ...


@router.get("/{user_id}")
def read_user_by_id(user_id: uuid.UUID):
    ...
