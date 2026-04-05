-- Fenêtre de paiement 5 min (payment_expires_at), expiration backend, libération chauffeur avant paiement.

alter table public.rides
  add column if not exists payment_expires_at timestamptz null;

comment on column public.rides.payment_expires_at is
  'Fin de fenêtre de paiement ; défini une seule fois à la première entrée en awaiting_payment (coalesce).';

-- Rides déjà en attente de paiement sans date : ancrage immédiat + 5 min (MVP rétroactif).
update public.rides
set payment_expires_at = now() + interval '5 minutes'
where status = 'awaiting_payment'::public.ride_status
  and payment_expires_at is null;

-- ---------------------------------------------------------------------------
-- Expiration batch (service_role / Edge) : awaiting_payment dépassé → expired
-- ---------------------------------------------------------------------------
create or replace function public.expire_rides_past_payment_deadline()
returns integer
language plpgsql
security definer
set search_path = public
as $$
declare
  v_count integer;
begin
  update public.rides
  set status = 'expired'::public.ride_status
  where status = 'awaiting_payment'::public.ride_status
    and payment_expires_at is not null
    and payment_expires_at <= now();

  get diagnostics v_count = row_count;
  return coalesce(v_count, 0);
end;
$$;

revoke all on function public.expire_rides_past_payment_deadline() from public;
grant execute on function public.expire_rides_past_payment_deadline() to service_role;

comment on function public.expire_rides_past_payment_deadline() is
  'Passe en expired les rides awaiting_payment dont payment_expires_at est dépassé. À appeler depuis Edge (create-payment-intent) et/ou pg_cron planifié.';

-- ---------------------------------------------------------------------------
-- Client : synchroniser l’expiration côté serveur (complément au cron, UX immédiate)
-- ---------------------------------------------------------------------------
create or replace function public.client_sync_ride_payment_expiry(p_ride_id uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_client_id uuid;
begin
  select r.client_id
    into v_client_id
  from public.rides r
  where r.id = p_ride_id
  for update;

  if not found then
    raise exception 'SYNC_EXPIRY_NOT_FOUND'
      using errcode = 'P0001',
        hint = 'Course introuvable.';
  end if;

  if v_client_id is distinct from auth.uid() then
    raise exception 'SYNC_EXPIRY_FORBIDDEN'
      using errcode = 'P0001',
        hint = 'Cette course ne vous appartient pas.';
  end if;

  update public.rides
  set status = 'expired'::public.ride_status
  where id = p_ride_id
    and status = 'awaiting_payment'::public.ride_status
    and payment_expires_at is not null
    and payment_expires_at <= now();
end;
$$;

revoke all on function public.client_sync_ride_payment_expiry(uuid) from public;
grant execute on function public.client_sync_ride_payment_expiry(uuid) to authenticated;

comment on function public.client_sync_ride_payment_expiry(uuid) is
  'Client : si awaiting_payment et délai dépassé, passe la ride en expired (idempotent).';

-- ---------------------------------------------------------------------------
-- Chauffeur : annuler avant paiement → requested, driver_id null, garde payment_expires_at
-- ---------------------------------------------------------------------------
create or replace function public.driver_release_ride_before_payment(p_ride_id uuid)
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
    raise exception 'DRIVER_RELEASE_NOT_DRIVER'
      using errcode = 'P0001',
        hint = 'Seuls les comptes chauffeur peuvent libérer une course.';
  end if;

  update public.rides
  set
    status = 'requested'::public.ride_status,
    driver_id = null
  where id = p_ride_id
    and driver_id = v_uid
    and status = 'awaiting_payment'::public.ride_status;

  get diagnostics v_updated = row_count;

  if v_updated = 0 then
    raise exception 'DRIVER_RELEASE_NOT_ALLOWED'
      using errcode = 'P0001',
        hint = 'Libération impossible (déjà payée, expirée ou vous n’êtes pas assigné).';
  end if;
end;
$$;

revoke all on function public.driver_release_ride_before_payment(uuid) from public;
grant execute on function public.driver_release_ride_before_payment(uuid) to authenticated;

comment on function public.driver_release_ride_before_payment(uuid) is
  'Chauffeur : awaiting_payment → requested, retire l’assignation ; ne réinitialise pas payment_expires_at.';

-- ---------------------------------------------------------------------------
-- Acceptation : première entrée en awaiting_payment → now()+5min si expires null
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

  update public.rides
  set
    driver_id = v_uid,
    status = 'awaiting_payment'::public.ride_status,
    payment_expires_at = coalesce(
      payment_expires_at,
      now() + interval '5 minutes'
    )
  where id = p_ride_id;
end;
$$;

comment on function public.accept_ride_as_driver(uuid) is
  'Chauffeur : requested → awaiting_payment ; payment_expires_at = coalesce(existant, now()+5min).';

-- ---------------------------------------------------------------------------
-- Webhook Stripe : paid seulement si fenêtre encore valide
-- ---------------------------------------------------------------------------
create or replace function public.mark_ride_paid_after_stripe(
  p_provider_payment_intent_id text
)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_ride_id uuid;
begin
  select p.ride_id
    into v_ride_id
  from public.payments p
  where p.provider_payment_intent_id = p_provider_payment_intent_id
  limit 1;

  if v_ride_id is null then
    return;
  end if;

  update public.payments
  set status = 'succeeded'
  where provider_payment_intent_id = p_provider_payment_intent_id;

  update public.rides r
  set status = 'paid'::public.ride_status
  where r.id = v_ride_id
    and r.status = 'awaiting_payment'::public.ride_status
    and (
      r.payment_expires_at is null
      or r.payment_expires_at > now()
    );
end;
$$;

-- ---------------------------------------------------------------------------
-- NOTE activation cron (hors repo) : planifier p.ex. chaque minute —
--   select public.expire_rides_past_payment_deadline();
-- en tant que rôle avec EXECUTE sur cette fonction (service_role / postgres selon pg_cron).
-- ---------------------------------------------------------------------------
