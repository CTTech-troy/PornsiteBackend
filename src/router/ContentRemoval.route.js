import express from "express";
import {
  createContentRemoval,
  getAllContentRemovals,
  getContentRemovalById,
  updateContentRemoval,
  deleteContentRemoval,
} from "../controller/ContentRemoval.controller.js";

const router = express.Router();

router.post("/", createContentRemoval);
router.get("/", getAllContentRemovals);
router.get("/:id", getContentRemovalById);
router.put("/:id", updateContentRemoval);
router.delete("/:id", deleteContentRemoval);

export default router;