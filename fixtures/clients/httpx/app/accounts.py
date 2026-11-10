"""Requests made on an `httpx.AsyncClient`, as the HTTPX async guide shows: a client opened per call with `async with`
and the API's base URL, each request awaited."""

import httpx

from app.settings import API_URL


def accounts() -> httpx.AsyncClient:
    return httpx.AsyncClient(base_url=f"{API_URL}/api/v2", headers={"Accept": "application/json"}, timeout=10)


async def list_accounts(owner: str):
    async with accounts() as client:
        response = await client.get("/accounts", params={"owner": owner})
        return response.json()


async def get_account(account_id: str):
    async with accounts() as client:
        response = await client.get(f"/accounts/{account_id}")
        response.raise_for_status()
        return response.json()


async def open_account(owner: str):
    async with accounts() as client:
        response = await client.post("/accounts", json={"owner": owner})
        return response.json()


async def close_account(account_id: str):
    async with accounts() as client:
        return await client.delete(f"/accounts/{account_id}")


async def statement(account_id: str, year: int):
    async with accounts() as client:
        return await client.request("GET", f"/accounts/{account_id}/statements/{year}")
