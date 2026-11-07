from fastapi import FastAPI

from app.api.main import api_router
from app.api.routes import webhooks
from app.core.config import settings

app = FastAPI(title=settings.PROJECT_NAME)

app.include_router(api_router, prefix=settings.API_V1_STR)
app.include_router(webhooks.router, prefix=f"{settings.API_V1_STR}/hooks")


@app.get("/healthz")
def healthz():
    return {"ok": True}
