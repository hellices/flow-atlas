from tornado.web import RequestHandler
from tornado.websocket import WebSocketHandler


class BaseHandler(RequestHandler):
    def get_current_user(self):
        return self.get_signed_cookie("user") if self.settings.get("cookie_secret") else None


class MainHandler(BaseHandler):
    def get(self):
        self.write('<a href="%s">link to story 1</a>' % self.reverse_url("story", "1"))


class StoryHandler(BaseHandler):
    def initialize(self, db):
        self.db = db

    def get(self, story_id):
        self.write("this is story %s" % story_id)


class MyFormHandler(BaseHandler):
    def get(self):
        self.write('<form action="/myform" method="POST"><input type="text" name="message"></form>')

    def post(self):
        self.write("You wrote " + self.get_body_argument("message", ""))


class UsersHandler(BaseHandler):
    def get(self):
        self.write({"users": []})

    def post(self):
        self.set_status(201)


class UserHandler(BaseHandler):
    def get(self, user_id):
        self.write({"id": user_id})

    def put(self, user_id):
        self.write({"id": user_id})

    def patch(self, user_id):
        self.write({"id": user_id})

    def delete(self, user_id):
        self.set_status(204)


class ProfileHandler(UserHandler):
    """Serves the methods it inherits from UserHandler but DELETE, which it leaves out of SUPPORTED_METHODS."""

    SUPPORTED_METHODS = ("GET", "PUT", "PATCH")


class EntryHandler(BaseHandler):
    async def get(self, year, slug):
        self.write({"year": year, "slug": slug})


class FileHandler(BaseHandler):
    def get(self, name):
        self.write(name)

    def head(self, name):
        self.set_header("Content-Type", "text/plain")


class PhotoHandler(BaseHandler):
    def get(self, path):
        self.write("photo %s" % path)


class EchoWebSocket(WebSocketHandler):
    def on_message(self, message):
        self.write_message("You said: " + message)
