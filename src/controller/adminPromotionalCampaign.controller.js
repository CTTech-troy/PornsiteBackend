import crypto from 'crypto';
import fs from 'fs';
import {
  IMAGE_BUCKET,
  VIDEO_BUCKET,
  getPublicUrl,
  uploadFileToBucket,
  isConfigured as isSupabaseConfigured,
} from '../config/supabase.js';
import {
  createPromotionalCampaign,
  deletePromotionalCampaign,
  listAdminPromotionalCampaigns,
  updatePromotionalCampaign,
} from '../services/promotionalCampaign.service.js';
import { scheduleMediaReplication } from '../services/mediaRedundancy.service.js';
import { writePlatformActivityEvent } from '../services/platformActivity.service.js';

function safeFileName(file) {
  const original = String(file?.originalname || 'asset.bin');
  const cleaned = original
    .replace(/[^\w.\-]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 160);
  return cleaned || 'asset.bin';
}

function firstFile(req, field) {
  const files = req.files?.[field];
  return Array.isArray(files) && files.length ? files[0] : null;
}

async function cleanupFiles(req) {
  const files = Object.values(req.files || {}).flat();
  await Promise.all(files.map((file) => (
    file?.path ? fs.promises.unlink(file.path).catch(() => null) : null
  )));
}

async function uploadCampaignMedia({ campaignId, file, type }) {
  if (!file) return null;
  if (!isSupabaseConfigured()) {
    const err = new Error('Storage is not configured');
    err.status = 503;
    throw err;
  }

  const bucket = type === 'video' ? VIDEO_BUCKET : IMAGE_BUCKET;
  const contentType = file.mimetype || (type === 'video' ? 'video/mp4' : 'image/jpeg');
  const storagePath = `promotions/${campaignId}/${Date.now()}-${safeFileName(file)}`;
  const data = await uploadFileToBucket(bucket, storagePath, file, contentType);
  const primaryUrl = getPublicUrl(bucket, data.path || storagePath);
  scheduleMediaReplication({
    sourceTable: 'promotional_campaigns',
    sourceId: campaignId,
    mediaType: type,
    primaryBucket: bucket,
    primaryPath: data.path || storagePath,
    primaryUrl,
    contentType,
  });
  return primaryUrl;
}

export async function listCampaigns(req, res) {
  try {
    const result = await listAdminPromotionalCampaigns();
    return res.json(result);
  } catch (err) {
    return res.status(err?.status || 500).json({ message: err?.message || 'Failed to load promotional campaigns' });
  }
}

export async function createCampaign(req, res) {
  try {
    const campaignId = crypto.randomUUID();
    const imageFile = firstFile(req, 'image');
    const videoFile = firstFile(req, 'video');
    const [imageUrl, videoUrl] = await Promise.all([
      uploadCampaignMedia({ campaignId, file: imageFile, type: 'image' }),
      uploadCampaignMedia({ campaignId, file: videoFile, type: 'video' }),
    ]);

    const campaign = await createPromotionalCampaign({
      ...req.body,
      id: campaignId,
      image_url: imageUrl || req.body?.image_url || req.body?.imageUrl || null,
      video_url: videoUrl || req.body?.video_url || req.body?.videoUrl || null,
    });

    await writePlatformActivityEvent({
      eventType: 'promotional_campaign_created',
      title: 'Promotional campaign created',
      message: campaign.title,
      actorId: req.admin?.user_id || req.admin?.sub || null,
      targetType: 'campaign',
      targetId: campaign.id,
    }).catch(() => null);

    return res.status(201).json({ campaign });
  } catch (err) {
    return res.status(err?.status || 500).json({ message: err?.message || 'Failed to create promotional campaign' });
  } finally {
    await cleanupFiles(req);
  }
}

export async function updateCampaign(req, res) {
  try {
    const { id } = req.params;
    if (!id) return res.status(400).json({ message: 'id is required' });

    const imageFile = firstFile(req, 'image');
    const videoFile = firstFile(req, 'video');
    const [imageUrl, videoUrl] = await Promise.all([
      uploadCampaignMedia({ campaignId: id, file: imageFile, type: 'image' }),
      uploadCampaignMedia({ campaignId: id, file: videoFile, type: 'video' }),
    ]);

    const patch = { ...req.body };
    if (imageUrl) patch.image_url = imageUrl;
    if (videoUrl) patch.video_url = videoUrl;
    const campaign = await updatePromotionalCampaign(id, patch);

    await writePlatformActivityEvent({
      eventType: 'promotional_campaign_updated',
      title: 'Promotional campaign updated',
      message: campaign.title,
      actorId: req.admin?.user_id || req.admin?.sub || null,
      targetType: 'campaign',
      targetId: campaign.id,
    }).catch(() => null);

    return res.json({ campaign });
  } catch (err) {
    return res.status(err?.status || 500).json({ message: err?.message || 'Failed to update promotional campaign' });
  } finally {
    await cleanupFiles(req);
  }
}

export async function deleteCampaign(req, res) {
  try {
    const { id } = req.params;
    if (!id) return res.status(400).json({ message: 'id is required' });
    const result = await deletePromotionalCampaign(id);
    await writePlatformActivityEvent({
      eventType: 'promotional_campaign_deleted',
      title: 'Promotional campaign deleted',
      actorId: req.admin?.user_id || req.admin?.sub || null,
      targetType: 'campaign',
      targetId: id,
    }).catch(() => null);
    return res.json(result);
  } catch (err) {
    return res.status(err?.status || 500).json({ message: err?.message || 'Failed to delete promotional campaign' });
  }
}

export async function toggleCampaign(req, res) {
  try {
    const { id } = req.params;
    const active = req.body?.active !== false && req.body?.active !== 'false';
    const campaign = await updatePromotionalCampaign(id, { active });
    await writePlatformActivityEvent({
      eventType: active ? 'promotional_campaign_enabled' : 'promotional_campaign_disabled',
      title: active ? 'Promotional campaign enabled' : 'Promotional campaign disabled',
      message: campaign.title,
      actorId: req.admin?.user_id || req.admin?.sub || null,
      targetType: 'campaign',
      targetId: campaign.id,
    }).catch(() => null);
    return res.json({ campaign });
  } catch (err) {
    return res.status(err?.status || 500).json({ message: err?.message || 'Failed to toggle promotional campaign' });
  }
}
