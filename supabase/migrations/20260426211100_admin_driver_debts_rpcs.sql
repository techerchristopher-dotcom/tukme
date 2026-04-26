-- Admin RPCs — Driver debts (fleet manual)
--
-- Context:
-- - Payable debts are represented as fleet_vehicle_entries (income, category in ('carburant','loyer'))
-- - Payments are fleet_vehicle_entry_payments (soft deletable)
-- - Backfill has populated:
--   - fleet_vehicle_entries.driver_vehicle_assignment_id (stores fleet_vehicle_assignments.id)
--   - fleet_vehicle_entries.driver_id_snapshot (stores profiles.id)
--   - assignment_resolution_status='resolved' for historical payable debts
--
-- Goals:
-- - Provide backend source of truth for an admin “Dettes chauffeurs” page.
-- - One row per driver with at least one OPEN debt.
-- - Detail RPC listing open debt entries for a given driver.
--
-- Security:
-- - SECURITY DEFINER (admin-api uses service role with RLS enabled)
-- - Revoke EXECUTE from public/anon/authenticated

-- ---------------------------------------------------------------------------
-- Shared concept: active payments per entry (ignores soft-deleted payments)
-- ---------------------------------------------------------------------------

-- ---------------------------------------------------------------------------
-- RPC 1 — admin_driver_debts_summary()
--   One row per driver having at least one open debt entry.
-- ---------------------------------------------------------------------------
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
      -- Prefer snapshot (explicit owner at creation/backfill), fall back to assignment driver_id if needed.
      coalesce(e.driver_id_snapshot, a.driver_id) as driver_id,
      e.vehicle_id,
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
    -- A driver can have multiple active vehicles today; pick the most recent starts_at as "current".
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

-- ---------------------------------------------------------------------------
-- RPC 2 — admin_driver_debts_detail(p_driver_id uuid)
--   One row per OPEN debt entry for the given driver.
-- ---------------------------------------------------------------------------
drop function if exists public.admin_driver_debts_detail(uuid);

create function public.admin_driver_debts_detail(
  p_driver_id uuid
)
returns table (
  entry_id uuid,
  driver_id uuid,
  vehicle_id uuid,
  vehicle_label text,
  assignment_id uuid,
  assignment_starts_at timestamptz,
  assignment_ends_at timestamptz,
  entry_date date,
  category text,
  label text,
  amount_ariary integer,
  total_paid_ariary bigint,
  remaining_amount_ariary bigint,
  payment_status text,
  last_payment_at timestamptz,
  assignment_resolution_status text,
  assignment_resolution_note text,
  created_at timestamptz
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
  rows as (
    select
      e.id as entry_id,
      coalesce(e.driver_id_snapshot, a.driver_id) as driver_id,
      e.vehicle_id,
      fv.plate_number as vehicle_label,
      a.id as assignment_id,
      a.starts_at as assignment_starts_at,
      a.ends_at as assignment_ends_at,
      e.entry_date,
      e.category,
      e.label,
      e.amount_ariary,
      coalesce(paid.total_paid_ariary, 0)::bigint as total_paid_ariary,
      greatest(
        0,
        e.amount_ariary::bigint - coalesce(paid.total_paid_ariary, 0)::bigint
      )::bigint as remaining_amount_ariary,
      case
        when coalesce(paid.total_paid_ariary, 0)::bigint <= 0 then 'non payé'
        else 'partiel'
      end as payment_status,
      paid.last_payment_at,
      e.assignment_resolution_status,
      e.assignment_resolution_note,
      e.created_at
    from public.fleet_vehicle_entries e
    left join paid on paid.entry_id = e.id
    left join public.fleet_vehicle_assignments a
      on a.id = e.driver_vehicle_assignment_id
    join public.fleet_vehicles fv on fv.id = e.vehicle_id
    where e.deleted_at is null
      and e.entry_type = 'income'
      and lower(btrim(e.category)) in ('carburant', 'loyer')
      and e.driver_vehicle_assignment_id is not null
  )
  select
    r.entry_id,
    r.driver_id,
    r.vehicle_id,
    r.vehicle_label,
    r.assignment_id,
    r.assignment_starts_at,
    r.assignment_ends_at,
    r.entry_date,
    r.category,
    r.label,
    r.amount_ariary,
    r.total_paid_ariary,
    r.remaining_amount_ariary,
    r.payment_status,
    r.last_payment_at,
    r.assignment_resolution_status,
    r.assignment_resolution_note,
    r.created_at
  from rows r
  where r.driver_id = p_driver_id
    and r.remaining_amount_ariary > 0
  order by r.entry_date asc, r.created_at asc;
$$;

revoke all on function public.admin_driver_debts_detail(uuid) from public;
revoke all on function public.admin_driver_debts_detail(uuid) from anon;
revoke all on function public.admin_driver_debts_detail(uuid) from authenticated;

