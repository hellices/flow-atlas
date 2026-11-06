from dataclasses import dataclass

import httpx


@dataclass
class Images:
    base_url: str

    async def read(self, storage_reference: str, customer_ref: str):
        async with httpx.AsyncClient() as client:
            response = await client.post(
                f"{self.base_url.rstrip('/')}/store/internal/v2/agent/images",
                json={"storageReference": storage_reference, "customerRef": customer_ref},
            )
            return response.json()
