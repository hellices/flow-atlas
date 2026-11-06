const { Router } = require("express");

const admin = Router();
admin.post("/reload", (req, res) => res.send("reloaded"));

module.exports = admin;
