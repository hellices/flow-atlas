# Rules nested under a `PathMatches`: Tornado tries them only for a path the outer pattern matches, each against the
# whole path.
from tornado.web import RequestHandler


class StatusHandler(RequestHandler):
    def get(self):
        self.write({"status": "ok"})


class ItemHandler(RequestHandler):
    def get(self, item_id):
        self.write({"id": item_id})

    def delete(self, item_id):
        self.set_status(204)
