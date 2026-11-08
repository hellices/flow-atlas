"""Requests made with the module-level functions, in the shapes the Requests quickstart shows: the URL built from the
configured base URL (an f-string, a concatenation, `str.format`), each method's function, `requests.request` with the
method as a string, a query in `params`, a JSON body in `json`, form data in `data`, headers."""

import requests

from app.settings import API_URL


def list_users(term: str):
    response = requests.get(f"{API_URL}/users", params={"q": term, "page": 1}, timeout=10)
    response.raise_for_status()
    return response.json()


def get_user(user_id: str):
    response = requests.get(f"{API_URL}/users/{user_id}", timeout=10)
    response.raise_for_status()
    return response.json()


def create_user(name: str):
    response = requests.post(f"{API_URL}/users", json={"name": name}, timeout=10)
    response.raise_for_status()
    return response.json()


def replace_user(user_id: str, name: str):
    return requests.put(f"{API_URL}/users/{user_id}", json={"name": name}, timeout=10)


def set_status(user_id: str, status: str):
    return requests.patch(f"{API_URL}/users/{user_id}/status", data={"status": status}, timeout=10)


def rename_user(user_id: str, name: str):
    return requests.request("PATCH", f"{API_URL}/users/{user_id}", json={"name": name}, timeout=10)


def delete_user(user_id: str):
    return requests.delete(f"{API_URL}/users/{user_id}", timeout=10)


def user_exists(user_id: str) -> bool:
    return requests.head(f"{API_URL}/users/{user_id}", timeout=10).ok


def user_options():
    return requests.options(f"{API_URL}/users", timeout=10).headers.get("Allow")


def avatar(user_id: str) -> bytes:
    response = requests.get(API_URL + "/users/" + user_id + "/avatar", headers={"Accept": "image/png"}, timeout=10)
    return response.content


def yearly_report(year: int):
    response = requests.get("{}/reports/{}".format(API_URL, year), timeout=10)
    return response.json()
