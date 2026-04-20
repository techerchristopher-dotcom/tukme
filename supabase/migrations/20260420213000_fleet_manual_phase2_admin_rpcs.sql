-- Fleet manual module (Suivi du parc) — PHASE 2 (Admin API helpers)
--
-- Goals:
-- - Provide small, atomic server-side primitives for the admin-api:
--   1) (Re)assign a driver to a fleet vehicle safely (close active + insert new).
--   2) Compute lightweight financial aggregates for a list of fleet vehicles, sourced ONLY from fleet_vehicle_entries.
--
-- Security:
-- - Functions are SECURITY DEFINER to allow service-role/admin-api execution with RLS enabled on tables.
-- - Explicitly revoke EXECUTE from public/anon/authenticated.

create extension if not exists btree_gist with schema extensions;

-- ---------------------------------------------------------------------------
-- 1) Atomic manual fleet assignment RPC
-- ---------------------------------------------------------------------------
create or replace function public.admin_fleet_set_vehicle_assignment(
  p_vehicle_id uuid,
  p_driver_id uuid,
  p_starts_at timestamptz default now(),
  p_notes text default null
)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  v_assignment_id uuid;
  v_is_driver boolean;
begin
  if p_vehicle_id is null or p_driver_id is null then
    raise exception 'vehicle_id and driver_id are required';
  end if;

  if p_starts_at is null then
    raise exception 'starts_at is required';
  end if;

  -- Basic guard: ensure the profile is a driver (consistent with other admin RPCs).
  select exists (
    select 1
    from public.profiles p
    where p.id = p_driver_id and p.role = 'driver'
  ) into v_is_driver;
  if not v_is_driver then
    raise exception 'driver_id is not a driver profile';
  end if;

  -- Serialize by vehicle to avoid races (double active assignment / overlap).
  perform pg_advisory_xact_lock(hashtext(p_vehicle_id::text));

  -- Close any active assignment for this vehicle (only if it started strictly before p_starts_at).
  update public.fleet_vehicle_assignments
    set ends_at = p_starts_at
  where vehicle_id = p_vehicle_id
    and ends_at is null
    and starts_at < p_starts_at;

  -- Refuse overlaps for a clear error (constraint also protects, but this message is nicer).
  if exists (
    select 1
    from public.fleet_vehicle_assignments a
    where a.vehicle_id = p_vehicle_id
      and tstzrange(a.starts_at, coalesce(a.ends_at, 'infinity'::timestamptz), '[)')
          && tstzrange(p_starts_at, 'infinity'::timestamptz, '[)')
  ) then
    raise exception 'Cannot assign: would overlap an existing assignment (or starts_at is not strictly after a closed period).';
  end if;

  insert into public.fleet_vehicle_assignments (
    vehicle_id,
    driver_id,
    starts_at,
    ends_at,
    notes
  )
  values (
    p_vehicle_id,
    p_driver_id,
    p_starts_at,
    null,
    nullif(btrim(coalesce(p_notes, '')), '')
  )
  returning id into v_assignment_id;

  return v_assignment_id;
end;
$$;

revoke all on function public.admin_fleet_set_vehicle_assignment(uuid, uuid, timestamptz, text) from public;
revoke all on function public.admin_fleet_set_vehicle_assignment(uuid, uuid, timestamptz, text) from anon;
revoke all on function public.admin_fleet_set_vehicle_assignment(uuid, uuid, timestamptz, text) from authenticated;

-- ---------------------------------------------------------------------------
-- 2) Aggregates for fleet vehicle list (source of truth: fleet_vehicle_entries only)
-- ---------------------------------------------------------------------------
create or replace function public.admin_fleet_vehicle_entries_aggregates(
  p_vehicle_ids uuid[]
)
returns table (
  vehicle_id uuid,
  total_income_ariary bigint,
  total_expense_ariary bigint
)
language sql
security definer
set search_path = public
as $$
  select
    e.vehicle_id,
    coalesce(sum(case when e.entry_type = 'income' then e.amount_ariary else 0 end), 0)::bigint as total_income_ariary,
    coalesce(sum(case when e.entry_type = 'expense' then e.amount_ariary else 0 end), 0)::bigint as total_expense_ariary
  from public.fleet_vehicle_entries e
  where e.vehicle_id = any(p_vehicle_ids)
  group by e.vehicle_id;
$$;

revoke all on function public.admin_fleet_vehicle_entries_aggregates(uuid[]) from public;
revoke all on function public.admin_fleet_vehicle_entries_aggregates(uuid[]) from anon;
revoke all on function public.admin_fleet_vehicle_entries_aggregates(uuid[]) from authenticated;

