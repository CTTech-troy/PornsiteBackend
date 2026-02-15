import express from 'express';
import multer from 'multer';
import * as authController from '../controller/Auth.Controller.js';

const router = express.Router();
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 200 * 1024 * 1024 } });

router.post('/signup', authController.signup);
router.post('/resend-verification', authController.resendVerification);
router.post('/login', authController.login);
router.post('/google', authController.google);
router.post('/verify-email', authController.verifyEmail);
router.post('/age-consent', authController.submitAgeConsent);

// Creator application endpoints
// Accept multipart/form-data for creator applications (forms + optional files).
// Use the same `upload` instance (memory storage) so files are available as `req.files`.
router.post('/apply-creator', upload.any(), authController.applyCreator);
router.post('/approve-creator', authController.approveCreator);

// Media upload (multipart/form-data with field `file`)
router.post('/media/upload', upload.single('file'), authController.uploadMedia);

export default router;
 
// Multer-specific error handler for this router: return 413 for file/field size limits
router.use((err, req, res, next) => {
	if (!err) return next();
	// Multer errors set `code` like 'LIMIT_FILE_SIZE', 'LIMIT_FIELD_VALUE', etc.
	if (err.code === 'LIMIT_FILE_SIZE' || err.code === 'LIMIT_FIELD_VALUE' || err.code === 'LIMIT_PART_COUNT' || err.code === 'LIMIT_FIELD_KEY') {
		console.warn('Multer limit reached:', err.code, err.message);
		return res.status(413).json({ success: false, message: 'Payload too large' });
	}
	// If it's a generic PayloadTooLargeError from body-parser
	if (err.type === 'entity.too.large' || err.status === 413) {
		console.warn('Payload too large (body-parser):', err.message || err);
		return res.status(413).json({ success: false, message: 'Payload too large' });
	}
	// Otherwise propagate
	return next(err);
});
