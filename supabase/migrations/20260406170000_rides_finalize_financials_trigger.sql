-- Trigger: when a ride becomes completed, finalize its financials.
-- Minimal & robust: only calls public.finalize_ride_financials(ride_id).

create or replace function public.tg_finalize_ride_financials_after_completed()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if
    new.status = 'completed'::public.ride_status
    and old.status is distinct from 'completed'::public.ride_status
    and new.is_financials_finalized = false
  then
    perform public.finalize_ride_financials(new.id);
  end if;
  return new;
end;
$$;

revoke all on function public.tg_finalize_ride_financials_after_completed() from public;
revoke all on function public.tg_finalize_ride_financials_after_completed() from anon;
revoke all on function public.tg_finalize_ride_financials_after_completed() from authenticated;

drop trigger if exists rides_finalize_financials_on_completed on public.rides;

create trigger rides_finalize_financials_on_completed
after update of status, is_financials_finalized
on public.rides
for each row
when (
  new.status = 'completed'::public.ride_status
  and old.status is distinct from 'completed'::public.ride_status
  and new.is_financials_finalized = false
)
execute function public.tg_finalize_ride_financials_after_completed();

