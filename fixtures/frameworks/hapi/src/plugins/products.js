// A plugin registered under `/v1`, registering another plugin under `/reviews` (served under `/v1/reviews`).
import reviews from "./reviews.js";

export default {
  name: "products",
  version: "1.0.0",
  register: async function (server, options) {
    server.route([
      { method: "GET", path: "/products", handler: () => [] },
      { method: "GET", path: "/products/{id}", handler: (request) => ({ id: request.params.id }) },
      { method: "POST", path: "/products", handler: (request, h) => h.response(request.payload).code(201) },
    ]);
    await server.register(reviews, { routes: { prefix: "/reviews" } });
  },
};
