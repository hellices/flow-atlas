// The routes of @koa/router's guide (github.com/koajs/router): verbs and `all`, named routes, a redirect, parameters,
// optional and wildcard segments, an array of paths, routers with a prefix (given to the constructor, set with
// `prefix()`, holding a parameter), nested routers mounted with `use`, and a router that matches one host.
import Koa from "koa";
import admin from "./routes/admin.js";
import api from "./routes/api.js";
import router from "./routes/index.js";
import versioned from "./routes/versioned.js";

const app = new Koa();

app.use(router.routes()).use(router.allowedMethods());
app.use(api.routes()).use(api.allowedMethods());
app.use(versioned.routes());
app.use(admin.routes());

export default app;
