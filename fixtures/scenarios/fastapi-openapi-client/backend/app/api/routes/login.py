from fastapi import APIRouter

from app.api.deps import CurrentUser, PasswordForm
from app.models import Token, UserPublic

router = APIRouter(tags=["login"])


@router.post("/login/access-token")
def login_access_token(form_data: PasswordForm) -> Token:
    return Token.issue(form_data.username, form_data.password)


@router.post("/login/test-token")
def test_token(current_user: CurrentUser) -> UserPublic:
    return current_user
