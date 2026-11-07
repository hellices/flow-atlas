from quart import Blueprint

users = Blueprint("users", __name__, url_prefix="/users")


@users.get("/")
async def list_users():
    return []


@users.post("/")
async def create_user():
    return {}, 201


@users.route("/<int:user_id>", methods=["GET", "PUT", "DELETE"])
async def user(user_id):
    return {"id": user_id}


@users.patch("/<int:user_id>/password")
async def change_password(user_id):
    return "", 204
