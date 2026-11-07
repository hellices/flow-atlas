import { Hono } from "hono";

const v1 = new Hono();
v1.get("/status", (c) => c.json({ ok: true }));
v1.patch("/settings/:key", (c) => c.json({ key: c.req.param("key") }));

const api = new Hono().basePath("/api");
api.get("/catalog", (c) => c.text("Catalog"));
api.route("/v1", v1);

export default api;
