-- Fleet manual module (Suivi du parc) — PHASE 1 (DB only)
--
-- Design principles:
-- - Fully decoupled from operational app: NO link to rides / payouts / driver ledger tables.
-- - Manual-only finance: all vehicle financials come from fleet_vehicle_entries.
-- - Safe, additive, production-friendly: create-if-not-exists, nullable where appropriate.
-- - Admin-only access pattern: RLS enabled + no policies + revoke to anon/authenticated.
--
-- Dependencies / conventions (already present in this project):
-- - UUIDs: gen_random_uuid() (pgcrypto)
-- - updated_at maintenance: public.tg_set_updated_at()
-- - Overlap constraints: btree_gist extension (create if missing)

create extension if not exists btree_gist with schema extensions;

-- ---------------------------------------------------------------------------
-- 1) fleet_vehicles
-- ---------------------------------------------------------------------------
create table if not exists public.fleet_vehicles (
  id uuid primary key default gen_random_uuid(),

  plate_number text not null,
  brand text,
  model text,

  status text not null default 'active',

  purchase_price_ariary integer,
  purchase_date date,
  amortization_months integer,
  target_resale_price_ariary integer,
  daily_rent_ariary integer,

  notes text,

  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),

  constraint fleet_vehicles_plate_nonempty check (btrim(plate_number) <> ''),
  constraint fleet_vehicles_status_check check (status in ('active', 'inactive', 'sold', 'retired')),
  constraint fleet_vehicles_purchase_price_nonneg check (purchase_price_ariary is null or purchase_price_ariary >= 0),
  constraint fleet_vehicles_target_resale_nonneg check (target_resale_price_ariary is null or target_resale_price_ariary >= 0),
  constraint fleet_vehicles_daily_rent_nonneg check (daily_rent_ariary is null or daily_rent_ariary >= 0),
  constraint fleet_vehicles_amort_months_pos check (amortization_months is null or amortization_months > 0),
  constraint fleet_vehicles_resale_le_purchase check (
    purchase_price_ariary is null
    or target_resale_price_ariary is null
    or target_resale_price_ariary <= purchase_price_ariary
  )
);

-- Plate is the business identifier in admin; make it unique (case-insensitive via lower()).
create unique index if not exists fleet_vehicles_plate_unique_idx
  on public.fleet_vehicles (lower(btrim(plate_number)));

create index if not exists fleet_vehicles_status_idx
  on public.fleet_vehicles (status);

drop trigger if exists fleet_vehicles_set_updated_at on public.fleet_vehicles;
create trigger fleet_vehicles_set_updated_at
  before update on public.fleet_vehicles
  for each row
  execute function public.tg_set_updated_at();

alter table public.fleet_vehicles enable row level security;
revoke all on table public.fleet_vehicles from public, anon, authenticated;

comment on table public.fleet_vehicles is
  'Manual fleet vehicles (internal admin tool). Decoupled from operational app tables.';

-- ---------------------------------------------------------------------------
-- 2) fleet_vehicle_assignments (vehicle ↔ driver profile)
--    Reuse public.profiles as driver directory (allowed by product decision).
-- ---------------------------------------------------------------------------
create table if not exists public.fleet_vehicle_assignments (
  id uuid primary key default gen_random_uuid(),
  vehicle_id uuid not null references public.fleet_vehicles (id) on delete restrict,
  driver_id uuid not null references public.profiles (id) on delete restrict,
  starts_at timestamptz not null default now(),
  ends_at timestamptz,
  notes text,
  created_at timestamptz not null default now(),

  constraint fva_dates_check check (ends_at is null or ends_at > starts_at)
);

create index if not exists fva_vehicle_id_idx on public.fleet_vehicle_assignments (vehicle_id);
create index if not exists fva_driver_id_idx on public.fleet_vehicle_assignments (driver_id);
create index if not exists fva_vehicle_starts_at_idx on public.fleet_vehicle_assignments (vehicle_id, starts_at desc);

-- Guardrail: at most one active assignment per vehicle.
create unique index if not exists fva_one_active_per_vehicle_idx
  on public.fleet_vehicle_assignments (vehicle_id)
  where ends_at is null;

-- Guardrail: no overlapping assignment windows per vehicle (including open-ended).
do $$ begin
  alter table public.fleet_vehicle_assignments
    add constraint fva_no_overlap_per_vehicle
      exclude using gist (
        vehicle_id with =,
        tstzrange(starts_at, coalesce(ends_at, 'infinity'::timestamptz), '[)') with &&
      );
exception when duplicate_object then null; end $$;

alter table public.fleet_vehicle_assignments enable row level security;
revoke all on table public.fleet_vehicle_assignments from public, anon, authenticated;

comment on table public.fleet_vehicle_assignments is
  'Manual fleet assignments: link a fleet vehicle to an operational profile (driver) for internal tracking.';

-- NOTE (intentional): we do NOT enforce "one active vehicle per driver" in MVP,
-- because operations may require temporary multi-vehicle tracking; can be added later if needed.

-- ---------------------------------------------------------------------------
-- 3) fleet_vehicle_entries (manual finance journal)
-- ---------------------------------------------------------------------------
create table if not exists public.fleet_vehicle_entries (
  id uuid primary key default gen_random_uuid(),
  vehicle_id uuid not null references public.fleet_vehicles (id) on delete restrict,

  entry_type text not null,
  amount_ariary integer not null check (amount_ariary > 0),
  entry_date date not null,
  category text not null,
  label text not null,
  notes text,

  created_at timestamptz not null default now(),

  constraint fve_entry_type_check check (entry_type in ('income', 'expense')),
  constraint fve_category_nonempty check (btrim(category) <> ''),
  constraint fve_label_nonempty check (btrim(label) <> '')
);

create index if not exists fve_vehicle_date_idx
  on public.fleet_vehicle_entries (vehicle_id, entry_date desc, created_at desc);

create index if not exists fve_vehicle_type_date_idx
  on public.fleet_vehicle_entries (vehicle_id, entry_type, entry_date desc);

alter table public.fleet_vehicle_entries enable row level security;
revoke all on table public.fleet_vehicle_entries from public, anon, authenticated;

comment on table public.fleet_vehicle_entries is
  'Manual finance journal for fleet vehicles. Source of truth for fleet financial calculations (no rides sync).';

