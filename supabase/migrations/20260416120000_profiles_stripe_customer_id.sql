-- Phase 1 (Stripe saved cards foundation):
-- Persist a unique Stripe Customer id per Tukme user (client).
-- This migration is intentionally minimal and non-breaking:
-- - adds a nullable column
-- - adds a unique index (partial) to prevent accidental reuse

alter table public.profiles
  add column if not exists stripe_customer_id text null;

comment on column public.profiles.stripe_customer_id is
  'Stripe Customer id for this user (created on-demand). Do not store card details in Supabase.';

-- Ensure one Stripe customer id cannot be shared across multiple users.
create unique index if not exists profiles_stripe_customer_id_unique
  on public.profiles (stripe_customer_id)
  where stripe_customer_id is not null;

