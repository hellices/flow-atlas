from flasgger import Swagger
from flask import Blueprint, Flask

app = Flask(__name__)
bp = Blueprint("orders", __name__, url_prefix="/api/v1/orders")


@bp.route("/<order_id>", methods=["GET"])
def read_order(order_id):
    """Read an order
    ---
    parameters:
      - name: order_id
        in: path
        type: string
        required: true
    responses:
      200:
        description: the order
    """
    return {"id": order_id}


@bp.route("", methods=["POST"])
def create_order():
    """Create an order
    ---
    responses:
      200:
        description: created
    """
    return {}


@bp.route("/<order_id>/history", methods=["GET"])
def history(order_id):
    return []


app.register_blueprint(bp)
swagger = Swagger(app)

if __name__ == "__main__":
    import json

    with app.test_client() as c:
        print(json.dumps(c.get("/apispec_1.json").get_json(), indent=2))
