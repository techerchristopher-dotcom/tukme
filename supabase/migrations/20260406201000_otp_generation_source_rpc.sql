-- Hotfix OTP MVP:
-- - start_ride ne génère plus l'OTP (uniquement transition arrived → in_progress)
-- - get_ride_otp_for_client devient la source unique de génération initiale (si hash null)
-- - si hash déjà présent : erreur OTP_ALREADY_GENERATED (le code doit être conservé côté client)

create extension if not exists pgcrypto with schema extensions;

create or replace function public.start_ride(p_ride_id uuid)
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
    raise exception 'START_RIDE_NOT_DRIVER'
      using errcode = 'P0001',
        hint = 'Seuls les comptes chauffeur peuvent démarrer la course.';
  end if;

  update public.rides
  set
    status = 'in_progress'::public.ride_status,
    ride_started_at = coalesce(ride_started_at, now())
  where id = p_ride_id
    and driver_id = v_uid
    and status = 'arrived'::public.ride_status;

  get diagnostics v_updated = row_count;
  if v_updated = 0 then
    raise exception 'START_RIDE_NOT_ALLOWED'
      using errcode = 'P0001',
        hint = 'Transition impossible (pas arrivé ou mauvais chauffeur).';
  end if;
end;
$$;

create or replace function public.get_ride_otp_for_client(p_ride_id uuid)
returns text
language plpgsql
security definer
set search_path = public
as $$
declare
  v_client_id uuid;
  v_status public.ride_status;
  v_hash text;
  v_otp text;
begin
  select r.client_id, r.status, r.ride_otp_hash
    into v_client_id, v_status, v_hash
  from public.rides r
  where r.id = p_ride_id
  for update;

  if not found then
    raise exception 'OTP_NOT_FOUND'
      using errcode = 'P0001',
        hint = 'Course introuvable.';
  end if;

  if v_client_id is distinct from auth.uid() then
    raise exception 'OTP_FORBIDDEN'
      using errcode = 'P0001',
        hint = 'Cette course ne vous appartient pas.';
  end if;

  if v_status is distinct from 'in_progress'::public.ride_status then
    raise exception 'OTP_NOT_IN_PROGRESS'
      using errcode = 'P0001',
        hint = 'Le code est disponible uniquement pendant la course.';
  end if;

  if v_hash is not null then
    raise exception 'OTP_ALREADY_GENERATED'
      using errcode = 'P0001',
        hint = 'Le code a déjà été affiché. Conservez-le sur l’appareil du client.';
  end if;

  v_otp := lpad((floor(random() * 10000))::int::text, 4, '0');
  update public.rides
  set
    ride_otp_hash = extensions.crypt(v_otp, extensions.gen_salt('bf')),
    ride_otp_generated_at = coalesce(ride_otp_generated_at, now())
  where id = p_ride_id;

  return v_otp;
end;
$$;

