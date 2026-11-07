// A plugin registered as `{ plugin, routes: { prefix } }` in an array.
export default {
  name: "admin",
  version: "1.0.0",
  register: async function (server, options) {
    server.route({ method: "GET", path: "/dashboard", handler: () => "dashboard" });
    server.route({ method: "DELETE", path: "/cache/{key?}", handler: () => "cleared" });
  },
};
