// The routes of Hono's routing guide (hono.dev/docs/api/routing): verbs, `all` and `on` with custom, several methods
// and several paths, parameters (optional and with a regexp), wildcards, a chained route, groups with `route()`, base
// paths, nested groups, and a fallback registered last.
import { Hono } from "hono";
import api from "./routes/api.js";
import book from "./routes/book.js";
import user from "./routes/user.js";

const app = new Hono();

app.get("/", (c) => c.text("GET /"));
app.post("/", (c) => c.text("POST /"));
app.put("/", (c) => c.text("PUT /"));
app.delete("/", (c) => c.text("DELETE /"));
app.query("/search", (c) => c.text("QUERY /search"));

app.get("/wild/*/card", (c) => c.text("GET /wild/*/card"));
app.all("/hello", (c) => c.text("Any Method /hello"));
app.on("PURGE", "/cache", (c) => c.text("PURGE Method /cache"));
app.on(["PUT", "DELETE"], "/post", (c) => c.text("PUT or DELETE /post"));
app.on("GET", ["/greet", "/ja/greet", "/en/greet"], (c) => c.text("Hello"));

app.get("/user/:name", (c) => c.text(c.req.param("name")));
app.get("/posts/:id/comment/:comment_id", (c) => c.json(c.req.param()));
app.get("/animal/:type?", (c) => c.text("Animal!"));
app.get("/post/:date{[0-9]+}/:title{[a-z]+}", (c) => c.json(c.req.param()));

app
  .get("/endpoint", (c) => c.text("GET /endpoint"))
  .post((c) => c.text("POST /endpoint"))
  .delete((c) => c.text("DELETE /endpoint"));

app.route("/book", book);
app.route("/", user);
app.route("/", api);

app.get("*", (c) => c.text("fallback"));

export default app;
