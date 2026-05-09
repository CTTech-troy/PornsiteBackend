-- Create creators_main_application table for new creator application system

CREATE TABLE IF NOT EXISTS public.creators_main_application (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id       uuid NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,
  full_name     text,
  email         text,
  phone         text,
  country       text,
  state         text,
  city          text,
  bio           text,
  social_links  jsonb DEFAULT '{}',
  category      text,
  experience    text,
  profile_picture text,
  uploaded_photos text[] DEFAULT '{}',
  uploaded_videos text[] DEFAULT '{}',
  status        text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'approved', 'rejected')),
  approved      boolean NOT NULL DEFAULT false,
  rejected      boolean NOT NULL DEFAULT false,
  rejection_reason text,
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now()
);

-- Indexes for performance
CREATE INDEX IF NOT EXISTS idx_creators_main_application_user_id ON public.creators_main_application(user_id);
CREATE INDEX IF NOT EXISTS idx_creators_main_application_status ON public.creators_main_application(status);
CREATE INDEX IF NOT EXISTS idx_creators_main_application_created_at ON public.creators_main_application(created_at DESC);

-- RLS policies (if needed)
ALTER TABLE public.creators_main_application ENABLE ROW LEVEL SECURITY;

-- Policy for users to see their own applications
CREATE POLICY "Users can view own applications" ON public.creators_main_application
  FOR SELECT USING (auth.uid() = user_id);

-- Policy for admins to manage all applications
CREATE POLICY "Admins can manage applications" ON public.creators_main_application
  FOR ALL USING (
    EXISTS (
      SELECT 1 FROM public.users
      WHERE id = auth.uid() AND role = 'admin'
    )
  );

-- Function to update updated_at on changes
CREATE OR REPLACE FUNCTION update_creators_main_application_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trigger_update_creators_main_application_updated_at
  BEFORE UPDATE ON public.creators_main_application
  FOR EACH ROW EXECUTE FUNCTION update_creators_main_application_updated_at();