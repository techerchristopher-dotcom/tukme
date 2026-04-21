-- Fleet manual module — Fuel theoretical stock foundation
--
-- Design goals:
-- - Additive, non-breaking: all new columns are nullable
-- - Keep "source of truth" as entries (no fixed balance stored)
-- - Prepare vehicle-level defaults and future recharge entries

-- ---------------------------------------------------------------------------
-- 1) Vehicle fuel defaults (used as suggested reference values)
-- ---------------------------------------------------------------------------
alter table public.fleet_vehicles
  add column if not exists fuel_ref_litres numeric,
  add column if not exists fuel_ref_km integer;

do $$ begin
  alter table public.fleet_vehicles
    add constraint fleet_vehicles_fuel_ref_litres_pos
      check (fuel_ref_litres is null or fuel_ref_litres > 0);
exception when duplicate_object then null; end $$;

do $$ begin
  alter table public.fleet_vehicles
    add constraint fleet_vehicles_fuel_ref_km_pos
      check (fuel_ref_km is null or fuel_ref_km > 0);
exception when duplicate_object then null; end $$;

-- ---------------------------------------------------------------------------
-- 2) Entry fields for fuel recharge (category='carburant' + entry_type='expense')
-- ---------------------------------------------------------------------------
alter table public.fleet_vehicle_entries
  add column if not exists fuel_recharge_litres_used numeric,
  add column if not exists fuel_recharge_km_credited_used numeric;

do $$ begin
  alter table public.fleet_vehicle_entries
    add constraint fleet_vehicle_entries_fuel_recharge_litres_pos
      check (fuel_recharge_litres_used is null or fuel_recharge_litres_used > 0);
exception when duplicate_object then null; end $$;

do $$ begin
  alter table public.fleet_vehicle_entries
    add constraint fleet_vehicle_entries_fuel_recharge_km_credited_nonneg
      check (fuel_recharge_km_credited_used is null or fuel_recharge_km_credited_used >= 0);
exception when duplicate_object then null; end $$;

