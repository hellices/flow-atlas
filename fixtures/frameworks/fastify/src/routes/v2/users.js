export default function (fastify, opts, done) {
  fastify.get("/user", async () => ({ version: 2 }));
  fastify.delete("/user/:id", async (request) => ({ deleted: request.params.id }));
  done();
}
