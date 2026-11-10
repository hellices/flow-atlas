import express from "express";
import posts from "./posts.js";

const router = express.Router();

router.get("/", (req, res) => res.send("users"));
router.post("/", (req, res) => res.send("created"));
// The current user, before `/:id`: Express runs the first route whose path matches (expressjs.com/en/guide/routing.html).
router.get("/me", (req, res) => res.send("me"));
router
  .route("/:id")
  .get((req, res) => res.send("user"))
  .put((req, res) => res.send("replaced"))
  .delete((req, res) => res.send("deleted"));
router.use("/:userId/posts", posts);

export default router;
