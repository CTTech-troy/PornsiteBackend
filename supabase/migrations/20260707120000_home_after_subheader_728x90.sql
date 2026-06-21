-- Resizes the home after-subheader slot from the old 900x250 frame to the 728x90 banner frame.

update public.ad_slots
set
  name = 'Home After Subheader Banner 728x90',
  page = 'home',
  location = 'after_subheader',
  width = 728,
  height = 90,
  size_label = '728x90',
  provider_type = 'custom',
  custom_enabled = true,
  third_party_enabled = false,
  display_mode = 'custom_only',
  device_target = 'all',
  updated_at = now()
where slot_key = 'home_after_subheader_900x250';
