import { supabase } from '../config/supabase.js';
import { sendApplicationDecisionEmail } from '../services/emailService.js';
import { v4 as uuidv4 } from 'uuid';

const MIN_CREATOR_AGE = 18;

function parseDateOfBirth(value) {
  const raw = String(value || '').trim();
  if (!raw) return null;
  const match = raw.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (match) {
    const [, year, month, day] = match;
    const dob = new Date(Number(year), Number(month) - 1, Number(day));
    if (
      dob.getFullYear() !== Number(year) ||
      dob.getMonth() !== Number(month) - 1 ||
      dob.getDate() !== Number(day)
    ) {
      return null;
    }
    return dob;
  }
  const dob = new Date(raw);
  return Number.isNaN(dob.getTime()) ? null : dob;
}

function calculateAge(value) {
  const dob = parseDateOfBirth(value);
  if (!dob) return null;
  const today = new Date();
  if (dob > today) return null;
  let age = today.getFullYear() - dob.getFullYear();
  const monthDiff = today.getMonth() - dob.getMonth();
  if (monthDiff < 0 || (monthDiff === 0 && today.getDate() < dob.getDate())) age -= 1;
  return age;
}

function normalizeDateOnly(value) {
  const dob = parseDateOfBirth(value);
  if (!dob) return '';
  const year = dob.getFullYear();
  const month = String(dob.getMonth() + 1).padStart(2, '0');
  const day = String(dob.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

function getRequestDob(body = {}) {
  return body.dateOfBirth || body.date_of_birth || body.dob || body.birthDate || body.birth_date || '';
}

function validateCreatorMinimumAge(body = {}) {
  const dobValue = getRequestDob(body);
  if (!dobValue) {
    return { ok: false, status: 400, message: 'Date of birth is required to apply as a creator.' };
  }
  const age = calculateAge(dobValue);
  if (age == null) {
    return { ok: false, status: 400, message: 'Enter a valid date of birth.' };
  }
  if (age < MIN_CREATOR_AGE) {
    return { ok: false, status: 403, message: `You must be at least ${MIN_CREATOR_AGE} years old to apply as a creator.` };
  }
  return { ok: true, age, dateOfBirth: normalizeDateOnly(dobValue) };
}

function isCreatorApplicationBanActive(ban) {
  if (!ban || typeof ban !== 'object' || ban.banned !== true) return false;
  if (!ban.expiresAt) return true;
  const expires = new Date(String(ban.expiresAt));
  return Number.isNaN(expires.getTime()) || expires > new Date();
}

async function ensureCanSubmitCreatorApplication(uid) {
  try {
    const { data } = await supabase
      .from('users')
      .select('creator_application_ban')
      .eq('id', uid)
      .maybeSingle();
    const ban = data?.creator_application_ban;
    if (isCreatorApplicationBanActive(ban)) {
      return {
        ok: false,
        status: 403,
        message: ban.expiresAt
          ? `You cannot submit a creator application until ${new Date(ban.expiresAt).toLocaleDateString()}.`
          : 'You are currently not allowed to submit a creator application.',
      };
    }
  } catch (_) {}
  return { ok: true };
}

const parseSocialLinks = (links) => {
  if (!links) return {};
  if (typeof links === 'string') {
    try {
      return JSON.parse(links);
    } catch {
      return {};
    }
  }
  return links;
};

const normalizeFiles = (files) => {
  if (!files) return [];
  if (Array.isArray(files)) return files;
  return Object.values(files).flat();
};

const isProfilePictureField = (fieldname) => ['profilePicture', 'profile_picture'].includes(fieldname);
const isPhotoField = (fieldname) => ['photos', 'uploaded_photos'].includes(fieldname);
const isVideoField = (fieldname) => ['videos', 'uploaded_videos'].includes(fieldname);

// ── Helper: Upload file to Supabase storage ────────────────────────────────
async function uploadToSupabase(file, userId, type) {
  const bucket = process.env.SUPABASE_CREATOR_BUCKET || 'creator_applications';
  const filename = `${userId}/${type}/${Date.now()}_${(file.originalname || 'file').replace(/[^a-zA-Z0-9._-]/g, '_')}`;
  const { data, error } = await supabase.storage.from(bucket).upload(filename, file.buffer, { contentType: file.mimetype });
  if (error) throw new Error(`Upload failed: ${error.message}`);
  const baseUrl = (process.env.SUPABASE_URL || '').replace(/\/$/, '');
  return `${baseUrl}/storage/v1/object/public/${bucket}/${encodeURIComponent(data.path)}`;
}

// ── POST /api/creators-main-application/submit ─────────────────────────────
export async function submitApplication(req, res) {
  try {
    const uid = req.uid;
    if (!uid) return res.status(401).json({ success: false, message: 'Authentication required' });

    const banGate = await ensureCanSubmitCreatorApplication(uid);
    if (!banGate.ok) return res.status(banGate.status).json({ success: false, message: banGate.message });

    // Check if user has a pending application
    const { data: existing } = await supabase
      .from('creators_main_application')
      .select('id')
      .eq('user_id', uid)
      .eq('status', 'pending')
      .maybeSingle();
    if (existing) return res.status(400).json({ success: false, message: 'You already have a pending application' });

    const fullName = req.body.fullName || req.body.full_name;
    const email = req.body.email;
    const phone = req.body.phone;
    const country = req.body.country;
    const state = req.body.state;
    const city = req.body.city;
    const bio = req.body.bio;
    const category = req.body.category;
    const experience = req.body.experience;
    const socialLinks = parseSocialLinks(req.body.socialLinks || req.body.social_links);
    const ageGate = validateCreatorMinimumAge(req.body);
    if (!ageGate.ok) {
      return res.status(ageGate.status).json({ success: false, message: ageGate.message });
    }

    // Validate required fields
    if (!fullName || !email) {
      return res.status(400).json({ success: false, message: 'Missing required fields' });
    }

    // Handle uploads
    let profilePicture = null;
    const uploadedPhotos = [];
    const uploadedVideos = [];

    const files = normalizeFiles(req.files);
    if (files.length > 0) {
      for (const file of files) {
        if (isProfilePictureField(file.fieldname)) {
          profilePicture = await uploadToSupabase(file, uid, 'profile');
        } else if (isPhotoField(file.fieldname)) {
          const url = await uploadToSupabase(file, uid, 'photos');
          uploadedPhotos.push(url);
        } else if (isVideoField(file.fieldname)) {
          const url = await uploadToSupabase(file, uid, 'videos');
          uploadedVideos.push(url);
        }
      }
    }

    // Insert application
    const { data, error } = await supabase
      .from('creators_main_application')
      .insert({
        user_id: uid,
        full_name: fullName,
        email,
        phone,
        country,
        state,
        city,
        date_of_birth: ageGate.dateOfBirth,
        age_verified: true,
        bio: bio || '',
        social_links: socialLinks || {},
        category,
        experience,
        profile_picture: profilePicture,
        uploaded_photos: uploadedPhotos,
        uploaded_videos: uploadedVideos,
        status: 'pending',
        approved: false,
        rejected: false
      })
      .select()
      .single();

    if (error) throw error;

    // Send email
    await sendApplicationDecisionEmail({
      to: email,
      name: fullName,
      status: 'submitted',
      reason: 'Your application has been submitted successfully.'
    });

    return res.status(201).json({ success: true, message: 'Application submitted', application: data });
  } catch (err) {
    console.error('Submit application error:', err);
    return res.status(500).json({ success: false, message: err.message });
  }
}

// ── GET /api/creators-main-application/my ───────────────────────────────────
export async function getMyApplications(req, res) {
  try {
    const uid = req.uid;
    if (!uid) return res.status(401).json({ success: false, message: 'Authentication required' });

    const { data, error } = await supabase
      .from('creators_main_application')
      .select('*')
      .eq('user_id', uid)
      .order('created_at', { ascending: false });

    if (error) throw error;

    const application = Array.isArray(data) ? data[0] || null : data;
    return res.json({ success: true, application });
  } catch (err) {
    return res.status(500).json({ success: false, message: err.message });
  }
}

// ── POST /api/creators-main-application/reapply ────────────────────────────
export async function reapplyApplication(req, res) {
  try {
    const uid = req.uid;
    if (!uid) return res.status(401).json({ success: false, message: 'Authentication required' });

    const banGate = await ensureCanSubmitCreatorApplication(uid);
    if (!banGate.ok) return res.status(banGate.status).json({ success: false, message: banGate.message });

    // Check if user has a pending application
    const { data: existing } = await supabase
      .from('creators_main_application')
      .select('id')
      .eq('user_id', uid)
      .eq('status', 'pending')
      .maybeSingle();
    if (existing) return res.status(400).json({ success: false, message: 'You already have a pending application' });

    // Similar to submit, but for reapply
    const fullName = req.body.fullName || req.body.full_name;
    const email = req.body.email;
    const phone = req.body.phone;
    const country = req.body.country;
    const state = req.body.state;
    const city = req.body.city;
    const bio = req.body.bio;
    const category = req.body.category;
    const experience = req.body.experience;
    const socialLinks = parseSocialLinks(req.body.socialLinks || req.body.social_links);
    const ageGate = validateCreatorMinimumAge(req.body);
    if (!ageGate.ok) {
      return res.status(ageGate.status).json({ success: false, message: ageGate.message });
    }

    if (!fullName || !email) {
      return res.status(400).json({ success: false, message: 'Missing required fields' });
    }

    // Handle uploads
    let profilePicture = null;
    const uploadedPhotos = [];
    const uploadedVideos = [];

    const files = normalizeFiles(req.files);
    if (files.length > 0) {
      for (const file of files) {
        if (isProfilePictureField(file.fieldname)) {
          profilePicture = await uploadToSupabase(file, uid, 'profile');
        } else if (isPhotoField(file.fieldname)) {
          const url = await uploadToSupabase(file, uid, 'photos');
          uploadedPhotos.push(url);
        } else if (isVideoField(file.fieldname)) {
          const url = await uploadToSupabase(file, uid, 'videos');
          uploadedVideos.push(url);
        }
      }
    }

    // Insert new application
    const { data, error } = await supabase
      .from('creators_main_application')
      .insert({
        user_id: uid,
        full_name: fullName,
        email,
        phone,
        country,
        state,
        city,
        date_of_birth: ageGate.dateOfBirth,
        age_verified: true,
        bio: bio || '',
        social_links: socialLinks || {},
        category,
        experience,
        profile_picture: profilePicture,
        uploaded_photos: uploadedPhotos,
        uploaded_videos: uploadedVideos,
        status: 'pending',
        approved: false,
        rejected: false
      })
      .select()
      .single();

    if (error) throw error;

    // Send email
    await sendApplicationDecisionEmail({
      to: email,
      name: fullName,
      status: 'reapplied',
      reason: 'Your reapplication has been submitted successfully.'
    });

    return res.status(201).json({ success: true, message: 'Reapplication submitted', application: data });
  } catch (err) {
    console.error('Reapply application error:', err);
    return res.status(500).json({ success: false, message: err.message });
  }
}

// ── GET /api/admin/creators-main-application ───────────────────────────────
export async function getApplications(req, res) {
  try {
    const { search = '', status = '', page = 1, limit = 10 } = req.query;
    const pageNum = Math.max(1, parseInt(String(page), 10) || 1);
    const limitNum = Math.min(100, Math.max(1, parseInt(String(limit), 10) || 10));
    const offset = (pageNum - 1) * limitNum;

    let query = supabase
      .from('creators_main_application')
      .select(`
        *,
        users(username, email, avatar_url)
      `, { count: 'exact' })
      .order('created_at', { ascending: false })
      .range(offset, offset + limitNum - 1);

    if (status) query = query.eq('status', status);
    if (search) query = query.ilike('full_name', `%${search}%`);

    const { data, error, count } = await query;
    if (error) throw error;

    return res.json({ success: true, applications: data || [], total: count || 0, page: pageNum, limit: limitNum });
  } catch (err) {
    return res.status(500).json({ success: false, message: err.message });
  }
}

// ── GET /api/admin/creators-main-application/:id ───────────────────────────
export async function getApplicationById(req, res) {
  try {
    const { id } = req.params;

    const { data, error } = await supabase
      .from('creators_main_application')
      .select(`
        *,
        users!inner(username, email, avatar_url)
      `)
      .eq('id', id)
      .single();

    if (error) throw error;
    if (!data) return res.status(404).json({ success: false, message: 'Application not found' });

    return res.json({ success: true, application: data });
  } catch (err) {
    return res.status(500).json({ success: false, message: err.message });
  }
}

// ── PUT /api/admin/creators-main-application/:id/approve ───────────────────
export async function approveApplication(req, res) {
  try {
    const { id } = req.params;
    const { reason = '' } = req.body;

    const { data: app, error: fetchError } = await supabase
      .from('creators_main_application')
      .select('*')
      .eq('id', id)
      .single();

    if (fetchError) throw fetchError;
    if (!app) return res.status(404).json({ success: false, message: 'Application not found' });

    // Update application
    const { error: updateError } = await supabase
      .from('creators_main_application')
      .update({
        status: 'approved',
        approved: true,
        rejected: false,
        rejection_reason: null
      })
      .eq('id', id);

    if (updateError) throw updateError;

    // Update user as creator
    await supabase
      .from('users')
      .update({ creator: true, verified: 'approved', role: 'creator' })
      .eq('id', app.user_id);

    await supabase
      .from('creators')
      .upsert({
        user_id: app.user_id,
        display_name: app.full_name,
        bio: app.bio || '',
        creator_type: app.creator_type === 'channel' ? 'channel' : 'pstar',
        active: true,
        status: 'active',
        application_id: app.id,
        updated_at: new Date().toISOString(),
      }, { onConflict: 'user_id' });

    // Send email
    await sendApplicationDecisionEmail({
      to: app.email,
      name: app.full_name,
      status: 'approved',
      reason
    });

    return res.json({ success: true, message: 'Application approved' });
  } catch (err) {
    console.error('Approve application error:', err);
    return res.status(500).json({ success: false, message: err.message });
  }
}

// ── PUT /api/admin/creators-main-application/:id/reject ────────────────────
export async function rejectApplication(req, res) {
  try {
    const { id } = req.params;
    const { reason } = req.body;

    if (!reason) return res.status(400).json({ success: false, message: 'Rejection reason required' });

    const { data: app, error: fetchError } = await supabase
      .from('creators_main_application')
      .select('*')
      .eq('id', id)
      .single();

    if (fetchError) throw fetchError;
    if (!app) return res.status(404).json({ success: false, message: 'Application not found' });

    // Update application
    const { error: updateError } = await supabase
      .from('creators_main_application')
      .update({
        status: 'rejected',
        approved: false,
        rejected: true,
        rejection_reason: reason
      })
      .eq('id', id);

    if (updateError) throw updateError;

    await supabase
      .from('users')
      .update({ creator: false, verified: 'rejected', role: 'user' })
      .eq('id', app.user_id);

    // Send email
    await sendApplicationDecisionEmail({
      to: app.email,
      name: app.full_name,
      status: 'rejected',
      reason
    });

    return res.json({ success: true, message: 'Application rejected' });
  } catch (err) {
    console.error('Reject application error:', err);
    return res.status(500).json({ success: false, message: err.message });
  }
}
