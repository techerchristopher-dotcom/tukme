-- MVP: allow switching payment method while awaiting_payment (no confirmed payment).
-- Cancels/neutralizes the conflicting "open" trace to avoid CASH_PAY_STRIPE_OPEN, etc.

create or replace function public.switch_payment_method_for_ride(
  p_ride_id uuid,
  p_method public.ride_payment_method
)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_uid uuid := auth.uid();
  v_client_id uuid;
  v_status public.ride_status;
  v_driver_id uuid;
begin
  if v_uid is null then
    raise exception 'SWITCH_PAY_NOT_AUTH'
      using errcode = 'P0001',
        hint = 'Authentification requise.';
  end if;

  select r.client_id, r.status, r.driver_id
    into v_client_id, v_status, v_driver_id
  from public.rides r
  where r.id = p_ride_id
  for update;

  if not found then
    raise exception 'SWITCH_PAY_RIDE_NOT_FOUND'
      using errcode = 'P0001',
        hint = 'Course introuvable.';
  end if;

  if v_client_id is distinct from v_uid then
    raise exception 'SWITCH_PAY_FORBIDDEN'
      using errcode = 'P0001',
        hint = 'Cette course ne vous appartient pas.';
  end if;

  if v_status is distinct from 'awaiting_payment'::public.ride_status then
    raise exception 'SWITCH_PAY_BAD_STATUS'
      using errcode = 'P0001',
        hint = 'Changement de mode de paiement impossible à ce stade.';
  end if;

  -- A confirmed payment exists → do not allow switching.
  if exists (
    select 1
    from public.payments p
    where p.ride_id = p_ride_id
      and p.status in ('succeeded', 'collected')
  ) then
    raise exception 'SWITCH_PAY_ALREADY_CONFIRMED'
      using errcode = 'P0001',
        hint = 'Paiement déjà confirmé.';
  end if;

  if p_method = 'cash'::public.ride_payment_method then
    -- Must have an assigned driver for cash collection.
    if v_driver_id is null then
      raise exception 'SWITCH_PAY_NO_DRIVER'
        using errcode = 'P0001',
          hint = 'Aucun chauffeur assigné.';
    end if;

    -- Cancel any open Stripe attempt (DB-side). Stripe PI may still exist, but will be ignored (ride.payment_method=cash).
    update public.payments
    set status = 'canceled'
    where ride_id = p_ride_id
      and provider = 'stripe'
      and status in ('requires_payment_method', 'processing');

    update public.rides
    set
      payment_method = 'cash'::public.ride_payment_method,
      payment_method_selected_at = coalesce(payment_method_selected_at, now())
    where id = p_ride_id;

    return;
  end if;

  if p_method = 'card'::public.ride_payment_method then
    -- Cancel any open cash attempt.
    update public.payments
    set status = 'canceled'
    where ride_id = p_ride_id
      and provider = 'cash'
      and status = 'pending_collection';

    update public.rides
    set payment_method = 'card'::public.ride_payment_method
    where id = p_ride_id;

    return;
  end if;
end;
$$;

comment on function public.switch_payment_method_for_ride(uuid, public.ride_payment_method) is
  'Client: switch payment method while awaiting_payment; cancels conflicting open payment traces.';

revoke all on function public.switch_payment_method_for_ride(uuid, public.ride_payment_method) from public;
grant execute on function public.switch_payment_method_for_ride(uuid, public.ride_payment_method) to authenticated;

