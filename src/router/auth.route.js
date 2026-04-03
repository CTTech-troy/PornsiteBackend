import express from 'express';
import multer from 'multer';
import * as authController from '../controller/Auth.Controller.js';
import {
  authLoginBurst,
  authLoginWindow,
  authSignupBurst,
  authSignupWindow,
  authMeLimiter,
} from '../middleware/authRateLimit.js';

const router = express.Router();
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 200 * 1024 * 1024 } });

const limitLogin = [authLoginBurst, authLoginWindow];
const limitSignup = [authSignupBurst, authSignupWindow];

router.get('/me', authMeLimiter, authController.me);
router.post('/signup', ...limitSignup, authController.signup);
router.post('/login', ...limitLogin, authController.login);
router.post('/google', ...limitLogin, authController.google);
router.post('/age-consent', authController.submitAgeConsent);

router.post('/apply-creator', upload.any(), authController.applyCreator);
router.post('/approve-creator', authController.approveCreator);

router.post('/media/upload', upload.single('file'), authController.uploadMedia);

export default router;

router.use((err, req, res, next) => {
	if (!err) return next();
	if (err.code === 'LIMIT_FILE_SIZE' || err.code === 'LIMIT_FIELD_VALUE' || err.code === 'LIMIT_PART_COUNT' || err.code === 'LIMIT_FIELD_KEY') {
		console.warn('Multer limit reached:', err.code, err.message);
		return res.status(413).json({ success: false, message: 'Payload too large' });
	}
	if (err.type === 'entity.too.large' || err.status === 413) {
		console.warn('Payload too large (body-parser):', err.message || err);
		return res.status(413).json({ success: false, message: 'Payload too large' });
	}
	return next(err);
});
