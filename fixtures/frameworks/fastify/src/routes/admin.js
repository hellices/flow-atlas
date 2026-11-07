export default async function admin(fastify) {
  fastify.get("/dashboard", async () => ({ dashboard: true }));
  fastify.patch("/settings/:key", async (request) => ({ key: request.params.key }));
}
