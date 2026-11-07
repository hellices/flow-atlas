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
app.get("/about{/:section}", (req, res) => res.send(req.params.section ?? "about"));
app.get(["/help", "/faq"], (req, res) => res.send("help"));

app
  .route("/book")
  .get((req, res) => res.send("a book"))
  .post((req, res) => res.send("added"))
  .put((req, res) => res.send("updated"));

app.use("/users", users);
app.use("/admin", admin);

export default app;
