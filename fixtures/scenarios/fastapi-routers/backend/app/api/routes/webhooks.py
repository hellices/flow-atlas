from fastapi import APIRouter

router = APIRouter(tags=["webhooks"])


@router.post("/payment")
def payment_event():
    ...
