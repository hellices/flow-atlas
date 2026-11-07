# The blueprint of "My First Blueprint": one view on two rules, the first with a default for the variable.
from flask import Blueprint

pages = Blueprint("pages", __name__)


@pages.route("/", defaults={"page": "index"})
@pages.route("/<page>")
def show(page):
    return f"page {page}"
