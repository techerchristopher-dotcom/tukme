-- Fleet manual module — Open fuel income debt details (driver debt)
--
-- Goals:
-- - Provide the list of open fuel income debts for a vehicle (used by admin UI modal)
-- - Source of truth: `fleet_vehicle_entries` (debts) + `fleet_vehicle_entry_payments` (payments)
--
-- Security:
-- - SECURITY DEFINER to allow service-role/admin-api execution with RLS enabled
-- - Revoke EXECUTE from public/anon/authenticated
--
-- Rules:
-- - Include only: entry_type='income' AND category='carburant'
-- - Ignore soft-deleted entries/payments (deleted_at is null)
-- - Return only remaining > 0 (open debts)
-- - Sort: oldest entry_date first, then created_at
create or replace function public.admin_fleet_vehicle_open_fuel_income_debt_details(
  p_vehicle_id uuid
)
returns table (
  entry_id uuid,
  entry_date text,
  description text,
  amount_ariary bigint,
  total_paid_ariary bigint,
  remaining_amount_ariary bigint,
  payment_status text,
  is_legacy boolean,
  created_at timestamptz
)
language sql
security definer
set search_path = public
as $$
  with paid as (
    select
      p.entry_id,
      coalesce(sum(p.amount_ariary), 0)::bigint as total_paid_ariary
    from public.fleet_vehicle_entry_payments p
    where p.deleted_at is null
    group by p.entry_id
  ),
  debts as (
    select
      e.id as entry_id,
      e.entry_date,
      e.label,
      e.amount_ariary::bigint as due_ariary,
      coalesce(paid.total_paid_ariary, 0)::bigint as paid_ariary,
      greatest(0, e.amount_ariary::bigint - coalesce(paid.total_paid_ariary, 0)::bigint)::bigint as remaining_ariary,
      case
        when greatest(0, e.amount_ariary::bigint - coalesce(paid.total_paid_ariary, 0)::bigint) <= 0 then 'paid'
        when coalesce(paid.total_paid_ariary, 0)::bigint <= 0 then 'unpaid'
        else 'partial'
      end as payment_status,
      (coalesce(e.fuel_mode, '') = 'legacy') as is_legacy,
      e.created_at
    from public.fleet_vehicle_entries e
    left join paid on paid.entry_id = e.id
    where e.vehicle_id = p_vehicle_id
      and e.deleted_at is null
      and lower(btrim(e.category)) = 'carburant'
      and e.entry_type = 'income'
  )
  select
    d.entry_id,
    d.entry_date,
    coalesce(nullif(btrim(d.label), ''), 'Carburant') as description,
    d.due_ariary as amount_ariary,
    d.paid_ariary as total_paid_ariary,
    d.remaining_ariary as remaining_amount_ariary,
    d.payment_status,
    d.is_legacy,
    d.created_at
  from debts d
  where d.remaining_ariary > 0
  order by d.entry_date asc, d.created_at asc;
$$;

revoke all on function public.admin_fleet_vehicle_open_fuel_income_debt_details(uuid) from public;
revoke all on function public.admin_fleet_vehicle_open_fuel_income_debt_details(uuid) from anon;
revoke all on function public.admin_fleet_vehicle_open_fuel_income_debt_details(uuid) from authenticated;

