-- Global platform settings catalog support.

CREATE TABLE IF NOT EXISTS public.platform_settings (
  key text PRIMARY KEY,
  value text NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE IF EXISTS public.platform_settings
  ADD COLUMN IF NOT EXISTS updated_by text,
  ADD COLUMN IF NOT EXISTS section text,
  ADD COLUMN IF NOT EXISTS description text,
  ADD COLUMN IF NOT EXISTS value_type text DEFAULT 'text',
  ADD COLUMN IF NOT EXISTS is_sensitive boolean NOT NULL DEFAULT false;

CREATE INDEX IF NOT EXISTS platform_settings_section_idx
  ON public.platform_settings(section);

CREATE INDEX IF NOT EXISTS platform_settings_updated_at_idx
  ON public.platform_settings(updated_at DESC);

INSERT INTO public.platform_settings (key, value, section, description, value_type)
VALUES
  ('platform_name', 'XStreamVideos', 'Brand', 'Platform Name', 'text'),
  ('platform_logo_url', '', 'Brand', 'Platform Logo URL', 'url'),
  ('platform_url', 'https://xstreamvideos.site', 'Brand', 'Platform URL', 'url'),
  ('support_email', 'support@xstreamvideos.site', 'Brand', 'Support Email', 'email'),
  ('contact_email', 'support@xstreamvideos.site', 'Brand', 'Contact Email', 'email'),
  ('contact_phone', '', 'Brand', 'Contact Phone', 'text'),
  ('company_name', 'XStreamVideos', 'Brand', 'Company Name', 'text'),
  ('company_address', '', 'Brand', 'Company Address', 'textarea'),
  ('terms_url', '/terms', 'Legal', 'Terms URL', 'url'),
  ('privacy_policy_url', '/privacy-policy', 'Legal', 'Privacy Policy URL', 'url'),
  ('privacy_notice_url', '/privacy-notice', 'Legal', 'Privacy Notice URL', 'url'),
  ('community_guidelines_url', '/legal/community-guidelines', 'Legal', 'Community Guidelines URL', 'url'),
  ('content_removal_url', '/content-removal', 'Legal', 'Content Removal Policy URL', 'url'),
  ('creator_terms_url', '/terms', 'Legal', 'Creator Terms URL', 'url'),
  ('default_currency', 'USD', 'Localization', 'Default Currency', 'select'),
  ('payout_currency', 'NGN', 'Localization', 'Payout Currency', 'select'),
  ('timezone', 'UTC', 'Localization', 'Timezone', 'select'),
  ('platform_language', 'en', 'Localization', 'Platform Language', 'select'),
  ('ngn_to_usd_rate', '1600', 'Localization', 'NGN to USD Rate', 'number'),
  ('content_moderation_enabled', 'true', 'Moderation', 'Content Moderation Enabled', 'toggle'),
  ('manual_review_required', 'true', 'Moderation', 'Manual Review Required', 'toggle'),
  ('ai_moderation_enabled', 'false', 'Moderation', 'AI Moderation Enabled', 'toggle'),
  ('nsfw_moderation_enabled', 'true', 'Moderation', 'NSFW Moderation Enabled', 'toggle'),
  ('auto_hide_report_threshold', '5', 'Moderation', 'Auto-hide Report Threshold', 'number'),
  ('abuse_reporting_enabled', 'true', 'Moderation', 'Reporting and Abuse Enabled', 'toggle'),
  ('report_response_sla_hours', '48', 'Moderation', 'Report Response SLA (hours)', 'number'),
  ('creator_payouts_enabled', 'true', 'Creator Payouts', 'Creator Payouts Enabled', 'toggle'),
  ('creator_payout_automation_enabled', 'true', 'Creator Payouts', 'Paystack Payout Automation', 'toggle'),
  ('min_payout_usd', '5', 'Creator Payouts', 'Minimum Payout (USD)', 'number'),
  ('payout_processing_days', '3', 'Creator Payouts', 'Payout Processing Days', 'number'),
  ('creator_revenue_share_percent', '70', 'Creator Payouts', 'Creator Revenue Share (%)', 'number'),
  ('platform_fee_percent', '30', 'Creator Payouts', 'Platform Fee (%)', 'number'),
  ('live_gift_creator_percent', '70', 'Creator Payouts', 'Live Gift Creator Share (%)', 'number'),
  ('live_gift_platform_percent', '30', 'Creator Payouts', 'Live Gift Platform Share (%)', 'number'),
  ('subscription_fee_enabled', 'true', 'Monetization', 'Subscriptions Enabled', 'toggle'),
  ('subscription_trial_days', '0', 'Monetization', 'Subscription Trial Days', 'number'),
  ('ad_revenue_enabled', 'true', 'Monetization', 'Ad Revenue Enabled', 'toggle'),
  ('ad_revenue_share_percent', '50', 'Monetization', 'Ad Revenue Creator Share (%)', 'number'),
  ('coin_to_usd_rate', '0.01', 'Monetization', 'Coin to USD Rate', 'number'),
  ('premium_preview_seconds', '12', 'Monetization', 'Premium Preview Seconds', 'number'),
  ('payment_gateway_primary', 'paystack', 'Payments', 'Primary Payment Gateway', 'select'),
  ('paystack_enabled', 'true', 'Payments', 'Paystack Enabled', 'toggle'),
  ('paystack_public_key', '', 'Payments', 'Paystack Public Key', 'text'),
  ('paystack_webhook_url', '/api/payments/webhooks/paystack', 'Payments', 'Paystack Webhook URL', 'url'),
  ('monnify_enabled', 'true', 'Payments', 'Monnify Enabled', 'toggle'),
  ('email_notifications_enabled', 'true', 'Notifications', 'Email Notifications Enabled', 'toggle'),
  ('support_notifications_email', 'support@xstreamvideos.site', 'Notifications', 'Support Notifications Email', 'email'),
  ('resend_from_email', 'XStreamVideos <support@xstreamvideos.site>', 'Notifications', 'Transactional From Email', 'email'),
  ('push_notifications_enabled', 'false', 'Notifications', 'Push Notifications Enabled', 'toggle'),
  ('push_vapid_public_key', '', 'Notifications', 'Push VAPID Public Key', 'text'),
  ('default_user_role', 'user', 'Access', 'Default User Role', 'select'),
  ('creator_default_role', 'creator', 'Access', 'Approved Creator Role', 'select'),
  ('admin_default_permissions', '["/"]', 'Access', 'Default Admin Permissions JSON', 'json'),
  ('super_admin_required_for_payouts', 'false', 'Access', 'Super Admin Required for Payouts', 'toggle'),
  ('registration_open', 'true', 'Verification', 'Registration Open', 'toggle'),
  ('email_verification_required', 'true', 'Verification', 'Email Verification Required', 'toggle'),
  ('age_verification_required', 'true', 'Verification', 'Age Verification Required', 'toggle'),
  ('minimum_creator_age', '18', 'Verification', 'Minimum Creator Age', 'number'),
  ('creator_applications_open', 'true', 'Verification', 'Creator Applications Open', 'toggle'),
  ('creator_onboarding_requires_id', 'true', 'Verification', 'Creator Onboarding Requires ID', 'toggle'),
  ('creator_onboarding_categories', '["pstar","channel"]', 'Verification', 'Creator Types JSON', 'json'),
  ('uploads_enabled', 'true', 'Uploads', 'Uploads Enabled', 'toggle'),
  ('max_video_size_mb', '1024', 'Uploads', 'Max Video Size (MB)', 'number'),
  ('max_thumbnail_size_mb', '10', 'Uploads', 'Max Thumbnail Size (MB)', 'number'),
  ('allowed_video_types', '["video/mp4","video/webm","application/x-mpegURL"]', 'Uploads', 'Allowed Video Types JSON', 'json'),
  ('video_storage_provider', 'supabase', 'Uploads', 'Video Storage Provider', 'select'),
  ('default_video_quality', 'auto', 'Uploads', 'Default Video Quality', 'select'),
  ('max_video_quality', '1080p', 'Uploads', 'Max Video Quality', 'select'),
  ('hls_transcoding_enabled', 'false', 'Uploads', 'HLS Transcoding Enabled', 'toggle'),
  ('analytics_enabled', 'true', 'System', 'Analytics Enabled', 'toggle'),
  ('finance_hub_enabled', 'true', 'System', 'Finance Hub Enabled', 'toggle'),
  ('maintenance_mode', 'false', 'System', 'Maintenance Mode', 'toggle'),
  ('api_base_url', '', 'System', 'Public API Base URL', 'url'),
  ('cors_allowed_origins', '[]', 'System', 'CORS Allowed Origins JSON', 'json'),
  ('session_ttl_hours', '168', 'System', 'Session TTL Hours', 'number')
ON CONFLICT (key) DO NOTHING;
