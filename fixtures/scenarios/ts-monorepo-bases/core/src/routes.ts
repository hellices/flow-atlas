import express from "express";

export const app = express();

app.post("/uploads", (req, res) => res.send({ ref: "a1" }));
app.post("/replies", (req, res) => res.send({ text: "..." }));
app.get("/profiles", (req, res) => res.send([]));
