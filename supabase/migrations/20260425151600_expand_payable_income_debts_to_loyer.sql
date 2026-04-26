-- Fleet manual module — Expand payable income debts to include loyer
--
-- We keep existing RPC names for compatibility but broaden the category filter:
-- - previously: only category='carburant'
-- - now: category in ('carburant', 'loyer')
--
-- This enables partial payments + debt tracking for rent (loyer) income entries using the same payments table.

-- ---------------------------------------------------------------------------
-- 1) Vehicle-level open balance for payable income debts (carburant + loyer)
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
      and lower(btrim(e.category)) in ('carburant', 'loyer')
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

-- ---------------------------------------------------------------------------
-- 2) Vehicle-level open debt details (carburant + loyer)
-- ---------------------------------------------------------------------------
-- Note: changing OUT parameters requires DROP + CREATE (Postgres limitation).
drop function if exists public.admin_fleet_vehicle_open_fuel_income_debt_details(uuid);

create function public.admin_fleet_vehicle_open_fuel_income_debt_details(
  p_vehicle_id uuid
)
returns table (
  entry_id uuid,
  entry_date text,
  category text,
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
      lower(btrim(e.category)) as category_norm,
      e.category as category,
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
      and lower(btrim(e.category)) in ('carburant', 'loyer')
      and e.entry_type = 'income'
  )
  select
    d.entry_id,
    d.entry_date,
    d.category,
    coalesce(nullif(btrim(d.label), ''), case when d.category_norm = 'loyer' then 'Loyer' else 'Carburant' end) as description,
    d.due_ariary as amount_ariary,
    d.paid_ariary as total_paid_ariary,
    d.remaining_ariary as remaining_amount_ariary,
    d.payment_status,
    case when d.category_norm = 'carburant' then d.is_legacy else false end as is_legacy,
    d.created_at
  from debts d
  where d.remaining_ariary > 0
  order by d.entry_date asc, d.created_at asc;
$$;

revoke all on function public.admin_fleet_vehicle_open_fuel_income_debt_details(uuid) from public;
revoke all on function public.admin_fleet_vehicle_open_fuel_income_debt_details(uuid) from anon;
revoke all on function public.admin_fleet_vehicle_open_fuel_income_debt_details(uuid) from authenticated;

