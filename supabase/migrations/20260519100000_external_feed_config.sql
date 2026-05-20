-- Default external home feed (RapidAPI xnxx) settings — editable from admin panel
insert into public.platform_settings (key, value)
values (
  'external_feed_config',
  '{"enabled":true,"activeProvider":"xnxx-api","mixCreatorsFirst":true,"pagesPerRequest":1,"providers":{"xnxx-api":{"label":"XNXX API (RapidAPI)","host":"xnxx-api.p.rapidapi.com","apiKey":"","bestPath":"/xn/best","periodMode":"none","fixedPeriod":""}}}'
)
on conflict (key) do nothing;
