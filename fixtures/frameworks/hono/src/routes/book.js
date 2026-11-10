import { Hono } from "hono";

const book = new Hono();

book.get("/", (c) => c.text("List Books"));
book.get("/:id", (c) => c.text("Get Book: " + c.req.param("id")));
book.post("/", (c) => c.text("Create Book"));

export default book;
