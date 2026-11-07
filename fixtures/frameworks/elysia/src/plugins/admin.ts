// A plugin with a `prefix` holding a group and another prefixed plugin.
import { Elysia } from "elysia";

const reports = new Elysia({ prefix: "/reports" }).get("/:year", ({ params: { year } }) => year).get("/*", "archive");

export const admin = new Elysia({ prefix: "/admin" })
  .get("/dashboard", "dashboard")
  .group("/cache", (app) => app.delete("/", "cleared").delete("/:key", ({ params: { key } }) => key))
  .use(reports);
