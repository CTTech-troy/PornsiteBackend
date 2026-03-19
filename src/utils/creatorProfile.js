import { db, firebaseInitialized } from '../config/firebase.js';

export async function getCreatorPublicFields(uid) {
  if (!uid || !firebaseInitialized) {
    return { creatorDisplayName: null, creatorAvatarUrl: null };
  }
  try {
    const snap = await db.collection('users').doc(uid).get();
    const d = snap.exists ? snap.data() : {};
    const name = String(d.displayName || d.name || '').trim();
    const avatar = String(d.avatar || d.photoURL || '').trim();
    return {
      creatorDisplayName: name || null,
      creatorAvatarUrl: avatar || null,
    };
  } catch {
    return { creatorDisplayName: null, creatorAvatarUrl: null };
  }
}

export async function mergeCreatorIntoPublicVideo(video) {
  if (!video?.userId) return video;
  const hasName = video.creatorDisplayName && String(video.creatorDisplayName).trim();
  const hasAvatar = video.creatorAvatarUrl && String(video.creatorAvatarUrl).trim();
  if (hasName && hasAvatar) return video;
  const { creatorDisplayName, creatorAvatarUrl } = await getCreatorPublicFields(video.userId);
  return {
    ...video,
    creatorDisplayName: hasName ? String(video.creatorDisplayName).trim() : (creatorDisplayName || null),
    creatorAvatarUrl: hasAvatar ? String(video.creatorAvatarUrl).trim() : (creatorAvatarUrl || null),
  };
}
