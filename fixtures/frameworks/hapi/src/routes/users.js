// Routes passed to `server.route` as an array.
export const userRoutes = [
  { method: "GET", path: "/users", handler: () => [] },
  { method: "POST", path: "/users", handler: (request, h) => h.response(request.payload).code(201) },
  { method: "GET", path: "/users/{id}", handler: (request) => ({ id: request.params.id }) },
  { method: ["PUT", "PATCH"], path: "/users/{id}", handler: (request) => ({ id: request.params.id }) },
  { method: "DELETE", path: "/users/{id}", handler: (request, h) => h.response().code(204) },
];
