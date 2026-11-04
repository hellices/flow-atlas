import express from "express";

const CORE = process.env.CORE_URL;
export const app = express();

app.post("/uploads", async (req, res) => {
  const stored = await fetch(`${CORE}/uploads`, { method: "POST", body: req.body });
  res.status(stored.status).send(await stored.json());
});

app.post("/messages", async (req, res) => {
  const turn = await fetch(`${CORE}/replies`, { method: "POST", body: req.body });
  res.status(turn.status).send(await turn.json());
});

// The client that called this was retired; nothing calls it now.
app.get("/legacy/profiles", async (req, res) => {
  res.send(await (await fetch(`${CORE}/profiles`)).json());
});
