UPDATE public.tiktok_videos
SET is_live = true
WHERE status = 'published'
  AND is_live = false;
