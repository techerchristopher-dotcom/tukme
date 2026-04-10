-- Client → contact chauffeur (MVP) : exposer uniquement le téléphone du chauffeur
-- pour une ride appartenant au client connecté, sur statuts autorisés.
-- On évite d’ouvrir profiles.phone en lecture globale côté client.

create or replace function public.get_driver_contact_for_ride(p_ride_id uuid)
returns table (
  driver_phone text
)
language plpgsql
security definer
set search_path = public
as $$
declare
  v_uid uuid := auth.uid();
  v_client_id uuid;
  v_driver_id uuid;
  v_status public.ride_status;
begin
  if v_uid is null then
    raise exception 'GET_DRIVER_CONTACT_UNAUTHENTICATED'
      using errcode = 'P0001',
        hint = 'Authentification requise.';
  end if;

  select r.client_id, r.driver_id, r.status
    into v_client_id, v_driver_id, v_status
  from public.rides r
  where r.id = p_ride_id;

  if not found then
    raise exception 'GET_DRIVER_CONTACT_NOT_FOUND'
      using errcode = 'P0001',
        hint = 'Course introuvable.';
  end if;

  if v_client_id is distinct from v_uid then
    raise exception 'GET_DRIVER_CONTACT_FORBIDDEN'
      using errcode = 'P0001',
        hint = 'Cette course ne vous appartient pas.';
  end if;

  if v_driver_id is null then
    raise exception 'GET_DRIVER_CONTACT_NO_DRIVER'
      using errcode = 'P0001',
        hint = 'Aucun chauffeur assigné pour le moment.';
  end if;

  if v_status is distinct from 'awaiting_payment'::public.ride_status
     and v_status is distinct from 'paid'::public.ride_status
     and v_status is distinct from 'en_route'::public.ride_status
     and v_status is distinct from 'arrived'::public.ride_status
     and v_status is distinct from 'in_progress'::public.ride_status then
    raise exception 'GET_DRIVER_CONTACT_NOT_ALLOWED'
      using errcode = 'P0001',
        hint = 'Contact chauffeur indisponible pour ce statut.';
  end if;

  -- Note: le téléphone peut être NULL (profil incomplet). On renvoie NULL plutôt que d’échouer.
  return query
  select p.phone as driver_phone
  from public.profiles p
  where p.id = v_driver_id
  limit 1;
end;
$$;

revoke all on function public.get_driver_contact_for_ride(uuid) from public;
revoke all on function public.get_driver_contact_for_ride(uuid) from anon;
grant execute on function public.get_driver_contact_for_ride(uuid) to authenticated;

comment on function public.get_driver_contact_for_ride(uuid) is
  'Client-only: returns the assigned driver phone for a client-owned ride on allowed statuses. Avoids exposing profiles.phone globally.';

