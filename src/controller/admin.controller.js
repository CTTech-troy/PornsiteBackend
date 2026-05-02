import crypto from 'crypto';
import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import { supabase } from '../config/supabase.js';
import { sendAdminInviteEmail } from '../services/emailService.js';
import { sendVerificationEmail } from '../services/emailService.js';

function normalizeEmail(email) {
  return String(email || '').trim().toLowerCase();
}

function signAdminJwt(payload) {
  return jwt.sign(payload, process.env.ADMIN_JWT_SECRET || 'admin-secret-fallback', { expiresIn: '8h' });
}

function generateNumericCode() {
  // 6-digit numeric code (keeps "some numbers" requirement)
  return String(Math.floor(100000 + Math.random() * 900000));
}

function sha256Hex(value) {
  return crypto.createHash('sha256').update(String(value)).digest('hex');
}

export async function signupAdmin(req, res) {
  try {
    const name = String(req.body?.name || '').trim();
    const email = normalizeEmail(req.body?.email);
    const password = String(req.body?.password || '');

    if (!name) return res.status(400).json({ message: 'Full name is required' });
    if (!email) return res.status(400).json({ message: 'Email is required' });
    if (!password || password.length < 8) return res.status(400).json({ message: 'Password must be at least 8 characters' });

    const { data: existing, error: existsErr } = await supabase
      .from('admin_users')
      .select('id')
      .eq('email', email)
      .maybeSingle();
    if (existsErr) return res.status(500).json({ message: existsErr.message });
    if (existing?.id) return res.status(409).json({ message: 'Admin user already exists' });

    const password_hash = await bcrypt.hash(password, 12);

    const { data: created, error: insertErr } = await supabase.from('admin_users').insert({
      name,
      email,
      password_hash,
      permissions: ['/'],
      is_active: false,
      is_super_admin: false,
    }).select('id,email,name').single();
    if (insertErr) return res.status(500).json({ message: insertErr.message });

    const uid = created?.id;
    if (!uid) return res.status(500).json({ message: 'Failed to create admin user id' });

    const code = generateNumericCode();
    const code_hash = sha256Hex(`${uid}:${code}`);
    const expires_at = new Date(Date.now() + 15 * 60 * 1000).toISOString(); // 15 minutes

    const { error: codeErr } = await supabase.from('admin_activation_codes').insert({
      admin_user_id: uid,
      code_hash,
      expires_at,
    });
    if (codeErr) return res.status(500).json({ message: codeErr.message });

    const mainUrl = (process.env.FRONTEND_URL || 'http://localhost:5173').replace(/\/$/, '');
    // Link includes domain + uid + numeric code
    const confirmationUrl = `${mainUrl}/admin-activate?uid=${encodeURIComponent(uid)}&code=${encodeURIComponent(code)}`;
    console.log('[admin-signup] confirmation link:', confirmationUrl);

    // Send link to main site for confirmation (requested)
    try {
      await sendVerificationEmail({ to: email, name, verificationUrl: confirmationUrl });
    } catch (err) {
      console.warn('[admin-signup] email failed:', err?.message || err);
    }

    return res.status(201).json({
      message: 'Account created. Confirmation link sent.',
      confirmationUrl,
    });
  } catch (err) {
    return res.status(500).json({ message: err?.message || String(err) });
  }
}

export async function activateAdmin(req, res) {
  try {
    const uid = String(req.body?.uid || '').trim();
    const code = String(req.body?.code || '').trim();
    if (!uid || !code) return res.status(400).json({ message: 'uid and code are required' });

    const code_hash = sha256Hex(`${uid}:${code}`);
    const { data: row, error } = await supabase
      .from('admin_activation_codes')
      .select('id,admin_user_id,expires_at,used_at')
      .eq('code_hash', code_hash)
      .maybeSingle();
    if (error) return res.status(500).json({ message: error.message });
    if (!row) return res.status(404).json({ message: 'Invalid activation code' });
    if (row.used_at) return res.status(410).json({ message: 'Activation code already used' });
    if (new Date(row.expires_at).getTime() < Date.now()) return res.status(410).json({ message: 'Activation code expired' });
    if (String(row.admin_user_id) !== uid) return res.status(400).json({ message: 'Activation code mismatch' });

    const nowIso = new Date().toISOString();
    const { error: upErr } = await supabase.from('admin_users').update({ is_active: true }).eq('id', uid);
    if (upErr) return res.status(500).json({ message: upErr.message });
    await supabase.from('admin_activation_codes').update({ used_at: nowIso }).eq('id', row.id);

    return res.json({ message: 'Admin account activated. You can now log in.' });
  } catch (err) {
    return res.status(500).json({ message: err?.message || String(err) });
  }
}

export async function loginAdmin(req, res) {
  try {
    const email = normalizeEmail(req.body?.email);
    const password = String(req.body?.password || '');

    if (!email || !password) return res.status(400).json({ message: 'Email and password are required' });

    const { data: user, error } = await supabase
      .from('admin_users')
      .select('id,name,email,password_hash,is_super_admin,permissions,is_active')
      .eq('email', email)
      .eq('is_active', true)
      .maybeSingle();

    if (error) return res.status(500).json({ message: error.message });
    if (!user || !user.password_hash) return res.status(401).json({ message: 'Invalid email or password' });

    const ok = await bcrypt.compare(password, user.password_hash);
    if (!ok) return res.status(401).json({ message: 'Invalid email or password' });

    await supabase.from('admin_users').update({ last_login: new Date().toISOString() }).eq('id', user.id);

    const token = signAdminJwt({
      id: user.id,
      email: user.email,
      is_super_admin: !!user.is_super_admin,
      permissions: Array.isArray(user.permissions) ? user.permissions : [],
    });

    return res.json({
      token,
      user: {
        id: user.id,
        name: user.name,
        email: user.email,
        is_super_admin: !!user.is_super_admin,
        permissions: Array.isArray(user.permissions) ? user.permissions : [],
      },
    });
  } catch (err) {
    return res.status(500).json({ message: err?.message || String(err) });
  }
}

export async function inviteAdmin(req, res) {
  try {
    const email = normalizeEmail(req.body?.email);
    const name = req.body?.name ? String(req.body.name).trim() : null;
    const permissions = req.body?.permissions;

    if (!email) return res.status(400).json({ message: 'Email is required' });
    if (!Array.isArray(permissions) || permissions.length === 0) {
      return res.status(400).json({ message: 'Permissions must be a non-empty array' });
    }

    const { data: existing, error: existsErr } = await supabase
      .from('admin_users')
      .select('id')
      .eq('email', email)
      .maybeSingle();

    if (existsErr) return res.status(500).json({ message: existsErr.message });
    if (existing?.id) return res.status(409).json({ message: 'Admin user already exists' });

    const token = crypto.randomBytes(32).toString('hex');
    const token_hash = crypto.createHash('sha256').update(token).digest('hex');
    const expires_at = new Date(Date.now() + 10 * 60 * 1000).toISOString();

    const { error: insertErr } = await supabase.from('admin_invites').insert({
      email,
      name,
      permissions,
      token_hash,
      expires_at,
      created_by: req.admin?.id ?? null,
    });

    if (insertErr) return res.status(500).json({ message: insertErr.message });

    const inviteUrl = `${process.env.ADMIN_FRONTEND_URL || 'http://localhost:5174'}/invite/complete?token=${token}`;
    await sendAdminInviteEmail({ to: email, name, inviteUrl, permissions });

    return res.json({ message: 'Invite sent successfully' });
  } catch (err) {
    return res.status(500).json({ message: err?.message || String(err) });
  }
}

export async function verifyInviteToken(req, res) {
  try {
    const token = String(req.params?.token || '').trim();
    if (!token) return res.status(400).json({ message: 'Token is required' });

    const token_hash = crypto.createHash('sha256').update(token).digest('hex');
    const { data: invite, error } = await supabase
      .from('admin_invites')
      .select('id,email,name,permissions,expires_at,used_at')
      .eq('token_hash', token_hash)
      .maybeSingle();

    if (error) return res.status(500).json({ message: error.message });
    if (!invite) return res.status(404).json({ error: 'invalid_token', message: 'Invitation not found' });
    if (invite.used_at) return res.status(410).json({ error: 'used_token', message: 'This invitation has already been used' });

    const expiresAtMs = new Date(invite.expires_at).getTime();
    if (Number.isFinite(expiresAtMs) && expiresAtMs < Date.now()) {
      return res.status(410).json({
        error: 'expired_token',
        message: 'This invitation link has expired. Please contact the admin for a new invite.',
      });
    }

    return res.json({
      email: invite.email,
      name: invite.name,
      permissions: Array.isArray(invite.permissions) ? invite.permissions : [],
    });
  } catch (err) {
    return res.status(500).json({ message: err?.message || String(err) });
  }
}

export async function completeInvite(req, res) {
  try {
    const token = String(req.body?.token || '').trim();
    const name = String(req.body?.name || '').trim();
    const password = String(req.body?.password || '');
    const confirmPassword = String(req.body?.confirmPassword || '');

    if (!token || !name || !password || !confirmPassword) {
      return res.status(400).json({ message: 'All fields are required' });
    }
    if (password !== confirmPassword) return res.status(400).json({ message: 'Passwords do not match' });
    if (password.length < 8) return res.status(400).json({ message: 'Password must be at least 8 characters' });

    const token_hash = crypto.createHash('sha256').update(token).digest('hex');
    const { data: invite, error } = await supabase
      .from('admin_invites')
      .select('id,email,name,permissions,expires_at,used_at')
      .eq('token_hash', token_hash)
      .maybeSingle();

    if (error) return res.status(500).json({ message: error.message });
    if (!invite) return res.status(404).json({ error: 'invalid_token', message: 'Invitation not found' });
    if (invite.used_at) return res.status(410).json({ error: 'used_token', message: 'This invitation has already been used' });

    const expiresAtMs = new Date(invite.expires_at).getTime();
    if (Number.isFinite(expiresAtMs) && expiresAtMs < Date.now()) {
      return res.status(410).json({
        error: 'expired_token',
        message: 'This invitation link has expired. Please contact the admin for a new invite.',
      });
    }

    const password_hash = await bcrypt.hash(password, 12);

    const { error: insertErr } = await supabase.from('admin_users').insert({
      name,
      email: invite.email,
      password_hash,
      permissions: Array.isArray(invite.permissions) ? invite.permissions : [],
      is_active: true,
      is_super_admin: false,
    });

    if (insertErr) {
      if (String(insertErr.message || '').toLowerCase().includes('duplicate')) {
        return res.status(409).json({ message: 'An admin account with this email already exists' });
      }
      return res.status(500).json({ message: insertErr.message });
    }

    await supabase.from('admin_invites').update({ used_at: new Date().toISOString() }).eq('id', invite.id);

    return res.json({ message: 'Account created successfully. You can now log in.' });
  } catch (err) {
    return res.status(500).json({ message: err?.message || String(err) });
  }
}

export async function listAdminUsers(req, res) {
  try {
    const { data: users, error } = await supabase
      .from('admin_users')
      .select('id,name,email,permissions,is_active,is_super_admin,last_login,created_at')
      .order('created_at', { ascending: false });

    if (error) return res.status(500).json({ message: error.message });
    return res.json({ users: users || [] });
  } catch (err) {
    return res.status(500).json({ message: err?.message || String(err) });
  }
}

export async function deleteAdminUser(req, res) {
  try {
    const id = String(req.params?.id || '').trim();
    if (!id) return res.status(400).json({ message: 'User id is required' });
    if (req.admin?.id === id) return res.status(400).json({ message: 'You cannot delete yourself' });

    const { error } = await supabase.from('admin_users').delete().eq('id', id);
    if (error) return res.status(500).json({ message: error.message });
    return res.json({ message: 'User deleted' });
  } catch (err) {
    return res.status(500).json({ message: err?.message || String(err) });
  }
}

export async function updateUserPermissions(req, res) {
  try {
    const id = String(req.params?.id || '').trim();
    const permissions = req.body?.permissions;
    if (!id) return res.status(400).json({ message: 'User id is required' });
    if (!Array.isArray(permissions)) return res.status(400).json({ message: 'Permissions must be an array' });

    const { error } = await supabase.from('admin_users').update({ permissions }).eq('id', id);
    if (error) return res.status(500).json({ message: error.message });
    return res.json({ message: 'Permissions updated' });
  } catch (err) {
    return res.status(500).json({ message: err?.message || String(err) });
  }
}
