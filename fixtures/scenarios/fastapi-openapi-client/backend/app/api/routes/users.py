import uuid

from fastapi import APIRouter

from app.api.deps import CurrentUser, SessionDep
from app.models import Message, UserCreate, UserPublic, UsersPublic, UserUpdateMe

router = APIRouter(prefix="/users", tags=["users"])


@router.get("/")
def read_users(session: SessionDep, skip: int = 0, limit: int = 100) -> UsersPublic:
    return UsersPublic.page(session, skip, limit)


@router.post("/")
def create_user(session: SessionDep, user_in: UserCreate) -> UserPublic:
    return UserPublic.create(session, user_in)


@router.get("/me")
def read_user_me(current_user: CurrentUser) -> UserPublic:
    return current_user


@router.patch("/me")
def update_user_me(session: SessionDep, user_in: UserUpdateMe, current_user: CurrentUser) -> UserPublic:
    return current_user.update(session, user_in)


@router.delete("/me")
def delete_user_me(session: SessionDep, current_user: CurrentUser) -> Message:
    return current_user.delete(session)


@router.get("/{user_id}")
def read_user_by_id(user_id: uuid.UUID, session: SessionDep) -> UserPublic:
    return UserPublic.get(session, user_id)


@router.delete("/{user_id}")
def delete_user(session: SessionDep, user_id: uuid.UUID) -> Message:
    return UserPublic.remove(session, user_id)
