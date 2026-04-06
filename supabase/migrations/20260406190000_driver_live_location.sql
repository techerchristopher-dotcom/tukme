-- Live location chauffeur (MVP) — stockée sur `rides` (pas de table dédiée).

alter table public.rides
  add column if not exists driver_lat double precision null,
  add column if not exists driver_lng double precision null,
  add column if not exists driver_location_updated_at timestamptz null;

comment on column public.rides.driver_lat is
  'Position GPS chauffeur (latitude) ; mise à jour via RPC pendant paid/en_route/arrived.';
comment on column public.rides.driver_lng is
  'Position GPS chauffeur (longitude) ; mise à jour via RPC pendant paid/en_route/arrived.';
comment on column public.rides.driver_location_updated_at is
  'Horodatage de la dernière position chauffeur mise à jour.';

create or replace function public.update_driver_location(
  p_ride_id uuid,
  p_lat double precision,
  p_lng double precision
)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_uid uuid := auth.uid();
  v_updated integer;
begin
  if not exists (
    select 1 from public.profiles p where p.id = v_uid and p.role = 'driver'
  ) then
    raise exception 'LOCATION_UPDATE_NOT_ALLOWED'
      using errcode = 'P0001',
        hint = 'Seuls les comptes chauffeur peuvent mettre à jour la position.';
  end if;

  update public.rides
  set
    driver_lat = p_lat,
    driver_lng = p_lng,
    driver_location_updated_at = now()
  where id = p_ride_id
    and driver_id = v_uid
    and status in (
      'paid'::public.ride_status,
      'en_route'::public.ride_status,
      'arrived'::public.ride_status
    );

  get diagnostics v_updated = row_count;
  if v_updated = 0 then
    raise exception 'LOCATION_UPDATE_NOT_ALLOWED'
      using errcode = 'P0001',
        hint = 'Statut ou assignation incorrecte pour la mise à jour position.';
  end if;
end;
$$;

revoke all on function public.update_driver_location(uuid, double precision, double precision) from public;
revoke all on function public.update_driver_location(uuid, double precision, double precision) from anon;
grant execute on function public.update_driver_location(uuid, double precision, double precision) to authenticated;

comment on function public.update_driver_location(uuid, double precision, double precision) is
  'Chauffeur assigné : met à jour driver_lat/lng (paid/en_route/arrived).';

