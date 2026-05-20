import {
  validateVideoPlaybackSource,
  filterPlayableVideos,
  isDirectPlayableStreamUrl,
} from '../src/utils/videoPlaybackValidation.js';

let passed = 0;
let failed = 0;

function assert(label, condition) {
  if (condition) {
    passed += 1;
    console.log(`PASS: ${label}`);
  } else {
    failed += 1;
    console.error(`FAIL: ${label}`);
  }
}

const supabaseMp4 =
  'https://xyz.supabase.co/storage/v1/object/public/videos/sample.mp4';
const cloudinaryHls = 'https://res.cloudinary.com/demo/video/upload/sp/sample.m3u8';
const youtubeEmbed = 'https://www.youtube.com/embed/dQw4w9WgXcQ';
const phPage = 'https://www.pornhub.com/view_video.php?viewkey=ph12345678';
const phCdn = 'https://ev-h.phncdn.com/videos/202401/01/12345678/12345678.mp4';
const blockedIframe = 'https://www.xnxx.com/embed/abc123';
const xnxxPreview =
  'https://res.cloudinary.com/demo/video/upload/sp/preview.mp4';

{
  const r = validateVideoPlaybackSource({ streamUrl: supabaseMp4, source: 'community' });
  assert('supabase mp4 playable', r.playable && r.sourceType === 'approved_stream');
}

{
  const r = validateVideoPlaybackSource({ streamUrl: cloudinaryHls, source: 'community' });
  assert('cloudinary hls playable', r.playable && r.validationStatus === 'playable');
}

{
  const r = validateVideoPlaybackSource({ embedUrl: youtubeEmbed, source: 'community' });
  assert('youtube embed playable', r.playable && r.sourceType === 'official_embed' && r.embedAllowed);
}

{
  const r = validateVideoPlaybackSource({ videoUrl: phPage, source: 'external' });
  assert('pornhub page unsupported', !r.playable && r.sourceType === 'external_page');
}

assert('phncdn blocked', !isDirectPlayableStreamUrl(phCdn));

{
  const r = validateVideoPlaybackSource({ embedUrl: blockedIframe });
  assert('blocked embed', !r.playable && r.sourceType === 'blocked_embed');
}

{
  const r = validateVideoPlaybackSource({
    source: 'external',
    videoUrl: phPage,
    previewVideo: xnxxPreview,
  });
  assert(
    'external preview on approved cdn',
    r.playable && r.sourceType === 'preview_stream' && r.playbackUrl === xnxxPreview,
  );
}

{
  const out = filterPlayableVideos([
    { source: 'external', videoUrl: phPage },
    { source: 'external', videoUrl: phPage, previewVideo: xnxxPreview },
  ]);
  assert('filterPlayableVideos drops unsupported', out.length === 1 && out[0].sourceType === 'preview_stream');
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
