-- MVP cash : ride.payment_method + payments élargi + RPC + garde-fous Stripe (mark_ride_paid_after_stripe).

-- ---------------------------------------------------------------------------
-- rides : mode de paiement
-- ---------------------------------------------------------------------------
create type public.ride_payment_method as enum ('card', 'cash');

comment on type public.ride_payment_method is
  'Mode de paiement client : card (Stripe, défaut historique) ou cash (espèces).';

alter table public.rides
  add column if not exists payment_method public.ride_payment_method not null default 'card';

alter table public.rides
  add column if not exists payment_method_selected_at timestamptz null;

comment on column public.rides.payment_method is
  'Vérité métier mode de paiement ; ride.status=paid reste le pivot UX pour la suite du flow.';
comment on column public.rides.payment_method_selected_at is
  'Horodatage du choix (rempli pour cash via select_cash_payment_for_ride).';

grant usage on type public.ride_payment_method to authenticated;

-- ---------------------------------------------------------------------------
-- payments : PI nullable, provider stripe|cash, statuts cash
-- ---------------------------------------------------------------------------
alter table public.payments drop constraint if exists payments_provider_intent_unique;

alter table public.payments alter column provider_payment_intent_id drop not null;

alter table public.payments drop constraint if exists payments_provider_check;
alter table public.payments
  add constraint payments_provider_check check (provider in ('stripe', 'cash'));

alter table public.payments drop constraint if exists payments_status_check;
alter table public.payments
  add constraint payments_status_check
  check (
    status in (
      'requires_payment_method',
      'processing',
      'succeeded',
      'canceled',
      'failed',
      'pending_collection',
      'collected'
    )
  );

create unique index if not exists payments_stripe_pi_unique
  on public.payments (provider_payment_intent_id)
  where provider = 'stripe' and provider_payment_intent_id is not null;

drop index if exists public.payments_one_active_per_ride_idx;
create unique index payments_one_active_per_ride_idx
  on public.payments (ride_id)
  where status in ('requires_payment_method', 'processing', 'pending_collection');

-- ---------------------------------------------------------------------------
-- Stripe → paid : ne pas écraser une ride déjà passée en cash
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
  where p.provider = 'stripe'
    and p.provider_payment_intent_id = p_provider_payment_intent_id
  limit 1;

  if v_ride_id is null then
    return;
  end if;

  update public.payments
  set status = 'succeeded'
  where provider = 'stripe'
    and provider_payment_intent_id = p_provider_payment_intent_id;

  update public.rides r
  set status = 'paid'::public.ride_status
  where r.id = v_ride_id
    and r.payment_method = 'card'::public.ride_payment_method
    and r.status in (
      'awaiting_payment'::public.ride_status,
      'expired'::public.ride_status
    );
end;
$$;

revoke all on function public.mark_ride_paid_after_stripe(text) from public;
grant execute on function public.mark_ride_paid_after_stripe(text) to service_role;

-- ---------------------------------------------------------------------------
-- Client : choisir espèces → trace + paid (pivot UX inchangé)
-- ---------------------------------------------------------------------------
create or replace function public.select_cash_payment_for_ride(p_ride_id uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_uid uuid := auth.uid();
  v_client_id uuid;
  v_driver_id uuid;
  v_status public.ride_status;
  v_pay public.ride_payment_method;
  v_amount_cents integer;
  v_currency text := 'eur';
begin
  if v_uid is null then
    raise exception 'CASH_PAY_NOT_AUTH'
      using errcode = 'P0001',
        hint = 'Authentification requise.';
  end if;

  select
    r.client_id,
    r.driver_id,
    r.status,
    r.payment_method,
    greatest(50, round(coalesce(r.estimated_price_eur, 0) * 100)::integer)
  into v_client_id, v_driver_id, v_status, v_pay, v_amount_cents
  from public.rides r
  where r.id = p_ride_id
  for update;

  if not found then
    raise exception 'CASH_PAY_RIDE_NOT_FOUND'
      using errcode = 'P0001',
        hint = 'Course introuvable.';
  end if;

  if v_client_id is distinct from v_uid then
    raise exception 'CASH_PAY_FORBIDDEN'
      using errcode = 'P0001',
        hint = 'Cette course ne vous appartient pas.';
  end if;

  if v_status = 'paid'::public.ride_status
     and v_pay = 'cash'::public.ride_payment_method then
    return;
  end if;

  if v_status is distinct from 'awaiting_payment'::public.ride_status then
    raise exception 'CASH_PAY_BAD_STATUS'
      using errcode = 'P0001',
        hint = 'La course n''est pas en attente de paiement.';
  end if;

  if v_driver_id is null then
    raise exception 'CASH_PAY_NO_DRIVER'
      using errcode = 'P0001',
        hint = 'Aucun chauffeur assigné.';
  end if;

  if exists (
    select 1
    from public.payments p
    where p.ride_id = p_ride_id
      and p.provider = 'stripe'
      and p.status in ('requires_payment_method', 'processing')
  ) then
    raise exception 'CASH_PAY_STRIPE_OPEN'
      using errcode = 'P0001',
        hint = 'Un paiement par carte est déjà en cours pour cette course.';
  end if;

  if exists (
    select 1
    from public.payments p
    where p.ride_id = p_ride_id
      and p.provider = 'cash'
      and p.status = 'pending_collection'
  ) then
    update public.rides
    set
      payment_method = 'cash'::public.ride_payment_method,
      payment_method_selected_at = coalesce(payment_method_selected_at, now()),
      status = 'paid'::public.ride_status
    where id = p_ride_id;
    return;
  end if;

  if exists (
    select 1
    from public.payments p
    where p.ride_id = p_ride_id
      and p.provider = 'cash'
  ) then
    raise exception 'CASH_PAY_INCONSISTENT'
      using errcode = 'P0001',
        hint = 'Paiement espèces déjà présent pour cette course.';
  end if;

  insert into public.payments (
    ride_id,
    client_id,
    provider,
    provider_payment_intent_id,
    amount,
    currency,
    status
  )
  values (
    p_ride_id,
    v_client_id,
    'cash',
    null,
    v_amount_cents,
    v_currency,
    'pending_collection'
  );

  update public.rides
  set
    payment_method = 'cash'::public.ride_payment_method,
    payment_method_selected_at = now(),
    status = 'paid'::public.ride_status
  where id = p_ride_id;
end;
$$;

comment on function public.select_cash_payment_for_ride(uuid) is
  'Client : espèces — insère payments (cash/pending_collection) et passe la ride en paid.';

revoke all on function public.select_cash_payment_for_ride(uuid) from public;
grant execute on function public.select_cash_payment_for_ride(uuid) to authenticated;
