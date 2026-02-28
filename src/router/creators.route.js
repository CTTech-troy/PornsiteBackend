import express from 'express';
import { getCreatorsList, getCreatorBySlug } from '../controller/creators.controller.js';

const router = express.Router();

// GET /api/creators — list all, sorted by rankingScore desc
router.get('/', getCreatorsList);
// GET /api/creators/:slug — profile + videos for one creator
router.get('/:slug', getCreatorBySlug);

export default router;
