-- Fleet manual module — Partial payments (server-side aggregates)
--
-- Goals:
-- - Provide small, atomic primitives for admin-api to avoid N+1 queries:
--   1) Sum active payments by entry_id (total_paid)
--   2) Compute vehicle-level open balance for fuel income debts (sum of remaining)
--
-- Security:
-- - SECURITY DEFINER to allow service-role/admin-api execution with RLS enabled
-- - Revoke EXECUTE from public/anon/authenticated

-- ---------------------------------------------------------------------------
-- 1) total_paid per entry_id (ignores soft-deleted payments)
-- ---------------------------------------------------------------------------
create or replace function public.admin_fleet_entry_payments_aggregates(
  p_entry_ids uuid[]
)
returns table (
  entry_id uuid,
  total_paid_ariary bigint
)
language sql
security definer
set search_path = public
as $$
  select
    p.entry_id,
    coalesce(sum(p.amount_ariary), 0)::bigint as total_paid_ariary
  from public.fleet_vehicle_entry_payments p
  where p.deleted_at is null
    and p.entry_id = any(p_entry_ids)
  group by p.entry_id;
$$;

revoke all on function public.admin_fleet_entry_payments_aggregates(uuid[]) from public;
revoke all on function public.admin_fleet_entry_payments_aggregates(uuid[]) from anon;
revoke all on function public.admin_fleet_entry_payments_aggregates(uuid[]) from authenticated;

-- ---------------------------------------------------------------------------
-- 2) Vehicle-level open balance for fuel income debts
--    - debt entries: fleet_vehicle_entries where category='carburant' and entry_type='income'
--    - remaining per entry: max(0, amount_ariary - total_paid)
-- ---------------------------------------------------------------------------
create or replace function public.admin_fleet_vehicle_open_fuel_income_debt(
  p_vehicle_id uuid
)
returns table (
  open_remaining_ariary bigint,
  open_entries_count integer
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
      e.amount_ariary::bigint as due_ariary,
      coalesce(paid.total_paid_ariary, 0)::bigint as paid_ariary
    from public.fleet_vehicle_entries e
    left join paid on paid.entry_id = e.id
    where e.vehicle_id = p_vehicle_id
      and e.deleted_at is null
      and lower(btrim(e.category)) = 'carburant'
      and e.entry_type = 'income'
  )
  select
    coalesce(sum(greatest(0, due_ariary - paid_ariary)), 0)::bigint as open_remaining_ariary,
    coalesce(sum(case when (due_ariary - paid_ariary) > 0 then 1 else 0 end), 0)::integer as open_entries_count
  from debts;
$$;

revoke all on function public.admin_fleet_vehicle_open_fuel_income_debt(uuid) from public;
revoke all on function public.admin_fleet_vehicle_open_fuel_income_debt(uuid) from anon;
revoke all on function public.admin_fleet_vehicle_open_fuel_income_debt(uuid) from authenticated;

