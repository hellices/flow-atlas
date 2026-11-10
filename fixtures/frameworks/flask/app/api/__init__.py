# Nested blueprints (flask.palletsprojects.com/en/stable/blueprints/#nesting-blueprints): a child's rules are served
# under its parent's url_prefix and its own.
from flask import Blueprint

from .users import users

api = Blueprint("api", __name__, url_prefix="/api")
v1 = Blueprint("v1", __name__, url_prefix="/v1")
v2 = Blueprint("v2", __name__, url_prefix="/v2")


@api.get("/status")
def status():
    return {"status": "ok"}


@v2.get("/users")
def list_users_v2():
    return {"users": [], "page": 1}


v1.register_blueprint(users)
v2.register_blueprint(users, url_prefix="/accounts", name="accounts")
api.register_blueprint(v1)
api.register_blueprint(v2)
