// A plugin registered without a prefix: its routes are served as written.
export default {
  name: "health",
  version: "1.0.0",
  register: async function (server, options) {
    server.route({ method: "GET", path: "/health", handler: () => ({ status: "ok" }) });
  },
};
