import Router from "@koa/router";

const admin = new Router({ host: "admin.example.com" });
admin.get("/dashboard", (ctx) => {
  ctx.body = "dashboard";
});

export default admin;
