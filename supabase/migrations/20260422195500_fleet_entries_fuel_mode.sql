-- Fleet manual module: add fuel_mode to carburant entries (structured vs legacy)
--
-- Principles:
-- - Minimal + incremental: keep existing behavior as default ("structured")
-- - Legacy entries are allowed to be incomplete and must be excluded from structured fuel computations.
-- - We intentionally keep fuel_mode nullable for non-fuel entries.

alter table public.fleet_vehicle_entries
  add column if not exists fuel_mode text;

do $$ begin
  alter table public.fleet_vehicle_entries
    add constraint fleet_vehicle_entries_fuel_mode_check
      check (fuel_mode is null or fuel_mode in ('structured', 'legacy'));
exception when duplicate_object then null; end $$;

-- Backfill existing carburant entries to structured to preserve current behavior.
update public.fleet_vehicle_entries
  set fuel_mode = 'structured'
  where lower(btrim(category)) = 'carburant'
    and fuel_mode is null;

