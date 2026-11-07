# Class-based views (flask.palletsprojects.com/en/stable/views/): a MethodView serves the methods it defines, a View the
# methods it lists.
from flask import request
from flask.views import MethodView, View


class ItemsAPI(MethodView):
    def get(self):
        return []

    def post(self):
        return {}, 201


class ItemAPI(MethodView):
    def get(self, id):
        return {"id": id}

    def patch(self, id):
        return {"id": id}

    def delete(self, id):
        return "", 204


class Counter(View):
    methods = ["GET", "POST"]

    def dispatch_request(self):
        return "counted" if request.method == "POST" else "0"
