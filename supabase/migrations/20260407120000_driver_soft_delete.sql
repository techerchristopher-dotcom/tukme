-- Soft-delete chauffeurs : historique finance / rides préservé, pas de DELETE auth.users
-- (FK rides.driver_id et vehicles.owner_driver_id → auth.users en NO ACTION).

alter table public.profiles
  add column if not exists deleted_at timestamptz;

comment on column public.profiles.deleted_at is
  'Chauffeur désactivé côté admin : masqué des listes opérationnelles, compte auth banni ; historique conservé.';

create index if not exists profiles_active_drivers_idx
  on public.profiles (id)
  where role = 'driver' and deleted_at is null;

-- Désactivation transactionnelle (idempotente si déjà désactivé).
create or replace function public.admin_deactivate_driver(p_driver_id uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  if p_driver_id is null then
    raise exception 'DRIVER_ID_REQUIRED'
      using errcode = 'P0001', hint = 'p_driver_id requis.';
  end if;

  if not exists (
    select 1 from public.profiles p
    where p.id = p_driver_id and p.role = 'driver'
  ) then
    raise exception 'DRIVER_NOT_FOUND'
      using errcode = 'P0001', hint = 'Profil chauffeur introuvable.';
  end if;

  if exists (
    select 1 from public.profiles p
    where p.id = p_driver_id and p.deleted_at is not null
  ) then
    return;
  end if;

  update public.profiles
  set deleted_at = now()
  where id = p_driver_id;

  update public.driver_vehicle_assignments
  set ends_at = now()
  where driver_id = p_driver_id
    and ends_at is null;

  update public.vehicles
  set active = false
  where owner_type = 'driver'::public.vehicle_owner_type
    and owner_driver_id = p_driver_id;
end;
$$;

revoke all on function public.admin_deactivate_driver(uuid) from public;
revoke all on function public.admin_deactivate_driver(uuid) from anon;
revoke all on function public.admin_deactivate_driver(uuid) from authenticated;
grant execute on function public.admin_deactivate_driver(uuid) to service_role;

comment on function public.admin_deactivate_driver(uuid) is
  'Service role: soft-delete chauffeur (deleted_at, fin affectations, véhicules driver inactifs).';

-- Empêcher de « recréer » un chauffeur sur un profil désactivé via le bundle admin.
create or replace function public.admin_create_driver_bundle(
  p_user_id uuid,
  p_full_name text,
  p_phone text,
  p_plate text
)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  v_vehicle_id uuid;
  v_plate text;
begin
  if p_user_id is null then
    raise exception 'USER_ID_REQUIRED'
      using errcode = 'P0001', hint = 'p_user_id requis.';
  end if;

  if exists (
    select 1 from public.profiles p
    where p.id = p_user_id and p.deleted_at is not null
  ) then
    raise exception 'PROFILE_DEACTIVATED'
      using errcode = 'P0001', hint = 'Chauffeur désactivé.';
  end if;

  v_plate := upper(trim(p_plate));
  if v_plate = '' then
    raise exception 'PLATE_INVALID'
      using errcode = 'P0001', hint = 'Immatriculation invalide.';
  end if;

  if trim(p_full_name) = '' then
    raise exception 'FULL_NAME_INVALID'
      using errcode = 'P0001', hint = 'Nom complet invalide.';
  end if;

  insert into public.profiles (id, email, role, full_name, phone)
  values (p_user_id, null, 'driver'::text, trim(p_full_name), p_phone)
  on conflict (id) do update
    set role = 'driver',
        full_name = excluded.full_name,
        phone = excluded.phone;

  select v.id
    into v_vehicle_id
  from public.vehicles v
  where v.owner_type = 'driver'::public.vehicle_owner_type
    and v.owner_driver_id = p_user_id
    and v.plate_number is not distinct from v_plate
  limit 1;

  if v_vehicle_id is null then
    insert into public.vehicles (owner_type, owner_driver_id, plate_number, active)
    values ('driver'::public.vehicle_owner_type, p_user_id, v_plate, true)
    returning id into v_vehicle_id;
  end if;

  update public.driver_vehicle_assignments dva
    set ends_at = now()
  where dva.driver_id = p_user_id
    and dva.ends_at is null;

  insert into public.driver_vehicle_assignments (driver_id, vehicle_id, starts_at)
  values (p_user_id, v_vehicle_id, now());

  return p_user_id;
end;
$$;

revoke all on function public.admin_create_driver_bundle(uuid, text, text, text) from public;
revoke all on function public.admin_create_driver_bundle(uuid, text, text, text) from anon;
revoke all on function public.admin_create_driver_bundle(uuid, text, text, text) from authenticated;
grant execute on function public.admin_create_driver_bundle(uuid, text, text, text) to service_role;

-- Liste admin : uniquement chauffeurs actifs (non désactivés).
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
    and p.deleted_at is null
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
