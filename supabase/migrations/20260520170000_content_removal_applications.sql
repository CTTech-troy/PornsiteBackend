-- Content removal application workflow.

CREATE EXTENSION IF NOT EXISTS pgcrypto;

CREATE TABLE IF NOT EXISTS public.content_removal_requests (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  request_id text UNIQUE NOT NULL,
  full_name text NOT NULL,
  email text NOT NULL,
  company text,
  phone text,
  relationship_to_content text,
  content_url text NOT NULL,
  additional_urls text[] NOT NULL DEFAULT '{}',
  content_title text,
  reason text NOT NULL,
  notes text NOT NULL,
  evidence_notes text,
  files jsonb NOT NULL DEFAULT '[]'::jsonb,
  status text NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'under_review', 'approved', 'rejected', 'needs_info')),
  admin_notes text,
  feedback_message text,
  consent_accuracy boolean NOT NULL DEFAULT false,
  consent_authorized boolean NOT NULL DEFAULT false,
  digital_signature text,
  activity jsonb NOT NULL DEFAULT '[]'::jsonb,
  submitted_at timestamptz NOT NULL DEFAULT now(),
  review_started_at timestamptz,
  decision_at timestamptz,
  deadline_at timestamptz NOT NULL DEFAULT (now() + interval '14 days'),
  updated_at timestamptz NOT NULL DEFAULT now(),
  updated_by text
);

ALTER TABLE public.content_removal_requests
  ADD COLUMN IF NOT EXISTS company text,
  ADD COLUMN IF NOT EXISTS phone text,
  ADD COLUMN IF NOT EXISTS relationship_to_content text,
  ADD COLUMN IF NOT EXISTS additional_urls text[] NOT NULL DEFAULT '{}',
  ADD COLUMN IF NOT EXISTS content_title text,
  ADD COLUMN IF NOT EXISTS evidence_notes text,
  ADD COLUMN IF NOT EXISTS files jsonb NOT NULL DEFAULT '[]'::jsonb,
  ADD COLUMN IF NOT EXISTS admin_notes text,
  ADD COLUMN IF NOT EXISTS feedback_message text,
  ADD COLUMN IF NOT EXISTS consent_accuracy boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS consent_authorized boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS digital_signature text,
  ADD COLUMN IF NOT EXISTS activity jsonb NOT NULL DEFAULT '[]'::jsonb,
  ADD COLUMN IF NOT EXISTS review_started_at timestamptz,
  ADD COLUMN IF NOT EXISTS decision_at timestamptz,
  ADD COLUMN IF NOT EXISTS deadline_at timestamptz NOT NULL DEFAULT (now() + interval '14 days'),
  ADD COLUMN IF NOT EXISTS updated_by text;

CREATE INDEX IF NOT EXISTS content_removal_requests_status_idx
  ON public.content_removal_requests(status);

CREATE INDEX IF NOT EXISTS content_removal_requests_email_idx
  ON public.content_removal_requests(email);

CREATE INDEX IF NOT EXISTS content_removal_requests_request_id_idx
  ON public.content_removal_requests(request_id);

CREATE INDEX IF NOT EXISTS content_removal_requests_submitted_at_idx
  ON public.content_removal_requests(submitted_at DESC);

CREATE INDEX IF NOT EXISTS content_removal_requests_deadline_at_idx
  ON public.content_removal_requests(deadline_at);

ALTER TABLE public.content_removal_requests ENABLE ROW LEVEL SECURITY;

-- Backend uses the service role key, which bypasses RLS. No anonymous table access is granted.

INSERT INTO storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
VALUES (
  'content_removal_evidence',
  'content_removal_evidence',
  false,
  10485760,
  ARRAY[
    'image/jpeg',
    'image/png',
    'image/webp',
    'application/pdf',
    'application/msword',
    'application/vnd.openxmlformats-officedocument.wordprocessingml.document'
  ]
)
ON CONFLICT (id) DO UPDATE SET
  public = false,
  file_size_limit = EXCLUDED.file_size_limit,
  allowed_mime_types = EXCLUDED.allowed_mime_types;
