-- Extend admin_driver_debts_summary() with oldest_entry_date for UI "ancienneté"
-- Note: return type change requires DROP + CREATE.

drop function if exists public.admin_driver_debts_summary();

create function public.admin_driver_debts_summary()
returns table (
  driver_id uuid,
  driver_name text,
  driver_phone text,
  open_entries_count integer,
  total_debt_ariary bigint,
  fuel_debt_ariary bigint,
  rent_debt_ariary bigint,
  last_payment_at timestamptz,
  oldest_entry_date date,
  current_vehicle_id uuid,
  current_vehicle_label text,
  current_assignment_id uuid
)
language sql
security definer
set search_path = public
as $$
  with paid as (
    select
      p.entry_id,
      coalesce(sum(p.amount_ariary), 0)::bigint as total_paid_ariary,
      max(p.paid_at) as last_payment_at
    from public.fleet_vehicle_entry_payments p
    where p.deleted_at is null
    group by p.entry_id
  ),
  debts as (
    select
      e.id as entry_id,
      coalesce(e.driver_id_snapshot, a.driver_id) as driver_id,
      e.vehicle_id,
      e.entry_date,
      lower(btrim(e.category)) as category_norm,
      greatest(
        0,
        e.amount_ariary::bigint - coalesce(paid.total_paid_ariary, 0)::bigint
      )::bigint as remaining_ariary,
      paid.last_payment_at,
      a.id as assignment_id
    from public.fleet_vehicle_entries e
    left join paid on paid.entry_id = e.id
    left join public.fleet_vehicle_assignments a
      on a.id = e.driver_vehicle_assignment_id
    where e.deleted_at is null
      and e.entry_type = 'income'
      and lower(btrim(e.category)) in ('carburant', 'loyer')
      and e.driver_vehicle_assignment_id is not null
  ),
  open_debts as (
    select *
    from debts
    where remaining_ariary > 0
      and driver_id is not null
  ),
  current_assign as (
    select distinct on (a.driver_id)
      a.driver_id,
      a.id as current_assignment_id,
      a.vehicle_id as current_vehicle_id,
      fv.plate_number as current_vehicle_label
    from public.fleet_vehicle_assignments a
    join public.fleet_vehicles fv on fv.id = a.vehicle_id
    where a.ends_at is null
    order by a.driver_id, a.starts_at desc, a.created_at desc
  )
  select
    p.id as driver_id,
    p.full_name as driver_name,
    p.phone as driver_phone,
    count(*)::integer as open_entries_count,
    coalesce(sum(o.remaining_ariary), 0)::bigint as total_debt_ariary,
    coalesce(sum(o.remaining_ariary) filter (where o.category_norm = 'carburant'), 0)::bigint as fuel_debt_ariary,
    coalesce(sum(o.remaining_ariary) filter (where o.category_norm = 'loyer'), 0)::bigint as rent_debt_ariary,
    max(o.last_payment_at) as last_payment_at,
    min(o.entry_date) as oldest_entry_date,
    ca.current_vehicle_id,
    ca.current_vehicle_label,
    ca.current_assignment_id
  from open_debts o
  join public.profiles p on p.id = o.driver_id
  left join current_assign ca on ca.driver_id = p.id
  group by p.id, p.full_name, p.phone, ca.current_vehicle_id, ca.current_vehicle_label, ca.current_assignment_id
  having count(*) > 0
  order by total_debt_ariary desc;
$$;

revoke all on function public.admin_driver_debts_summary() from public;
revoke all on function public.admin_driver_debts_summary() from anon;
revoke all on function public.admin_driver_debts_summary() from authenticated;

