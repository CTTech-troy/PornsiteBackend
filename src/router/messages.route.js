import express from 'express';
import { requireAuth } from '../middleware/authFirebase.js';
import * as messagesCtrl from '../controller/messages.controller.js';

const router = express.Router();

router.post('/creators/:creatorId', requireAuth, messagesCtrl.sendMessageToCreator);
router.get('/conversations', requireAuth, messagesCtrl.listMyConversations);
router.get('/conversations/:conversationId/messages', requireAuth, messagesCtrl.getConversationMessages);
router.patch('/conversations/:conversationId/read', requireAuth, messagesCtrl.markConversationRead);

export default router;
