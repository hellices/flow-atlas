"""Makes every request the app's modules make once: the app reads its base URL from the environment, as it does in
each deployment, here the recording server's; each function a module defines is called (a coroutine function run to
its end) with `ARG` for each argument (`ARG_NUMBER` where it takes a number)."""

import asyncio
import inspect
import json
import os
from importlib import import_module
from importlib.metadata import version

os.environ["API_URL"] = os.environ["RECORD_URL"]


def argument(parameter: inspect.Parameter):
    return int(os.environ["ARG_NUMBER"]) if parameter.annotation is int else os.environ["ARG"]


for name in ["app.items", "app.accounts"]:
    module = import_module(name)
    for attr, function in vars(module).items():
        if not inspect.isfunction(function) or function.__module__ != name or attr.startswith("_"):
            continue
        arguments = [argument(p) for p in inspect.signature(function).parameters.values()]
        try:
            if inspect.iscoroutinefunction(function):
                asyncio.run(function(*arguments))
            else:
                function(*arguments)
        except Exception as error:
            raise SystemExit(f"{name}.{attr}: {error!r}")

print(json.dumps({"library": "httpx", "version": version("httpx")}))
