-- Guardrail: detect completed rides missing finance finalization.

alter table public.rides
  add column if not exists is_financials_finalized boolean not null default false;

create index if not exists rides_financials_finalized_idx
  on public.rides (is_financials_finalized)
  where status = 'completed'::public.ride_status;

comment on column public.rides.is_financials_finalized is
  'True when finalize_ride_financials has frozen finance snapshots + attempted ledger write.';

-- Patch finalize_ride_financials to mark is_financials_finalized=true.
create or replace function public.finalize_ride_financials(p_ride_id uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_driver_id uuid;
  v_completed_at timestamptz;
  v_fare integer;
  v_rate_bps integer;
  v_commission integer;
  v_driver_gross integer;
  v_vehicle_id uuid;
  v_vehicle_owner public.vehicle_owner_type;
  v_effective_date date;
begin
  select r.driver_id, r.ride_completed_at
    into v_driver_id, v_completed_at
  from public.rides r
  where r.id = p_ride_id
  for update;

  if not found then
    raise exception 'FINALIZE_RIDE_NOT_FOUND'
      using errcode = 'P0001',
        hint = 'Course introuvable.';
  end if;

  if v_driver_id is null then
    raise exception 'FINALIZE_RIDE_NO_DRIVER'
      using errcode = 'P0001',
        hint = 'Aucun chauffeur assigné.';
  end if;

  if v_completed_at is null then
    raise exception 'FINALIZE_RIDE_NOT_COMPLETED'
      using errcode = 'P0001',
        hint = 'La course doit être terminée (completed).';
  end if;

  v_effective_date := (v_completed_at at time zone 'utc')::date;

  select
    coalesce(r.final_price_ariary, r.estimated_price_ariary),
    r.platform_commission_rate_bps
  into v_fare, v_rate_bps
  from public.rides r
  where r.id = p_ride_id;

  v_commission := floor((v_fare::numeric * v_rate_bps::numeric) / 10000)::int;
  v_driver_gross := greatest(v_fare - v_commission, 0);

  select a.vehicle_id, v.owner_type
    into v_vehicle_id, v_vehicle_owner
  from public.driver_vehicle_assignments a
  join public.vehicles v on v.id = a.vehicle_id
  where a.driver_id = v_driver_id
    and a.starts_at <= v_completed_at
    and (a.ends_at is null or a.ends_at > v_completed_at)
  order by a.starts_at desc
  limit 1;

  update public.rides
  set
    fare_total_ariary = coalesce(fare_total_ariary, v_fare),
    platform_commission_ariary = coalesce(platform_commission_ariary, v_commission),
    driver_gross_ariary = coalesce(driver_gross_ariary, v_driver_gross),
    vehicle_id = coalesce(vehicle_id, v_vehicle_id),
    vehicle_owner_type = coalesce(vehicle_owner_type, v_vehicle_owner),
    is_financials_finalized = true
  where id = p_ride_id;

  insert into public.driver_ledger_entries (
    driver_id,
    entry_type,
    direction,
    amount_ariary,
    effective_date,
    ride_id,
    notes
  ) values (
    v_driver_id,
    'ride_earning'::public.driver_ledger_entry_type,
    'credit'::public.ledger_direction,
    v_driver_gross,
    v_effective_date,
    p_ride_id,
    'Ride earning (gross) from completed ride.'
  )
  on conflict do nothing;
end;
$$;

revoke all on function public.finalize_ride_financials(uuid) from public;
revoke all on function public.finalize_ride_financials(uuid) from anon;
revoke all on function public.finalize_ride_financials(uuid) from authenticated;
grant execute on function public.finalize_ride_financials(uuid) to service_role;

