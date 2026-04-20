-- Suivi du parc — PHASE 1 (DB only)
-- Goals:
-- 1) Enrich vehicles as financial assets (minimal, nullable)
-- 2) Add a simple vehicle expenses table (admin-only via service role / admin API)
-- 3) Ensure rides are explicitly attachable to vehicles (already present in schema; add index + safe backfill)
--
-- Safety principles:
-- - No breaking changes (all new columns nullable / additive).
-- - Do not open new client access (RLS enabled, no new policies; keep admin-only access patterns).
-- - Conservative backfill: only set rides.vehicle_id when driver→vehicle assignment is unambiguous at ride time.

-- ---------------------------------------------------------------------------
-- 1) Extend public.vehicles (asset metadata)
-- ---------------------------------------------------------------------------
alter table public.vehicles
  add column if not exists purchase_price_ariary integer,
  add column if not exists purchase_date date,
  add column if not exists amortization_months integer,
  add column if not exists target_resale_price_ariary integer;

do $$ begin
  alter table public.vehicles
    add constraint vehicles_purchase_price_nonneg
      check (purchase_price_ariary is null or purchase_price_ariary >= 0);
exception when duplicate_object then null; end $$;

do $$ begin
  alter table public.vehicles
    add constraint vehicles_target_resale_price_nonneg
      check (target_resale_price_ariary is null or target_resale_price_ariary >= 0);
exception when duplicate_object then null; end $$;

do $$ begin
  alter table public.vehicles
    add constraint vehicles_amortization_months_pos
      check (amortization_months is null or amortization_months > 0);
exception when duplicate_object then null; end $$;

-- Optional cross-field sanity: resale cannot exceed purchase when both known.
do $$ begin
  alter table public.vehicles
    add constraint vehicles_resale_le_purchase
      check (
        purchase_price_ariary is null
        or target_resale_price_ariary is null
        or target_resale_price_ariary <= purchase_price_ariary
      );
exception when duplicate_object then null; end $$;

comment on column public.vehicles.purchase_price_ariary is
  'Purchase price of the vehicle in Ariary (nullable for legacy rows).';
comment on column public.vehicles.purchase_date is
  'Purchase date of the vehicle (nullable for legacy rows).';
comment on column public.vehicles.amortization_months is
  'Desired amortization duration in months (nullable for legacy rows).';
comment on column public.vehicles.target_resale_price_ariary is
  'Optional target resale price in Ariary (nullable).';

-- ---------------------------------------------------------------------------
-- 2) Create public.vehicle_expenses (simple vehicle OPEX)
-- ---------------------------------------------------------------------------
create table if not exists public.vehicle_expenses (
  id uuid primary key default gen_random_uuid(),
  vehicle_id uuid not null references public.vehicles (id) on delete restrict,
  amount_ariary integer not null check (amount_ariary > 0),
  label text not null,
  expense_date date not null,
  category text not null,
  notes text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint vehicle_expenses_label_nonempty check (btrim(label) <> ''),
  constraint vehicle_expenses_category_nonempty check (btrim(category) <> '')
);

comment on table public.vehicle_expenses is
  'Vehicle expenses (OPEX) tracked for fleet reporting. Admin-only access via service role.';

create index if not exists vehicle_expenses_vehicle_date_idx
  on public.vehicle_expenses (vehicle_id, expense_date desc);

create index if not exists vehicle_expenses_category_date_idx
  on public.vehicle_expenses (category, expense_date desc);

-- Keep conventions consistent with existing tables (updated_at maintained by tg_set_updated_at).
drop trigger if exists vehicle_expenses_set_updated_at on public.vehicle_expenses;
create trigger vehicle_expenses_set_updated_at
  before update on public.vehicle_expenses
  for each row
  execute function public.tg_set_updated_at();

alter table public.vehicle_expenses enable row level security;
revoke all on table public.vehicle_expenses from public, anon, authenticated;

-- ---------------------------------------------------------------------------
-- 3) Rides ↔ vehicle link (index + conservative backfill)
-- Notes:
-- - public.rides.vehicle_id already exists (introduced by finance_mvp_schema).
-- - Ensure we have an index for vehicle-based reporting.
-- ---------------------------------------------------------------------------
create index if not exists rides_vehicle_id_idx
  on public.rides (vehicle_id)
  where vehicle_id is not null;

-- Conservative backfill strategy:
-- - Only update rides where vehicle_id is NULL and driver_id is present.
-- - Use ride_completed_at if available; else ride_started_at; else created_at as the event timestamp.
-- - Set vehicle_id only when exactly ONE assignment matches for that driver at that timestamp.
-- - If no matching assignment or ambiguous (0 or >1), leave NULL.
with candidate as (
  select
    r.id as ride_id,
    (
      select a.vehicle_id
      from public.driver_vehicle_assignments a
      where a.driver_id = r.driver_id
        and a.starts_at <= coalesce(r.ride_completed_at, r.ride_started_at, r.created_at)
        and (a.ends_at is null or a.ends_at > coalesce(r.ride_completed_at, r.ride_started_at, r.created_at))
      group by a.vehicle_id
      having count(*) = 1
    ) as inferred_vehicle_id
  from public.rides r
  where r.vehicle_id is null
    and r.driver_id is not null
)
update public.rides r
set vehicle_id = c.inferred_vehicle_id
from candidate c
where r.id = c.ride_id
  and c.inferred_vehicle_id is not null
  and r.vehicle_id is null;

