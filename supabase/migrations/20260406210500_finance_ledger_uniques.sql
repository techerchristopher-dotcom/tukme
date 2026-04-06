-- Add idempotency guardrails for ledger entries beyond rides.
-- - one daily_rent_due per daily_rent_id
-- - one payout per payout_id

create unique index if not exists dle_one_daily_rent_due_per_rent_idx
  on public.driver_ledger_entries (daily_rent_id)
  where entry_type = 'daily_rent_due' and daily_rent_id is not null;

create unique index if not exists dle_one_payout_entry_per_payout_idx
  on public.driver_ledger_entries (payout_id)
  where entry_type = 'payout' and payout_id is not null;

