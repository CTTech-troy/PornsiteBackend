import { supabase } from '../config/supabase.js';
import { decryptApplicationData } from '../config/encrypt.js';

const CACHE_TTL_MS = 60_000;
const publicFieldsCache = new Map();

function cleanString(value) {
  return String(value || '').trim();
}

function firstUrl(...values) {
  for (const value of values) {
    const raw = cleanString(value);
    if (/^https?:\/\//i.test(raw)) return raw;
  }
  return '';
}

function safeDecryptApplicationData(data) {
  if (!data || typeof data !== 'object') return {};
  try {
    return decryptApplicationData(data) || data;
  } catch {
    return data;
  }
}

function creatorProfilePictureFromApplicationData(data) {
  const app = safeDecryptApplicationData(data);
  const creatorProfile = app.creatorProfile || app.creator_profile || {};
  const publicProfile = app.publicProfile || app.public_profile || {};
  return firstUrl(
    app.profilePicture,
    app.profile_picture,
    app.profilePhoto,
    app.profile_photo,
    app.creatorProfilePicture,
    app.creator_profile_picture,
    creatorProfile.profilePicture,
    creatorProfile.profile_picture,
    creatorProfile.avatarUrl,
    creatorProfile.avatar_url,
    publicProfile.profilePicture,
    publicProfile.profile_picture,
    publicProfile.avatarUrl,
    publicProfile.avatar_url,
  );
}

function creatorDisplayNameFromApplicationData(data) {
  const app = safeDecryptApplicationData(data);
  const creatorProfile = app.creatorProfile || app.creator_profile || {};
  const publicProfile = app.publicProfile || app.public_profile || {};
  return cleanString(
    app.stageName ||
    app.stage_name ||
    app.performerName ||
    app.performer_name ||
    app.channelName ||
    app.channel_name ||
    app.displayName ||
    app.display_name ||
    creatorProfile.stageName ||
    creatorProfile.stage_name ||
    creatorProfile.displayName ||
    creatorProfile.display_name ||
    publicProfile.displayName ||
    publicProfile.display_name,
  );
}

async function getUserPublicFields(uid) {
  try {
    const { data, error } = await supabase
      .from('users')
      .select('username, display_name, avatar, avatar_url, creator_application')
      .eq('id', uid)
      .maybeSingle();
    if (error) throw error;
    const appName = creatorDisplayNameFromApplicationData(data?.creator_application);
    const appProfilePicture = creatorProfilePictureFromApplicationData(data?.creator_application);
    return {
      name: cleanString(data?.display_name || data?.username || appName),
      profilePicture: appProfilePicture,
      avatar: firstUrl(data?.avatar_url, data?.avatar),
    };
  } catch {
    try {
      const { data, error } = await supabase
        .from('users')
        .select('username, display_name, avatar, avatar_url')
        .eq('id', uid)
        .maybeSingle();
      if (error) throw error;
      return {
        name: cleanString(data?.display_name || data?.username),
        profilePicture: '',
        avatar: firstUrl(data?.avatar_url, data?.avatar),
      };
    } catch {
      return { name: '', profilePicture: '', avatar: '' };
    }
  }
}

async function getMainApplicationPublicFields(uid) {
  try {
    const { data, error } = await supabase
      .from('creators_main_application')
      .select('full_name, profile_picture, status, approved, created_at, updated_at')
      .eq('user_id', uid)
      .not('profile_picture', 'is', null)
      .order('updated_at', { ascending: false })
      .order('created_at', { ascending: false })
      .limit(1)
      .maybeSingle();
    if (error) return { profilePicture: '', name: '' };
    return {
      profilePicture: firstUrl(data?.profile_picture),
      name: cleanString(data?.full_name),
    };
  } catch {
    return { profilePicture: '', name: '' };
  }
}

async function getLegacyApplicationPublicFields(uid) {
  try {
    const { data, error } = await supabase
      .from('creator_applications')
      .select('data, status, created_at')
      .eq('user_id', uid)
      .order('created_at', { ascending: false })
      .limit(5);
    if (error) return { profilePicture: '', name: '' };
    for (const row of data || []) {
      const profilePicture = creatorProfilePictureFromApplicationData(row?.data);
      const name = creatorDisplayNameFromApplicationData(row?.data);
      if (profilePicture || name) return { profilePicture, name };
    }
    return { profilePicture: '', name: '' };
  } catch {
    return { profilePicture: '', name: '' };
  }
}

async function resolveCreatorPublicFields(uid) {
  if (!uid || !supabase) return { creatorDisplayName: null, creatorAvatarUrl: null, creatorAvatarSource: null };
  const [user, mainApplication, legacyApplication] = await Promise.all([
    getUserPublicFields(uid),
    getMainApplicationPublicFields(uid),
    getLegacyApplicationPublicFields(uid),
  ]);
  const profilePicture = firstUrl(
    mainApplication.profilePicture,
    user.profilePicture,
    legacyApplication.profilePicture,
  );
  const avatar = profilePicture || user.avatar;
  return {
    creatorDisplayName: user.name || mainApplication.name || legacyApplication.name || null,
    creatorAvatarUrl: avatar || null,
    creatorAvatarSource: profilePicture ? 'profile_picture' : (user.avatar ? 'avatar' : null),
  };
}

export async function getCreatorPublicFields(uid) {
  const cacheKey = cleanString(uid);
  if (!cacheKey) return { creatorDisplayName: null, creatorAvatarUrl: null, creatorAvatarSource: null };
  const cached = publicFieldsCache.get(cacheKey);
  if (cached && Date.now() - cached.cachedAt < CACHE_TTL_MS) return cached.value;
  const value = await resolveCreatorPublicFields(cacheKey);
  publicFieldsCache.set(cacheKey, { cachedAt: Date.now(), value });
  return value;
}

function shouldUseResolvedProfilePicture(currentAvatar, resolved) {
  return resolved?.creatorAvatarSource === 'profile_picture'
    && resolved.creatorAvatarUrl
    && cleanString(currentAvatar) !== cleanString(resolved.creatorAvatarUrl);
}

export function invalidateCreatorPublicFields(uid = null) {
  if (uid) publicFieldsCache.delete(cleanString(uid));
  else publicFieldsCache.clear();
}

export async function mergeCreatorIntoPublicVideo(video) {
  if (!video?.userId) return video;
  const hasName = video.creatorDisplayName && cleanString(video.creatorDisplayName);
  const hasAvatar = video.creatorAvatarUrl && cleanString(video.creatorAvatarUrl);
  const resolved = await getCreatorPublicFields(video.userId);
  const useProfilePicture = shouldUseResolvedProfilePicture(video.creatorAvatarUrl, resolved);
  return {
    ...video,
    creatorDisplayName: hasName ? cleanString(video.creatorDisplayName) : (resolved.creatorDisplayName || null),
    creatorAvatarUrl: useProfilePicture
      ? resolved.creatorAvatarUrl
      : hasAvatar
        ? cleanString(video.creatorAvatarUrl)
        : (resolved.creatorAvatarUrl || null),
  };
}
