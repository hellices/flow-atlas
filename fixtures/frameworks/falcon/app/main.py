# The routes of Falcon's routing guide (falcon.readthedocs.io/en/stable/api/routing.html): URI templates with fields
# and converters (`int`, `uuid`, `dt`, `path`), several fields in one segment, resources answering several methods,
# suffixed responders on a second route, and static files (`add_static_route`). Sinks (`add_sink`) take every path a
# regex prefix matches, which the routes' form does not express; the application has none.
from pathlib import Path

import falcon

from .resources import (
    CompareResource,
    FileResource,
    HealthResource,
    ItemResource,
    OrderResource,
    PingResource,
    ReportResource,
    UserResource,
)

app = falcon.App()

items = ItemResource()
app.add_route("/items", items, suffix="collection")
app.add_route("/items/{item_id:int(min=1)}", items)
app.add_route("/users/{username}", UserResource())
app.add_route("/reports/{day:dt('%Y-%m-%d')}", ReportResource())
app.add_route("/orders/{order_id:uuid}", OrderResource())
app.add_route("/repos/{org}/{repo}/compare/{usr0}:{branch0}...{usr1}:{branch1}", CompareResource())
app.add_route("/files/{file_path:path}", FileResource())
app.add_route("/health", HealthResource())
app.add_route("/ping", PingResource())
app.add_static_route("/static", str(Path(__file__).parent / "static"))
