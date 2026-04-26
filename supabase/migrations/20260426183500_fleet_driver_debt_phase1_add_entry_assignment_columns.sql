-- Phase 1 (prep only): add nullable columns to attach payable fleet entries
-- to a driver/assignment later, without changing existing logic.
--
-- IMPORTANT:
-- - Additive only (nullable columns, safe indexes, CHECK constraint).
-- - No foreign keys yet (to avoid breaking historical data during backfill).
-- - No backfill here.
-- - No changes to existing endpoints/front/backends; this is DB prep only.

-- ---------------------------------------------------------------------------
-- 1) Add nullable columns on public.fleet_vehicle_entries
-- ---------------------------------------------------------------------------
alter table public.fleet_vehicle_entries
  add column if not exists driver_vehicle_assignment_id uuid null,
  add column if not exists driver_id_snapshot uuid null,
  add column if not exists assignment_resolution_status text null,
  add column if not exists assignment_resolution_note text null;

-- ---------------------------------------------------------------------------
-- 2) CHECK constraint for assignment_resolution_status (nullable)
-- ---------------------------------------------------------------------------
do $$ begin
  alter table public.fleet_vehicle_entries
    add constraint fleet_vehicle_entries_assignment_resolution_status_check
      check (
        assignment_resolution_status is null
        or assignment_resolution_status in ('resolved', 'unassigned', 'ambiguous', 'manual')
      );
exception
  when duplicate_object then null;
end $$;

-- ---------------------------------------------------------------------------
-- 3) Indexes (safe; IF NOT EXISTS)
-- ---------------------------------------------------------------------------
create index if not exists idx_fleet_vehicle_entries_assignment_id
  on public.fleet_vehicle_entries (driver_vehicle_assignment_id);

create index if not exists idx_fleet_vehicle_entries_driver_snapshot
  on public.fleet_vehicle_entries (driver_id_snapshot);

-- entry_date exists in this project and is used as business date for fleet entries.
create index if not exists idx_fleet_vehicle_entries_vehicle_entry_date
  on public.fleet_vehicle_entries (vehicle_id, entry_date);

create index if not exists idx_fleet_vehicle_entries_assignment_status
  on public.fleet_vehicle_entries (assignment_resolution_status);

-- Fast path for payable/open debt candidates by assignment (partial index).
create index if not exists idx_fleet_vehicle_entries_open_payable_assignment
  on public.fleet_vehicle_entries (driver_vehicle_assignment_id)
  where deleted_at is null
    and entry_type = 'income'
    and category in ('carburant', 'loyer');

