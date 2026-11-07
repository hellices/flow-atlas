# The routes of Tornado's guide (tornadoweb.org/en/stable/guide/structure.html, routing.html, web.html): a routing
# table of tuples and `url()` specs whose regexes' groups are the handlers' arguments, named groups, initialization
# arguments, `RedirectHandler` with and without substitutions, `StaticFileHandler` mapped by hand and the static files
# Tornado serves by itself from `static_path`, a WebSocket handler, a nested list of rules under a `PathMatches`, and a
# second `Application` the first routes to. Each handler serves the methods it defines.
import os

from tornado.routing import PathMatches, Rule
from tornado.web import Application, RedirectHandler, StaticFileHandler, url

from .admin import make_admin
from .api import ItemHandler, StatusHandler
from .handlers import (
    EchoWebSocket,
    EntryHandler,
    FileHandler,
    MainHandler,
    MyFormHandler,
    PhotoHandler,
    ProfileHandler,
    StoryHandler,
    UserHandler,
    UsersHandler,
)

HERE = os.path.dirname(__file__)


def make_app():
    return Application(
        [
            url(r"/", MainHandler),
            url(r"/story/([0-9]+)", StoryHandler, dict(db={}), name="story"),
            (r"/myform", MyFormHandler),
            (r"/users", UsersHandler),
            (r"/users/([^/]+)", UserHandler),
            (r"/users/([^/]+)/profile", ProfileHandler),
            (r"/blog/(?P<year>[0-9]{4})/(?P<slug>[^/]+)", EntryHandler),
            (r"/files/([^/]+)\.txt", FileHandler),
            url(r"/app", RedirectHandler, dict(url="https://example.com/my-app-id")),
            url(r"/photos/(.*)", PhotoHandler),
            url(r"/pictures/(.*)", RedirectHandler, dict(url=r"/photos/{0}")),
            (r"/assets/(.*)", StaticFileHandler, {"path": os.path.join(HERE, "assets"), "default_filename": "index.html"}),
            (r"/websocket", EchoWebSocket),
            Rule(PathMatches(r"/api/.*"), [
                (r"/api/status", StatusHandler),
                (r"/api/items/([0-9]+)", ItemHandler),
            ]),
            Rule(PathMatches(r"/admin.*"), make_admin()),
        ],
        static_path=os.path.join(HERE, "static"),
    )
