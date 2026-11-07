import { Hono } from "hono";

const user = new Hono().basePath("/users");

user.get("/", (c) => c.text("List Users"));
user.post("/", (c) => c.text("Create User"));

export default user;
