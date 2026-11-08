"""Requests made on a session that holds the base URL, the `BaseUrlSession` apps write (and requests-toolbelt ships):
a `Session` subclass whose `request` joins each URL to the base with `urljoin`, so a path relative to the base
(`projects/...`) is sent under the base's path."""

from urllib.parse import urljoin

import requests

from app.settings import API_URL


class BaseUrlSession(requests.Session):
    def __init__(self, base_url: str):
        super().__init__()
        self.base_url = base_url

    def request(self, method, url, *args, **kwargs):
        return super().request(method, urljoin(self.base_url, url), *args, **kwargs)


api = BaseUrlSession(f"{API_URL}/api/v2/")
api.headers["Authorization"] = "Bearer token"


def list_projects(owner: str):
    return api.get("projects", params={"owner": owner}).json()


def get_project(project_id: str):
    return api.get(f"projects/{project_id}").json()


def create_project(name: str):
    return api.post("projects", json={"name": name}).json()


def update_project(project_id: str, name: str):
    return api.put(f"projects/{project_id}", json={"name": name})


def archive_project(project_id: str):
    return api.request("POST", f"projects/{project_id}/archive")


def delete_project(project_id: str):
    return api.delete(f"projects/{project_id}")
