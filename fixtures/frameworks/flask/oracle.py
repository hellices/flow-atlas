"""Asks Flask which routes the application serves: Flask dispatches each request through `app.url_map`, the Werkzeug
map its rules, the blueprints' included under their url prefixes and the static files route Flask adds, are registered
in; `iter_rules()` yields every rule with the methods it answers."""

import json
import re
from importlib.metadata import version

from app import create_app

app = create_app()

VARIABLE = re.compile(r"<(?:(\w+)(?:\([^()]*\))?:)?[^<>:]+>")


def canonical(rule) -> str:
    # A variable whose converter's regex takes a slash (`path`) takes the rest of the path; any other one segment's text.
    def variable(m: re.Match) -> str:
        regex = app.url_map.converters[m.group(1) or "default"].regex
        return "{**}" if re.fullmatch(regex, "a/b") else "{}"

    path = VARIABLE.sub(variable, rule.rule)
    return path.rstrip("/") or "/"


routes = []
for rule in app.url_map.iter_rules():
    for method in sorted(rule.methods) if rule.methods else ["*"]:
        routes.append({"method": method, "path": canonical(rule), "raw": rule.rule})

print(json.dumps({"framework": "flask", "version": version("flask"), "routes": routes}))
