-- Hardening: accept_ride_as_driver concurrency + clearer error.
-- Goal: guarantee a ride is accepted by only one driver, and return a distinct
-- error when the ride is already taken (instead of generic NOT_REQUESTED).

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
  v_updated integer;
begin
  if not exists (
    select 1 from public.profiles p where p.id = v_uid and p.role = 'driver'
  ) then
    raise exception 'ACCEPT_RIDE_NOT_DRIVER'
      using errcode = 'P0001',
        hint = 'Seuls les comptes chauffeur peuvent accepter une course.';
  end if;

  -- Serialize concurrent accept attempts.
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
    raise exception 'ACCEPT_RIDE_ALREADY_ACCEPTED'
      using errcode = 'P0001',
        hint = 'Cette course n''est plus disponible (déjà acceptée ou terminée).';
  end if;

  -- Defensive condition: ensure we only transition from the requested state.
  update public.rides
  set
    driver_id = v_uid,
    status = 'awaiting_payment'::public.ride_status,
    payment_expires_at = coalesce(payment_expires_at, now() + interval '5 minutes')
  where id = p_ride_id
    and status = 'requested'::public.ride_status
    and driver_id is null;

  get diagnostics v_updated = row_count;
  if v_updated = 0 then
    -- Should be rare (corrupted row / legacy data), but keep error deterministic.
    raise exception 'ACCEPT_RIDE_ALREADY_ACCEPTED'
      using errcode = 'P0001',
        hint = 'Cette course n''est plus disponible (déjà acceptée).';
  end if;
end;
$$;

comment on function public.accept_ride_as_driver(uuid) is
  'Chauffeur : requested → awaiting_payment ; assigne driver_id ; fixe payment_expires_at (coalesce). Concurrency-safe.';

revoke all on function public.accept_ride_as_driver(uuid) from public;
grant execute on function public.accept_ride_as_driver(uuid) to authenticated;

