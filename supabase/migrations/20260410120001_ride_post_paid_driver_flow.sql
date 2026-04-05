-- Flux après paiement : paid → en_route → arrived → in_progress (RPC chauffeur uniquement).

alter table public.rides
  add column if not exists driver_en_route_at timestamptz null,
  add column if not exists driver_arrived_at timestamptz null,
  add column if not exists ride_started_at timestamptz null;

comment on column public.rides.driver_en_route_at is
  'Horodatage : le chauffeur a signalé être en route vers le client.';
comment on column public.rides.driver_arrived_at is
  'Horodatage : le chauffeur a signalé être arrivé.';
comment on column public.rides.ride_started_at is
  'Horodatage : début effectif de la course côté chauffeur.';

-- Index « une ride ouverte par client » : inclut en_route et arrived.
drop index if exists public.rides_one_open_per_client_idx;

with ranked as (
  select
    id,
    row_number() over (
      partition by client_id
      order by created_at desc
    ) as rn
  from public.rides
  where status in (
    'requested'::public.ride_status,
    'awaiting_payment'::public.ride_status,
    'paid'::public.ride_status,
    'en_route'::public.ride_status,
    'arrived'::public.ride_status,
    'in_progress'::public.ride_status
  )
)
update public.rides r
set status = 'cancelled_by_client'::public.ride_status
from ranked x
where r.id = x.id
  and x.rn > 1;

create unique index rides_one_open_per_client_idx
  on public.rides (client_id)
  where status in (
    'requested'::public.ride_status,
    'awaiting_payment'::public.ride_status,
    'paid'::public.ride_status,
    'en_route'::public.ride_status,
    'arrived'::public.ride_status,
    'in_progress'::public.ride_status
  );

comment on index public.rides_one_open_per_client_idx is
  'Au plus une course active par client (jusqu''à completion / annulation / expiration).';

-- ---------------------------------------------------------------------------
-- paid → en_route
-- ---------------------------------------------------------------------------
create or replace function public.start_en_route(p_ride_id uuid)
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
    raise exception 'START_EN_ROUTE_NOT_DRIVER'
      using errcode = 'P0001',
        hint = 'Seuls les comptes chauffeur peuvent démarrer le trajet.';
  end if;

  update public.rides
  set
    status = 'en_route'::public.ride_status,
    driver_en_route_at = coalesce(driver_en_route_at, now())
  where id = p_ride_id
    and driver_id = v_uid
    and status = 'paid'::public.ride_status;

  get diagnostics v_updated = row_count;
  if v_updated = 0 then
    raise exception 'START_EN_ROUTE_NOT_ALLOWED'
      using errcode = 'P0001',
        hint = 'Transition impossible (statut ou assignation incorrecte).';
  end if;
end;
$$;

revoke all on function public.start_en_route(uuid) from public;
grant execute on function public.start_en_route(uuid) to authenticated;

comment on function public.start_en_route(uuid) is
  'Chauffeur assigné : paid → en_route.';

-- ---------------------------------------------------------------------------
-- en_route → arrived
-- ---------------------------------------------------------------------------
create or replace function public.mark_arrived(p_ride_id uuid)
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
    raise exception 'MARK_ARRIVED_NOT_DRIVER'
      using errcode = 'P0001',
        hint = 'Seuls les comptes chauffeur peuvent signaler l''arrivée.';
  end if;

  update public.rides
  set
    status = 'arrived'::public.ride_status,
    driver_arrived_at = coalesce(driver_arrived_at, now())
  where id = p_ride_id
    and driver_id = v_uid
    and status = 'en_route'::public.ride_status;

  get diagnostics v_updated = row_count;
  if v_updated = 0 then
    raise exception 'MARK_ARRIVED_NOT_ALLOWED'
      using errcode = 'P0001',
        hint = 'Transition impossible (pas en route ou mauvais chauffeur).';
  end if;
end;
$$;

revoke all on function public.mark_arrived(uuid) from public;
grant execute on function public.mark_arrived(uuid) to authenticated;

comment on function public.mark_arrived(uuid) is
  'Chauffeur assigné : en_route → arrived.';

-- ---------------------------------------------------------------------------
-- arrived → in_progress
-- ---------------------------------------------------------------------------
create or replace function public.start_ride(p_ride_id uuid)
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
    raise exception 'START_RIDE_NOT_DRIVER'
      using errcode = 'P0001',
        hint = 'Seuls les comptes chauffeur peuvent démarrer la course.';
  end if;

  update public.rides
  set
    status = 'in_progress'::public.ride_status,
    ride_started_at = coalesce(ride_started_at, now())
  where id = p_ride_id
    and driver_id = v_uid
    and status = 'arrived'::public.ride_status;

  get diagnostics v_updated = row_count;
  if v_updated = 0 then
    raise exception 'START_RIDE_NOT_ALLOWED'
      using errcode = 'P0001',
        hint = 'Transition impossible (pas arrivé ou mauvais chauffeur).';
  end if;
end;
$$;

revoke all on function public.start_ride(uuid) from public;
grant execute on function public.start_ride(uuid) to authenticated;

comment on function public.start_ride(uuid) is
  'Chauffeur assigné : arrived → in_progress.';
