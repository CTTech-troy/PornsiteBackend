-- Studio profile settings: social links + notification preferences on creators

alter table public.creators
  add column if not exists social_links jsonb not null default '{}'::jsonb,
  add column if not exists notification_prefs jsonb not null default '{
    "premiumPurchase": true,
    "payoutUpdates": true,
    "newFollowers": true,
    "uploadStatus": true
  }'::jsonb;

comment on column public.creators.social_links is 'Creator social URLs keyed by platform id (e.g. twitter, instagram)';
comment on column public.creators.notification_prefs is 'Creator studio notification toggles';
