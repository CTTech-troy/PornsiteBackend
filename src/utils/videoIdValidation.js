const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function isValidPlatformVideoId(value) {
  return typeof value === 'string' && UUID_RE.test(value.trim());
}

export function invalidVideoIdResponse(res, extra = {}) {
  return res.status(400).json({
    success: false,
    message: 'Invalid video ID',
    ...extra,
  });
}
