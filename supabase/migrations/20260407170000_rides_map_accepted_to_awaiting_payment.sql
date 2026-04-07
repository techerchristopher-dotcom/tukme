-- Cleanup legacy status `accepted` (production-safe):
-- - `accepted` is kept in enum for backward compatibility (removing enum values is risky)
-- - But we ensure no existing rides remain stuck on `accepted`
-- - Map `accepted` → `awaiting_payment` and initialize payment_expires_at when missing

update public.rides
set
  status = 'awaiting_payment'::public.ride_status,
  payment_expires_at = coalesce(payment_expires_at, now() + interval '5 minutes')
where status = 'accepted'::public.ride_status;

