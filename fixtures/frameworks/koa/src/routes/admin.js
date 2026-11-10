import Router from "@koa/router";

const admin = new Router();
admin.get("/dashboard", (ctx) => {
  ctx.body = "dashboard";
});
// @koa/router runs the routes a request matches in the order they are registered, and the first that answers ends it,
// so the static path comes before the parameter.
admin.get("/reports/latest", (ctx) => {
  ctx.body = { latest: true };
});
admin.get("/reports/:id", (ctx) => {
  ctx.body = { id: ctx.params.id };
});

export default admin;
