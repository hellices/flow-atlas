import Router from "@koa/router";

const router = new Router();

router.post("documents.info", async (ctx) => {
  ctx.body = { data: { id: ctx.request.body.id } };
});

router.post("documents.list", async (ctx) => {
  ctx.body = { data: [] };
});

export default router;
