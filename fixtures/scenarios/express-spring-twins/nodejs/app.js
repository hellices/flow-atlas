require("module-alias/register");
const express = require("express");
const constants = require("@common/constants");
const eventRoutes = require("./routes/events");
const adminRoutes = require("./routes/admin");

const app = express();
app.use(express.json());

app.get(`${constants.API_PREFIX}/`, (req, res) => res.send("ok"));
app.use(`${constants.API_PREFIX}/events`, eventRoutes);
app.use(`${constants.API_PREFIX}/admin`, adminRoutes);

module.exports = app;
