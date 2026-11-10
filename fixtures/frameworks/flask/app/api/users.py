from flask import Blueprint

users = Blueprint("users", __name__, url_prefix="/users")


@users.get("/")
def list_users():
    return []


@users.post("/")
def create_user():
    return {}, 201


@users.route("/<int:user_id>", methods=["GET", "PUT", "DELETE"])
def user(user_id):
    return {"id": user_id}


@users.patch("/<int:user_id>/password")
def change_password(user_id):
    return "", 204
