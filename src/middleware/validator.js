import { validationResult } from 'express-validator';

/**
 * Middleware to check for express-validator errors and return them cleanly.
 */
export function validateRequest(req, res, next) {
  const errors = validationResult(req);
  if (!errors.isEmpty()) {
    // MED-08: Reject malformed requests proactively
    return res.status(400).json({
      success: false,
      message: 'Validation failed',
      errors: errors.array(),
    });
  }
  next();
}
