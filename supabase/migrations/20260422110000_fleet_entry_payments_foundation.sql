-- Fleet manual module — Partial payments foundation for fuel income debts
--
-- Goals:
-- - Add a payment journal linked to a specific fleet vehicle entry (debt)
-- - Support multiple partial payments per entry
-- - Keep status/remaining amounts derivable (no stored status here)
-- - Additive and non-breaking for existing fleet_vehicle_entries logic
--
-- Security:
-- - RLS enabled with no policies (admin-api uses service role)
-- - Revoke privileges from public/anon/authenticated (same pattern as fleet_* tables)

-- ---------------------------------------------------------------------------
-- 1) Payments table (linked to a single entry)
-- ---------------------------------------------------------------------------
create table if not exists public.fleet_vehicle_entry_payments (
  id uuid primary key default gen_random_uuid(),
  entry_id uuid not null references public.fleet_vehicle_entries (id) on delete restrict,

  amount_ariary integer not null check (amount_ariary > 0),
  paid_at timestamptz not null default now(),
  notes text,

  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  updated_by text,

  deleted_at timestamptz,
  deleted_by text,
  delete_reason text,

  constraint fvep_notes_nonempty check (notes is null or btrim(notes) <> ''),
  constraint fvep_deleted_by_requires_deleted_at check (deleted_by is null or deleted_at is not null),
  constraint fvep_deleted_at_requires_deleted_by check (deleted_at is null or deleted_by is not null)
);

-- Maintain updated_at automatically on UPDATE (same pattern as fleet_vehicles / fleet_vehicle_entries).
drop trigger if exists fleet_vehicle_entry_payments_set_updated_at on public.fleet_vehicle_entry_payments;
create trigger fleet_vehicle_entry_payments_set_updated_at
  before update on public.fleet_vehicle_entry_payments
  for each row
  execute function public.tg_set_updated_at();

-- Indexes for future queries:
-- - list payments for an entry (detail UI)
-- - sum active payments per entry (status/remaining computations)
create index if not exists fvep_entry_id_idx
  on public.fleet_vehicle_entry_payments (entry_id, paid_at desc, created_at desc);

create index if not exists fvep_entry_id_active_idx
  on public.fleet_vehicle_entry_payments (entry_id, paid_at desc, created_at desc)
  where deleted_at is null;

alter table public.fleet_vehicle_entry_payments enable row level security;
revoke all on table public.fleet_vehicle_entry_payments from public, anon, authenticated;

comment on table public.fleet_vehicle_entry_payments is
  'Manual fleet: partial payments linked to a specific fleet_vehicle_entries row (e.g. fuel income debt).';

