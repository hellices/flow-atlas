import Router from "@koa/router";

const router = new Router();

const logAccess = async (ctx, next) => {
  await next();
  ctx.body ??= { method: ctx.method };
};

router.get("/", (ctx) => {
  ctx.body = "Hello World!";
});

router
  .get("/users", (ctx) => {
    ctx.body = [];
  })
  .post("/users", (ctx) => {
    ctx.status = 201;
  })
  .put("/users/:id", (ctx) => {
    ctx.body = { id: ctx.params.id };
  })
  .delete("/users/:id", (ctx) => {
    ctx.status = 204;
  })
  .all("/users/:id", logAccess);

router.get("user", "/user/:id", (ctx) => {
  ctx.body = { id: ctx.params.id, self: router.url("user", ctx.params.id) };
});
router.get("sign-in", "/sign-in", (ctx) => {
  ctx.body = "sign in";
});
router.redirect("/login", "sign-in");

router.get("/profile{/:id}", (ctx) => {
  ctx.body = { id: ctx.params.id ?? "all" };
});
router.get("/files/*path", (ctx) => {
  ctx.body = { path: ctx.params.path };
});
router.get(["/people", "/persons"], (ctx) => {
  ctx.body = [];
});
router.del("/sessions/:id", (ctx) => {
  ctx.status = 204;
});
router.patch("/settings/:key", (ctx) => {
  ctx.body = { key: ctx.params.key };
});
router.purge("/cache/:key", (ctx) => {
  ctx.body = { cleared: ctx.params.key };
});

router
  .param("article", async (id, ctx, next) => {
    ctx.state.article = { id };
    return next();
  })
  .get("/articles/:article", (ctx) => {
    ctx.body = ctx.state.article;
  })
  .get("/articles/:article/comments", (ctx) => {
    ctx.body = [];
  });

export default router;
