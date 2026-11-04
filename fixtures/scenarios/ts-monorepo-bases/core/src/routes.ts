import express from "express";

export const app = express();

app.post("/uploads", (req, res) => res.status(201).send({ ref: "a1" }));
app.post("/replies", (req, res) => res.status(200).send({ text: "..." }));
app.get("/profiles", (req, res) => res.send([]));
