import rateLimit from 'express-rate-limit';

export const adminDeleteUserLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: Number(process.env.ADMIN_DELETE_USER_MAX_PER_MIN || 12),
  standardHeaders: true,
  legacyHeaders: false,
  message: {
    success: false,
    message: 'Too many delete requests. Please wait and try again.',
  },
});
