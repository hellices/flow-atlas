import express from "express";

export const app = express();

app.get("/feed", (_req, res) => {
  res.json({ cards: [] });
});

// The app lists devices from the state it already holds; no client asks for this list.
app.get("/devices", (_req, res) => {
  res.json({ devices: [] });
});

app.get("/devices/:deviceId/status", (req, res) => {
  res.json({ deviceId: req.params.deviceId, online: true });
});

app.post("/interactions", (_req, res) => {
  res.status(202).json({ accepted: true });
});
