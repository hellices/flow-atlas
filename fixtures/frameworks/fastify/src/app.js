// The routes of Fastify's routing guide (fastify.dev/docs/latest/Reference/Routes/), as a root plugin the way
// fastify-cli loads one: shorthand and full declarations, parameters in the guide's shapes, prefixed plugins nested
// and imported, version constraints, and the static files @fastify/static serves.
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import fastifyStatic from "@fastify/static";
import admin from "./routes/admin.js";
import usersV1 from "./routes/v1/users.js";
import usersV2 from "./routes/v2/users.js";

export default async function app(fastify) {
  fastify.get("/", async () => ({ hello: "world" }));

  fastify.route({
    method: "GET",
    url: "/hello",
    schema: { querystring: { type: "object", properties: { name: { type: "string" } } } },
    handler: async (request) => ({ hello: request.query.name ?? "world" }),
  });
  fastify.route({ method: ["POST", "PUT"], path: "/items", handler: async (request) => ({ method: request.method }) });
  fastify.get("/status", { handler: async () => ({ ok: true }) });

  fastify.get("/example/:userId", async (request) => request.params);
  fastify.get("/example/:userId/:secretToken", async (request) => request.params);
  fastify.get("/example/*", async (request) => request.params);
  fastify.get("/example/:file(^\\d+).png", async (request) => request.params);
  fastify.get("/example/near/:lat-:lng/radius/:r", async (request) => request.params);
  fastify.get("/example/at/:hour(^\\d{2})h:minute(^\\d{2})m", async (request) => request.params);
  fastify.get("/example/posts/:id?", async (request) => request.params);
  fastify.post("/name::verb", async () => ({ verb: true }));

  fastify.all("/any", async (request) => ({ method: request.method }));
  fastify.query("/search", async () => ({ results: [] }));

  fastify.route({ method: "GET", url: "/versioned", constraints: { version: "1.2.0" }, handler: async () => ({ version: 1 }) });
  fastify.route({ method: "GET", url: "/versioned", constraints: { version: "2.0.0" }, handler: async () => ({ version: 2 }) });

  fastify.register(usersV1, { prefix: "/v1" });
  fastify.register(usersV2, { prefix: "/v2" });

  fastify.register(
    async function (fastify) {
      fastify.get("/", async () => ({ api: true }));
      fastify.register(admin, { prefix: "/admin" });
    },
    { prefix: "/api" },
  );

  fastify.register(fastifyStatic, { root: join(dirname(fileURLToPath(import.meta.url)), "../public"), prefix: "/public/" });
}
