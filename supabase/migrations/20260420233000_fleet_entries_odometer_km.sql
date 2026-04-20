-- Fleet manual module — Add optional odometer to entries (MVP)
--
-- Goals:
-- - Add an optional odometer_km to fleet_vehicle_entries.
-- - Safe / non-breaking: nullable column + additive check constraint.

alter table public.fleet_vehicle_entries
  add column if not exists odometer_km integer;

do $$ begin
  alter table public.fleet_vehicle_entries
    add constraint fleet_vehicle_entries_odometer_nonneg
      check (odometer_km is null or odometer_km >= 0);
exception when duplicate_object then null; end $$;

