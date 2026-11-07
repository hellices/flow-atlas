// The routes of hapi's routing and plugins tutorials (hapi.dev/tutorials/en_us/routing, /tutorials/en_us/plugins) and
// its API's path parameters (hapi.dev/api/21.x.x#path-parameters): one method or several on a path, the `*` method,
// named, optional, multi-segment and wildcard parameters, a parameter within a segment (optional too), a handler in the
// route's options, an array of routes, and plugins registered with a route prefix, nested.
import Hapi from "@hapi/hapi";
import health from "./plugins/health.js";
import products from "./plugins/products.js";
import admin from "./plugins/admin.js";
import { userRoutes } from "./routes/users.js";

export async function create() {
  const server = Hapi.server({ port: 3000, host: "localhost" });

  server.route({
    method: "GET",
    path: "/",
    handler: (request, h) => "Hello World!",
  });

  server.route({
    method: ["PUT", "POST"],
    path: "/",
    handler: (request, h) => "I did something!",
  });

  server.route({
    method: "GET",
    path: "/hello/{user}",
    handler: (request, h) => `Hello ${request.params.user}!`,
  });

  server.route({
    method: "GET",
    path: "/greet/{user?}",
    handler: (request, h) => `Hello ${request.params.user ?? "stranger"}!`,
  });

  server.route({
    method: "GET",
    path: "/names/{user*2}",
    handler: (request, h) => {
      const userParts = request.params.user.split("/");
      return `Hello ${userParts[0]} ${userParts[1]}!`;
    },
  });

  server.route({
    method: "GET",
    path: "/files/{path*}",
    handler: (request, h) => `file ${request.params.path}`,
  });

  server.route({
    method: "GET",
    path: "/images/{filename}.jpg",
    handler: (request, h) => `image ${request.params.filename}`,
  });

  server.route({
    method: "GET",
    path: "/reports/q{quarter?}/summary",
    handler: (request, h) => `summary of ${request.params.quarter || "the year"}`,
  });

  server.route({
    method: "POST",
    path: "/signup",
    options: {
      auth: false,
      handler: (request, h) => `Welcome ${request.payload?.username}!`,
    },
  });

  server.route(userRoutes);

  server.route({
    method: "*",
    path: "/{any*}",
    handler: (request, h) => h.response("404 Error! Page Not Found!").code(404),
  });

  await server.register(health);
  await server.register(products, { routes: { prefix: "/v1" } });
  await server.register([{ plugin: admin, routes: { prefix: "/admin" } }]);

  return server;
}
