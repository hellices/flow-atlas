# A controller (docs.litestar.dev/latest/usage/routing/overview.html#controllers): its path comes before the paths of the
# handlers declared on it, several methods on one path among them.
from uuid import UUID

from litestar import Controller, delete, get, patch, post, put


class OrderController(Controller):
    path = "/orders"

    @post()
    async def create_order(self, data: dict) -> dict:
        return data

    @get()
    async def list_orders(self) -> list[dict]:
        return []

    @get("/{order_id:uuid}")
    async def retrieve_order(self, order_id: UUID) -> dict:
        return {"id": str(order_id)}

    @patch("/{order_id:uuid}")
    async def update_order(self, order_id: UUID, data: dict) -> dict:
        return data

    @put("/{order_id:uuid}")
    async def replace_order(self, order_id: UUID, data: dict) -> dict:
        return data

    @delete("/{order_id:uuid}")
    async def delete_order(self, order_id: UUID) -> None:
        return None
