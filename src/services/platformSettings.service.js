import { supabase, isConfigured } from '../config/supabase.js';

const CACHE_TTL_MS = 30_000;
let cachedSettings = null;
let cacheLoadedAt = 0;

const CURRENCY_OPTIONS = ['USD', 'NGN'];
const LANGUAGE_OPTIONS = ['en', 'en-US'];
const TIMEZONE_OPTIONS = ['UTC', 'Africa/Lagos', 'America/Los_Angeles', 'America/New_York', 'Europe/London'];
const QUALITY_OPTIONS = ['auto', '480p', '720p', '1080p'];
const STORAGE_OPTIONS = ['supabase', 'firebase', 'cloudinary', 's3', 'mux', 'bunny'];
const WATERMARK_POSITION_OPTIONS = ['bottom-right', 'bottom-left', 'top-right', 'top-left'];
const WATERMARK_ANIMATION_OPTIONS = ['none', 'pulse', 'fade'];
const VAST_PROVIDER_OPTIONS = ['monetag', 'clickadilla', 'custom'];
export const FEED_PAGE_SIZE_OPTIONS = [50, 100, 200, 500];

export const VAST_PROVIDER_URLS = Object.freeze({
  monetag: 'https://s.magsrv.com/v1/vast.php?idz=5932212',
  clickadilla: 'https://vast.yomeno.xyz/vast?spot_id=1492236',
});

export const PLATFORM_SETTINGS_CATALOG = [
  // Brand and company
  { key: 'platform_name', label: 'Platform Name', section: 'Brand', type: 'text', defaultValue: 'XStreamVideos', public: true, required: true },
  { key: 'platform_logo_url', label: 'Platform Logo URL', section: 'Brand', type: 'url', defaultValue: '', public: true },
  { key: 'platform_url', label: 'Platform URL', section: 'Brand', type: 'url', defaultValue: 'https://xstreamvideos.site', public: true, required: true },
  { key: 'support_email', label: 'Support Email', section: 'Brand', type: 'email', defaultValue: 'support@xstreamvideos.site', public: true, required: true },
  { key: 'contact_email', label: 'Contact Email', section: 'Brand', type: 'email', defaultValue: 'support@xstreamvideos.site', public: true },
  { key: 'contact_phone', label: 'Contact Phone', section: 'Brand', type: 'text', defaultValue: '', public: true },
  { key: 'company_name', label: 'Company Name', section: 'Brand', type: 'text', defaultValue: 'XStreamVideos', public: true },
  { key: 'company_address', label: 'Company Address', section: 'Brand', type: 'textarea', defaultValue: '', public: true },
  { key: 'video_watermark_enabled', label: 'Video Watermark Enabled', section: 'Video Watermark', type: 'toggle', defaultValue: 'true', public: true },
  { key: 'video_watermark_logo_url', label: 'Watermark Logo URL', section: 'Video Watermark', type: 'url', defaultValue: '', public: true },
  { key: 'video_watermark_logo_url_dark', label: 'Dark Watermark Logo URL', section: 'Video Watermark', type: 'url', defaultValue: '', public: true },
  { key: 'video_watermark_logo_url_light', label: 'Light Watermark Logo URL', section: 'Video Watermark', type: 'url', defaultValue: '', public: true },
  { key: 'video_watermark_size_px', label: 'Watermark Size (px)', section: 'Video Watermark', type: 'number', defaultValue: '92', min: 32, max: 240, public: true },
  { key: 'video_watermark_opacity', label: 'Watermark Opacity', section: 'Video Watermark', type: 'number', defaultValue: '0.72', min: 0.15, max: 1, public: true },
  { key: 'video_watermark_margin_px', label: 'Watermark Margin (px)', section: 'Video Watermark', type: 'number', defaultValue: '16', min: 4, max: 80, public: true },
  { key: 'video_watermark_position', label: 'Watermark Position', section: 'Video Watermark', type: 'select', defaultValue: 'bottom-right', options: WATERMARK_POSITION_OPTIONS, public: true },
  { key: 'video_watermark_animation', label: 'Watermark Animation', section: 'Video Watermark', type: 'select', defaultValue: 'none', options: WATERMARK_ANIMATION_OPTIONS, public: true },
  { key: 'video_watermark_burn_in_enabled', label: 'Burn Watermark Into Exports', section: 'Video Watermark', type: 'toggle', defaultValue: 'true', public: true },

  // Legal
  { key: 'terms_url', label: 'Terms URL', section: 'Legal', type: 'url', defaultValue: '/terms', public: true },
  { key: 'privacy_policy_url', label: 'Privacy Policy URL', section: 'Legal', type: 'url', defaultValue: '/privacy-policy', public: true },
  { key: 'privacy_notice_url', label: 'Privacy Notice URL', section: 'Legal', type: 'url', defaultValue: '/privacy-notice', public: true },
  { key: 'community_guidelines_url', label: 'Community Guidelines URL', section: 'Legal', type: 'url', defaultValue: '/legal/community-guidelines', public: true },
  { key: 'content_removal_url', label: 'Content Removal Policy URL', section: 'Legal', type: 'url', defaultValue: '/content-removal', public: true },
  { key: 'creator_terms_url', label: 'Creator Terms URL', section: 'Legal', type: 'url', defaultValue: '/terms', public: true },

  // Localization
  { key: 'default_currency', label: 'Default Currency', section: 'Localization', type: 'select', defaultValue: 'USD', options: CURRENCY_OPTIONS, public: true },
  { key: 'payout_currency', label: 'Payout Currency', section: 'Localization', type: 'select', defaultValue: 'NGN', options: CURRENCY_OPTIONS },
  { key: 'timezone', label: 'Timezone', section: 'Localization', type: 'select', defaultValue: 'UTC', options: TIMEZONE_OPTIONS, public: true },
  { key: 'platform_language', label: 'Platform Language', section: 'Localization', type: 'select', defaultValue: 'en', options: LANGUAGE_OPTIONS, public: true },
  { key: 'ngn_to_usd_rate', label: 'NGN to USD Rate', section: 'Localization', type: 'number', defaultValue: '1600', min: 1 },

  // Moderation and safety
  { key: 'content_moderation_enabled', label: 'Content Moderation Enabled', section: 'Moderation', type: 'toggle', defaultValue: 'true' },
  { key: 'manual_review_required', label: 'Manual Review Required', section: 'Moderation', type: 'toggle', defaultValue: 'true' },
  { key: 'ai_moderation_enabled', label: 'AI Moderation Enabled', section: 'Moderation', type: 'toggle', defaultValue: 'false' },
  { key: 'nsfw_moderation_enabled', label: 'NSFW Moderation Enabled', section: 'Moderation', type: 'toggle', defaultValue: 'true' },
  { key: 'auto_hide_report_threshold', label: 'Auto-hide Report Threshold', section: 'Moderation', type: 'number', defaultValue: '5', min: 1, max: 100 },
  { key: 'abuse_reporting_enabled', label: 'Reporting and Abuse Enabled', section: 'Moderation', type: 'toggle', defaultValue: 'true', public: true },
  { key: 'report_response_sla_hours', label: 'Report Response SLA (hours)', section: 'Moderation', type: 'number', defaultValue: '48', min: 1, max: 720 },

  // Creator payouts and revenue
  { key: 'creator_payouts_enabled', label: 'Creator Payouts Enabled', section: 'Creator Payouts', type: 'toggle', defaultValue: 'true' },
  { key: 'creator_payout_automation_enabled', label: 'Paystack Payout Automation', section: 'Creator Payouts', type: 'toggle', defaultValue: 'true' },
  { key: 'min_payout_usd', label: 'Minimum Payout (USD)', section: 'Creator Payouts', type: 'number', defaultValue: '5', min: 1, public: true },
  { key: 'payout_processing_days', label: 'Payout Processing Days', section: 'Creator Payouts', type: 'number', defaultValue: '3', min: 0, max: 30 },
  { key: 'creator_revenue_share_percent', label: 'Creator Revenue Share (%)', section: 'Creator Payouts', type: 'number', defaultValue: '70', min: 0, max: 100 },
  { key: 'platform_fee_percent', label: 'Platform Fee (%)', section: 'Creator Payouts', type: 'number', defaultValue: '30', min: 0, max: 100 },
  { key: 'live_gift_creator_percent', label: 'Live Gift Creator Share (%)', section: 'Creator Payouts', type: 'number', defaultValue: '70', min: 0, max: 100 },
  { key: 'live_gift_platform_percent', label: 'Live Gift Platform Share (%)', section: 'Creator Payouts', type: 'number', defaultValue: '30', min: 0, max: 100 },

  // Revenue settings (admin commission & fees)
  { key: 'tax_percent', label: 'Tax Percentage (%)', section: 'Revenue Settings', type: 'number', defaultValue: '0', min: 0, max: 100 },
  { key: 'withdrawal_fee_percent', label: 'Withdrawal Fee (%)', section: 'Revenue Settings', type: 'number', defaultValue: '0', min: 0, max: 100 },
  { key: 'processing_fee_percent', label: 'Payment Processing Fee (%)', section: 'Revenue Settings', type: 'number', defaultValue: '2.9', min: 0, max: 100 },
  {
    key: 'revenue_commission_rules',
    label: 'Commission Overrides (JSON)',
    section: 'Revenue Settings',
    type: 'json',
    defaultValue: '{"categories":{},"creators":{}}',
    description: 'Per-category and per-creator platform/creator percent overrides.',
  },

  // Monetization
  { key: 'ad_revenue_enabled', label: 'Ad Revenue Enabled', section: 'Monetization', type: 'toggle', defaultValue: 'true' },
  { key: 'ad_revenue_share_percent', label: 'Legacy Ad Share (%) — unused for preroll', section: 'Monetization', type: 'number', defaultValue: '0', min: 0, max: 100, description: 'Preroll uses flat reward per valid view (Ad Reward Settings).' },
  { key: 'ad_creator_reward_per_1k_views', label: 'Creator Reward per 1K Valid Views (USD)', section: 'Ad Reward Settings', type: 'number', defaultValue: '0.60', min: 0 },
  { key: 'ad_valid_view_min_watch_sec', label: 'Min Watch Before Skip Counts (sec)', section: 'Ad Reward Settings', type: 'number', defaultValue: '5', min: 0, max: 60 },
  { key: 'ad_reward_require_impression', label: 'Require Impression for Reward', section: 'Ad Reward Settings', type: 'toggle', defaultValue: 'true' },
  { key: 'ad_reward_fraud_protection', label: 'Fraud Protection', section: 'Ad Reward Settings', type: 'toggle', defaultValue: 'true' },
  { key: 'ad_reward_max_daily_per_viewer', label: 'Max Rewards per Viewer / Day', section: 'Ad Reward Settings', type: 'number', defaultValue: '100', min: 1, max: 10000 },
  { key: 'ad_reward_min_complete_ms', label: 'Min Complete Duration (ms)', section: 'Ad Reward Settings', type: 'number', defaultValue: '1000', min: 0, max: 30000 },
  { key: 'vast_enabled', label: 'Enable VAST Pre-roll Ads', section: 'Video Ad Settings', type: 'toggle', defaultValue: 'true', public: true },
  { key: 'vast_provider', label: 'Active VAST Provider', section: 'Video Ad Settings', type: 'select', defaultValue: 'monetag', options: VAST_PROVIDER_OPTIONS, public: true },
  { key: 'vast_url_custom', label: 'Custom VAST URL', section: 'Video Ad Settings', type: 'url', defaultValue: '' },
  { key: 'exoclick_vast_tag_url', label: 'ExoClick VAST Tag URL', section: 'Monetization', type: 'url', defaultValue: 'https://s.magsrv.com/v1/vast.php?idz=5932212', public: true },
  { key: 'vast_ad_timeout_sec', label: 'VAST Ad Load Timeout (sec)', section: 'Monetization', type: 'number', defaultValue: '5', min: 3, max: 30 },
  { key: 'vast_skip_after_seconds_default', label: 'Default Ad Skip After (sec)', section: 'Monetization', type: 'number', defaultValue: '5', min: 0, max: 30, public: true },
  { key: 'vast_estimated_cpm_usd', label: 'Estimated VAST CPM (USD) — platform gross', section: 'Ad Reward Settings', type: 'number', defaultValue: '2', min: 0, description: 'Used to estimate platform gross per valid view (CPM ÷ 1000).' },
  { key: 'ad_preroll_frequency_videos', label: 'Pre-roll Frequency (videos)', section: 'Monetization', type: 'number', defaultValue: '3', min: 1, max: 20, public: true },
  { key: 'ad_preroll_cooldown_seconds', label: 'Pre-roll Cooldown (sec)', section: 'Monetization', type: 'number', defaultValue: '600', min: 0, max: 7200, public: true },
  { key: 'ad_preroll_probability', label: 'Pre-roll Probability', section: 'Monetization', type: 'number', defaultValue: '1', min: 0, max: 1, public: true },
  { key: 'ad_provider_priority_order', label: 'Ad Provider Priority (JSON)', section: 'Monetization', type: 'json', defaultValue: '["exoclick","juicyads","monetag","google_ad_manager"]' },
  { key: 'ad_auto_fallback_enabled', label: 'Ad Auto-Fallback Enabled', section: 'Monetization', type: 'toggle', defaultValue: 'true' },
  { key: 'ad_health_scan_interval_minutes', label: 'Ad Health Scan Interval (min)', section: 'Monetization', type: 'number', defaultValue: '15', min: 5, max: 1440 },
  { key: 'ad_safe_mode_strict', label: 'Strict Safe Mode', section: 'Safe Ads', type: 'toggle', defaultValue: 'true' },
  { key: 'ad_allow_popups', label: 'Allow Ad Popups', section: 'Safe Ads', type: 'toggle', defaultValue: 'false' },
  { key: 'ad_allow_redirects', label: 'Allow Ad Redirects', section: 'Safe Ads', type: 'toggle', defaultValue: 'false' },
  { key: 'ad_allow_floating', label: 'Allow Floating Ads', section: 'Safe Ads', type: 'toggle', defaultValue: 'false' },
  { key: 'ad_block_aggressive', label: 'Block Aggressive Ads', section: 'Safe Ads', type: 'toggle', defaultValue: 'true' },
  { key: 'ad_max_width_px', label: 'Max Ad Width (px)', section: 'Safe Ads', type: 'number', defaultValue: '970', min: 100, max: 1920 },
  { key: 'ad_max_height_px', label: 'Max Ad Height (px)', section: 'Safe Ads', type: 'number', defaultValue: '600', min: 50, max: 1080 },
  { key: 'ad_dom_guard_enabled', label: 'DOM Guard Enabled', section: 'Safe Ads', type: 'toggle', defaultValue: 'true' },
  { key: 'ad_click_isolation', label: 'Click Isolation', section: 'Safe Ads', type: 'toggle', defaultValue: 'true' },
  { key: 'ad_block_interstitials', label: 'Block Interstitials', section: 'Safe Ads', type: 'toggle', defaultValue: 'true' },
  { key: 'ad_block_click_hijacking', label: 'Block Click Hijacking', section: 'Safe Ads', type: 'toggle', defaultValue: 'true' },
  { key: 'ad_safe_formats_only', label: 'Safe Formats Only', section: 'Safe Ads', type: 'toggle', defaultValue: 'true' },
  { key: 'ad_allowed_formats', label: 'Allowed Ad Formats (JSON)', section: 'Safe Ads', type: 'json', defaultValue: '["banner","display","native","vast","video"]' },
  { key: 'ad_preroll_enabled', label: 'Pre-roll Ads Enabled', section: 'Safe Ads', type: 'toggle', defaultValue: 'true', public: true },
  { key: 'ad_feed_ads_enabled', label: 'Feed Ads Enabled', section: 'Safe Ads', type: 'toggle', defaultValue: 'true', public: true },
  { key: 'ad_banner_ads_enabled', label: 'Banner Ads Enabled', section: 'Safe Ads', type: 'toggle', defaultValue: 'true', public: true },
  { key: 'ad_allowed_placements', label: 'Allowed Placements (JSON)', section: 'Safe Ads', type: 'json', defaultValue: '["video_preroll","feed","native_card","between_content","sidebar","home_after_subheader_900x250","home_sidebar","home_softcore_160x600","video_sidebar","video_recommended","creator_sidebar","live_sidebar","feed_sidebar","search_sidebar","before_footer","homepage_banner","leaderboard","banner"]' },
  { key: 'ad_allowed_domains', label: 'Allowed Ad Domains (JSON)', section: 'Safe Ads', type: 'json', defaultValue: '["juicyads.com","www.juicyads.com","js.juicyads.com","poweredby.jads.co","jads.co","exoclick.com","magsrv.com","a.magsrv.com","s.magsrv.com","vast.yomeno.xyz","yomeno.xyz","googleads.g.doubleclick.net","securepubads.g.doubleclick.net","googlesyndication.com","adtng.com","a.adtng.com","quge5.com","monetag.com","www.monetag.com","highperformanceformat.com","profitablecpmrate.com","profitablecpmgate.com","alwingulla.com","5gvci.com"]' },
  { key: 'juicyads_enabled', label: 'JuicyAds Enabled', section: 'Monetization', type: 'toggle', defaultValue: 'true', public: true },
  { key: 'juicyads_script_url', label: 'JuicyAds Script URL', section: 'Monetization', type: 'url', defaultValue: 'https://poweredby.jads.co/js/jads.js' },
  { key: 'juicyads_sidebar_zone_id', label: 'JuicyAds Sidebar Zone ID', section: 'Monetization', type: 'text', defaultValue: '1118510' },
  { key: 'sidebar_ads_enabled', label: 'Sidebar Ads Enabled', section: 'Monetization', type: 'toggle', defaultValue: 'true', public: true },
  { key: 'sidebar_custom_ads_enabled', label: 'Custom Sidebar Ads Enabled', section: 'Monetization', type: 'toggle', defaultValue: 'true' },
  { key: 'sidebar_third_party_enabled', label: 'Third-Party Sidebar Ads Enabled', section: 'Monetization', type: 'toggle', defaultValue: 'true', public: true },
  { key: 'monetag_enabled', label: 'Monetag Safe Mode Enabled', section: 'Monetization', type: 'toggle', defaultValue: 'true', public: true },
  { key: 'monetag_native_enabled', label: 'Monetag Native Feed Ads Enabled', section: 'Monetization', type: 'toggle', defaultValue: 'true', public: true },
  { key: 'monetag_sidebar_enabled', label: 'Monetag Sidebar Ads Enabled', section: 'Monetization', type: 'toggle', defaultValue: 'true', public: true },
  { key: 'monetag_banner_enabled', label: 'Monetag Banner Ads Enabled', section: 'Monetization', type: 'toggle', defaultValue: 'true', public: true },
  { key: 'monetag_script_url', label: 'Monetag Safe Script URL', section: 'Monetization', type: 'url', defaultValue: 'https://quge5.com/88/tag.min.js' },
  { key: 'monetag_native_zone_id', label: 'Monetag Native Zone ID', section: 'Monetization', type: 'text', defaultValue: '242279' },
  { key: 'monetag_sidebar_zone_id', label: 'Monetag Sidebar Zone ID', section: 'Monetization', type: 'text', defaultValue: '242279' },
  { key: 'monetag_banner_zone_id', label: 'Monetag Banner Zone ID', section: 'Monetization', type: 'text', defaultValue: '242279' },
  { key: 'monetag_allowed_pages', label: 'Monetag Allowed Pages (JSON)', section: 'Monetization', type: 'json', defaultValue: '["home","video","creator","feed","search","live"]' },
  { key: 'monetag_allowed_slots', label: 'Monetag Allowed Slots (JSON)', section: 'Monetization', type: 'json', defaultValue: '["home_feed_native","home_mobile_inline_300x100","category_feed_native","feed_native","mobile_inline","category_feed","home_after_subheader_900x250","home_sidebar","home_bottom_900x250","video_sidebar","video_recommended","creator_sidebar","live_sidebar","feed_sidebar","search_sidebar","before_footer","homepage_banner","homepage_top","homepage_bottom","leaderboard","banner"]' },
  { key: 'monetag_allowed_domains', label: 'Monetag Allowed Domains (JSON)', section: 'Monetization', type: 'json', defaultValue: '["quge5.com","monetag.com","www.monetag.com","highperformanceformat.com","profitablecpmrate.com","profitablecpmgate.com","alwingulla.com","5gvci.com"]' },
  { key: 'google_ad_manager_enabled', label: 'Google Ad Manager Enabled', section: 'Monetization', type: 'toggle', defaultValue: 'false' },
  { key: 'coin_to_usd_rate', label: 'Coin to USD Rate', section: 'Monetization', type: 'number', defaultValue: '0.01', min: 0 },
  { key: 'video_purchase_creator_percent', label: 'Premium Video Creator Share (%)', section: 'Monetization', type: 'number', defaultValue: '70', min: 0, max: 100 },
  { key: 'video_purchase_platform_percent', label: 'Premium Video Platform Share (%)', section: 'Monetization', type: 'number', defaultValue: '30', min: 0, max: 100 },
  { key: 'premium_preview_seconds', label: 'Premium Preview Seconds', section: 'Monetization', type: 'number', defaultValue: '12', min: 0, max: 600, public: true },

  // Payment gateways
  { key: 'payment_gateway_primary', label: 'Primary Payment Gateway', section: 'Payments', type: 'select', defaultValue: 'flutterwave', options: ['flutterwave', 'paystack', 'manual'], public: true },
  { key: 'payment_gateway_fallback', label: 'Fallback Payment Gateway', section: 'Payments', type: 'select', defaultValue: 'paystack', options: ['paystack', 'flutterwave', 'none'], public: true },
  { key: 'payment_retry_limit', label: 'Payment Retry Limit', section: 'Payments', type: 'number', defaultValue: '2', min: 0, max: 5 },
  { key: 'payment_retry_delay_ms', label: 'Payment Retry Delay (ms)', section: 'Payments', type: 'number', defaultValue: '750', min: 100, max: 5000 },
  { key: 'payment_timeout_ms', label: 'Payment Timeout (ms)', section: 'Payments', type: 'number', defaultValue: '20000', min: 5000, max: 60000 },
  { key: 'paystack_enabled', label: 'Paystack Enabled', section: 'Payments', type: 'toggle', defaultValue: 'true', public: true },
  { key: 'paystack_public_key', label: 'Paystack Public Key', section: 'Payments', type: 'text', defaultValue: '', public: true },
  { key: 'paystack_secret_key', label: 'Paystack Secret Key', section: 'Payments', type: 'secret', defaultValue: '', envKey: 'PAYSTACK_SECRET_KEY', sensitive: true },
  { key: 'paystack_webhook_url', label: 'Paystack Webhook URL', section: 'Payments', type: 'url', defaultValue: '/api/payments/webhooks/paystack' },
  { key: 'flutterwave_enabled', label: 'Flutterwave Enabled', section: 'Payments', type: 'toggle', defaultValue: 'true' },
  { key: 'flutterwave_public_key', label: 'Flutterwave Public Key', section: 'Payments', type: 'text', defaultValue: '', envKey: 'FLUTTERWAVE_PUBLIC_KEY', public: true },
  { key: 'flutterwave_secret_key', label: 'Flutterwave Secret Key', section: 'Payments', type: 'secret', defaultValue: '', envKey: 'FLUTTERWAVE_SECRET_KEY', sensitive: true },
  { key: 'flutterwave_webhook_url', label: 'Flutterwave Webhook URL', section: 'Payments', type: 'url', defaultValue: '/api/payments/webhooks/flutterwave' },

  // Notifications
  { key: 'email_notifications_enabled', label: 'Email Notifications Enabled', section: 'Notifications', type: 'toggle', defaultValue: 'true' },
  { key: 'support_notifications_email', label: 'Support Notifications Email', section: 'Notifications', type: 'email', defaultValue: 'support@xstreamvideos.site' },
  { key: 'resend_from_email', label: 'Transactional From Email', section: 'Notifications', type: 'email', defaultValue: 'XStreamVideos <support@xstreamvideos.site>' },
  { key: 'resend_api_key', label: 'Resend API Key', section: 'Notifications', type: 'secret', defaultValue: '', envKey: 'RESEND_API_KEY', sensitive: true },
  { key: 'push_notifications_enabled', label: 'Push Notifications Enabled', section: 'Notifications', type: 'toggle', defaultValue: 'false', public: true },
  { key: 'push_vapid_public_key', label: 'Push VAPID Public Key', section: 'Notifications', type: 'text', defaultValue: '', public: true },
  { key: 'push_vapid_private_key', label: 'Push VAPID Private Key', section: 'Notifications', type: 'secret', defaultValue: '', envKey: 'PUSH_VAPID_PRIVATE_KEY', sensitive: true },

  // Roles and access
  { key: 'default_user_role', label: 'Default User Role', section: 'Access', type: 'select', defaultValue: 'user', options: ['user', 'creator', 'admin'] },
  { key: 'creator_default_role', label: 'Approved Creator Role', section: 'Access', type: 'select', defaultValue: 'creator', options: ['creator'] },
  { key: 'admin_default_permissions', label: 'Default Admin Permissions JSON', section: 'Access', type: 'json', defaultValue: '["/"]' },
  { key: 'super_admin_required_for_payouts', label: 'Super Admin Required for Payouts', section: 'Access', type: 'toggle', defaultValue: 'false' },

  // Uploads and video
  { key: 'uploads_enabled', label: 'Uploads Enabled', section: 'Uploads', type: 'toggle', defaultValue: 'true', public: true },
  { key: 'max_video_size_mb', label: 'Max Video Size (MB)', section: 'Uploads', type: 'number', defaultValue: '1024', min: 1, max: 10240 },
  { key: 'max_thumbnail_size_mb', label: 'Max Thumbnail Size (MB)', section: 'Uploads', type: 'number', defaultValue: '10', min: 1, max: 100 },
  { key: 'import_batch_size', label: 'Import Chunk Size', section: 'Uploads', type: 'number', defaultValue: '500', min: 100, max: 10000 },
  { key: 'allowed_video_types', label: 'Allowed Video Types JSON', section: 'Uploads', type: 'json', defaultValue: '["video/mp4","video/webm","application/x-mpegURL"]' },
  { key: 'video_storage_provider', label: 'Video Storage Provider', section: 'Uploads', type: 'select', defaultValue: 'supabase', options: STORAGE_OPTIONS },
  { key: 'default_video_quality', label: 'Default Video Quality', section: 'Uploads', type: 'select', defaultValue: 'auto', options: QUALITY_OPTIONS, public: true },
  { key: 'max_video_quality', label: 'Max Video Quality', section: 'Uploads', type: 'select', defaultValue: '1080p', options: QUALITY_OPTIONS },
  { key: 'hls_transcoding_enabled', label: 'HLS Transcoding Enabled', section: 'Uploads', type: 'toggle', defaultValue: 'false' },

  // Discovery feed
  {
    key: 'feed_videos_per_page',
    label: 'Videos Per Feed Page',
    section: 'Discovery Feed',
    type: 'select',
    defaultValue: '50',
    options: FEED_PAGE_SIZE_OPTIONS.map(String),
    public: true,
    description: 'Controls public homepage, category, and search feed pagination. Minimum is 50 videos per page.',
  },

  // Verification and creator onboarding
  { key: 'registration_open', label: 'Registration Open', section: 'Verification', type: 'toggle', defaultValue: 'true', public: true },
  { key: 'email_verification_required', label: 'Email Verification Required', section: 'Verification', type: 'toggle', defaultValue: 'true', public: true },
  { key: 'age_verification_required', label: 'Age Verification Required', section: 'Verification', type: 'toggle', defaultValue: 'true', public: true },
  { key: 'minimum_creator_age', label: 'Minimum Creator Age', section: 'Verification', type: 'number', defaultValue: '18', min: 18, max: 100, public: true },
  { key: 'creator_applications_open', label: 'Creator Applications Open', section: 'Verification', type: 'toggle', defaultValue: 'true', public: true },
  { key: 'creator_onboarding_requires_id', label: 'Creator Onboarding Requires ID', section: 'Verification', type: 'toggle', defaultValue: 'true' },
  { key: 'creator_onboarding_categories', label: 'Creator Types JSON', section: 'Verification', type: 'json', defaultValue: '["pstar","channel"]', public: true },

  // Analytics, security, API
  { key: 'analytics_enabled', label: 'Analytics Enabled', section: 'System', type: 'toggle', defaultValue: 'true' },
  { key: 'finance_hub_enabled', label: 'Finance Hub Enabled', section: 'System', type: 'toggle', defaultValue: 'true' },
  { key: 'maintenance_mode', label: 'Maintenance Mode', section: 'System', type: 'toggle', defaultValue: 'false', public: true },
  { key: 'api_base_url', label: 'Public API Base URL', section: 'System', type: 'url', defaultValue: '', public: true },
  { key: 'cors_allowed_origins', label: 'CORS Allowed Origins JSON', section: 'System', type: 'json', defaultValue: '[]' },
  { key: 'session_ttl_hours', label: 'Session TTL Hours', section: 'System', type: 'number', defaultValue: '168', min: 1, max: 8760 },
  { key: 'jwt_secret', label: 'User JWT Secret', section: 'System', type: 'secret', defaultValue: '', envKey: 'JWT_SECRET', sensitive: true },
  { key: 'admin_jwt_secret', label: 'Admin JWT Secret', section: 'System', type: 'secret', defaultValue: '', envKey: 'ADMIN_JWT_SECRET', sensitive: true },
  { key: 'supabase_service_role_key', label: 'Supabase Service Role Key', section: 'System', type: 'secret', defaultValue: '', envKey: 'SUPABASE_SERVICE_ROLE_KEY', sensitive: true },
  { key: 'firebase_service_account_key', label: 'Firebase Service Account Key', section: 'System', type: 'secret', defaultValue: '', envKey: 'FIREBASE_SERVICE_ACCOUNT_KEY', sensitive: true },
];

const CATALOG_BY_KEY = new Map(PLATFORM_SETTINGS_CATALOG.map((item) => [item.key, item]));

function isMissingSettingsTable(err) {
  return (
    err?.code === '42P01' ||
    err?.code === 'PGRST200' ||
    (typeof err?.message === 'string' && err.message.includes('schema cache'))
  );
}

function normalizeBoolean(value) {
  const v = String(value ?? '').trim().toLowerCase();
  return ['true', '1', 'yes', 'on', 'enabled'].includes(v) ? 'true' : 'false';
}

function normalizeUrl(value) {
  const v = String(value ?? '').trim();
  if (!v) return '';
  if (v.startsWith('/')) return v;
  try {
    const u = new URL(v);
    return u.toString();
  } catch {
    throw new Error('Enter a valid URL or an absolute path beginning with /.');
  }
}

function normalizeEmail(value, required) {
  const v = String(value ?? '').trim();
  if (!v && !required) return '';
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v) && !/^[^<>]+<[^@\s<>]+@[^@\s<>]+\.[^@\s<>]+>$/.test(v)) {
    throw new Error('Enter a valid email address.');
  }
  return v;
}

function normalizeJson(value) {
  const raw = String(value ?? '').trim();
  if (!raw) return '';
  try {
    return JSON.stringify(JSON.parse(raw));
  } catch {
    throw new Error('Enter valid JSON.');
  }
}

export function sanitizeSettingValue(def, value) {
  if (def.sensitive) return { skip: true, value: '' };
  const raw = value ?? def.defaultValue ?? '';

  if (def.required && !String(raw).trim()) {
    throw new Error(`${def.label} is required.`);
  }

  if (def.type === 'toggle') return { value: normalizeBoolean(raw) };
  if (def.type === 'url') return { value: normalizeUrl(raw) };
  if (def.type === 'email') return { value: normalizeEmail(raw, def.required) };
  if (def.type === 'json') return { value: normalizeJson(raw) };
  if (def.type === 'select') {
    const v = String(raw || def.defaultValue || '').trim();
    if (def.options?.length && !def.options.includes(v)) {
      throw new Error(`${def.label} must be one of: ${def.options.join(', ')}.`);
    }
    return { value: v };
  }
  if (def.type === 'number') {
    const n = Number(raw);
    if (!Number.isFinite(n)) throw new Error(`${def.label} must be a number.`);
    if (def.min != null && n < def.min) throw new Error(`${def.label} must be at least ${def.min}.`);
    if (def.max != null && n > def.max) throw new Error(`${def.label} must be at most ${def.max}.`);
    return { value: String(n) };
  }
  return { value: String(raw ?? '').trim() };
}

async function readStoredSettings() {
  if (!isConfigured() || !supabase) return { rows: [], tableMissing: true };
  const { data, error } = await supabase
    .from('platform_settings')
    .select('key, value, updated_at, updated_by, section, description, value_type, is_sensitive');
  if (error) {
    if (isMissingSettingsTable(error) || error.code === '42703' || error.code === 'PGRST204') {
      const fallback = await supabase.from('platform_settings').select('key, value, updated_at');
      if (fallback.error) {
        if (isMissingSettingsTable(fallback.error)) return { rows: [], tableMissing: true };
        throw fallback.error;
      }
      return { rows: fallback.data || [], tableMissing: false };
    }
    throw error;
  }
  return { rows: data || [], tableMissing: false };
}

export async function getPlatformSettingsMap(force = false) {
  if (!force && cachedSettings && Date.now() - cacheLoadedAt < CACHE_TTL_MS) return cachedSettings;

  const defaults = Object.fromEntries(
    PLATFORM_SETTINGS_CATALOG
      .filter((def) => !def.sensitive)
      .map((def) => [def.key, String(def.defaultValue ?? '')]),
  );

  try {
    const { rows } = await readStoredSettings();
    for (const row of rows) {
      if (row?.key && CATALOG_BY_KEY.has(row.key) && !CATALOG_BY_KEY.get(row.key).sensitive) {
        defaults[row.key] = String(row.value ?? '');
      }
    }
  } catch (_) {
    /* use defaults */
  }

  cachedSettings = defaults;
  cacheLoadedAt = Date.now();
  return cachedSettings;
}

export function invalidatePlatformSettingsCache() {
  cachedSettings = null;
  cacheLoadedAt = 0;
}

export async function getAdminSettingsPayload() {
  const { rows, tableMissing } = await readStoredSettings().catch((err) => {
    if (isMissingSettingsTable(err)) return { rows: [], tableMissing: true };
    throw err;
  });
  const stored = new Map((rows || []).map((row) => [row.key, row]));

  return {
    tableMissing,
    settings: PLATFORM_SETTINGS_CATALOG.map((def) => {
      const row = stored.get(def.key);
      const envConfigured = def.envKey ? Boolean(process.env[def.envKey]) : undefined;
      return {
        key: def.key,
        label: def.label,
        section: def.section,
        type: def.type,
        value: def.sensitive ? '' : String(row?.value ?? def.defaultValue ?? ''),
        defaultValue: String(def.defaultValue ?? ''),
        description: def.description || '',
        options: def.options || [],
        required: def.required === true,
        sensitive: def.sensitive === true,
        envKey: def.envKey || null,
        envConfigured,
        public: def.public === true,
        updated_at: row?.updated_at || null,
      };
    }),
  };
}

export async function saveAdminSettings(settings, admin = 'Admin') {
  if (!Array.isArray(settings) || settings.length === 0) {
    const err = new Error('settings array required.');
    err.status = 400;
    throw err;
  }

  const adminName = typeof admin === 'string' ? admin : (admin?.name || admin?.email || 'Admin');
  const adminMeta = typeof admin === 'object' && admin ? admin : { name: adminName };

  const currentMap = await getPlatformSettingsMap(true);
  const auditChanges = [];

  const errors = [];
  const rows = [];
  for (const input of settings) {
    const key = String(input?.key || '').trim();
    const def = CATALOG_BY_KEY.get(key);
    if (!def) {
      errors.push({ key, message: 'Unknown setting key.' });
      continue;
    }
    try {
      const sanitized = sanitizeSettingValue(def, input.value);
      if (sanitized.skip) continue;
      const oldValue = currentMap[key] ?? String(def.defaultValue ?? '');
      if (oldValue !== sanitized.value) {
        auditChanges.push({ key, oldValue, newValue: sanitized.value });
      }
      rows.push({
        key,
        value: sanitized.value,
        section: def.section,
        description: def.label,
        value_type: def.type,
        is_sensitive: false,
        updated_at: new Date().toISOString(),
        updated_by: adminName || 'Admin',
      });
    } catch (err) {
      errors.push({ key, message: err.message });
    }
  }

  if (errors.length) {
    const err = new Error('Some settings are invalid.');
    err.status = 400;
    err.errors = errors;
    throw err;
  }

  if (!rows.length) return { updatedKeys: [] };

  let { error } = await supabase.from('platform_settings').upsert(rows, { onConflict: 'key' });
  if (error && (error.code === '42703' || error.code === 'PGRST204')) {
    const fallbackRows = rows.map(({ key, value, updated_at }) => ({ key, value, updated_at }));
    const fallback = await supabase.from('platform_settings').upsert(fallbackRows, { onConflict: 'key' });
    error = fallback.error;
  }
  if (error) throw error;

  try {
    const { logPlatformSettingChanges } = await import('./platformSettingsAudit.service.js');
    await logPlatformSettingChanges(auditChanges, adminMeta);
  } catch (_) {
    /* audit optional until migration applied */
  }

  invalidatePlatformSettingsCache();
  return { updatedKeys: rows.map((row) => row.key) };
}

export async function getRevenueSettingsPayload() {
  const { settings, tableMissing } = await getAdminSettingsPayload();
  const revenueKeys = new Set(
    PLATFORM_SETTINGS_CATALOG.filter((d) =>
      d.section === 'Revenue Settings' || d.section === 'Creator Payouts' || d.section === 'Monetization' || d.section === 'Ad Reward Settings',
    )
      .map((d) => d.key),
  );
  return {
    tableMissing,
    settings: settings.filter((s) => revenueKeys.has(s.key)),
  };
}

export async function getPublicPlatformSettings() {
  const map = await getPlatformSettingsMap();
  return Object.fromEntries(
    PLATFORM_SETTINGS_CATALOG
      .filter((def) => def.public && !def.sensitive)
      .map((def) => [def.key, map[def.key] ?? String(def.defaultValue ?? '')]),
  );
}

function normalizeVastPlaybackUrl(value) {
  const raw = String(value || '').trim();
  if (!raw) return '';
  try {
    const url = new URL(raw);
    if (url.protocol !== 'https:') return '';
    url.username = '';
    url.password = '';
    return url.toString();
  } catch {
    return '';
  }
}

export function resolveVastSettingsFromMap(map = {}) {
  const rawProvider = String(map.vast_provider || 'monetag').trim().toLowerCase();
  const provider = VAST_PROVIDER_OPTIONS.includes(rawProvider) ? rawProvider : 'monetag';
  const url = provider === 'custom'
    ? normalizeVastPlaybackUrl(map.vast_url_custom)
    : VAST_PROVIDER_URLS[provider];
  const revenueEnabled = normalizeBoolean(map.ad_revenue_enabled ?? 'true') === 'true';
  const prerollEnabled = normalizeBoolean(map.ad_preroll_enabled ?? 'true') === 'true';
  const vastEnabled = normalizeBoolean(map.vast_enabled ?? 'true') === 'true';

  return {
    enabled: Boolean(url) && revenueEnabled && prerollEnabled && vastEnabled,
    provider,
    url,
    customUrl: normalizeVastPlaybackUrl(map.vast_url_custom),
    providers: VAST_PROVIDER_URLS,
  };
}

export async function getResolvedVastSettings() {
  const map = await getPlatformSettingsMap();
  return resolveVastSettingsFromMap(map);
}

export async function getStringSetting(key, fallback = '') {
  const map = await getPlatformSettingsMap();
  return String(map[key] ?? fallback);
}

export async function getNumberSetting(key, fallback = 0) {
  const map = await getPlatformSettingsMap();
  const value = Array.isArray(key)
    ? key.map((k) => map[k]).find((v) => v != null && v !== '')
    : map[key];
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

export function normalizeFeedPageSize(value, fallback = 50) {
  const requested = Number(value);
  const fallbackValue = FEED_PAGE_SIZE_OPTIONS.includes(Number(fallback)) ? Number(fallback) : 50;
  return FEED_PAGE_SIZE_OPTIONS.includes(requested) ? requested : fallbackValue;
}

export async function getFeedPageSizeSetting(fallback = 50) {
  const value = await getNumberSetting('feed_videos_per_page', fallback);
  return normalizeFeedPageSize(value, fallback);
}

export async function getBooleanSetting(key, fallback = false) {
  const map = await getPlatformSettingsMap();
  if (map[key] == null) return fallback;
  return normalizeBoolean(map[key]) === 'true';
}
