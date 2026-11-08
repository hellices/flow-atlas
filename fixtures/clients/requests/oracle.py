"""Makes every request the app's modules make once: the app reads its base URL from the environment, as it does in
each deployment, here the recording server's; each function a module defines is called with `ARG` for each argument
(`ARG_NUMBER` where it takes a number)."""

import inspect
import json
import os
from importlib import import_module
from importlib.metadata import version

os.environ["API_URL"] = os.environ["RECORD_URL"]


def argument(parameter: inspect.Parameter):
    return int(os.environ["ARG_NUMBER"]) if parameter.annotation is int else os.environ["ARG"]


for name in ["app.users", "app.orders", "app.projects"]:
    module = import_module(name)
    for attr, function in vars(module).items():
        if not inspect.isfunction(function) or function.__module__ != name or attr.startswith("_"):
            continue
        try:
            function(*[argument(p) for p in inspect.signature(function).parameters.values()])
        except Exception as error:
            raise SystemExit(f"{name}.{attr}: {error!r}")

print(json.dumps({"library": "requests", "version": version("requests")}))
