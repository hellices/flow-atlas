import express from "express";

export const app = express();

app.get("/api/v1/notebooks", (_req, res) => {
  res.json([]);
});

app.post("/api/v1/notebooks/:notebookId/search", (req, res) => {
  res.json({ notebookId: req.params.notebookId, hits: [] });
});
