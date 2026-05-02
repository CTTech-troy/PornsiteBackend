import crypto from 'crypto';
import { supabase, isConfigured } from '../config/supabase.js';
import { sendOTPEmail } from './emailService.js';

export function generateOTP() {
  return crypto.randomInt(100000, 1000000);
}

export async function storeOTP(uid, email, otp, purpose = 'login') {
  if (!isConfigured() || !supabase) throw new Error('Database not configured');

  const otpHash  = crypto.createHash('sha256').update(String(otp)).digest('hex');
  const expiresAt = new Date(Date.now() + 5 * 60 * 1000); // 5 minutes

  // Invalidate any existing unused OTPs for this user+purpose
  await supabase
    .from('otp_codes')
    .update({ used_at: new Date().toISOString() })
    .eq('user_id', uid)
    .eq('purpose', purpose)
    .is('used_at', null);

  const { error } = await supabase.from('otp_codes').insert({
    user_id:    uid,
    email,
    otp_hash:   otpHash,
    purpose,
    expires_at: expiresAt.toISOString(),
  });

  if (error) throw new Error(`Failed to store OTP: ${error.message}`);
}

export async function verifyOTP(email, otp, purpose = 'login') {
  if (!isConfigured() || !supabase) throw new Error('Database not configured');

  const otpHash = crypto.createHash('sha256').update(String(otp)).digest('hex');

  const { data: record, error } = await supabase
    .from('otp_codes')
    .select('*')
    .eq('email', email.trim().toLowerCase())
    .eq('otp_hash', otpHash)
    .eq('purpose', purpose)
    .is('used_at', null)
    .order('created_at', { ascending: false })
    .limit(1)
    .maybeSingle();

  if (error || !record) return { valid: false, reason: 'Invalid OTP.' };
  if (new Date(record.expires_at) < new Date()) return { valid: false, reason: 'OTP has expired.' };

  await supabase
    .from('otp_codes')
    .update({ used_at: new Date().toISOString() })
    .eq('id', record.id);

  return { valid: true, uid: record.user_id };
}

export async function sendOTPToUser(uid, email) {
  const otp = generateOTP();
  await storeOTP(uid, email, otp, 'login');
  await sendOTPEmail(email, otp);
}
