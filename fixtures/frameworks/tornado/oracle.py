"""Asks Tornado which routes the application serves: Tornado dispatches each request through the rules of the
application's `wildcard_router` (its handlers, the static files routes `static_path` adds among them), trying a nested
list of rules or another application only for a path its `PathMatches` takes. Those rules are walked here.

The path of a rule is its regex, as compiled by Tornado, written out: a group is `{}`, `{**}` where it takes a slash,
its text where it takes one literal only (`(favicon\\.ico)`); a group ending the path that also takes nothing (`(.*)`)
gives the path before its `/` as well.

Its methods are the ones its handler class defines among its `SUPPORTED_METHODS`, the rest left to RequestHandler,
which answers them with 405.

Each route is then confirmed by requests through `tornado.testing`: every method Tornado supports, on a path the
rule's regex and every enclosing `PathMatches` take, must reach the rule's handler class with the path arguments
written in, and the handler must answer 405 exactly to the methods it does not define.
"""

import json
import logging
import re
import sys
import unittest
from importlib.metadata import version
from re import _parser as sre_parse  # the parser `re.compile` uses

from tornado.routing import PathMatches, Router
from tornado.testing import AsyncHTTPTestCase
from tornado.web import Application, RequestHandler

from app import make_app

logging.disable(logging.CRITICAL)  # Tornado logs each 404 and 405 the requests below get

app = make_app()
METHODS = list(RequestHandler.SUPPORTED_METHODS)
# Values tried for a group, the first its regex takes standing in the requests; "a/b" tells a group that takes a slash.
SAMPLES = ["1", "2024", "x", "a1", "a-b", "a/b"]


def written(regex: re.Pattern) -> tuple[str, str, bool]:
    """The canonical path of a rule's regex, a path it takes, and whether its last group also takes nothing."""
    path, sample, empty_tail = "", "", False
    items = list(sre_parse.parse(regex.pattern))
    for i, (op, av) in enumerate(items):
        if op is sre_parse.AT:
            continue
        if op is sre_parse.LITERAL:
            path += chr(av)
            sample += chr(av)
            continue
        if op is not sre_parse.SUBPATTERN:
            raise ValueError(f"cannot write out {regex.pattern}")
        body = av[-1]
        if all(o is sre_parse.LITERAL for o, _ in body):
            text = "".join(chr(c) for _, c in body)
            path, sample = path + text, sample + text
            continue
        group = re.compile(group_text(regex.pattern, av[0]))
        takes = [s for s in SAMPLES if group.fullmatch(s)]
        if not takes:
            raise ValueError(f"no sample for a group of {regex.pattern}")
        path += "{**}" if group.fullmatch("a/b") else "{}"
        sample += takes[0]
        last = all(o is sre_parse.AT for o, _ in items[i + 1 :])
        empty_tail = last and path.endswith("/{**}") and bool(group.fullmatch(""))
    return path, sample, empty_tail


def group_text(pattern: str, number: int) -> str:
    """The text of the capturing group `number` (counted from 1, as Python numbers them) of a regex."""
    count, depth, i, in_class, body = 0, 0, 0, False, -1
    while i < len(pattern):
        ch = pattern[i]
        if ch == "\\":
            i += 2
            continue
        if in_class:
            in_class = ch != "]"
        elif ch == "[":
            in_class = True
        elif ch == "(":
            depth += 1
            if not pattern.startswith("(?", i) or pattern.startswith("(?P<", i):
                count += 1
                if count == number:
                    body, at = (pattern.index(">", i) + 1 if pattern.startswith("(?P<", i) else i + 1), depth
        elif ch == ")":
            if body >= 0 and depth == at:
                return pattern[body:i]
            depth -= 1
        i += 1
    raise ValueError(f"no group {number} in {pattern}")


def methods(handler: type) -> list[str]:
    return [m for m in handler.SUPPORTED_METHODS if getattr(handler, m.lower()) is not getattr(RequestHandler, m.lower())]


def walk(router: Router, enclosing: list[re.Pattern], out: list[dict]) -> list[dict]:
    for rule in router.rules:
        if not isinstance(rule.matcher, PathMatches):
            raise ValueError(f"a rule matched by {type(rule.matcher).__name__} is not part of the form")
        target = rule.target
        if isinstance(target, Application):
            target.settings["log_function"] = served.append
            walk(target.wildcard_router, [*enclosing, rule.matcher.regex], out)
        elif isinstance(target, Router):
            walk(target, [*enclosing, rule.matcher.regex], out)
        elif isinstance(target, type) and issubclass(target, RequestHandler):
            path, sample, empty_tail = written(rule.matcher.regex)
            for outer in enclosing:
                if not outer.match(sample):
                    raise ValueError(f"{sample} is not taken by the enclosing {outer.pattern}")
            paths = [path, path.removesuffix("/{**}") or "/"] if empty_tail else [path]
            samples = [sample, sample[: sample.rindex("/") + 1]] if empty_tail else [sample]
            for p, s in zip(paths, samples):
                route = {"path": p.rstrip("/") or "/", "raw": rule.matcher.regex.pattern, "handler": target, "sample": s}
                route["args"] = rule.matcher.regex.match(s).groups()
                route["methods"] = methods(target)
                out.append(route)
        else:
            raise ValueError(f"a rule's target {target!r} is not walked")
    return out


served: list[RequestHandler] = []
app.settings["log_function"] = served.append
found = walk(app.wildcard_router, [], [])


class Confirm(AsyncHTTPTestCase):
    def get_app(self):
        return app

    def test_routes(self):
        for route in found:
            answered = []
            for method in METHODS:
                served.clear()
                body = b"" if method in ("POST", "PUT", "PATCH") else None
                response = self.fetch(route["sample"], method=method, body=body, allow_nonstandard_methods=True, follow_redirects=False)
                handler = served[-1] if served else None
                if type(handler) is not route["handler"]:
                    raise AssertionError(f"{method} {route['sample']} reached {type(handler).__name__}, not {route['handler'].__name__}")
                # A method outside SUPPORTED_METHODS is refused before the handler takes the path arguments.
                given = getattr(handler, "path_args", None) or getattr(handler, "path_kwargs", {}).values()
                args = tuple(a.decode() if isinstance(a, bytes) else a for a in given)
                if response.code != 405 and args != tuple(route["args"]):
                    raise AssertionError(f"{method} {route['sample']} reached its handler with {args}, not {route['args']}")
                if response.code != 405:
                    answered.append(method)
            if sorted(answered) != sorted(route["methods"]):
                raise AssertionError(f"{route['sample']} answers {answered}, its handler defines {route['methods']}")


result = unittest.TextTestRunner(stream=sys.stderr, verbosity=0).run(unittest.defaultTestLoader.loadTestsFromTestCase(Confirm))
if not result.wasSuccessful():
    sys.exit(1)

routes = [{"method": m, "path": r["path"], "raw": r["raw"]} for r in found for m in r["methods"]]
print(json.dumps({"framework": "tornado", "version": version("tornado"), "routes": routes}))
