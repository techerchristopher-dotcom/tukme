-- Finance MVP RPCs (idempotent)
-- Note: For MVP, we grant EXECUTE to service_role only.

-- ---------------------------------------------------------------------------
-- Finalize ride financial snapshots + create ledger credit ride_earning
-- Guardrail: unique ride_earning per ride (unique index in schema migration).
-- ---------------------------------------------------------------------------
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

  -- Compute fare + commission from ride snapshot (prefer final price).
  select
    coalesce(r.final_price_ariary, r.estimated_price_ariary),
    r.platform_commission_rate_bps
  into v_fare, v_rate_bps
  from public.rides r
  where r.id = p_ride_id;

  v_commission := floor((v_fare::numeric * v_rate_bps::numeric) / 10000)::int;
  v_driver_gross := greatest(v_fare - v_commission, 0);

  -- Snapshot vehicle info from assignment around completion time (best effort).
  select a.vehicle_id, v.owner_type
    into v_vehicle_id, v_vehicle_owner
  from public.driver_vehicle_assignments a
  join public.vehicles v on v.id = a.vehicle_id
  where a.driver_id = v_driver_id
    and a.starts_at <= v_completed_at
    and (a.ends_at is null or a.ends_at > v_completed_at)
  order by a.starts_at desc
  limit 1;

  -- Freeze snapshots only if not already frozen (idempotent).
  update public.rides
  set
    fare_total_ariary = coalesce(fare_total_ariary, v_fare),
    platform_commission_ariary = coalesce(platform_commission_ariary, v_commission),
    driver_gross_ariary = coalesce(driver_gross_ariary, v_driver_gross),
    vehicle_id = coalesce(vehicle_id, v_vehicle_id),
    vehicle_owner_type = coalesce(vehicle_owner_type, v_vehicle_owner)
  where id = p_ride_id;

  -- Ledger: one ride_earning entry per ride (guarded by unique index).
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
  on conflict on constraint dle_one_ride_earning_per_ride_idx do nothing;
end;
$$;

revoke all on function public.finalize_ride_financials(uuid) from public;
revoke all on function public.finalize_ride_financials(uuid) from anon;
revoke all on function public.finalize_ride_financials(uuid) from authenticated;
grant execute on function public.finalize_ride_financials(uuid) to service_role;

comment on function public.finalize_ride_financials(uuid) is
  'Service role: freeze ride financial snapshots at completion and create one ledger credit (ride_earning) per ride.';

-- ---------------------------------------------------------------------------
-- Ensure daily rent due (separate from rides) + ledger debit daily_rent_due
-- ---------------------------------------------------------------------------
create or replace function public.ensure_daily_rent_due(
  p_driver_id uuid,
  p_date date
)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  v_assignment_id uuid;
  v_vehicle_id uuid;
  v_rent integer;
  v_rent_id uuid;
begin
  -- Pick the most recent assignment overlapping this day, only for platform vehicles with a rent.
  select a.id, a.vehicle_id, a.daily_rent_ariary
    into v_assignment_id, v_vehicle_id, v_rent
  from public.driver_vehicle_assignments a
  join public.vehicles v on v.id = a.vehicle_id
  where a.driver_id = p_driver_id
    and v.owner_type = 'platform'::public.vehicle_owner_type
    and a.daily_rent_ariary is not null
    and a.daily_rent_ariary > 0
    and a.starts_at::date <= p_date
    and (a.ends_at is null or a.ends_at::date > p_date)
  order by a.starts_at desc
  limit 1;

  if v_vehicle_id is null then
    -- No rent due for that day (either independent driver or no assignment).
    return null;
  end if;

  insert into public.driver_daily_rents (driver_id, vehicle_id, date, rent_ariary, status)
  values (p_driver_id, v_vehicle_id, p_date, v_rent, 'due'::public.rent_status)
  on conflict (driver_id, vehicle_id, date) do update
    set rent_ariary = excluded.rent_ariary
  returning id into v_rent_id;

  -- Ledger debit (idempotent per daily_rent_id).
  insert into public.driver_ledger_entries (
    driver_id,
    entry_type,
    direction,
    amount_ariary,
    effective_date,
    daily_rent_id,
    notes
  ) values (
    p_driver_id,
    'daily_rent_due'::public.driver_ledger_entry_type,
    'debit'::public.ledger_direction,
    v_rent,
    p_date,
    v_rent_id,
    'Daily vehicle rent due.'
  )
  on conflict do nothing;

  return v_rent_id;
end;
$$;

revoke all on function public.ensure_daily_rent_due(uuid, date) from public;
revoke all on function public.ensure_daily_rent_due(uuid, date) from anon;
revoke all on function public.ensure_daily_rent_due(uuid, date) from authenticated;
grant execute on function public.ensure_daily_rent_due(uuid, date) to service_role;

comment on function public.ensure_daily_rent_due(uuid, date) is
  'Service role: upsert daily rent due (platform vehicles only) and create one ledger debit entry.';

-- ---------------------------------------------------------------------------
-- Record manual payout + ledger debit payout
-- ---------------------------------------------------------------------------
create or replace function public.record_driver_payout(
  p_driver_id uuid,
  p_amount_ariary integer,
  p_method public.payout_method,
  p_status public.payout_status default 'recorded',
  p_paid_at timestamptz default null,
  p_reference text default null,
  p_notes text default null
)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  v_payout_id uuid;
  v_effective_date date;
begin
  if p_amount_ariary is null or p_amount_ariary <= 0 then
    raise exception 'PAYOUT_INVALID_AMOUNT'
      using errcode = 'P0001',
        hint = 'Montant payout invalide.';
  end if;

  v_effective_date := (coalesce(p_paid_at, now()) at time zone 'utc')::date;

  insert into public.driver_payouts (
    driver_id,
    amount_ariary,
    method,
    status,
    paid_at,
    reference,
    notes
  ) values (
    p_driver_id,
    p_amount_ariary,
    p_method,
    p_status,
    p_paid_at,
    p_reference,
    p_notes
  )
  returning id into v_payout_id;

  insert into public.driver_ledger_entries (
    driver_id,
    entry_type,
    direction,
    amount_ariary,
    effective_date,
    payout_id,
    notes
  ) values (
    p_driver_id,
    'payout'::public.driver_ledger_entry_type,
    'debit'::public.ledger_direction,
    p_amount_ariary,
    v_effective_date,
    v_payout_id,
    'Manual payout.'
  );

  return v_payout_id;
end;
$$;

revoke all on function public.record_driver_payout(uuid, integer, public.payout_method, public.payout_status, timestamptz, text, text) from public;
revoke all on function public.record_driver_payout(uuid, integer, public.payout_method, public.payout_status, timestamptz, text, text) from anon;
revoke all on function public.record_driver_payout(uuid, integer, public.payout_method, public.payout_status, timestamptz, text, text) from authenticated;
grant execute on function public.record_driver_payout(uuid, integer, public.payout_method, public.payout_status, timestamptz, text, text) to service_role;

comment on function public.record_driver_payout(uuid, integer, public.payout_method, public.payout_status, timestamptz, text, text) is
  'Service role: record a manual driver payout (cash/orange money) and create a ledger debit entry.';

