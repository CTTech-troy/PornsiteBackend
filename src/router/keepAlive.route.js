import express from 'express';
import {
  getKeepAliveStatus,
  handleKeepAlive,
  handleKeepAliveFailure,
} from '../controller/keepAlive.controller.js';
import { keepAliveAbuseLimiter, verifyQstashSignature } from '../middleware/qstashSignature.js';

const router = express.Router();

router.post('/', keepAliveAbuseLimiter, verifyQstashSignature, handleKeepAlive);
router.post('/failure', keepAliveAbuseLimiter, verifyQstashSignature, handleKeepAliveFailure);
router.get('/status', getKeepAliveStatus);

router.all('/', (_req, res) => {
  res.status(405).json({ success: false, message: 'Use POST for QStash keep-alive delivery.' });
});

router.all('/failure', (_req, res) => {
  res.status(405).json({ success: false, message: 'Use POST for QStash keep-alive failure callbacks.' });
});

export default router;
