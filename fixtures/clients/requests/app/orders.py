"""Requests made on a `Session`, as the Requests advanced guide shows: headers and auth set once on the session, each
URL joined to the configured base URL with `urljoin` (Requests has no base URL of its own), and a prepared request
the session sends."""

from urllib.parse import urljoin

import requests

from app.settings import API_URL

session = requests.Session()
session.headers.update({"Accept": "application/json", "User-Agent": "orders-client/1.0"})
session.auth = ("orders", "secret")


def url(path: str) -> str:
    return urljoin(API_URL, path)


def list_orders(status: str):
    response = session.get(url("/orders"), params={"status": status})
    response.raise_for_status()
    return response.json()


def get_order(order_id: str):
    return session.get(url(f"/orders/{order_id}")).json()


def cancel_order(order_id: str):
    return session.post(url(f"/orders/{order_id}/cancel"), json={"reason": "customer"})


def delete_order(order_id: str):
    return session.delete(url(f"/orders/{order_id}"))


def import_orders(rows: str):
    request = requests.Request("POST", url("/orders/import"), json={"rows": rows})
    prepared = session.prepare_request(request)
    return session.send(prepared)
