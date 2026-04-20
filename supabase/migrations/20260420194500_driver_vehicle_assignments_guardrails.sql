-- Suivi du parc — Guardrails affectation véhicule ↔ chauffeur (DB only)
-- Goals:
-- - No double active assignment for a given vehicle (ends_at IS NULL).
-- - No overlapping assignment periods for the same vehicle (time range overlap).
-- - Provide a small atomic admin RPC to (re)assign a driver to a vehicle safely.
--
-- Notes:
-- - We keep the model flexible (a driver could still have multiple historical assignments).
-- - We do NOT refactor existing admin RPCs here; this is an additive safety layer.

-- Needed for exclusion constraints with equality on UUID + range overlap.
create extension if not exists btree_gist with schema extensions;

-- ---------------------------------------------------------------------------
-- 1) Hard DB guarantee: only one active assignment per vehicle
-- ---------------------------------------------------------------------------
create unique index if not exists dva_one_active_per_vehicle_idx
  on public.driver_vehicle_assignments (vehicle_id)
  where ends_at is null;

comment on index public.dva_one_active_per_vehicle_idx is
  'Guarantee: at most one active (ends_at IS NULL) assignment per vehicle.';

-- ---------------------------------------------------------------------------
-- 2) Hard DB guarantee: no overlapping assignment windows for a vehicle
-- ---------------------------------------------------------------------------
do $$ begin
  alter table public.driver_vehicle_assignments
    add constraint dva_no_overlap_per_vehicle
      exclude using gist (
        vehicle_id with =,
        tstzrange(starts_at, coalesce(ends_at, 'infinity'::timestamptz), '[)') with &&
      );
exception
  when duplicate_object then null;
end $$;

comment on constraint dva_no_overlap_per_vehicle on public.driver_vehicle_assignments is
  'Prevent overlapping assignment windows for the same vehicle (including open-ended active assignments).';

-- ---------------------------------------------------------------------------
-- 3) Atomic admin RPC: assign a driver to a vehicle
--    - Closes any active assignment for the vehicle at starts_at
--    - Inserts the new assignment row
-- ---------------------------------------------------------------------------
create or replace function public.admin_assign_vehicle_to_driver(
  p_vehicle_id uuid,
  p_driver_id uuid,
  p_starts_at timestamptz default now(),
  p_daily_rent_ariary integer default null
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

  if p_daily_rent_ariary is not null and p_daily_rent_ariary < 0 then
    raise exception 'daily_rent_ariary must be >= 0';
  end if;

  -- Basic guard: ensure this user is a driver profile (MVP).
  select exists (
    select 1 from public.profiles p
    where p.id = p_driver_id and p.role = 'driver'
  ) into v_is_driver;
  if not v_is_driver then
    raise exception 'driver_id is not a driver profile';
  end if;

  -- Serialize by vehicle to avoid races (double active assignment / overlap).
  perform pg_advisory_xact_lock(hashtext(p_vehicle_id::text));

  -- Close any active assignment for the vehicle.
  update public.driver_vehicle_assignments
    set ends_at = p_starts_at
  where vehicle_id = p_vehicle_id
    and ends_at is null
    and starts_at < p_starts_at;

  -- Refuse any overlap (including degenerate starts_at=ends_at and historical overlaps).
  -- Note: the exclusion constraint will also protect us, but raising a clear message helps.
  if exists (
    select 1
    from public.driver_vehicle_assignments a
    where a.vehicle_id = p_vehicle_id
      and tstzrange(a.starts_at, coalesce(a.ends_at, 'infinity'::timestamptz), '[)')
          && tstzrange(p_starts_at, 'infinity'::timestamptz, '[)')
  ) then
    raise exception 'Cannot assign: would overlap an existing assignment (or starts_at is not strictly after a closed period).';
  end if;

  insert into public.driver_vehicle_assignments (
    driver_id,
    vehicle_id,
    starts_at,
    ends_at,
    daily_rent_ariary
  )
  values (
    p_driver_id,
    p_vehicle_id,
    p_starts_at,
    null,
    p_daily_rent_ariary
  )
  returning id into v_assignment_id;

  return v_assignment_id;
end;
$$;

revoke all on function public.admin_assign_vehicle_to_driver(uuid, uuid, timestamptz, integer) from public;
revoke all on function public.admin_assign_vehicle_to_driver(uuid, uuid, timestamptz, integer) from anon;
revoke all on function public.admin_assign_vehicle_to_driver(uuid, uuid, timestamptz, integer) from authenticated;

