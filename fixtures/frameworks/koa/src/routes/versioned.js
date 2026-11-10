import Router from "@koa/router";

const versioned = new Router({ prefix: "/api/v:version" });
versioned.get("/status", (ctx) => {
  ctx.body = { version: ctx.params.version };
});

const legacy = new Router();
legacy.prefix("/legacy");
legacy.get("/", (ctx) => {
  ctx.body = "legacy";
});
legacy.get("/items", (ctx) => {
  ctx.body = [];
});
versioned.use(legacy.routes());

export default versioned;
