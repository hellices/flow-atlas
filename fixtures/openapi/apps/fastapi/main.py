from fastapi import APIRouter, FastAPI

router = APIRouter(prefix="/orders", tags=["orders"])


@router.get("/{order_id}")
def read_order(order_id: str) -> dict:
    return {"id": order_id}


@router.post("")
def create_order(body: dict) -> dict:
    return body


@router.get("/{order_id}/history", operation_id="orderHistory")
def history(order_id: str) -> list:
    return []


@router.get("/internal/health", include_in_schema=False)
def hidden() -> dict:
    return {}


app = FastAPI(title="Orders", version="1")
app.include_router(router, prefix="/api/v1")

if __name__ == "__main__":
    import json

    print(json.dumps(app.openapi(), indent=2))
