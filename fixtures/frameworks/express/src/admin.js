import express from "express";

// A sub-application mounted on the main one (expressjs.com/en/api.html#app.mountpath).
const admin = express();

admin.get("/dashboard", (req, res) => res.send("dashboard"));
admin.delete("/cache", (req, res) => res.send("cleared"));

export default admin;
