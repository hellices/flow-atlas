// Loaded into `next start` (node --require) by oracle.mjs: tells, on each response, what Next's own routing matched the
// request to. Its router (server/lib/router-utils/resolve-routes) resolves a request against the routes manifest, the
// public folder and the build's assets to an output (`appFile`, `pageFile`, `publicFolder`, `nextStaticFolder`,
// `nextImage`, ...) with its item path, the route's page for a route; the render server then matches the page it
// renders again (request meta `match`). Both are sent back as headers, the second to cross-check the first.
const Module = require("node:module");

const META = Symbol.for("NextInternalRequestMeta");
const OUTPUT = "x-oracle-matched-output";
const RENDERED = "x-oracle-matched-route";

const load = Module._load;
Module._load = function (request, parent, isMain) {
  const exports = load.apply(this, arguments);
  if (!/[\\/]server[\\/]lib[\\/]router-utils[\\/]resolve-routes(\.js)?$/.test(Module._resolveFilename(request, parent, isMain))) return exports;
  return {
    ...exports,
    getResolveRoutes(...args) {
      const resolveRoutes = exports.getResolveRoutes(...args);
      return async function (options) {
        const result = await resolveRoutes(options);
        const { res } = options;
        const output = result.matchedOutput;
        if (res && !res.headersSent && output) res.setHeader(OUTPUT, JSON.stringify({ type: output.type, itemPath: output.itemPath }));
        if (res && !res.patchedByOracle) {
          res.patchedByOracle = true;
          const writeHead = res.writeHead;
          res.writeHead = function () {
            const match = options.req[META]?.match?.definition;
            if (match && !this.headersSent) this.setHeader(RENDERED, match.pathname);
            return writeHead.apply(this, arguments);
          };
        }
        return result;
      };
    },
  };
};
