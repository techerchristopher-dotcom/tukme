-- MVP paiement : migration données + payments + RLS + RPC (après enum awaiting_payment / paid).

update public.rides
set status = 'awaiting_payment'::public.ride_status
where status = 'accepted'::public.ride_status;

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
    'in_progress'::public.ride_status
  );

comment on index public.rides_one_open_per_client_idx is
  'Au plus une course active par client (jusqu''à completion / annulation / expiration).';

create table public.payments (
  id uuid primary key default gen_random_uuid(),
  ride_id uuid not null references public.rides (id) on delete cascade,
  client_id uuid not null references auth.users (id) on delete cascade,
  provider text not null default 'stripe',
  provider_payment_intent_id text not null,
  amount integer not null
    constraint payments_amount_positive check (amount > 0),
  currency text not null default 'eur',
  status text not null
    constraint payments_status_check
      check (
        status in (
          'requires_payment_method',
          'processing',
          'succeeded',
          'canceled',
          'failed'
        )
      ),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint payments_provider_intent_unique unique (provider, provider_payment_intent_id)
);

create index payments_ride_id_idx on public.payments (ride_id);
create index payments_client_id_idx on public.payments (client_id);
create index payments_status_idx on public.payments (status);

create unique index payments_one_active_per_ride_idx
  on public.payments (ride_id)
  where status in ('requires_payment_method', 'processing');

comment on table public.payments is
  'Paiements Stripe liés aux courses ; écriture réservée au service role / Edge Functions.';

create or replace function public.tg_payments_set_updated_at()
returns trigger
language plpgsql
security invoker
set search_path = public
as $$
begin
  new.updated_at := now();
  return new;
end;
$$;

create trigger payments_set_updated_at
  before update on public.payments
  for each row
  execute function public.tg_payments_set_updated_at();

alter table public.payments enable row level security;

create policy "payments_select_own"
  on public.payments
  for select
  to authenticated
  using (client_id = (select auth.uid()));

grant select on table public.payments to authenticated;

create policy "rides_select_driver_requested"
  on public.rides
  for select
  to authenticated
  using (
    exists (
      select 1
      from public.profiles p
      where p.id = (select auth.uid())
        and p.role = 'driver'
    )
    and status = 'requested'::public.ride_status
  );

create policy "rides_select_driver_assigned"
  on public.rides
  for select
  to authenticated
  using (driver_id = (select auth.uid()));

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

  if v_status is distinct from 'requested'::public.ride_status
     and v_status is distinct from 'awaiting_payment'::public.ride_status then
    raise exception 'CANCEL_RIDE_NOT_ALLOWED'
      using errcode = 'P0001',
        hint = 'Annulation impossible à ce stade (déjà payée ou course engagée).';
  end if;

  update public.rides
  set status = 'cancelled_by_client'::public.ride_status
  where id = p_ride_id;
end;
$$;

comment on function public.cancel_ride(uuid) is
  'Annulation client : requested ou awaiting_payment → cancelled_by_client.';

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
    status = 'awaiting_payment'::public.ride_status
  where id = p_ride_id;
end;
$$;

comment on function public.accept_ride_as_driver(uuid) is
  'Chauffeur : requested → awaiting_payment, assigne driver_id.';

revoke all on function public.accept_ride_as_driver(uuid) from public;
grant execute on function public.accept_ride_as_driver(uuid) to authenticated;

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

  update public.rides
  set status = 'paid'::public.ride_status
  where id = v_ride_id
    and status = 'awaiting_payment'::public.ride_status;
end;
$$;

revoke all on function public.mark_ride_paid_after_stripe(text) from public;
grant execute on function public.mark_ride_paid_after_stripe(text) to service_role;

create or replace function public.mark_payment_failed_from_stripe(
  p_provider_payment_intent_id text
)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  update public.payments
  set status = 'failed'
  where provider_payment_intent_id = p_provider_payment_intent_id
    and status in ('requires_payment_method', 'processing');
end;
$$;

revoke all on function public.mark_payment_failed_from_stripe(text) from public;
grant execute on function public.mark_payment_failed_from_stripe(text) to service_role;
