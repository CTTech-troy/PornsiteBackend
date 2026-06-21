-- Admin-controlled VAST provider switcher for video pre-roll ads.
-- The player resolves one active VAST URL from these platform settings.

insert into public.platform_settings (key, value, section, description, value_type, updated_at)
values
  ('vast_enabled', 'true', 'Video Ad Settings', 'Enable or disable VAST pre-roll ads globally', 'toggle', now()),
  ('vast_provider', 'monetag', 'Video Ad Settings', 'Active VAST provider: monetag, clickadilla, or custom', 'select', now()),
  ('vast_url_custom', '', 'Video Ad Settings', 'Custom HTTPS VAST tag URL used when provider is custom', 'url', now())
on conflict (key) do update set
  section = excluded.section,
  description = excluded.description,
  value_type = excluded.value_type,
  updated_at = now();
