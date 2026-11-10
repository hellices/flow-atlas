# Resources (falcon.readthedocs.io/en/stable/api/routing.html): a class answers the methods it has a responder for
# (`on_get`, `on_post`, ...), and a route's suffix picks the responders named with it (`on_get_collection`).
import falcon


class ItemResource:
    def on_get_collection(self, req, resp):
        resp.media = []

    def on_post_collection(self, req, resp):
        resp.status = falcon.HTTP_201

    def on_get(self, req, resp, item_id):
        resp.media = {"id": item_id}

    def on_put(self, req, resp, item_id):
        resp.media = {"id": item_id}

    def on_delete(self, req, resp, item_id):
        resp.status = falcon.HTTP_204


class UserResource:
    def on_get(self, req, resp, username):
        resp.media = {"username": username}


class ReportResource:
    def on_get(self, req, resp, day):
        resp.media = {"day": day.isoformat()}


class OrderResource:
    def on_get(self, req, resp, order_id):
        resp.media = {"id": str(order_id)}

    def on_patch(self, req, resp, order_id):
        resp.media = {"id": str(order_id)}


class CompareResource:
    def on_get(self, req, resp, org, repo, usr0, branch0, usr1, branch1):
        resp.media = {"base": f"{usr0}:{branch0}", "head": f"{usr1}:{branch1}"}


class FileResource:
    def on_get(self, req, resp, file_path):
        resp.media = {"path": file_path}


class HealthResource:
    def on_get(self, req, resp):
        resp.text = "ok"


class PingResource:
    def on_get(self, req, resp):
        resp.text = "pong"

    def on_post(self, req, resp):
        resp.text = "pong"
