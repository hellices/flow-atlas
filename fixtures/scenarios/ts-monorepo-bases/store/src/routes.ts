import express from "express";

export const app = express();

app.post("/store/internal/v2/shares", (req, res) => res.send({}));
app.post("/store/internal/v2/upload-tickets", (req, res) => res.send({}));
app.get("/store/internal/object-info/*", (req, res) => res.send({}));
app.post("/store/internal/v2/agent/images", (req, res) => res.send({}));
