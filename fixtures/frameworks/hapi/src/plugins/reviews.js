export default {
  name: "reviews",
  version: "1.0.0",
  register: async function (server, options) {
    server.route({ method: "GET", path: "/", handler: () => [] });
    server.route({ method: "GET", path: "/{reviewId}", handler: (request) => ({ id: request.params.reviewId }) });
  },
};
