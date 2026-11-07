# A second Application, routed to by the first for the paths its `PathMatches` takes (tornadoweb.org/en/stable/
# routing.html: "route between applications").
from tornado.web import Application, RequestHandler


class DashboardHandler(RequestHandler):
    def get(self):
        self.write("admin")


class SettingsHandler(RequestHandler):
    def get(self):
        self.write({})

    def post(self):
        self.write({})


def make_admin():
    return Application([
        (r"/admin", DashboardHandler),
        (r"/admin/settings", SettingsHandler),
    ])
