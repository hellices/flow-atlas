// The routes of Elysia's routing, plugin and mount guides (elysiajs.com/essential/route, /essential/plugin,
// /patterns/mount): static, dynamic, optional and wildcard paths with their priority, several methods on one path, a
// custom method, `all`, groups (with a guard, nested), plugin instances with a `prefix` (used in a group too),
// configurable and functional plugins, a deduplicated plugin, and a mounted WinterCG handler.
import { Elysia, t } from "elysia";
import { users } from "./plugins/users";
import { version } from "./plugins/version";
import { health } from "./plugins/health";
import { admin } from "./plugins/admin";

export const app = new Elysia()
  .get("/", "hello")
  .get("/hi", "hi")
  .get("/id/1", "static path")
  .get("/id/:id", ({ params: { id } }) => id)
  .get("/id/:id/:name", ({ params: { id, name } }) => `${id} ${name}`)
  .get("/id/*", ({ params }) => params["*"])
  .get("/optional/:id?", ({ params: { id } }) => `id ${id}`)
  .get("/items", () => [])
  .post("/items", ({ body }) => body)
  .put("/items/:id", ({ params: { id } }) => id)
  .patch("/items/:id", ({ params: { id } }) => id)
  .delete("/items/:id", ({ params: { id } }) => id)
  .route("M-SEARCH", "/m-search", "connect")
  .all("/any", "hi")
  .group("/user", (app) =>
    app
      .post("/sign-in", "Sign in")
      .post("/sign-up", "Sign up")
      .post("/profile", "Profile"),
  )
  .group("/account", { body: t.Object({ name: t.String() }) }, (app) =>
    app.post("/rename", ({ body }) => body.name).group("/settings", (app) => app.put("/:key", ({ params }) => params.key)),
  )
  .group("/api", (app) => app.use(users))
  .use(version(1))
  .use((app) => app.get("/callback", "functional"))
  .use(health)
  .use(health)
  .use(admin)
  .mount("/legacy", (request: Request) => new Response(`legacy ${new URL(request.url).pathname}`));
