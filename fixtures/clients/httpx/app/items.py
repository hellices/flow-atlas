"""Requests made on an `httpx.Client` configured with the API's base URL, in the shapes the HTTPX guide shows: paths
relative to `base_url` (sent under its path), each method, `client.request` with the method as a string, a query in
`params`, a JSON body in `json`, form data in `data`, headers set on the client and per request, a request built with
`build_request` and sent, and the top-level API with a full URL."""

import httpx

from app.settings import API_URL

client = httpx.Client(base_url=f"{API_URL}/api/v1", headers={"Accept": "application/json"}, timeout=10)


def health():
    return httpx.get(f"{API_URL}/health", timeout=10).json()


def list_items(term: str, page: int):
    response = client.get("/items", params={"q": term, "page": page})
    response.raise_for_status()
    return response.json()


def get_item(item_id: str):
    response = client.get(f"/items/{item_id}")
    response.raise_for_status()
    return response.json()


def create_item(name: str):
    return client.post("/items", json={"name": name}).json()


def replace_item(item_id: str, name: str):
    return client.put(f"/items/{item_id}", json={"name": name})


def update_item(item_id: str, name: str):
    return client.patch(f"/items/{item_id}", json={"name": name})


def delete_item(item_id: str):
    return client.delete(f"/items/{item_id}")


def item_exists(item_id: str) -> bool:
    return client.head(f"/items/{item_id}").is_success


def item_options():
    return client.options("/items").headers.get("allow")


def move_item(item_id: str, shelf: str):
    return client.request("POST", f"/items/{item_id}/move", data={"shelf": shelf})


def tag_item(item_id: str, tag: str):
    request = client.build_request("PUT", f"/items/{item_id}/tags/{tag}", headers={"X-Request-Source": "tags"})
    return client.send(request)
