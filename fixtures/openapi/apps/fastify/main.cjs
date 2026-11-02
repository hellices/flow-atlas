const Fastify = require("fastify");
const swagger = require("@fastify/swagger");

async function build(mode) {
  const app = Fastify({ logger: false });
  await app.register(swagger, mode === "swagger" ? { swagger: { info: { title: "Orders", version: "1" } } } : { openapi: { info: { title: "Orders", version: "1" } } });
  await app.register(
    async (orders) => {
      orders.get("/:orderId", { schema: { params: { type: "object", properties: { orderId: { type: "string" } } } } }, async (req) => ({ id: req.params.orderId }));
      orders.post("/", async () => ({}));
      orders.get("/:orderId/history", { schema: { operationId: "orderHistory" } }, async () => []);
      orders.get("/internal/health", { schema: { hide: true } }, async () => ({}));
    },
    { prefix: "/api/v1/orders" },
  );
  await app.ready();
  return app.swagger();
}

(async () => {
  const mode = process.argv[2];
  process.stdout.write(JSON.stringify(await build(mode), null, 2));
})();
