from fastapi import APIRouter

from app.api.routes import admin, items, login, private, users
from app.core.config import settings

from .routes.utils import router as utils_router

api_router = APIRouter()
api_router.include_router(login.router)
api_router.include_router(users.router)
api_router.include_router(utils_router)
api_router.include_router(items.router)
api_router.include_router(admin.router, prefix="/admin")


if settings.ENVIRONMENT == "local":
    api_router.include_router(private.router)
