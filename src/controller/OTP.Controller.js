import { sendOTPToUser, verifyOTP } from '../services/otpService.js';
import { getFirebaseAuth } from '../config/firebase.js';
import { mintSessionToken } from '../utils/sessionToken.js';

export async function sendOTP(req, res) {
  try {
    const { email } = req.body;
    if (!email || typeof email !== 'string' || !email.includes('@')) {
      return res.status(400).json({ success: false, message: 'Valid email is required.' });
    }

    const emailNorm = email.trim().toLowerCase();
    const auth = getFirebaseAuth();
    if (!auth) {
      return res.status(503).json({ success: false, message: 'Auth service temporarily unavailable.' });
    }

    let uid;
    try {
      const userRecord = await auth.getUserByEmail(emailNorm);
      uid = userRecord.uid;
    } catch {
      // Don't reveal whether the email exists
      return res.status(200).json({ success: true, message: 'If this email is registered, an OTP has been sent.' });
    }

    try {
      await sendOTPToUser(uid, emailNorm);
    } catch (err) {
      console.error('[otp] sendOTPToUser failed:', err?.message || err);
      return res.status(500).json({ success: false, message: 'Failed to send OTP. Please try again.' });
    }

    return res.status(200).json({ success: true, message: 'OTP sent. Please check your email.' });
  } catch (err) {
    console.error('[otp] sendOTP error:', err);
    return res.status(500).json({ success: false, message: 'Failed to send OTP.' });
  }
}

export async function verifyOTPHandler(req, res) {
  try {
    const { email, otp } = req.body;
    if (!email || typeof email !== 'string' || !email.includes('@')) {
      return res.status(400).json({ success: false, message: 'Valid email is required.' });
    }
    if (!otp) {
      return res.status(400).json({ success: false, message: 'OTP is required.' });
    }

    const emailNorm = email.trim().toLowerCase();
    const result = await verifyOTP(emailNorm, String(otp).trim(), 'login');

    if (!result.valid) {
      return res.status(400).json({ success: false, message: result.reason });
    }

    const sessionToken = mintSessionToken(result.uid, emailNorm);
    return res.status(200).json({
      success: true,
      message: 'OTP verified successfully.',
      uid: result.uid,
      ...(sessionToken && { sessionToken }),
    });
  } catch (err) {
    console.error('[otp] verifyOTP error:', err);
    return res.status(500).json({ success: false, message: 'Failed to verify OTP.' });
  }
}
