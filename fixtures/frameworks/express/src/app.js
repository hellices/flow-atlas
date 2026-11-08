// The routes of the Express routing guide (expressjs.com/en/guide/routing.html), in Express 5's path syntax.
import express from "express";
import admin from "./admin.js";
import users from "./routes/users.js";

const app = express();

app.get("/", (req, res) => res.send("home"));
app.post("/", (req, res) => res.send("posted"));
app.all("/secret", (req, res) => res.send("any method"));

app.get("/users/:userId/books/:bookId", (req, res) => res.send(req.params));
app.get("/flights/:from-:to", (req, res) => res.send(req.params));
app.get("/plantae/:genus.:species", (req, res) => res.send(req.params));
app.get("/files/*filepath", (req, res) => res.send(req.params.filepath));
app.get("/about{/:section}", (req, res) => res.type("text").send(req.params.section ?? "about"));
app.get(["/help", "/faq"], (req, res) => res.send("help"));

// More than one callback, the first passing the request on; one answering with a route-level error handler
// (expressjs.com/en/guide/error-handling.html); one answering with a redirect.
app.get(
  "/example/b",
  (req, res, next) => next(),
  (req, res) => res.send("Hello from B!"),
);
app.get(
  "/example/e",
  (req, res, next) => next(new Error("not ready")),
  (err, req, res, next) => res.status(503).send(err.message),
);
app.get("/home", (req, res) => res.redirect(301, "/"));

app
  .route("/book")
  .get((req, res) => res.send("a book"))
  .post((req, res) => res.send("added"))
  .put((req, res) => res.send("updated"));

app.use("/users", users);
app.use("/admin", admin);

export default app;
