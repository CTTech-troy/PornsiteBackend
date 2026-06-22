-- Lightweight player telemetry for buffering, recovery, stream quality, and playback failures.

create table if not exists public.playback_performance_events (
  id uuid primary key default gen_random_uuid(),
  video_id text not null,
  user_id text,
  fingerprint text,
  event_type text not null check (
    event_type in (
      'play_start',
      'playing',
      'buffer_start',
      'buffer_end',
      'quality_change',
      'stream_retry',
      'playback_error',
      'ended', 
      'watch_progress'
    )
  ),
  "current_time" numeric,
  duration numeric,
  quality_label text,
  buffering_ms integer,
  stream_type text,AI Moderator Refactor

Security Requirements

* Use OpenAI through the backend only.
* Never expose the OpenAI API key to the frontend.
* Never hardcode API keys in the codebase.
* Never commit API keys to Git.
* Never log API keys.
* Never return API keys in API responses.

1. OpenAI Integration

Replace the current AI moderation implementation with OpenAI.

Create a dedicated backend service:

* ModerationService
* ContentAnalysisService
* AIQueueProcessor

All moderation requests must pass through the backend.

2. Environment Configuration

Configure backend environment variables:

OPENAI_API_KEY=YOUR_NEW_OPENAI_API_KEY

Startup validation:

* Verify API key exists.
* Verify API key format.
* Fail gracefully if missing.
* Show admin warning if configuration is invalid.

3. AI Content Moderation

Analyze:

* Video titles
* Video descriptions
* Hashtags
* Tags
* Creator metadata
* User reports
* Comments

Return:

* Risk score
* Confidence score
* Moderation category
* Recommended action
* Explanation summary

Moderation outcomes:

* Approved
* Needs Manual Review
* Rejected

4. Upload Workflow Integration

When creators upload content:

* Run AI moderation automatically.
* Store moderation results.
* Approve safe content automatically.
* Route suspicious content to manual review.
* Block clearly prohibited content.

5. Admin Sidebar Cleanup

Remove these menu items from the Admin Sidebar:

* AI Overview
* AI Analytics
* AI Monitoring
* AI Reports
* AI Settings

The sidebar should remain clean and uncluttered.

6. AI Moderation Page

Create a dedicated AI Moderation page.

Sections:

AI Overview

* Total scans
* Approved content
* Pending review
* Rejected content
* Accuracy metrics
* Average processing time

AI History

Display:

* Thumbnail
* Content title
* Creator
* Scan date
* Risk score
* AI decision
* Final admin decision
* Status

7. AI History Enhancements

Add:

* Search
* Filters
* Date range filters
* Creator filters
* Status filters
* Risk score filters
* Pagination
* Sorting

8. Manual Review Queue

Create a review queue for flagged content.

Moderators should be able to:

* Approve content
* Reject content
* Add notes
* Override AI decisions

9. Audit Logging

Track:

* AI decisions
* Moderator decisions
* Admin overrides
* Content status changes
* Review timestamps

Store all actions permanently.

10. Performance

* Queue moderation jobs.
* Process asynchronously.
* Prevent upload delays.
* Prevent UI freezing.
* Cache common moderation responses where appropriate.

11. Database

Store:

* Scan ID
* Content ID
* Creator ID
* AI response
* Risk score
* Decision
* Confidence
* Review status
* Moderator actions
* Timestamps

12. Production Readiness

* Remove all mock AI data.
* Remove all placeholder statistics.
* Connect dashboard metrics to real moderation records.
* Ensure all moderation activity uses production database data.

The final result should be a secure OpenAI-powered moderation system with backend-only API access, automated content analysis, manual review capabilities, detailed AI history tracking, and a clean Admin Dashboard experience.

  error_kind text,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);

create index if not exists idx_playback_perf_video_created
  on public.playback_performance_events (video_id, created_at desc);

create index if not exists idx_playback_perf_user_created
  on public.playback_performance_events (user_id, created_at desc)
  where user_id is not null;

create index if not exists idx_playback_perf_fingerprint_created
  on public.playback_performance_events (fingerprint, created_at desc)
  where fingerprint is not null;

create index if not exists idx_video_play_history_user_updated
  on public.video_play_history (user_id, updated_at desc)
  where user_id is not null;

create index if not exists idx_video_play_history_session_updated
  on public.video_play_history (session_id, updated_at desc)
  where session_id is not null;

comment on table public.playback_performance_events is 'Player telemetry for buffering, quality switches, stream recovery, and playback failure monitoring.';
