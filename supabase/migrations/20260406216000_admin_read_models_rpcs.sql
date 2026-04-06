-- Admin read-models (RPC) — service_role only.
-- Business day is defined in Madagascar timezone by default.
-- Net payable today definition (MVP):
-- net_payable_today_ariary = max(0, driver_gross_today - daily_rent_due_today - payouts_today)

create or replace function public.admin_driver_daily_summary(
  p_business_date date,
  p_tz text default 'Indian/Antananarivo'
)
returns table (
  business_date date,
  driver_id uuid,
  full_name text,
  phone text,
  rides_count bigint,
  gross_fares_ariary bigint,
  platform_commission_ariary bigint,
  driver_gross_ariary bigint,
  daily_rent_due_ariary bigint,
  payouts_done_ariary bigint,
  current_balance_ariary bigint,
  net_payable_today_ariary bigint,
  rent_expected boolean,
  rent_missing boolean,
  current_vehicle_id uuid,
  current_vehicle_owner_type public.vehicle_owner_type,
  current_daily_rent_ariary integer
)
language sql
security definer
set search_path = public
as $$
with drivers as (
  select p.id as driver_id, p.full_name, p.phone
  from public.profiles p
  where p.role = 'driver'
),
rides_today as (
  select
    r.driver_id,
    count(*)::bigint as rides_count,
    coalesce(sum(r.fare_total_ariary), 0)::bigint as gross_fares_ariary,
    coalesce(sum(r.platform_commission_ariary), 0)::bigint as platform_commission_ariary,
    coalesce(sum(r.driver_gross_ariary), 0)::bigint as driver_gross_ariary
  from public.rides r
  where r.status = 'completed'::public.ride_status
    and r.driver_id is not null
    and r.ride_completed_at is not null
    and date(timezone(p_tz, r.ride_completed_at)) = p_business_date
  group by r.driver_id
),
rents_today as (
  select
    dle.driver_id,
    coalesce(sum(dle.amount_ariary), 0)::bigint as daily_rent_due_ariary
  from public.driver_ledger_entries dle
  where dle.entry_type = 'daily_rent_due'::public.driver_ledger_entry_type
    and dle.effective_date = p_business_date
  group by dle.driver_id
),
payouts_today as (
  select
    p.driver_id,
    coalesce(sum(p.amount_ariary), 0)::bigint as payouts_done_ariary
  from public.driver_payouts p
  where p.status is distinct from 'cancelled'::public.payout_status
    and date(timezone(p_tz, coalesce(p.paid_at, p.created_at))) = p_business_date
  group by p.driver_id
),
balances as (
  select b.driver_id, b.driver_balance_ariary::bigint as current_balance_ariary
  from public.driver_balances b
),
current_assignment as (
  select distinct on (a.driver_id)
    a.driver_id,
    a.vehicle_id,
    a.daily_rent_ariary,
    v.owner_type as vehicle_owner_type
  from public.driver_vehicle_assignments a
  join public.vehicles v on v.id = a.vehicle_id
  where a.starts_at::date <= p_business_date
    and (a.ends_at is null or a.ends_at::date > p_business_date)
  order by a.driver_id, a.starts_at desc
),
rent_expected as (
  select
    ca.driver_id,
    (ca.vehicle_owner_type = 'platform'::public.vehicle_owner_type and ca.daily_rent_ariary is not null and ca.daily_rent_ariary > 0) as rent_expected,
    ca.vehicle_id as current_vehicle_id,
    ca.vehicle_owner_type as current_vehicle_owner_type,
    ca.daily_rent_ariary as current_daily_rent_ariary
  from current_assignment ca
)
select
  p_business_date as business_date,
  d.driver_id,
  d.full_name,
  d.phone,
  coalesce(rt.rides_count, 0) as rides_count,
  coalesce(rt.gross_fares_ariary, 0) as gross_fares_ariary,
  coalesce(rt.platform_commission_ariary, 0) as platform_commission_ariary,
  coalesce(rt.driver_gross_ariary, 0) as driver_gross_ariary,
  coalesce(rn.daily_rent_due_ariary, 0) as daily_rent_due_ariary,
  coalesce(po.payouts_done_ariary, 0) as payouts_done_ariary,
  coalesce(b.current_balance_ariary, 0) as current_balance_ariary,
  greatest(
    0,
    coalesce(rt.driver_gross_ariary, 0)
      - coalesce(rn.daily_rent_due_ariary, 0)
      - coalesce(po.payouts_done_ariary, 0)
  ) as net_payable_today_ariary,
  coalesce(re.rent_expected, false) as rent_expected,
  (
    coalesce(re.rent_expected, false)
    and coalesce(rn.daily_rent_due_ariary, 0) = 0
  ) as rent_missing,
  re.current_vehicle_id,
  re.current_vehicle_owner_type,
  re.current_daily_rent_ariary
from drivers d
left join rides_today rt on rt.driver_id = d.driver_id
left join rents_today rn on rn.driver_id = d.driver_id
left join payouts_today po on po.driver_id = d.driver_id
left join balances b on b.driver_id = d.driver_id
left join rent_expected re on re.driver_id = d.driver_id
order by d.full_name nulls last, d.driver_id;
$$;

revoke all on function public.admin_driver_daily_summary(date, text) from public;
revoke all on function public.admin_driver_daily_summary(date, text) from anon;
revoke all on function public.admin_driver_daily_summary(date, text) from authenticated;
grant execute on function public.admin_driver_daily_summary(date, text) to service_role;

comment on function public.admin_driver_daily_summary(date, text) is
  'Service role: per-driver daily summary for admin reporting (Madagascar business day by default). Includes rent_missing flag when a rent is expected but no daily_rent_due entry exists for that day.';

create or replace function public.admin_platform_daily_summary(
  p_business_date date,
  p_tz text default 'Indian/Antananarivo'
)
returns table (
  business_date date,
  total_rides bigint,
  gross_fares_ariary bigint,
  total_platform_commission_ariary bigint,
  total_driver_gross_ariary bigint,
  total_daily_rents_due_ariary bigint,
  total_payouts_ariary bigint,
  drivers_with_positive_balance_count bigint,
  drivers_with_negative_balance_count bigint,
  drivers_with_zero_balance_count bigint,
  drivers_with_rent_missing_count bigint
)
language sql
security definer
set search_path = public
as $$
with d as (
  select * from public.admin_driver_daily_summary(p_business_date, p_tz)
),
rides as (
  select
    count(*)::bigint as total_rides,
    coalesce(sum(r.fare_total_ariary), 0)::bigint as gross_fares_ariary,
    coalesce(sum(r.platform_commission_ariary), 0)::bigint as total_platform_commission_ariary,
    coalesce(sum(r.driver_gross_ariary), 0)::bigint as total_driver_gross_ariary
  from public.rides r
  where r.status = 'completed'::public.ride_status
    and r.ride_completed_at is not null
    and date(timezone(p_tz, r.ride_completed_at)) = p_business_date
),
d_agg as (
  select
    coalesce(sum(d.daily_rent_due_ariary), 0)::bigint as total_daily_rents_due_ariary,
    coalesce(sum(d.payouts_done_ariary), 0)::bigint as total_payouts_ariary,
    count(*) filter (where d.current_balance_ariary > 0)::bigint as drivers_with_positive_balance_count,
    count(*) filter (where d.current_balance_ariary < 0)::bigint as drivers_with_negative_balance_count,
    count(*) filter (where d.current_balance_ariary = 0)::bigint as drivers_with_zero_balance_count,
    count(*) filter (where d.rent_missing)::bigint as drivers_with_rent_missing_count
  from d
)
select
  p_business_date as business_date,
  rides.total_rides,
  rides.gross_fares_ariary,
  rides.total_platform_commission_ariary,
  rides.total_driver_gross_ariary,
  d_agg.total_daily_rents_due_ariary,
  d_agg.total_payouts_ariary,
  d_agg.drivers_with_positive_balance_count,
  d_agg.drivers_with_negative_balance_count,
  d_agg.drivers_with_zero_balance_count,
  d_agg.drivers_with_rent_missing_count
from rides
cross join d_agg;
$$;

revoke all on function public.admin_platform_daily_summary(date, text) from public;
revoke all on function public.admin_platform_daily_summary(date, text) from anon;
revoke all on function public.admin_platform_daily_summary(date, text) from authenticated;
grant execute on function public.admin_platform_daily_summary(date, text) to service_role;

comment on function public.admin_platform_daily_summary(date, text) is
  'Service role: global daily platform summary for admin reporting (Madagascar business day by default).';

