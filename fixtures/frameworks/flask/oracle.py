"""Asks Flask which routes the application serves: Flask dispatches each request through `app.url_map`, the Werkzeug
map its rules, the blueprints' included under their url prefixes and the static files route Flask adds, are registered
in; `iter_rules()` yields every rule with the methods it answers."""

import json
import re
from importlib.metadata import version

from flask import request
from werkzeug.routing import AnyConverter

from app import create_app

app = create_app()

VARIABLE = re.compile(r"<(?:\w+(?:\([^()]*\))?:)?([^<>:]+)>")


def canonical(rule) -> str:
    # A variable whose converter's regex takes a slash (`path`) takes the rest of the path; any other one segment's text.
    # The converter is the one bound to the rule, whose regex can depend on its arguments (`any('a/b', 'c')`).
    def variable(m: re.Match) -> str:
        regex = rule._converters[m.group(1)].regex
        return "{**}" if re.fullmatch(regex, "a/b") else "{}"

    path = VARIABLE.sub(variable, rule.rule)
    return path.rstrip("/") or "/"


routes = []
for rule in app.url_map.iter_rules():
    for method in sorted(rule.methods) if rule.methods else ["*"]:
        routes.append({"method": method, "path": canonical(rule), "raw": rule.rule})


def sample(rule) -> str:
    # A concrete path the rule takes: each variable a value its converter's regex takes, the rest of the path for one
    # that takes a slash.
    def value(m: re.Match) -> str:
        converter = rule._converters[m.group(2)]
        if isinstance(converter, AnyConverter):
            return sorted(converter.items)[0]
        candidates = ("rest/of/it", "value1", "1", "1.5", "00000000-0000-0000-0000-000000000001")
        return next(v for v in candidates if re.fullmatch(converter.regex, v))

    return re.sub(r"<(?:(\w+)(?:\([^()]*\))?:)?([^<>:]+)>", value, rule.rule).rstrip("/") or "/"


# Sample requests, and the rule Flask dispatched each to: every rule's sample path, also with a trailing `/`, and a path
# no rule takes, each with every method a rule registers. A rule is told by `request.url_rule`, the rule Werkzeug's map
# matched for the request (none where it raised 404, 405 or a redirect; a view's own answer, a 404 for a missing file
# included, is its rule's). Werkzeug orders the rules by their own weights, static parts before variables, whatever
# order they were added in.
# A branch rule (`/projects/`) asked for without its trailing `/` is answered by Werkzeug's map itself with a 308 to the
# path with it appended (`strict_slashes`, raised as RequestRedirect before any rule is bound), as Starlette's and
# Django's slash redirects are: the request is no rule's, though the redirect leads to one.
rules = list(app.url_map.iter_rules())


@app.after_request
def tag(response):
    if request.url_rule is not None:
        response.headers["x-rule"] = str(next(i for i, r in enumerate(rules) if r is request.url_rule))
    return response


client = app.test_client()
# HEAD and OPTIONS only where a route registers them on their own: the compared form leaves out the HEAD beside a GET
# and the OPTIONS beside another method of the same path, which the framework answers by itself.
methods_at: dict[str, set[str]] = {}
for r in routes:
    methods_at.setdefault(r["path"], set()).add(r["method"])
methods = sorted(
    {
        r["method"]
        for r in routes
        if r["method"] != "*"
        and not (r["method"] == "HEAD" and "GET" in methods_at[r["path"]])
        and not (r["method"] == "OPTIONS" and len(methods_at[r["path"]]) > 1)
    }
)
samples = {sample(rule) for rule in rules}
probes = sorted(samples | {s if s == "/" else s + "/" for s in samples} | {"/nowhere/value1"})
keys = {f"{r['method']} {r['path']}" for r in routes}
requests = []
for path in probes:
    for method in methods:
        response = client.open(path, method=method)
        index = response.headers.get("x-rule")
        if index is None:
            requests.append({"method": method, "path": path, "route": None})
            continue
        rule = rules[int(index)]
        key = f"{'*' if not rule.methods else method} {canonical(rule)}"
        if key not in keys:
            raise SystemExit(f"{method} {path} is answered by {rule.rule}, which gives {key}, no route")
        requests.append({"method": method, "path": path, "route": key})

print(json.dumps({"framework": "flask", "version": version("flask"), "routes": routes, "requests": requests}))
