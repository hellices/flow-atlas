import Fastify from "fastify";
import app from "./app.js";

const fastify = Fastify({ logger: true });
fastify.register(app);
await fastify.listen({ port: 3000 });
