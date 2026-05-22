import { decryptApplicationData } from '../config/encrypt.js';

function pickString(...values) {
  for (const value of values) {
    if (value == null) continue;
    const text = String(value).trim();
    if (text) return text;
  }
  return '';
}

function socialLinksFromData(data = {}) {
  const links = {};
  const map = {
    instagram: data.instagramUrl || data.instagram,
    x: data.xUrl || data.twitterUrl || data.twitter,
    tiktok: data.tiktokUrl || data.tiktok,
    youtube: data.youtubeUrl || data.youtube,
    website: data.websiteUrl || data.website,
  };
  Object.entries(map).forEach(([key, url]) => {
    if (url && String(url).trim()) links[key] = String(url).trim();
  });
  return links;
}

export function normalizeCreatorApplicationKyc(application, creator = null) {
  if (!application) return null;

  let data = {};
  try {
    data = decryptApplicationData(application.data || {});
  } catch {
    data = application.data && typeof application.data === 'object' ? application.data : {};
  }

  const fullName =
    pickString(
      [data.firstName, data.lastName].filter(Boolean).join(' '),
      data.displayName,
      data.fullName,
      data.stageName,
    ) || pickString(creator?.display_name, creator?.username);

  const attachments = Array.isArray(data.attachments) ? data.attachments : [];
  const photos = attachments.filter((f) => String(f.contentType || '').startsWith('image/'));
  const videos = attachments.filter((f) => String(f.contentType || '').startsWith('video/'));

  return {
    applicationId: application.id,
    applicationStatus: application.status || 'unknown',
    submittedAt: application.created_at || null,
    reviewedAt: application.reviewed_at || application.decision_at || null,
    reviewReason: application.review_reason || null,
    fullName,
    email: pickString(data.email, creator?.email),
    phone: pickString(data.phone, creator?.phone),
    dateOfBirth: pickString(data.dateOfBirth, data.dob),
    gender: pickString(data.gender),
    country: pickString(data.country),
    state: pickString(data.state),
    city: pickString(data.city, data.lga),
    streetAddress: pickString(data.streetAddress, data.address),
    addressLine2: pickString(data.addressLine2, data.houseDetails),
    postalCode: pickString(data.postalCode),
    idType: pickString(data.idType),
    idNumber: pickString(data.idNumber),
    creatorType: pickString(data.creator_type),
    category: pickString(data.creatorCategory, data.creatorMode),
    contentType: pickString(data.contentType, data.content_type, data.mainOrientationCategory),
    experienceLevel: pickString(data.experienceLevel, data.creatorMode),
    bio: pickString(data.bio, data.content, data.message, data.application_message),
    termsAccepted: Boolean(data.termsAccepted),
    privacyAccepted: Boolean(data.privacyAccepted),
    dataProcessingAccepted: Boolean(data.dataProcessingAccepted),
    ageConfirmed: Boolean(data.ageConfirmed),
    socialLinks: socialLinksFromData(data),
    idPhotos: photos.map((f, i) => ({
      label: f.name || f.filename || `ID photo ${i + 1}`,
      url: f.url || f.path || null,
    })).filter((f) => f.url),
    verificationVideos: videos.map((f, i) => ({
      label: f.name || f.filename || `Verification video ${i + 1}`,
      url: f.url || f.path || null,
    })).filter((f) => f.url),
  };
}
