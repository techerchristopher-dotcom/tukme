-- Phase 1 (chauffeur -> client awaiting_payment):
-- - Source unique avatar: profiles.avatar_path (+ metadata)
-- - Snapshot driver + vehicle fields on rides at accept time
-- - Keep RLS unchanged: client reads only its ride; snapshots live on rides.

-- ---------------------------------------------------------------------------
-- Profiles: unique avatar reference (Storage path)
-- ---------------------------------------------------------------------------
alter table public.profiles
  add column if not exists avatar_path text null,
  add column if not exists avatar_updated_at timestamptz null,
  add column if not exists avatar_source text null
    constraint profiles_avatar_source_check
      check (avatar_source is null or avatar_source in ('admin', 'driver'));

comment on column public.profiles.avatar_path is
  'Supabase Storage path to the profile avatar (single source of truth).';
comment on column public.profiles.avatar_updated_at is
  'Last time avatar_path was updated.';
comment on column public.profiles.avatar_source is
  'Who last set the avatar_path: admin or driver (optional metadata).';

-- ---------------------------------------------------------------------------
-- Rides: snapshots for client UI (awaiting_payment)
-- ---------------------------------------------------------------------------
alter table public.rides
  add column if not exists driver_display_name text null,
  add column if not exists driver_avatar_path text null,
  add column if not exists vehicle_type text null,
  add column if not exists vehicle_plate text null;

comment on column public.rides.driver_display_name is
  'Snapshot: driver display name at accept time (for client UI).';
comment on column public.rides.driver_avatar_path is
  'Snapshot: driver avatar_path at accept time (for client UI).';
comment on column public.rides.vehicle_type is
  'Snapshot: vehicle type/kind at accept time (for client UI).';
comment on column public.rides.vehicle_plate is
  'Snapshot: vehicle plate number at accept time (for client UI).';

-- ---------------------------------------------------------------------------
-- Accept ride: snapshot driver + active vehicle (best effort)
-- ---------------------------------------------------------------------------
create or replace function public.accept_ride_as_driver(p_ride_id uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_client_id uuid;
  v_status public.ride_status;
  v_uid uuid := auth.uid();
  v_driver_name text;
  v_driver_avatar_path text;
  v_vehicle_type text;
  v_vehicle_plate text;
begin
  if not exists (
    select 1 from public.profiles p where p.id = v_uid and p.role = 'driver'
  ) then
    raise exception 'ACCEPT_RIDE_NOT_DRIVER'
      using errcode = 'P0001',
        hint = 'Seuls les comptes chauffeur peuvent accepter une course.';
  end if;

  select r.client_id, r.status
    into v_client_id, v_status
  from public.rides r
  where r.id = p_ride_id
  for update;

  if not found then
    raise exception 'ACCEPT_RIDE_NOT_FOUND'
      using errcode = 'P0001',
        hint = 'Course introuvable.';
  end if;

  if v_client_id = v_uid then
    raise exception 'ACCEPT_RIDE_OWN_RIDE'
      using errcode = 'P0001',
        hint = 'Vous ne pouvez pas accepter votre propre demande.';
  end if;

  if v_status is distinct from 'requested'::public.ride_status then
    raise exception 'ACCEPT_RIDE_NOT_REQUESTED'
      using errcode = 'P0001',
        hint = 'Cette course n''est plus disponible.';
  end if;

  -- Driver identity snapshot (best effort).
  select
    nullif(trim(p.full_name), ''),
    p.avatar_path
    into v_driver_name, v_driver_avatar_path
  from public.profiles p
  where p.id = v_uid
  limit 1;

  -- Active vehicle snapshot (best effort). If none, keep nulls.
  select
    nullif(trim(v.kind), ''),
    nullif(trim(v.plate_number), '')
    into v_vehicle_type, v_vehicle_plate
  from public.driver_vehicle_assignments a
  join public.vehicles v on v.id = a.vehicle_id
  where a.driver_id = v_uid
    and a.ends_at is null
  order by a.starts_at desc
  limit 1;

  update public.rides
  set
    driver_id = v_uid,
    status = 'awaiting_payment'::public.ride_status,
    payment_expires_at = coalesce(payment_expires_at, now() + interval '5 minutes'),
    driver_display_name = coalesce(v_driver_name, driver_display_name, 'Chauffeur'),
    driver_avatar_path = coalesce(v_driver_avatar_path, driver_avatar_path),
    vehicle_type = coalesce(v_vehicle_type, vehicle_type),
    vehicle_plate = coalesce(v_vehicle_plate, vehicle_plate)
  where id = p_ride_id;
end;
$$;

revoke all on function public.accept_ride_as_driver(uuid) from public;
grant execute on function public.accept_ride_as_driver(uuid) to authenticated;

comment on function public.accept_ride_as_driver(uuid) is
  'Chauffeur : requested → awaiting_payment, assigne driver_id + snapshots driver/vehicle.';

