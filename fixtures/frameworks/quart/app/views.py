# Class-based views (quart.views): a MethodView serves the methods it defines, a View the methods it lists.
from quart import request
from quart.views import MethodView, View


class ItemsAPI(MethodView):
    async def get(self):
        return []

    async def post(self):
        return {}, 201


class ItemAPI(MethodView):
    async def get(self, id):
        return {"id": id}

    async def patch(self, id):
        return {"id": id}

    async def delete(self, id):
        return "", 204


class Counter(View):
    methods = ["GET", "POST"]

    async def dispatch_request(self):
        return "counted" if request.method == "POST" else "0"
