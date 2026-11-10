// A plugin instance with a `prefix`, used inside the group `/api` (served under `/api/users`).
import { Elysia } from "elysia";

export const users = new Elysia({ prefix: "/users" })
  .get("/", () => [])
  .get("/:id", ({ params: { id } }) => ({ id }))
  .post("/", ({ body }) => body);
