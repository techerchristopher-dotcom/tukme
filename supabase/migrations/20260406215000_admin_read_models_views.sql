-- Admin read-models (views) — not exposed to authenticated (service_role only).

-- ---------------------------------------------------------------------------
-- Completed rides — finance-ready list
-- ---------------------------------------------------------------------------
create or replace view public.admin_completed_rides_financial as
select
  r.id as ride_id,
  r.ride_completed_at,
  r.status,
  r.is_financials_finalized,
  r.client_id,
  r.driver_id,
  pd.full_name as driver_full_name,
  pd.phone as driver_phone,
  r.fare_total_ariary,
  r.platform_commission_rate_bps,
  r.platform_commission_ariary,
  r.driver_gross_ariary,
  r.vehicle_id,
  r.vehicle_owner_type,
  v.kind as vehicle_kind,
  v.plate_number as vehicle_plate_number
from public.rides r
left join public.profiles pd on pd.id = r.driver_id
left join public.vehicles v on v.id = r.vehicle_id
where r.status = 'completed'::public.ride_status;

comment on view public.admin_completed_rides_financial is
  'Admin read-model: completed rides with frozen finance snapshots and driver/vehicle context.';

revoke all on table public.admin_completed_rides_financial from PUBLIC;
revoke all on table public.admin_completed_rides_financial from anon;
revoke all on table public.admin_completed_rides_financial from authenticated;

-- ---------------------------------------------------------------------------
-- Driver payouts — detailed list
-- ---------------------------------------------------------------------------
create or replace view public.admin_driver_payouts_detailed as
select
  p.id as payout_id,
  p.created_at,
  p.paid_at,
  p.status,
  p.method,
  p.amount_ariary,
  p.reference,
  p.notes,
  p.driver_id,
  d.full_name as driver_full_name,
  d.phone as driver_phone
from public.driver_payouts p
left join public.profiles d on d.id = p.driver_id;

comment on view public.admin_driver_payouts_detailed is
  'Admin read-model: driver payouts with driver identity.';

revoke all on table public.admin_driver_payouts_detailed from PUBLIC;
revoke all on table public.admin_driver_payouts_detailed from anon;
revoke all on table public.admin_driver_payouts_detailed from authenticated;

-- ---------------------------------------------------------------------------
-- Daily rents — detailed list
-- ---------------------------------------------------------------------------
create or replace view public.admin_driver_daily_rents_detailed as
select
  r.id as daily_rent_id,
  r.created_at,
  r.date as business_date,
  r.status,
  r.rent_ariary,
  r.notes,
  r.driver_id,
  d.full_name as driver_full_name,
  d.phone as driver_phone,
  r.vehicle_id,
  v.owner_type as vehicle_owner_type,
  v.kind as vehicle_kind,
  v.plate_number as vehicle_plate_number
from public.driver_daily_rents r
left join public.profiles d on d.id = r.driver_id
left join public.vehicles v on v.id = r.vehicle_id;

comment on view public.admin_driver_daily_rents_detailed is
  'Admin read-model: daily rents with driver identity and vehicle context.';

revoke all on table public.admin_driver_daily_rents_detailed from PUBLIC;
revoke all on table public.admin_driver_daily_rents_detailed from anon;
revoke all on table public.admin_driver_daily_rents_detailed from authenticated;

