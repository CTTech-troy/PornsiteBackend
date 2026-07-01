import { Router } from 'express';
import {
  getPublicBlogPost,
  listPublicBlogPosts,
} from '../controller/blogPost.controller.js';

const router = Router();

router.get('/posts', listPublicBlogPosts);
router.get('/posts/:slug', getPublicBlogPost);

export default router;
