# Mounted by its import path: `api.add_router("/news/", "news.api.router")`.
from ninja import Router

router = Router()


@router.get("/")
def list_news(request):
    return []


@router.post("/", response={201: dict})
def create_news(request):
    return 201, {}
