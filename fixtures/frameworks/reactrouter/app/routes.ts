import { type RouteConfig, index, layout, prefix, route } from "@react-router/dev/routes";
import { flatRoutes } from "@react-router/fs-routes";

export default [
  index("./home.tsx"),
  route("about", "./about.tsx"),

  layout("./auth/layout.tsx", [
    route("login", "./auth/login.tsx"),
    route("register", "./auth/register.tsx"),
  ]),

  ...prefix("concerts", [
    index("./concerts/home.tsx"),
    route(":city", "./concerts/city.tsx"),
    route("trending", "./concerts/trending.tsx"),
  ]),

  route("dashboard", "./dashboard/layout.tsx", [
    index("./dashboard/home.tsx"),
    route("settings", "./dashboard/settings.tsx"),
  ]),

  route("c/:categoryId/p/:productId", "./product.tsx"),
  route(":lang?/categories", "./categories.tsx"),
  route("users/:userId/edit?", "./user.tsx"),
  route("files/*", "./files.tsx"),

  route("reports/pdf/:id", "./resources/report-pdf.ts"),
  ...prefix("api", [
    route("items", "./resources/items.ts"),
    route("webhook", "./resources/webhook.ts"),
  ]),

  ...(await flatRoutes()),
] satisfies RouteConfig;
