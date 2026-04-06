-- Finance MVP schema:
-- - Vehicles ownership (platform vs driver)
-- - Driver↔vehicle assignments (optionally with daily rent)
-- - Ride financial snapshots (commission + driver gross)
-- - Daily rents + manual payouts
-- - Driver ledger entries (credit/debit) with guardrails:
--   1) entry_type ↔ direction coherence
--   2) anti-double: only one ride_earning entry per ride_id

-- ---------------------------------------------------------------------------
-- Enums
-- ---------------------------------------------------------------------------
do $$ begin
  create type public.vehicle_owner_type as enum ('platform', 'driver');
exception when duplicate_object then null; end $$;

do $$ begin
  create type public.driver_ledger_entry_type as enum (
    'ride_earning',
    'daily_rent_due',
    'payout',
    'adjustment'
  );
exception when duplicate_object then null; end $$;

do $$ begin
  create type public.ledger_direction as enum ('credit', 'debit');
exception when duplicate_object then null; end $$;

do $$ begin
  create type public.payout_method as enum ('cash', 'orange_money');
exception when duplicate_object then null; end $$;

do $$ begin
  create type public.payout_status as enum ('recorded', 'sent', 'confirmed', 'cancelled');
exception when duplicate_object then null; end $$;

do $$ begin
  create type public.rent_status as enum ('due', 'paid', 'waived');
exception when duplicate_object then null; end $$;

comment on type public.ledger_direction is
  'Ledger direction: credit increases driver balance; debit decreases it.';

-- ---------------------------------------------------------------------------
-- Shared updated_at trigger (if already exists, keep it)
-- ---------------------------------------------------------------------------
create or replace function public.tg_set_updated_at()
returns trigger
language plpgsql
security invoker
set search_path = public
as $$
begin
  new.updated_at := now();
  return new;
end;
$$;

-- ---------------------------------------------------------------------------
-- Vehicles
-- ---------------------------------------------------------------------------
create table if not exists public.vehicles (
  id uuid primary key default gen_random_uuid(),
  owner_type public.vehicle_owner_type not null,
  owner_driver_id uuid references auth.users (id) on delete set null,
  kind text,
  plate_number text,
  active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint vehicles_owner_driver_check
    check (
      (owner_type = 'driver' and owner_driver_id is not null)
      or (owner_type = 'platform' and owner_driver_id is null)
    )
);

create index if not exists vehicles_owner_type_idx on public.vehicles (owner_type);
create index if not exists vehicles_owner_driver_id_idx
  on public.vehicles (owner_driver_id)
  where owner_driver_id is not null;

drop trigger if exists vehicles_set_updated_at on public.vehicles;
create trigger vehicles_set_updated_at
  before update on public.vehicles
  for each row
  execute function public.tg_set_updated_at();

alter table public.vehicles enable row level security;
revoke all on table public.vehicles from public, anon, authenticated;

comment on table public.vehicles is
  'Vehicles used by drivers. owner_type=platform for fleet vehicles; owner_type=driver for independent vehicles.';

-- ---------------------------------------------------------------------------
-- Driver ↔ vehicle assignments (+ daily rent if platform vehicle)
-- ---------------------------------------------------------------------------
create table if not exists public.driver_vehicle_assignments (
  id uuid primary key default gen_random_uuid(),
  driver_id uuid not null references auth.users (id) on delete cascade,
  vehicle_id uuid not null references public.vehicles (id) on delete restrict,
  starts_at timestamptz not null default now(),
  ends_at timestamptz,
  daily_rent_ariary integer,
  created_at timestamptz not null default now(),
  constraint dva_daily_rent_nonneg
    check (daily_rent_ariary is null or daily_rent_ariary >= 0),
  constraint dva_dates_check
    check (ends_at is null or ends_at > starts_at)
);

create index if not exists dva_driver_id_idx on public.driver_vehicle_assignments (driver_id);
create index if not exists dva_vehicle_id_idx on public.driver_vehicle_assignments (vehicle_id);
create index if not exists dva_active_driver_idx
  on public.driver_vehicle_assignments (driver_id)
  where ends_at is null;

alter table public.driver_vehicle_assignments enable row level security;
revoke all on table public.driver_vehicle_assignments from public, anon, authenticated;

comment on table public.driver_vehicle_assignments is
  'Tracks which vehicle a driver is using over time; daily_rent_ariary is only used for platform-owned vehicles.';

-- ---------------------------------------------------------------------------
-- Ride financial snapshots (frozen at completion)
-- ---------------------------------------------------------------------------
alter table public.rides
  add column if not exists fare_total_ariary integer,
  add column if not exists platform_commission_rate_bps integer not null default 1500,
  add column if not exists platform_commission_ariary integer,
  add column if not exists driver_gross_ariary integer,
  add column if not exists vehicle_id uuid references public.vehicles (id) on delete set null,
  add column if not exists vehicle_owner_type public.vehicle_owner_type;

do $$ begin
  alter table public.rides
    add constraint rides_fare_total_nonneg check (fare_total_ariary is null or fare_total_ariary >= 0);
exception when duplicate_object then null; end $$;

do $$ begin
  alter table public.rides
    add constraint rides_commission_rate_check check (platform_commission_rate_bps >= 0 and platform_commission_rate_bps <= 10000);
exception when duplicate_object then null; end $$;

do $$ begin
  alter table public.rides
    add constraint rides_commission_nonneg check (platform_commission_ariary is null or platform_commission_ariary >= 0);
exception when duplicate_object then null; end $$;

do $$ begin
  alter table public.rides
    add constraint rides_driver_gross_nonneg check (driver_gross_ariary is null or driver_gross_ariary >= 0);
exception when duplicate_object then null; end $$;

create index if not exists rides_driver_completed_at_idx
  on public.rides (driver_id, ride_completed_at desc)
  where driver_id is not null and ride_completed_at is not null;

-- ---------------------------------------------------------------------------
-- Daily rents (separate from rides)
-- ---------------------------------------------------------------------------
create table if not exists public.driver_daily_rents (
  id uuid primary key default gen_random_uuid(),
  driver_id uuid not null references auth.users (id) on delete cascade,
  vehicle_id uuid not null references public.vehicles (id) on delete restrict,
  date date not null,
  rent_ariary integer not null check (rent_ariary >= 0),
  status public.rent_status not null default 'due',
  notes text,
  created_at timestamptz not null default now(),
  constraint driver_daily_rents_unique unique (driver_id, vehicle_id, date)
);

create index if not exists ddr_driver_date_idx on public.driver_daily_rents (driver_id, date desc);

alter table public.driver_daily_rents enable row level security;
revoke all on table public.driver_daily_rents from public, anon, authenticated;

-- ---------------------------------------------------------------------------
-- Manual payouts
-- ---------------------------------------------------------------------------
create table if not exists public.driver_payouts (
  id uuid primary key default gen_random_uuid(),
  driver_id uuid not null references auth.users (id) on delete cascade,
  amount_ariary integer not null check (amount_ariary > 0),
  method public.payout_method not null,
  status public.payout_status not null default 'recorded',
  paid_at timestamptz,
  reference text,
  notes text,
  created_at timestamptz not null default now()
);

create index if not exists dp_driver_paid_at_idx on public.driver_payouts (driver_id, paid_at desc);

alter table public.driver_payouts enable row level security;
revoke all on table public.driver_payouts from public, anon, authenticated;

-- ---------------------------------------------------------------------------
-- Ledger entries (source of truth)
-- Guardrails:
-- 1) entry_type ↔ direction coherence
-- 2) anti-double ride_earning per ride_id (unique index)
-- 3) strong linking expectations for non-adjustment types
-- ---------------------------------------------------------------------------
create table if not exists public.driver_ledger_entries (
  id uuid primary key default gen_random_uuid(),
  driver_id uuid not null references auth.users (id) on delete cascade,
  entry_type public.driver_ledger_entry_type not null,
  direction public.ledger_direction not null,
  amount_ariary integer not null check (amount_ariary > 0),
  effective_date date not null,
  ride_id uuid references public.rides (id) on delete set null,
  daily_rent_id uuid references public.driver_daily_rents (id) on delete set null,
  payout_id uuid references public.driver_payouts (id) on delete set null,
  notes text,
  created_at timestamptz not null default now(),

  constraint dle_entry_type_direction_check
    check (
      (entry_type = 'ride_earning' and direction = 'credit')
      or (entry_type = 'daily_rent_due' and direction = 'debit')
      or (entry_type = 'payout' and direction = 'debit')
      or (entry_type = 'adjustment') -- credit or debit allowed
    ),

  constraint dle_required_links_check
    check (
      (entry_type = 'ride_earning' and ride_id is not null and daily_rent_id is null and payout_id is null)
      or (entry_type = 'daily_rent_due' and daily_rent_id is not null and ride_id is null and payout_id is null)
      or (entry_type = 'payout' and payout_id is not null and ride_id is null and daily_rent_id is null)
      or (entry_type = 'adjustment')
    )
);

create index if not exists dle_driver_date_idx on public.driver_ledger_entries (driver_id, effective_date desc);
create index if not exists dle_ride_id_idx on public.driver_ledger_entries (ride_id) where ride_id is not null;
create index if not exists dle_daily_rent_id_idx on public.driver_ledger_entries (daily_rent_id) where daily_rent_id is not null;
create index if not exists dle_payout_id_idx on public.driver_ledger_entries (payout_id) where payout_id is not null;

-- Guardrail 3: one and only one ride_earning per ride_id.
create unique index if not exists dle_one_ride_earning_per_ride_idx
  on public.driver_ledger_entries (ride_id)
  where entry_type = 'ride_earning' and ride_id is not null;

alter table public.driver_ledger_entries enable row level security;
revoke all on table public.driver_ledger_entries from public, anon, authenticated;

comment on table public.driver_ledger_entries is
  'Driver ledger. Balance definition: driver_balance_ariary = total credits - total debits. Positive means platform owes driver; negative means driver owes platform.';

