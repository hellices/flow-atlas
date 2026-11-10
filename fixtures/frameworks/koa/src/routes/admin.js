import Router from "@koa/router";

const admin = new Router();
admin.get("/dashboard", (ctx) => {
  ctx.body = "dashboard";
});

export default admin;
