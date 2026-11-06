import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";

const outputPath = "/outputs";
const snapshotPath = "/outputs/snapshot";

export function registerOutputEvents(fastify: FastifyInstance): void {
  fastify.get(outputPath, async (request: FastifyRequest, reply: FastifyReply) => {
    reply.raw.setHeader("content-type", "text/event-stream");
  });
  fastify.get(
    `${snapshotPath}`,
    async (request: FastifyRequest, reply: FastifyReply) => reply.send({ items: [] }),
  );
}
