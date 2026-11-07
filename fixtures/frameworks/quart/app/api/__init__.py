# Nested blueprints (quart.palletsprojects.com/en/latest/how_to_guides/blueprints/#nested-blueprints): a child's rules
# are served under its parent's url_prefix and its own.
from quart import Blueprint, websocket

from .users import users

api = Blueprint("api", __name__, url_prefix="/api")
v1 = Blueprint("v1", __name__, url_prefix="/v1")


@api.get("/status")
async def status():
    return {"status": "ok"}


@api.websocket("/events")
async def events():
    await websocket.send("hello")


v1.register_blueprint(users)
api.register_blueprint(v1)
