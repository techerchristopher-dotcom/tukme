-- Fleet manual module — Ensure all aggregates exclude soft-deleted entries
--
-- Rationale:
-- - Soft delete is implemented via fleet_vehicle_entries.deleted_at
-- - Any aggregate helper must ignore deleted rows to keep KPIs consistent

create or replace function public.admin_fleet_vehicle_entries_aggregates(
  p_vehicle_ids uuid[]
)
returns table (
  vehicle_id uuid,
  total_income_ariary bigint,
  total_expense_ariary bigint
)
language sql
security definer
set search_path = public
as $$
  select
    e.vehicle_id,
    coalesce(sum(case when e.entry_type = 'income' then e.amount_ariary else 0 end), 0)::bigint as total_income_ariary,
    coalesce(sum(case when e.entry_type = 'expense' then e.amount_ariary else 0 end), 0)::bigint as total_expense_ariary
  from public.fleet_vehicle_entries e
  where e.vehicle_id = any(p_vehicle_ids)
    and e.deleted_at is null
  group by e.vehicle_id;
$$;

revoke all on function public.admin_fleet_vehicle_entries_aggregates(uuid[]) from public;
revoke all on function public.admin_fleet_vehicle_entries_aggregates(uuid[]) from anon;
revoke all on function public.admin_fleet_vehicle_entries_aggregates(uuid[]) from authenticated;

