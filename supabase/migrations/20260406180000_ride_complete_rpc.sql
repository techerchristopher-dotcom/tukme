-- Clôture de course (MVP) : in_progress → completed (chauffeur assigné uniquement).

alter table public.rides
  add column if not exists ride_completed_at timestamptz null;

comment on column public.rides.ride_completed_at is
  'Horodatage : la course a été terminée par le chauffeur (in_progress → completed).';

create or replace function public.complete_ride(p_ride_id uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_uid uuid := auth.uid();
  v_updated integer;
begin
  if not exists (
    select 1 from public.profiles p where p.id = v_uid and p.role = 'driver'
  ) then
    raise exception 'COMPLETE_RIDE_NOT_DRIVER'
      using errcode = 'P0001',
        hint = 'Seuls les comptes chauffeur peuvent terminer une course.';
  end if;

  update public.rides
  set
    status = 'completed'::public.ride_status,
    ride_completed_at = coalesce(ride_completed_at, now())
  where id = p_ride_id
    and driver_id = v_uid
    and status = 'in_progress'::public.ride_status;

  get diagnostics v_updated = row_count;
  if v_updated = 0 then
    raise exception 'COMPLETE_RIDE_NOT_ALLOWED'
      using errcode = 'P0001',
        hint = 'Transition impossible (statut ou assignation incorrecte).';
  end if;
end;
$$;

revoke all on function public.complete_ride(uuid) from public;
grant execute on function public.complete_ride(uuid) to authenticated;

comment on function public.complete_ride(uuid) is
  'Chauffeur assigné : in_progress → completed.';

