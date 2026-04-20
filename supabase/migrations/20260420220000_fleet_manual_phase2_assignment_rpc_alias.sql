-- Fleet manual module — PHASE 2 (RPC alias for assignment)
--
-- Goal:
-- - Provide a stable, explicit RPC name for the admin-api assignment operation, without changing
--   the existing implementation.
--
-- Security:
-- - SECURITY DEFINER for admin/service-role usage (RLS enabled on underlying tables).
-- - Revoke EXECUTE from public/anon/authenticated.

create or replace function public.admin_assign_fleet_vehicle_to_driver(
  p_vehicle_id uuid,
  p_driver_id uuid,
  p_starts_at timestamptz default now(),
  p_notes text default null
)
returns uuid
language sql
security definer
set search_path = public
as $$
  select public.admin_fleet_set_vehicle_assignment(
    p_vehicle_id,
    p_driver_id,
    p_starts_at,
    p_notes
  );
$$;

revoke all on function public.admin_assign_fleet_vehicle_to_driver(uuid, uuid, timestamptz, text) from public;
revoke all on function public.admin_assign_fleet_vehicle_to_driver(uuid, uuid, timestamptz, text) from anon;
revoke all on function public.admin_assign_fleet_vehicle_to_driver(uuid, uuid, timestamptz, text) from authenticated;

