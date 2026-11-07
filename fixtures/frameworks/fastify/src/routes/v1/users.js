export default function (fastify, opts, done) {
  fastify.get("/user", async () => ({ version: 1 }));
  done();
}
