import express from "express";

// The desktop app's local server, where the app and the browser extension hand over pages to keep.
export const app = express();

app.post("/workspace", (_req, res) => {
  res.status(204).end();
});

app.get("/inbox/items", (_req, res) => {
  res.json([]);
});

app.listen(4800, "127.0.0.1");
