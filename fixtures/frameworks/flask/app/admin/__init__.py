# A blueprint with its own static folder (flask.palletsprojects.com/en/stable/blueprints/#static-files), served
# under the blueprint's url_prefix.
from flask import Blueprint

admin = Blueprint("admin", __name__, url_prefix="/admin", static_folder="static")


@admin.route("/")
def dashboard():
    return "admin"


@admin.route("/settings", methods=["GET", "POST"])
def settings():
    return "settings"
