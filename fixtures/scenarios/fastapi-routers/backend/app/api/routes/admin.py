from fastapi import APIRouter

# Shared with other projects, so it carries no prefix of its own; api/main.py includes it under /admin.
router = APIRouter()


@router.post("/")
def update_admin():
    return {"ok": True}
