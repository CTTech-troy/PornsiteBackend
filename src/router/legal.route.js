import { Router } from 'express';
import {
  acceptPublicLegalPolicy,
  getPublicLegalPolicy,
  getPublicLegalUpdates,
  listPublicLegalPolicies,
} from '../controller/legalDocument.controller.js';

const router = Router();

router.get('/documents', listPublicLegalPolicies);
router.get('/updates', getPublicLegalUpdates);
router.get('/documents/:slug', getPublicLegalPolicy);
router.post('/documents/:slug/accept', acceptPublicLegalPolicy);

export default router;
