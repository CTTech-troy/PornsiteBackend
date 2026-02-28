-- Add creator display name to lives so we show name instead of id
ALTER TABLE lives ADD COLUMN IF NOT EXISTS host_display_name TEXT;
