UPDATE ad_slots
SET display_mode = 'custom_only', third_party_enabled = false
WHERE location = 'sidebar' AND display_mode IN ('custom_first', 'third_party_first', 'rotate');
