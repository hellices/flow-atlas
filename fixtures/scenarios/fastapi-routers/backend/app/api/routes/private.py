from fastapi import APIRouter

router = APIRouter(tags=["private"], prefix="/private")


@router.post("/users/")
def create_private_user():
    ...
