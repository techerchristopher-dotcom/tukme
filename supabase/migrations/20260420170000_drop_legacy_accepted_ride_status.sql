-- Remove legacy `accepted` ride status from the *system*.
--
-- Important: PostgreSQL does not support dropping enum values. Even on recent
-- versions, `alter type ... drop value` is not implemented.
--
-- So we do the next best production-safe approach:
-- - migrate any existing rows `accepted` → `awaiting_payment` (idempotent)
-- - add a CHECK constraint preventing any future use of `accepted`
-- This guarantees a single source of truth for runtime statuses without
-- breaking existing migrations or functions that still mention the legacy enum.

update public.rides
set status = 'awaiting_payment'::public.ride_status
where status = 'accepted'::public.ride_status;

alter table public.rides
  add constraint rides_status_no_accepted
  check (status is distinct from 'accepted'::public.ride_status)
  not valid;

alter table public.rides
  validate constraint rides_status_no_accepted;

