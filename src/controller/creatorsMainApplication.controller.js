import { supabase } from '../config/supabase.js';
import { sendApplicationDecisionEmail } from '../services/emailService.js';
import { v4 as uuidv4 } from 'uuid';

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

    // Validate required fields
    if (!fullName || !email || !bio) {
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
        bio,
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

    if (!fullName || !email || !bio) {
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
        bio,
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
    const offset = (page - 1) * limit;

    let query = supabase
      .from('creators_main_application')
      .select(`
        *,
        users!inner(username, email, avatar_url)
      `)
      .order('created_at', { ascending: false })
      .range(offset, offset + limit - 1);

    if (status) query = query.eq('status', status);
    if (search) query = query.ilike('full_name', `%${search}%`);

    const { data, error, count } = await query;
    if (error) throw error;

    return res.json({ success: true, applications: data, total: count, page: parseInt(page), limit: parseInt(limit) });
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
      .update({ creator: true, creator_status: 'approved' })
      .eq('id', app.user_id);

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