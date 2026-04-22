-- Fleet manual module — Payments foundation hardening
--
-- Purpose:
-- - Ensure explicit, named guardrails for payment amount > 0
-- - Ensure fast lookup by entry_id via indexes
--
-- Notes:
-- - Additive + idempotent (safe to run multiple times)

-- 1) Explicit constraint: payment amount must be > 0
do $$ begin
  alter table public.fleet_vehicle_entry_payments
    add constraint fleet_vehicle_entry_payments_amount_pos
      check (amount_ariary > 0);
exception when duplicate_object then null; end $$;

-- 2) Indexes on entry_id to support per-entry queries / aggregates
create index if not exists fvep_entry_id_idx
  on public.fleet_vehicle_entry_payments (entry_id, paid_at desc, created_at desc);

create index if not exists fvep_entry_id_active_idx
  on public.fleet_vehicle_entry_payments (entry_id, paid_at desc, created_at desc)
  where deleted_at is null;

