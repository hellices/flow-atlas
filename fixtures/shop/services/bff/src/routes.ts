import { registerRoute } from "./route-support";
import { showOrder } from "./application/index.js";

function placeOrder(deps: any) {
  return deps.orders.createOrder();
}

export function routes(app: any, deps: any) {
  app.get("/screens/order/:orderId", (req: any) => showOrder(deps, req.params.orderId));
  app.post("/orders", () => placeOrder(deps));
  registerRoute(app, "GET", "/screens/home", { operationId: "getHome" });
  registerRoute(app, "PUT", "/preferences", { operationId: "putPreferences" });
  app.get("/openapi.json", () => deps.openapi);
}
