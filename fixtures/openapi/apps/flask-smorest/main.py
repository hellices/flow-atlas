from flask import Flask
from flask.views import MethodView
from flask_smorest import Api, Blueprint

app = Flask(__name__)
app.config.update(API_TITLE="Orders", API_VERSION="1", OPENAPI_VERSION="3.0.3")
api = Api(app)

blp = Blueprint("orders", __name__, url_prefix="/api/v1/orders")


@blp.route("/<order_id>")
class Order(MethodView):
    def get(self, order_id):
        return {"id": order_id}


@blp.route("")
class Orders(MethodView):
    def post(self):
        return {}


@blp.route("/<order_id>/history")
@blp.doc(operationId="orderHistory")
def history(order_id):
    return []


api.register_blueprint(blp)

if __name__ == "__main__":
    import json

    print(json.dumps(api.spec.to_dict(), indent=2))
