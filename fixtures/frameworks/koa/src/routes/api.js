import Router from "@koa/router";

const users = new Router();
users.get("/", (ctx) => {
  ctx.body = [];
});
users.get("/:id", (ctx) => {
  ctx.body = { id: ctx.params.id };
});

const posts = new Router();
posts.get("/", (ctx) => {
  ctx.body = [];
});
posts.get("/:id", (ctx) => {
  ctx.body = { id: ctx.params.id };
});
posts.post("/:id/likes", (ctx) => {
  ctx.status = 201;
});

const api = new Router({ prefix: "/api" });
api.use("/users", users.routes());
api.use("/posts", posts.routes());

export default api;
