-- Au plus une ride « ouverte » par client (requested | accepted | in_progress).
-- Annulation client via RPC sécurisée (statut requested → cancelled_by_client).

-- Si des doublons existent déjà (ex. tests avant contrainte), on ne garde que la plus récente ouverte par client.
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
    'accepted'::public.ride_status,
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
    'accepted'::public.ride_status,
    'in_progress'::public.ride_status
  );

comment on index public.rides_one_open_per_client_idx is
  'Empêche plusieurs courses actives simultanées pour un même client.';

create or replace function public.cancel_ride(p_ride_id uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_client_id uuid;
  v_status public.ride_status;
begin
  select r.client_id, r.status
    into v_client_id, v_status
  from public.rides r
  where r.id = p_ride_id;

  if not found then
    raise exception 'CANCEL_RIDE_NOT_FOUND'
      using errcode = 'P0001',
        hint = 'Aucune course avec cet identifiant.';
  end if;

  if v_client_id is distinct from auth.uid() then
    raise exception 'CANCEL_RIDE_FORBIDDEN'
      using errcode = 'P0001',
        hint = 'Cette course ne vous appartient pas.';
  end if;

  if v_status is distinct from 'requested'::public.ride_status then
    raise exception 'CANCEL_RIDE_NOT_REQUESTED'
      using errcode = 'P0001',
        hint = 'Seules les demandes en attente peuvent être annulées.';
  end if;

  update public.rides
  set status = 'cancelled_by_client'::public.ride_status
  where id = p_ride_id;
end;
$$;

comment on function public.cancel_ride(uuid) is
  'Annulation client : requested → cancelled_by_client, contrôle auth.uid().';

revoke all on function public.cancel_ride(uuid) from public;
grant execute on function public.cancel_ride(uuid) to authenticated;
