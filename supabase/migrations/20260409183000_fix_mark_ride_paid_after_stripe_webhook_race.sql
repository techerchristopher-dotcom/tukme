-- Stripe payment_intent.succeeded est la source de vérité : ne pas bloquer si payment_expires_at est passé
-- (course déjà passée en expired par le batch) ou si le webhook arrive après l'expiration.
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
    and r.status in (
      'awaiting_payment'::public.ride_status,
      'expired'::public.ride_status
    );
end;
$$;
