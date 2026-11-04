const express = require("express");
const controller = require("../controllers/events");

const router = express.Router();

router.get("/opt_out", controller.optOut);
router.post("/page_view", controller.pageView);
router.post("/click", controller.click);
router.post("/session", controller.session);
router.post("/consent", controller.consent);

module.exports = router;
