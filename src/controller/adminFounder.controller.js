import bcrypt from 'bcryptjs';
import { supabase } from '../config/supabase.js';

function normalizeEmail(email) {
  return String(email || '').trim().toLowerCase();
}

/**
 * Founder bootstrap endpoint.
 * Creates the first super admin in Supabase admin_users.
 * Security: requires header `x-admin-bootstrap-secret` matching env ADMIN_BOOTSTRAP_SECRET.
 * Only works if no super admin exists yet (one-shot protection).
 */
export async function createFounderAdmin(req, res) {
  try {
    const secretHeader = String(req.headers['x-admin-bootstrap-secret'] || '');
    const expected = String(process.env.ADMIN_BOOTSTRAP_SECRET || '');

    if (!expected) {
      return res.status(503).json({ message: 'ADMIN_BOOTSTRAP_SECRET is not configured on this server.' });
    }
    if (!secretHeader || secretHeader !== expected) {
      return res.status(401).json({ message: 'Invalid bootstrap secret.' });
    }

    const email = normalizeEmail(req.body?.email);
    const name = String(req.body?.name || '').trim() || 'Founder Admin';
    const password = String(req.body?.password || '');

    if (!email) return res.status(400).json({ message: 'Email is required' });
    if (!password || password.length < 8) {
      return res.status(400).json({ message: 'Password must be at least 8 characters' });
    }

    // Check if a super admin already exists (prevent accidental re-bootstrap)
    const { data: existing, error: checkErr } = await supabase
      .from('admin_users')
      .select('id')
      .eq('is_super_admin', true)
      .maybeSingle();

    if (checkErr) return res.status(500).json({ message: checkErr.message });
    if (existing?.id) {
      return res.status(409).json({ message: 'A super admin already exists. Use the invite flow to add more admins.' });
    }

    const password_hash = await bcrypt.hash(password, 12);

    const { data: created, error: insertErr } = await supabase
      .from('admin_users')
      .insert({
        name,
        email,
        password_hash,
        permissions: [],
        is_active: true,
        is_super_admin: true,
      })
      .select('id, email, name')
      .single();

    if (insertErr) return res.status(500).json({ message: insertErr.message });

    return res.status(201).json({
      message: 'Founder admin created successfully. You can now log in.',
      email: created.email,
      name: created.name,
    });
  } catch (err) {
    return res.status(500).json({ message: err?.message || String(err) });
  }
}
