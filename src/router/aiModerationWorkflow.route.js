import { Router } from 'express';
import { keepAliveAbuseLimiter, verifyQstashSignature } from '../middleware/qstashSignature.js';
import {
  aggregateAiModerationWorkflow,
  aiModerationWorkflowFailure,
  escalateAiModerationWorkflow,
  processAiModerationWorkflow,
  summarizeAiModerationWorkflow,
  trainAiModerationWorkflow,
} from '../controller/aiModeration.controller.js';

const router = Router();

router.use(keepAliveAbuseLimiter);
router.use(verifyQstashSignature);

router.post('/process', processAiModerationWorkflow);
router.post('/aggregate', aggregateAiModerationWorkflow);
router.post('/escalate', escalateAiModerationWorkflow);
router.post('/summary', summarizeAiModerationWorkflow);
router.post('/training', trainAiModerationWorkflow);
router.post('/failure', aiModerationWorkflowFailure);

export default router;
