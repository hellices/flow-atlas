import express from "express";

// Merged params: the user's id from the path the router is mounted on.
const router = express.Router({ mergeParams: true });

router.get("/", (req, res) => res.type("text").send(`posts of ${req.params.userId}`));
router.get("/:postId", (req, res) => res.send(req.params));

export default router;
