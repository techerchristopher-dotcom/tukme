-- Fleet manual module — Extend entries for:
-- - soft delete + minimal audit
-- - future "calculated" entries (fuel snapshot fields)
--
-- Design goals:
-- - Additive, non-breaking for existing entry creation/listing
-- - Preserve current aggregates semantics by allowing queries to exclude soft-deleted rows
-- - Store "values actually used" on each fuel entry (snapshot), independent of future defaults

-- ---------------------------------------------------------------------------
-- 1) Soft delete + update audit
-- ---------------------------------------------------------------------------
alter table public.fleet_vehicle_entries
  add column if not exists updated_at timestamptz not null default now(),
  add column if not exists updated_by text,
  add column if not exists deleted_at timestamptz,
  add column if not exists deleted_by text,
  add column if not exists delete_reason text;

-- Maintain updated_at automatically on UPDATE (same pattern as fleet_vehicles).
drop trigger if exists fleet_vehicle_entries_set_updated_at on public.fleet_vehicle_entries;
create trigger fleet_vehicle_entries_set_updated_at
  before update on public.fleet_vehicle_entries
  for each row
  execute function public.tg_set_updated_at();

-- Soft delete invariants.
do $$ begin
  alter table public.fleet_vehicle_entries
    add constraint fleet_vehicle_entries_deleted_by_requires_deleted_at
      check (deleted_by is null or deleted_at is not null);
exception when duplicate_object then null; end $$;

-- Index to support "active entries only" queries (most UI/aggregates).
create index if not exists fve_vehicle_date_active_idx
  on public.fleet_vehicle_entries (vehicle_id, entry_date desc, created_at desc)
  where deleted_at is null;

-- ---------------------------------------------------------------------------
-- 2) Fuel snapshot fields (values actually used + computed results)
-- ---------------------------------------------------------------------------
alter table public.fleet_vehicle_entries
  add column if not exists fuel_km_start integer,
  add column if not exists fuel_km_end integer,
  add column if not exists fuel_km_travelled integer,
  add column if not exists fuel_price_per_litre_ariary_used integer,
  add column if not exists fuel_consumption_l_per_km_used numeric,
  add column if not exists fuel_due_ariary integer;

do $$ begin
  alter table public.fleet_vehicle_entries
    add constraint fleet_vehicle_entries_fuel_km_start_nonneg
      check (fuel_km_start is null or fuel_km_start >= 0);
exception when duplicate_object then null; end $$;

do $$ begin
  alter table public.fleet_vehicle_entries
    add constraint fleet_vehicle_entries_fuel_km_end_nonneg
      check (fuel_km_end is null or fuel_km_end >= 0);
exception when duplicate_object then null; end $$;

do $$ begin
  alter table public.fleet_vehicle_entries
    add constraint fleet_vehicle_entries_fuel_km_travelled_nonneg
      check (fuel_km_travelled is null or fuel_km_travelled >= 0);
exception when duplicate_object then null; end $$;

do $$ begin
  alter table public.fleet_vehicle_entries
    add constraint fleet_vehicle_entries_fuel_price_per_litre_pos
      check (fuel_price_per_litre_ariary_used is null or fuel_price_per_litre_ariary_used > 0);
exception when duplicate_object then null; end $$;

do $$ begin
  alter table public.fleet_vehicle_entries
    add constraint fleet_vehicle_entries_fuel_consumption_pos
      check (fuel_consumption_l_per_km_used is null or fuel_consumption_l_per_km_used > 0);
exception when duplicate_object then null; end $$;

do $$ begin
  alter table public.fleet_vehicle_entries
    add constraint fleet_vehicle_entries_fuel_due_nonneg
      check (fuel_due_ariary is null or fuel_due_ariary >= 0);
exception when duplicate_object then null; end $$;

-- Consistency guardrails (nullable-friendly):
-- - If both start/end are set, end must be >= start.
do $$ begin
  alter table public.fleet_vehicle_entries
    add constraint fleet_vehicle_entries_fuel_end_gte_start
      check (
        fuel_km_start is null
        or fuel_km_end is null
        or fuel_km_end >= fuel_km_start
      );
exception when duplicate_object then null; end $$;

-- - If travelled is set alongside start/end, it must match (end - start).
do $$ begin
  alter table public.fleet_vehicle_entries
    add constraint fleet_vehicle_entries_fuel_travelled_matches
      check (
        fuel_km_travelled is null
        or fuel_km_start is null
        or fuel_km_end is null
        or fuel_km_travelled = (fuel_km_end - fuel_km_start)
      );
exception when duplicate_object then null; end $$;

-- - If fuel_due_ariary is present, it should remain compatible with the journal amount.
--   This is a "best-effort" check (nullable-friendly) and does NOT enforce category='carburant' yet.
do $$ begin
  alter table public.fleet_vehicle_entries
    add constraint fleet_vehicle_entries_fuel_due_matches_amount
      check (fuel_due_ariary is null or fuel_due_ariary = amount_ariary);
exception when duplicate_object then null; end $$;

