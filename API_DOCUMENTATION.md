# Platform API & Database Documentation

*Generated on: 2026-05-08 23:58:36*

## Table of Contents
- [API Architecture](#api-architecture)
- [Key Platform Flows](#key-platform-flows)
- [Database Schema (Supabase)](#database-schema-supabase)
- [API Endpoints](#api-endpoints)
- [WebSocket APIs](#websocket-apis)
- [Frontend Integration Notes](#frontend-integration-notes)

## API Architecture
The backend is a Node.js Express application using Supabase for PostgreSQL and Firebase for Realtime Database and Auth. Real-time features are powered by Socket.IO and LiveKit.

### Authentication Flow
1. User logins/signups via `/api/auth`.
2. Server returns a JWT or validates a Firebase ID Token.
3. All subsequent requests must include `Authorization: Bearer <token>`.

## Key Platform Flows
### Creator Approval Flow
1. User submits documents via `/api/auth/apply-creator`.
2. Admin reviews application in the Admin Panel (`/api/admin/applications`).
3. Admin approves/rejects via `/api/admin/applications/:id/status`.
4. If approved, user is granted `creator: true` status and can access `/api/studio`.

### Premium Subscription Flow
1. User selects a plan from `/api/payments/plans`.
2. App calls `/api/payments/checkout` to get a checkout session (Flutterwave for Africa, Paystack internationally).
3. User completes payment on the provider's hosted page.
4. Webhook confirms payment and calls `activatePlan` to update user status.

### Video Publishing Flow
1. Creator prepares upload via `/api/posts/prepare-upload` to get a signed S3 URL.
2. Browser uploads file directly to Supabase Storage.
3. Creator submits metadata and storage path to `/api/posts/publish`.
4. Video is processed and appears in public feeds.

### Live Streaming Flow
1. Creator calls `/api/live/create` to initialize a session.
2. Creator obtains LiveKit token and starts broadcasting.
3. Users join via Socket.IO `join-live` and obtain LiveKit tokens to view.
4. Host ends stream; server calculates final earnings (70% to creator).

## Database Schema (Supabase)

### Tables
#### Table: `public.users`
| Column | Type |
| --- | --- |
| `id` | `text` |
| `balance` | `numeric(18, 2)` |
| `username` | `text` |
| `creator` | `boolean` |
| `verified` | `text` |
| `creator_application` | `jsonb` |
| `followers` | `integer` |
| `created_at` | `timestamptz` |
| `coin_balance` | `integer` |
| `active_plan` | `text` |
| `plan_expires_at` | `timestamptz` |
| `plan_grace_ends_at` | `timestamptz` |
| `email_verified` | `boolean` |
| `email_verified_at` | `timestamptz` |
| `email` | `text` |

#### Table: `public.streams`
| Column | Type |
| --- | --- |
| `id` | `text` |
| `creator_id` | `text` |
| `total_earned` | `numeric(18, 2)` |
| `created_at` | `timestamptz` |

#### Table: `public.stream_donations`
| Column | Type |
| --- | --- |
| `id` | `uuid` |
| `stream_id` | `text` |
| `sender_id` | `text` |
| `creator_id` | `text` |
| `amount` | `numeric(18, 2)` |
| `platform_fee` | `numeric(18, 2)` |
| `creator_earnings` | `numeric(18, 2)` |
| `gift_type` | `text` |
| `created_at` | `timestamptz` |

#### Table: `public.gift_catalog`
| Column | Type |
| --- | --- |
| `gift_type` | `text` |
| `label` | `text` |
| `price` | `numeric(18, 2)` |

#### Table: `public.lives`
| Column | Type |
| --- | --- |
| `id` | `uuid` |
| `host_id` | `text` |
| `host_display_name` | `text` |
| `status` | `text` |
| `viewers_count` | `integer` |
| `total_likes` | `bigint` |
| `total_gifts_amount` | `numeric(12,2)` |
| `created_at` | `timestamptz` |
| `ended_at` | `timestamptz` |

#### Table: `public.live_viewers`
| Column | Type |
| --- | --- |
| `id` | `uuid` |
| `live_id` | `uuid` |
| `user_id` | `text` |
| `joined_at` | `timestamptz` |
| `left_at` | `timestamptz` |
| `is_active` | `boolean` |

#### Table: `public.live_comments`
| Column | Type |
| --- | --- |
| `id` | `uuid` |
| `live_id` | `uuid` |
| `user_id` | `text` |
| `message` | `text` |
| `created_at` | `timestamptz` |

#### Table: `public.live_gifts`
| Column | Type |
| --- | --- |
| `id` | `uuid` |
| `live_id` | `uuid` |
| `sender_id` | `text` |
| `gift_type` | `text` |
| `amount` | `numeric(12,2)` |
| `created_at` | `timestamptz` |
| `token_price` | `numeric` |
| `gift_emoji` | `text` |
| `gift_name` | `text` |
| `sender_name` | `text` |
| `sender_balance_after` | `numeric` |

#### Table: `public.wallets`
| Column | Type |
| --- | --- |
| `id` | `uuid` |
| `owner_id` | `text` |
| `balance` | `numeric(14,2)` |
| `updated_at` | `timestamptz` |

#### Table: `public.creators`
| Column | Type |
| --- | --- |
| `creator_type` | `TEXT` |

#### Table: `public.transactions`
| Column | Type |
| --- | --- |
| `id` | `uuid` |
| `owner_id` | `text` |
| `type` | `text` |
| `amount` | `numeric(14,2)` |
| `balance_after` | `numeric(14,2)` |
| `meta` | `jsonb` |
| `created_at` | `timestamptz` |

#### Table: `public.live_streams`
| Column | Type |
| --- | --- |
| `id` | `uuid` |
| `user_id` | `text` |
| `title` | `text` |
| `status` | `text` |
| `started_at` | `timestamptz` |
| `ended_at` | `timestamptz` |

#### Table: `public.creator_applications`
| Column | Type |
| --- | --- |
| `id` | `uuid` |
| `user_id` | `text` |
| `data` | `jsonb` |
| `status` | `text` |
| `created_at` | `timestamptz` |

#### Table: `public.media`
| Column | Type |
| --- | --- |
| `id` | `text` |
| `user_id` | `text` |
| `bucket` | `text` |
| `path` | `text` |
| `url` | `text` |
| `type` | `text` |
| `title` | `text` |
| `created_at` | `timestamptz` |
| `extra` | `jsonb` |

#### Table: `public.tiktok_videos`
| Column | Type |
| --- | --- |
| `video_id` | `uuid` |
| `user_id` | `text` |
| `storage_url` | `text` |
| `title` | `text` |
| `description` | `text` |
| `likes_count` | `integer` |
| `views_count` | `integer` |
| `comments_count` | `integer` |
| `created_at` | `timestamptz` |

#### Table: `public.tiktok_video_likes`
| Column | Type |
| --- | --- |
| `video_id` | `uuid` |
| `user_id` | `text` |
| `created_at` | `timestamptz` |

#### Table: `public.tiktok_video_views`
| Column | Type |
| --- | --- |
| `id` | `uuid` |
| `video_id` | `uuid` |
| `user_id` | `text` |
| `session_id` | `text` |
| `created_at` | `timestamptz` |

#### Table: `public.tiktok_video_comments`
| Column | Type |
| --- | --- |
| `id` | `uuid` |
| `video_id` | `uuid` |
| `user_id` | `text` |
| `comment` | `text` |
| `created_at` | `timestamptz` |

#### Table: `public.video_play_history`
| Column | Type |
| --- | --- |
| `id` | `uuid` |
| `video_id` | `uuid` |
| `user_id` | `text` |
| `session_id` | `text` |
| `has_seen_ad` | `boolean` |
| `played_at` | `timestamptz` |

#### Table: `public.video_ads`
| Column | Type |
| --- | --- |
| `id` | `uuid` |
| `storage_url` | `text` |
| `title` | `text` |
| `skip_after_seconds` | `integer` |
| `is_active` | `boolean` |
| `created_at` | `timestamptz` |

#### Table: `public.video_ad_impressions`
| Column | Type |
| --- | --- |
| `id` | `uuid` |
| `ad_id` | `uuid` |
| `video_id` | `uuid` |
| `user_id` | `text` |
| `session_id` | `text` |
| `skipped` | `boolean` |
| `created_at` | `timestamptz` |

#### Table: `public.membership_plans`
| Column | Type |
| --- | --- |
| `id` | `text` |
| `name` | `text` |
| `description` | `text` |
| `coins` | `integer` |
| `price_usd` | `numeric(10,2)` |
| `price_ngn` | `numeric(14,2)` |
| `duration_days` | `integer` |
| `is_active` | `boolean` |

#### Table: `public.user_memberships`
| Column | Type |
| --- | --- |
| `id` | `uuid` |
| `user_id` | `text` |
| `plan_id` | `text` |
| `coins_received` | `integer` |
| `status` | `text` |
| `payment_provider` | `text` |
| `started_at` | `timestamptz` |
| `expires_at` | `timestamptz` |
| `grace_ends_at` | `timestamptz` |
| `created_at` | `timestamptz` |

#### Table: `public.creator_earnings`
| Column | Type |
| --- | --- |
| `id` | `uuid` |
| `creator_id` | `text` |
| `amount_usd` | `numeric(12,6)` |
| `source` | `text` |
| `source_id` | `text` |
| `created_at` | `timestamptz` |

#### Table: `public.platform_settings`
| Column | Type |
| --- | --- |
| `key` | `text` |
| `value` | `text` |
| `updated_at` | `timestamptz` |

#### Table: `public.email_verification_tokens`
| Column | Type |
| --- | --- |
| `id` | `uuid` |
| `user_id` | `text` |
| `email` | `text` |
| `token_hash` | `text` |
| `expires_at` | `timestamptz` |
| `used_at` | `timestamptz` |
| `created_at` | `timestamptz` |

#### Table: `public.token_transactions`
| Column | Type |
| --- | --- |
| `id` | `uuid` |
| `user_id` | `text` |
| `type` | `text` |
| `amount` | `numeric` |
| `payment_amount` | `numeric` |
| `payment_currency` | `text` |
| `status` | `text` |
| `reference` | `text` |
| `metadata` | `jsonb` |
| `created_at` | `timestamptz` |

#### Table: `public.ad_campaigns`
| Column | Type |
| --- | --- |
| `title` | `text` |
| `type` | `text` |
| `video_url` | `text` |
| `description` | `text` |
| `id` | `uuid` |
| `name` | `text` |
| `image_url` | `text` |
| `click_url` | `text` |
| `placement` | `text` |
| `is_active` | `boolean` |
| `impressions` | `bigint` |
| `clicks` | `bigint` |
| `budget_usd` | `numeric(12, 4)` |
| `cpc` | `numeric(12, 6)` |
| `revenue_usd` | `numeric(12, 6)` |
| `created_at` | `timestamptz` |
| `updated_at` | `timestamptz` |

### RLS Policies
| Policy Name | Table | Definition |
| --- | --- | --- |
| users_no_client_write | users | `for all using (false) with check (false)` |
| streams_no_client_write | streams | `for all using (false) with check (false)` |
| stream_donations_no_client_write | stream_donations | `for all using (false) with check (false)` |
| gift_catalog_read | gift_catalog | `for select using (true)` |
| plans_public_read | membership_plans | `for select using (is_active = true)` |
| memberships_service_only | user_memberships | `for all using (false) with check (false)` |
| service_role_all_token_transactions | token_transactions | `FOR ALL
  TO service_role USING (true)` |
| service_role_all | ad_campaigns | `as permissive for all
  to service_role
  using (true)
  with check (true)` |
| public_read_active | ad_campaigns | `as permissive for select
  to anon, authenticated
  using (is_active = true)` |

## API Endpoints

### Contentremoval API Section
#### POST `/api/contentRemoval/`
- **Auth:** None
- **Source File:** `src/router/ContentRemoval.route.js`

#### GET `/api/contentRemoval/`
- **Auth:** None
- **Source File:** `src/router/ContentRemoval.route.js`

#### GET `/api/contentRemoval/:id`
- **Auth:** None
- **Source File:** `src/router/ContentRemoval.route.js`

#### PUT `/api/contentRemoval/:id`
- **Auth:** None
- **Source File:** `src/router/ContentRemoval.route.js`

#### DELETE `/api/contentRemoval/:id`
- **Auth:** None
- **Source File:** `src/router/ContentRemoval.route.js`

### Admin API Section
#### POST `/api/admin/auth/founder-create`
- **Auth:** None
- **Source File:** `src/router/admin.route.js`

#### POST `/api/admin/auth/signup`
- **Auth:** None
- **Source File:** `src/router/admin.route.js`

#### POST `/api/admin/auth/activate`
- **Auth:** None
- **Source File:** `src/router/admin.route.js`

#### POST `/api/admin/auth/login`
- **Auth:** None
- **Source File:** `src/router/admin.route.js`

#### GET `/api/admin/invite/verify/:token`
- **Auth:** None
- **Source File:** `src/router/admin.route.js`

#### POST `/api/admin/invite/complete`
- **Auth:** None
- **Source File:** `src/router/admin.route.js`

#### GET `/api/admin/admin-users`
- **Auth:** Required
- **Source File:** `src/router/admin.route.js`

#### POST `/api/admin/invite`
- **Auth:** Required
- **Source File:** `src/router/admin.route.js`

#### DELETE `/api/admin/admin-users/:id`
- **Auth:** Required
- **Source File:** `src/router/admin.route.js`

#### PUT `/api/admin/admin-users/:id/permissions`
- **Auth:** Required
- **Source File:** `src/router/admin.route.js`

### Admincontent API Section
#### GET `/api/admin/content/videos`
- **Auth:** None
- **Source File:** `src/router/adminContent.route.js`

#### GET `/api/admin/content/videos/:id`
- **Auth:** None
- **Source File:** `src/router/adminContent.route.js`

#### PUT `/api/admin/content/videos/:id/status`
- **Auth:** None
- **Source File:** `src/router/adminContent.route.js`

#### DELETE `/api/admin/content/videos/:id`
- **Auth:** None
- **Source File:** `src/router/adminContent.route.js`

#### GET `/api/admin/content/lives`
- **Auth:** None
- **Source File:** `src/router/adminContent.route.js`

#### GET `/api/admin/content/lives/:id`
- **Auth:** None
- **Source File:** `src/router/adminContent.route.js`

#### PUT `/api/admin/content/lives/:id/status`
- **Auth:** None
- **Source File:** `src/router/adminContent.route.js`

#### GET `/api/admin/content/random-sessions`
- **Auth:** None
- **Source File:** `src/router/adminContent.route.js`

#### GET `/api/admin/content/premium-videos`
- **Auth:** None
- **Source File:** `src/router/adminContent.route.js`

### Adminmoderation API Section
#### GET `/api/admin/moderation/reports`
- **Auth:** None
- **Source File:** `src/router/adminModeration.route.js`

#### PUT `/api/admin/moderation/reports/:id`
- **Auth:** None
- **Source File:** `src/router/adminModeration.route.js`

#### GET `/api/admin/moderation/audit-logs`
- **Auth:** None
- **Source File:** `src/router/adminModeration.route.js`

#### GET `/api/admin/moderation/ai-flags`
- **Auth:** None
- **Source File:** `src/router/adminModeration.route.js`

#### PUT `/api/admin/moderation/ai-flags/:id`
- **Auth:** None
- **Source File:** `src/router/adminModeration.route.js`

### Adminsystem API Section
#### GET `/api/admin/system/stats`
- **Auth:** None
- **Source File:** `src/router/adminSystem.route.js`

#### GET `/api/admin/system/settings`
- **Auth:** None
- **Source File:** `src/router/adminSystem.route.js`

#### PUT `/api/admin/system/settings`
- **Auth:** None
- **Source File:** `src/router/adminSystem.route.js`

#### PUT `/api/admin/system/settings/:key`
- **Auth:** None
- **Source File:** `src/router/adminSystem.route.js`

#### GET `/api/admin/system/health`
- **Auth:** None
- **Source File:** `src/router/adminSystem.route.js`

#### GET `/api/admin/system/api-health`
- **Auth:** None
- **Source File:** `src/router/adminSystem.route.js`

#### GET `/api/admin/system/route-latency`
- **Auth:** None
- **Source File:** `src/router/adminSystem.route.js`

#### GET `/api/admin/system/env`
- **Auth:** None
- **Source File:** `src/router/adminSystem.route.js`

#### GET `/api/admin/system/admin-users`
- **Auth:** None
- **Source File:** `src/router/adminSystem.route.js`

#### PUT `/api/admin/system/admin-users/:id/toggle`
- **Auth:** None
- **Source File:** `src/router/adminSystem.route.js`

### Adminusers API Section
#### GET `/api/admin/users`
- **Auth:** Required
- **Source File:** `src/router/adminUsers.route.js`

#### GET `/api/admin/users/:id`
- **Auth:** Required
- **Source File:** `src/router/adminUsers.route.js`

#### PUT `/api/admin/users/:id/status`
- **Auth:** Required
- **Source File:** `src/router/adminUsers.route.js`

#### PUT `/api/admin/users/:id/coins`
- **Auth:** Required
- **Source File:** `src/router/adminUsers.route.js`

#### GET `/api/admin/creators`
- **Auth:** Required
- **Source File:** `src/router/adminUsers.route.js`

#### PUT `/api/admin/creators/:id/status`
- **Auth:** Required
- **Source File:** `src/router/adminUsers.route.js`

#### GET `/api/admin/applications`
- **Auth:** Required
- **Source File:** `src/router/adminUsers.route.js`

#### GET `/api/admin/applications/:id`
- **Auth:** Required
- **Source File:** `src/router/adminUsers.route.js`

#### PUT `/api/admin/applications/:id/status`
- **Auth:** Required
- **Source File:** `src/router/adminUsers.route.js`

#### GET `/api/admin/application-update/:token`
- **Auth:** None
- **Source File:** `src/router/adminUsers.route.js`

#### POST `/api/admin/application-update/:token`
- **Auth:** None
- **Source File:** `src/router/adminUsers.route.js`

### Ads API Section
#### GET `/api/ads/feed`
- **Auth:** None
- **Source File:** `src/router/ads.route.js`

#### GET `/api/ads/sidebar`
- **Auth:** None
- **Source File:** `src/router/ads.route.js`

#### GET `/api/ads/homepage`
- **Auth:** None
- **Source File:** `src/router/ads.route.js`

#### GET `/api/ads/placement/:placement`
- **Auth:** None
- **Source File:** `src/router/ads.route.js`

#### POST `/api/ads/campaign/:adId/click`
- **Auth:** None
- **Source File:** `src/router/ads.route.js`

#### GET `/api/ads/next`
- **Auth:** None
- **Source File:** `src/router/ads.route.js`

#### POST `/api/ads/:adId/impression`
- **Auth:** None
- **Source File:** `src/router/ads.route.js`

#### POST `/api/ads/:adId/click`
- **Auth:** None
- **Source File:** `src/router/ads.route.js`

#### GET `/api/ads/`
- **Auth:** Required
- **Source File:** `src/router/ads.route.js`

#### POST `/api/ads/`
- **Auth:** Required
- **Source File:** `src/router/ads.route.js`

#### PATCH `/api/ads/:adId`
- **Auth:** Required
- **Source File:** `src/router/ads.route.js`

#### DELETE `/api/ads/:adId`
- **Auth:** Required
- **Source File:** `src/router/ads.route.js`

### Auth API Section
#### POST `/api/auth/signup`
- **Auth:** None
- **Source File:** `src/router/auth.route.js`

#### POST `/api/auth/login`
- **Auth:** None
- **Source File:** `src/router/auth.route.js`

#### POST `/api/auth/google`
- **Auth:** None
- **Source File:** `src/router/auth.route.js`

#### POST `/api/auth/age-consent`
- **Auth:** None
- **Source File:** `src/router/auth.route.js`

#### GET `/api/auth/me`
- **Auth:** Required
- **Source File:** `src/router/auth.route.js`

#### POST `/api/auth/verify-email`
- **Auth:** None
- **Source File:** `src/router/auth.route.js`

#### POST `/api/auth/resend-verification-email`
- **Auth:** None
- **Source File:** `src/router/auth.route.js`

#### POST `/api/auth/send-otp`
- **Auth:** None
- **Source File:** `src/router/auth.route.js`

#### POST `/api/auth/verify-otp`
- **Auth:** None
- **Source File:** `src/router/auth.route.js`

#### POST `/api/auth/apply-creator`
- **Auth:** None
- **Source File:** `src/router/auth.route.js`

#### POST `/api/auth/approve-creator`
- **Auth:** None
- **Source File:** `src/router/auth.route.js`

#### POST `/api/auth/media/upload`
- **Auth:** Required
- **Source File:** `src/router/auth.route.js`

### Creatorstudio API Section
#### GET `/api/studio/banks`
- **Auth:** None
- **Source File:** `src/router/creatorStudio.route.js`

#### POST `/api/studio/banks/verify`
- **Auth:** None
- **Source File:** `src/router/creatorStudio.route.js`

#### GET `/api/studio/overview`
- **Auth:** None
- **Source File:** `src/router/creatorStudio.route.js`

#### GET `/api/studio/analytics`
- **Auth:** None
- **Source File:** `src/router/creatorStudio.route.js`

#### GET `/api/studio/videos`
- **Auth:** None
- **Source File:** `src/router/creatorStudio.route.js`

#### GET `/api/studio/earnings`
- **Auth:** None
- **Source File:** `src/router/creatorStudio.route.js`

#### GET `/api/studio/withdrawals`
- **Auth:** None
- **Source File:** `src/router/creatorStudio.route.js`

#### POST `/api/studio/withdrawals`
- **Auth:** None
- **Source File:** `src/router/creatorStudio.route.js`

#### GET `/api/studio/settings`
- **Auth:** None
- **Source File:** `src/router/creatorStudio.route.js`

#### PATCH `/api/studio/settings`
- **Auth:** None
- **Source File:** `src/router/creatorStudio.route.js`

### Creators API Section
#### GET `/api/creators/`
- **Auth:** None
- **Source File:** `src/router/creators.route.js`

#### GET `/api/creators/top`
- **Auth:** None
- **Source File:** `src/router/creators.route.js`

#### GET `/api/creators/platform`
- **Auth:** None
- **Source File:** `src/router/creators.route.js`

#### GET `/api/creators/:slug`
- **Auth:** None
- **Source File:** `src/router/creators.route.js`

### Earnings API Section
#### GET `/api/earnings/`
- **Auth:** Required
- **Source File:** `src/router/earnings.route.js`

#### POST `/api/earnings/rate`
- **Auth:** None
- **Source File:** `src/router/earnings.route.js`

### Finance API Section
#### GET `/api/admin/finance/summary`
- **Auth:** None
- **Source File:** `src/router/finance.route.js`

#### GET `/api/admin/finance/membership-plans`
- **Auth:** None
- **Source File:** `src/router/finance.route.js`

#### POST `/api/admin/finance/membership-plans`
- **Auth:** None
- **Source File:** `src/router/finance.route.js`

#### PUT `/api/admin/finance/membership-plans/:id/toggle`
- **Auth:** None
- **Source File:** `src/router/finance.route.js`

#### DELETE `/api/admin/finance/membership-plans/:id`
- **Auth:** None
- **Source File:** `src/router/finance.route.js`

#### GET `/api/admin/finance/subscribers`
- **Auth:** None
- **Source File:** `src/router/finance.route.js`

#### GET `/api/admin/finance/payments`
- **Auth:** None
- **Source File:** `src/router/finance.route.js`

#### GET `/api/admin/finance/payouts`
- **Auth:** None
- **Source File:** `src/router/finance.route.js`

#### POST `/api/admin/finance/payouts/:id/approve`
- **Auth:** None
- **Source File:** `src/router/finance.route.js`

#### POST `/api/admin/finance/payouts/:id/mark-paid`
- **Auth:** None
- **Source File:** `src/router/finance.route.js`

#### POST `/api/admin/finance/payouts/:id/reject`
- **Auth:** None
- **Source File:** `src/router/finance.route.js`

#### POST `/api/admin/finance/ads/upload-image`
- **Auth:** None
- **Source File:** `src/router/finance.route.js`

#### GET `/api/admin/finance/ads`
- **Auth:** None
- **Source File:** `src/router/finance.route.js`

#### POST `/api/admin/finance/ads`
- **Auth:** None
- **Source File:** `src/router/finance.route.js`

#### PUT `/api/admin/finance/ads/:id`
- **Auth:** None
- **Source File:** `src/router/finance.route.js`

#### DELETE `/api/admin/finance/ads/:id`
- **Auth:** None
- **Source File:** `src/router/finance.route.js`

### Gift API Section
#### GET `/api/gifts/`
- **Auth:** None
- **Source File:** `src/router/gift.route.js`

### Live API Section
#### POST `/api/live/cancel-all`
- **Auth:** None
- **Source File:** `src/router/live.route.js`

#### POST `/api/live/start`
- **Auth:** None
- **Source File:** `src/router/live.route.js`

#### POST `/api/live/join/:sessionId`
- **Auth:** None
- **Source File:** `src/router/live.route.js`

#### POST `/api/live/leave/:sessionId`
- **Auth:** None
- **Source File:** `src/router/live.route.js`

#### POST `/api/live/end/:sessionId`
- **Auth:** None
- **Source File:** `src/router/live.route.js`

#### GET `/api/live/session/:sessionId`
- **Auth:** None
- **Source File:** `src/router/live.route.js`

#### POST `/api/live/create`
- **Auth:** Required
- **Source File:** `src/router/live.route.js`

#### GET `/api/live/my-active`
- **Auth:** Required
- **Source File:** `src/router/live.route.js`

#### POST `/api/live/:id/end`
- **Auth:** Required
- **Source File:** `src/router/live.route.js`

#### POST `/api/live/:id/pause`
- **Auth:** Required
- **Source File:** `src/router/live.route.js`

#### GET `/api/live/`
- **Auth:** None
- **Source File:** `src/router/live.route.js`

#### GET `/api/live/:id`
- **Auth:** None
- **Source File:** `src/router/live.route.js`

### Messages API Section
#### POST `/api/messages/creators/:creatorId`
- **Auth:** Required
- **Source File:** `src/router/messages.route.js`

#### GET `/api/messages/conversations`
- **Auth:** Required
- **Source File:** `src/router/messages.route.js`

#### GET `/api/messages/conversations/:conversationId/messages`
- **Auth:** Required
- **Source File:** `src/router/messages.route.js`

#### PATCH `/api/messages/conversations/:conversationId/read`
- **Auth:** Required
- **Source File:** `src/router/messages.route.js`

### Payment API Section
#### GET `/api/payments/plans`
- **Auth:** None
- **Source File:** `src/router/payment.route.js`

#### GET `/api/payments/membership`
- **Auth:** Required
- **Source File:** `src/router/payment.route.js`

#### POST `/api/payments/checkout`
- **Auth:** Required
- **Source File:** `src/router/payment.route.js`

#### GET `/api/payments/verify/:reference`
- **Auth:** Required
- **Source File:** `src/router/payment.route.js`

#### POST `/api/payments/webhooks/paystack`
- **Auth:** None
- **Source File:** `src/router/payment.route.js`

#### POST `/api/payments/webhooks/flutterwave`
- **Auth:** None (signature via `verif-hash` header)
- **Source File:** `src/router/payment.route.js`

#### GET `/api/payments/region`
- **Auth:** None
- **Query:** `countryCode`, optional `billingCountry`
- **Returns:** `{ provider, providerLabel, countryCode, isAfrica }`

### Pornhub API Section
#### GET `/api/pornhub/video-info`
- **Auth:** None
- **Source File:** `src/router/pornhubRoutes.js`

#### GET `/api/pornhub/search`
- **Auth:** None
- **Source File:** `src/router/pornhubRoutes.js`

#### GET `/api/pornhub/category`
- **Auth:** None
- **Source File:** `src/router/pornhubRoutes.js`

#### GET `/api/pornhub/model`
- **Auth:** None
- **Source File:** `src/router/pornhubRoutes.js`

### Posts API Section
#### GET `/api/posts/`
- **Auth:** Optional
- **Source File:** `src/router/posts.route.js`

#### POST `/api/posts/prepare-upload`
- **Auth:** Required
- **Source File:** `src/router/posts.route.js`

#### POST `/api/posts/publish`
- **Auth:** Required
- **Source File:** `src/router/posts.route.js`

#### POST `/api/posts/`
- **Auth:** Required
- **Source File:** `src/router/posts.route.js`

### Tiktokvideo API Section
#### POST `/upload`
- **Auth:** Required
- **Source File:** `src/router/tiktokVideo.route.js`

#### GET `/feed`
- **Auth:** None
- **Source File:** `src/router/tiktokVideo.route.js`

#### GET `/user/:userId`
- **Auth:** None
- **Source File:** `src/router/tiktokVideo.route.js`

#### DELETE `/comments/:commentId`
- **Auth:** Required
- **Source File:** `src/router/tiktokVideo.route.js`

#### GET `/ads/list`
- **Auth:** None
- **Source File:** `src/router/tiktokVideo.route.js`

#### GET `/:videoId`
- **Auth:** None
- **Source File:** `src/router/tiktokVideo.route.js`

#### GET `/:videoId/playback`
- **Auth:** None
- **Source File:** `src/router/tiktokVideo.route.js`

#### POST `/:videoId/ad-completed`
- **Auth:** None
- **Source File:** `src/router/tiktokVideo.route.js`

#### POST `/:videoId/ad-impression`
- **Auth:** None
- **Source File:** `src/router/tiktokVideo.route.js`

#### GET `/:videoId/like-status`
- **Auth:** None
- **Source File:** `src/router/tiktokVideo.route.js`

#### POST `/:videoId/like`
- **Auth:** Required
- **Source File:** `src/router/tiktokVideo.route.js`

#### DELETE `/:videoId/like`
- **Auth:** Required
- **Source File:** `src/router/tiktokVideo.route.js`

#### POST `/:videoId/view`
- **Auth:** None
- **Source File:** `src/router/tiktokVideo.route.js`

#### GET `/:videoId/comments`
- **Auth:** None
- **Source File:** `src/router/tiktokVideo.route.js`

#### POST `/:videoId/comments`
- **Auth:** Required
- **Source File:** `src/router/tiktokVideo.route.js`

### Tokens API Section
#### GET `/api/tokens/balance`
- **Auth:** Required
- **Source File:** `src/router/tokens.route.js`

#### GET `/api/tokens/packages`
- **Auth:** None
- **Source File:** `src/router/tokens.route.js`

#### POST `/api/tokens/send-gift`
- **Auth:** Required
- **Source File:** `src/router/tokens.route.js`

#### POST `/api/tokens/purchase`
- **Auth:** Required
- **Source File:** `src/router/tokens.route.js`

### Users API Section
#### GET `/api/users/:id`
- **Auth:** None
- **Source File:** `src/router/users.route.js`

#### POST `/api/users/:id/follow`
- **Auth:** Required
- **Source File:** `src/router/users.route.js`

### Videos API Section
#### GET `/api/videos/stream/:id`
- **Auth:** None
- **Source File:** `src/router/videos.route.js`

#### GET `/api/videos/`
- **Auth:** None
- **Source File:** `src/router/videos.route.js`

#### POST `/api/videos/upload`
- **Auth:** Required
- **Source File:** `src/router/videos.route.js`

#### GET `/api/videos/creator-level`
- **Auth:** Required
- **Source File:** `src/router/videos.route.js`

#### GET `/api/videos/public`
- **Auth:** None
- **Source File:** `src/router/videos.route.js`

#### GET `/api/videos/public/:videoId`
- **Auth:** Optional
- **Source File:** `src/router/videos.route.js`

#### DELETE `/api/videos/public/:videoId`
- **Auth:** Required
- **Source File:** `src/router/videos.route.js`

#### PATCH `/api/videos/public/:videoId`
- **Auth:** Required
- **Source File:** `src/router/videos.route.js`

#### PATCH `/api/videos/public/:videoId/draft`
- **Auth:** Required
- **Source File:** `src/router/videos.route.js`

#### GET `/api/videos/public/:videoId/comments`
- **Auth:** None
- **Source File:** `src/router/videos.route.js`

#### POST `/api/videos/public/:videoId/like`
- **Auth:** Required
- **Source File:** `src/router/videos.route.js`

#### DELETE `/api/videos/public/:videoId/like`
- **Auth:** Required
- **Source File:** `src/router/videos.route.js`

#### GET `/api/videos/public/:videoId/like-status`
- **Auth:** None
- **Source File:** `src/router/videos.route.js`

#### POST `/api/videos/public/:videoId/comments`
- **Auth:** Required
- **Source File:** `src/router/videos.route.js`

#### POST `/api/videos/public/:videoId/view`
- **Auth:** Optional
- **Source File:** `src/router/videos.route.js`

#### POST `/api/videos/public/:videoId/purchase`
- **Auth:** Required
- **Source File:** `src/router/videos.route.js`

#### GET `/api/videos/public/:videoId/purchase-status`
- **Auth:** Required
- **Source File:** `src/router/videos.route.js`

#### GET `/api/videos/search/pornstar`
- **Auth:** None
- **Source File:** `src/router/videos.route.js`

#### GET `/api/videos/search`
- **Auth:** None
- **Source File:** `src/router/videos.route.js`

#### GET `/api/videos/trending`
- **Auth:** None
- **Source File:** `src/router/videos.route.js`

#### GET `/api/videos/home-feed`
- **Auth:** None
- **Source File:** `src/router/videos.route.js`

#### GET `/api/videos/todays-selection`
- **Auth:** None
- **Source File:** `src/router/videos.route.js`

#### GET `/api/videos/pornstars`
- **Auth:** None
- **Source File:** `src/router/videos.route.js`

#### GET `/api/videos/:videoId/like-status`
- **Auth:** None
- **Source File:** `src/router/videos.route.js`

#### POST `/api/videos/:videoId/like`
- **Auth:** Required
- **Source File:** `src/router/videos.route.js`

#### DELETE `/api/videos/:videoId/like`
- **Auth:** Required
- **Source File:** `src/router/videos.route.js`

#### GET `/api/videos/:videoId/comments`
- **Auth:** None
- **Source File:** `src/router/videos.route.js`

#### POST `/api/videos/:videoId/comments`
- **Auth:** Required
- **Source File:** `src/router/videos.route.js`

#### GET `/api/videos/:id`
- **Auth:** None
- **Source File:** `src/router/videos.route.js`

## WebSocket APIs

### Incoming Events (Client -> Server)
| Event | Params |
| --- | --- |
| `join-live` | `{ liveId }` |
| `leave-live` | `{ liveId }` |
| `like-live` | `{ liveId }` |
| `comment-live` | `{ liveId, message, authorName }` |
| `gift-live` | `{ liveId, giftType, quantity, amount, name, emoji, senderName, tokenPaid }` |
| `end-live` | `{ liveId }` |
| `pause-live` | `{ liveId }` |
| `resume-live` | `{ liveId }` |
| `chat:find-match` | `{ gender = 'any' } = {}` |
| `chat:cancel` | `` |
| `chat:signal` | `{ roomId, signal } = {}` |
| `chat:next` | `{ roomId } = {}` |
| `chat:leave` | `{ roomId } = {}` |
| `chat:message` | `{ roomId, text } = {}` |
| `live:host-register` | `{ liveId } = {}` |
| `live:thumbnail-update` | `{ liveId, thumbnail } = {}` |
| `disconnect` | `` |

### Outgoing Events (Server -> Client)
| Event | Payload |
| --- | --- |
| `update-viewers` | `{ viewersCount }` |
| `user_joined` | `{ userId, viewersCount }` |
| `error` | `{ message: String(err` |
| `update-viewers` | `{ viewersCount }` |
| `user_left` | `{ userId, viewersCount }` |
| `error` | `{ message: String(err` |
| `update-likes` | `{ totalLikes: live?.total_likes || 0 }` |
| `new-comment` | `enriched` |
| `error` | `{ message: 'Sign in to send gifts' }` |
| `error` | `{ message: String(payErr?.message || payErr` |
| `error` | `{ message: String(err?.message || err` |
| `error` | `{ message: 'Only the host can end this live stream' }` |
| `live_ended` | `{ sessionId: liveId, payout }` |
| `live-ended` | `payout` |
| `live_ended` | `{ sessionId: liveId, payout }` |
| `error` | `{ message: String(err?.message || err` |
| `error` | `{ message: 'Only the host can pause this live stream' }` |
| `live-paused` | `{ liveId }` |
| `error` | `{ message: 'Only the host can resume this live stream' }` |
| `live-resumed` | `{ liveId }` |
| `chat:matched` | `{ roomId, initiator: true, peerId: peerUserId }` |
| `chat:matched` | `{ roomId, initiator: false, peerId: userId }` |
| `chat:error` | `{ message: String(err?.message || err` |
| `chat:signal` | `{ signal, fromId: socket.uid }` |
| `chat:peer-left` | `{ roomId }` |
| `chat:ended` | `{ roomId }` |
| `chat:error` | `{ message: String(err?.message || err` |
| `chat:peer-left` | `{ roomId }` |
| `chat:ended` | `{ roomId }` |
| `live:thumbnail-update` | `{ liveId, thumbnail }` |
| `update-viewers` | `{ viewersCount }` |
| `chat:peer-left` | `{ roomId }` |

## Frontend Integration Notes
- **Pagination:** Listings use `page` and `limit`. Default limit is usually 20.
- **Authentication:** Store JWT in LocalStorage and send in `Authorization: Bearer <token>`.
- **Real-time:** Use `socket.io-client` to connect to the base URL with auth token.
- **Environment Variables:** Production API is at `https://api.xstreamvideos.site/api`.
