import express from 'express';
import multer from 'multer';
import * as authController from '../controller/Auth.Controller.js';
import {
  authLoginBurst,
  authLoginWindow,
  authSignupBurst,
  authSignupWindow,
} from '../middleware/authRateLimit.js';
import { requireAuth } from '../middleware/authFirebase.js';
import { body } from 'express-validator';
import { validateRequest } from '../middleware/validator.js';

const router = express.Router();
// MED-04: Reduced to 50MB to prevent memory exhaustion
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 50 * 1024 * 1024 } });

const limitAuth = [authLoginBurst, authLoginWindow];
const limitSignup = [authSignupBurst, authSignupWindow];

// MED-08: Validation rules
const signupVal = [
  body('name').trim().notEmpty().withMessage('Name is required'),
  body('email').trim().isEmail().withMessage('Valid email is required'),
  body('password').isLength({ min: 8 }).withMessage('Password must be at least 8 characters'),
  validateRequest
];

const loginVal = [
  body('email').trim().isEmail().withMessage('Valid email is required'),
  body('password').notEmpty().withMessage('Password is required'),
  validateRequest
];

const googleVal = [
  body('idToken').notEmpty().withMessage('idToken is required'),
  validateRequest
];

const ageConsentVal = [
  body('dob').isISO8601().toDate().withMessage('Valid date of birth required'),
  body('consent').isBoolean().withMessage('Consent must be a boolean'),
  validateRequest
];

const approveCreatorVal = [
  body('user_id').notEmpty().withMessage('user_id is required'),
  body('approve').isBoolean().withMessage('approve must be a boolean'),
  validateRequest
];

router.post('/signup', ...limitSignup, signupVal, authController.signup);
router.post('/login', ...limitAuth, loginVal, authController.login);
router.post('/google', ...limitAuth, googleVal, authController.google);
router.post('/age-consent', ...limitAuth, ageConsentVal, authController.submitAgeConsent);

// Creator application endpoints
// Accept multipart/form-data for creator applications (forms + optional files).
// Use the same `upload` instance (memory storage) so files are available as `req.files`.
router.post('/apply-creator', ...limitAuth, upload.any(), authController.applyCreator);
router.post('/approve-creator', ...limitAuth, approveCreatorVal, authController.approveCreator);

// Media upload (multipart/form-data with field `file`)
router.post('/media/upload', requireAuth, upload.single('file'), authController.uploadMedia);

export default router;

// Multer-specific error handler for this router: return 413 for file/field size limits
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
