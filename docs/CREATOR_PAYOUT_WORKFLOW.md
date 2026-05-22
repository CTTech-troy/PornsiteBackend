# Creator Payout Workflow

This workflow lets creators request withdrawals, admins approve or reject them, and the finance team complete or fail the payout with a full audit trail.

## Folder Structure

```txt
backend/
  src/
    controller/
      adminFinance.controller.js
      creatorStudio.controller.js
      payoutWorkflow.controller.js
    middleware/
      adminAuth.js
      qstashSignature.middleware.js
    router/
      creatorStudio.route.js
      finance.route.js
      payoutWorkflow.route.js
    services/
      payoutWorkflow.service.js
      financePayoutEvents.service.js
    config/
      qstash.js
  scripts/
    create-qstash-payout-workflows.mjs
  supabase/migrations/
    20260521130000_creator_payout_workflow.sql
  docs/
    CREATOR_PAYOUT_WORKFLOW.md

admin/
  src/
    api/financeApi.ts
    pages/CreatorPayouts.tsx
    pages/FinanceHub.tsx

frontend/
  src/components/studio/
    StudioEarnings.jsx
    StudioWithdrawals.jsx
```

## Environment Variables

Add these values in Render and in local `.env` when testing:

```env
QSTASH_TOKEN=
QSTASH_CURRENT_SIGNING_KEY=
QSTASH_NEXT_SIGNING_KEY=
RENDER_BACKEND_URL=https://your-render-service.onrender.com

QSTASH_PAYOUT_VERIFY_CRON=*/15 * * * *
QSTASH_PAYOUT_DAILY_SUMMARY_CRON=10 0 * * *
QSTASH_PAYOUT_RETRIES=5
QSTASH_PAYOUT_RETRY_DELAY=120s
QSTASH_PAYOUT_ASSIGN_DELAY_SECONDS=30

PAYOUT_LARGE_WITHDRAWAL_USD=500
PAYOUT_ANALYTICS_CACHE_TTL_SECONDS=30
SUPABASE_PAYOUT_PROOF_BUCKET=payout-proofs
```

`QSTASH_CURRENT_SIGNING_KEY` and `QSTASH_NEXT_SIGNING_KEY` must come from the Upstash QStash dashboard. Never expose them to the browser.

## Database

Run the Supabase migration:

```bash
supabase db push
```

The migration creates:

- wallet payout lock columns
- payout requests and payout transaction records
- creator and finance notification records
- payout audit logs
- daily payout summary rows
- database functions for atomic withdrawal requests and status transitions
- Redis-backed short-lived analytics caching for admin finance dashboards

Important balance rules are enforced inside PostgreSQL functions:

- pending withdrawals reduce available balance immediately
- active duplicate withdrawals are blocked per creator
- failed or rejected payouts restore locked funds
- completed payouts move funds to withdrawn balance
- row locks prevent race conditions and negative balances

## API Workflow

Creator:

```txt
POST /api/creator-studio/withdrawals
GET  /api/creator-studio/withdrawals
GET  /api/creator-studio/earnings
```

Admin and finance:

```txt
GET  /api/admin/finance/payouts
GET  /api/admin/finance/payouts/analytics
GET  /api/admin/finance/payouts/export.csv
POST /api/admin/finance/payouts/:id/approve
POST /api/admin/finance/payouts/:id/reject
POST /api/admin/finance/payouts/:id/mark-processing
POST /api/admin/finance/payouts/:id/mark-paid
POST /api/admin/finance/payouts/:id/mark-failed
POST /api/admin/finance/payouts/:id/retry
POST /api/admin/finance/payouts/:id/proof
```

Internal QStash webhooks:

```txt
POST /api/internal/qstash/payouts/notify
POST /api/internal/qstash/payouts/assign-finance
POST /api/internal/qstash/payouts/verify
POST /api/internal/qstash/payouts/verify-due
POST /api/internal/qstash/payouts/audit
POST /api/internal/qstash/payouts/daily-summary
POST /api/internal/qstash/payouts/failure
```

Internal endpoints use raw request bodies and QStash signature verification. They should not be called from the frontend.

## QStash Setup

Create the scheduled payout workflows:

```bash
cd backend
npm run qstash:create-payouts
```

This registers:

- due payout verification every 15 minutes by default
- daily payout summary generation once per day

Runtime actions also publish QStash jobs for:

- creator notifications
- finance assignment
- audit event processing
- payout verification
- failed payout retries

## Frontend Flow

Creator dashboard:

```txt
Request withdrawal -> status pending -> admin approval -> finance processing -> completed
```

The creator sees:

- available balance
- pending balance
- processing balance
- withdrawn balance
- payment method
- transaction ID
- request date
- completed date
- "Payment processing may take up to 24 hours"

Admin dashboard:

- filter and search payout requests
- approve, reject, mark processing, fail, or retry
- view risk score and risk flags
- review payout analytics

Finance Hub:

- process approved payouts
- upload proof of payment
- add transaction references
- complete, fail, or retry payouts
- export payout CSV reports

## Testing

1. Start the backend:

```bash
cd backend
npm run dev
```

2. Log in as a creator and submit a withdrawal.

3. Verify the database:

```sql
select id, creator_id, amount_usd, status, risk_score
from creator_payout_requests
order by requested_at desc
limit 5;

select owner_id, balance, pending_payout_balance, processing_payout_balance, withdrawn_payout_balance
from wallets
where owner_id = '<creator-user-id>';
```

4. Log in to the admin panel and approve the payout under Creator Payouts.

5. Open Finance Hub and mark the payout as processing, then complete it with a transaction reference or uploaded proof.

6. Confirm final state:

```sql
select status, transaction_reference, completed_at
from creator_payout_requests
where id = '<payout-id>';

select *
from payout_audit_logs
where payout_request_id = '<payout-id>'
order by created_at;
```

## Production Deployment

1. Add all QStash and Supabase env vars in Render.
2. Set `BACKEND_PUBLIC_URL` to the public HTTPS Render URL.
3. Deploy backend first.
4. Run database migrations.
5. Run `npm run qstash:create-payouts` once after deploy.
6. Deploy admin and frontend.
7. Test one low-value payout in production before enabling large withdrawals.

## Security Notes

- Only authenticated creators can request withdrawals.
- Only admins with finance access can use finance routes.
- QStash routes reject unsigned requests.
- Active duplicate withdrawals are blocked at the database level.
- Balance changes happen inside database transactions.
- Proof uploads are capped at 5 MB.
- Every state change creates audit records and realtime events.

## Troubleshooting

- `QStash signature verification failed`: confirm current and next signing keys in Render.
- Payout stays approved: run `npm run qstash:create-payouts` and confirm `BACKEND_PUBLIC_URL`.
- Creator available balance looks wrong: check wallet payout columns and active payout statuses.
- Proof upload fails: confirm `SUPABASE_PAYOUT_PROOF_BUCKET` exists and allows service-role uploads.
- Finance stream disconnects: verify admin token and finance permissions.
