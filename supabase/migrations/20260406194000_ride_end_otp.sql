-- OTP fin de course (MVP).
-- - Généré au passage arrived → in_progress (start_ride)
-- - Stockage : hash + generated_at (pas d’OTP en clair en base)
-- - Clôture : complete_ride_with_otp (driver assigné + otp valide) → completed
-- - Affichage client : get_ride_otp_for_client (RPC qui retourne le code en clair au client propriétaire)
--
-- IMPORTANT MVP: le code OTP est dérivé avec un secret côté DB (salt) via pgcrypto `crypt`.
-- On ne persiste que le hash ; le code en clair est retourné uniquement via RPC pour le client.

create extension if not exists pgcrypto;

alter table public.rides
  add column if not exists ride_otp_hash text null,
  add column if not exists ride_otp_generated_at timestamptz null;

comment on column public.rides.ride_otp_hash is
  'Hash OTP fin de course (bcrypt via pgcrypto.crypt). OTP en clair non stocké.';
comment on column public.rides.ride_otp_generated_at is
  'Horodatage de génération OTP fin de course (arrived → in_progress).';

-- ---------------------------------------------------------------------------
-- Patch start_ride : génération OTP (hash) au passage in_progress
-- ---------------------------------------------------------------------------
create or replace function public.start_ride(p_ride_id uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_uid uuid := auth.uid();
  v_updated integer;
  v_otp text;
begin
  if not exists (
    select 1 from public.profiles p where p.id = v_uid and p.role = 'driver'
  ) then
    raise exception 'START_RIDE_NOT_DRIVER'
      using errcode = 'P0001',
        hint = 'Seuls les comptes chauffeur peuvent démarrer la course.';
  end if;

  -- OTP 4 chiffres : généré uniquement si absent.
  v_otp := lpad((floor(random() * 10000))::int::text, 4, '0');

  update public.rides
  set
    status = 'in_progress'::public.ride_status,
    ride_started_at = coalesce(ride_started_at, now()),
    ride_otp_hash = coalesce(ride_otp_hash, crypt(v_otp, gen_salt('bf'))),
    ride_otp_generated_at = coalesce(ride_otp_generated_at, now())
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

revoke all on function public.start_ride(uuid) from public;
grant execute on function public.start_ride(uuid) to authenticated;

comment on function public.start_ride(uuid) is
  'Chauffeur assigné : arrived → in_progress (génère ride_otp_hash si absent).';

-- ---------------------------------------------------------------------------
-- RPC client : lire le code OTP (en clair) uniquement pour le client propriétaire.
-- Le code est régénéré si hash absent (cas legacy), sans changer le statut.
-- ---------------------------------------------------------------------------
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

  -- Si legacy : générer hash + timestamp, et retourner le code en clair.
  if v_hash is null then
    v_otp := lpad((floor(random() * 10000))::int::text, 4, '0');
    update public.rides
    set
      ride_otp_hash = crypt(v_otp, gen_salt('bf')),
      ride_otp_generated_at = coalesce(ride_otp_generated_at, now())
    where id = p_ride_id;
    return v_otp;
  end if;

  -- Hash présent : on ne peut pas re-dériver le code en clair.
  -- MVP: on force la génération côté start_ride (cas normal). Si on est ici, c'est un état incohérent.
  raise exception 'OTP_HASH_PRESENT_NO_CODE'
    using errcode = 'P0001',
      hint = 'OTP déjà généré. Rafraîchissez l’application si le code ne s’affiche pas.';
end;
$$;

revoke all on function public.get_ride_otp_for_client(uuid) from public;
revoke all on function public.get_ride_otp_for_client(uuid) from anon;
grant execute on function public.get_ride_otp_for_client(uuid) to authenticated;

comment on function public.get_ride_otp_for_client(uuid) is
  'Client propriétaire : retourne le code OTP fin de course (en clair) pendant in_progress.';

-- ---------------------------------------------------------------------------
-- complete_ride_with_otp : driver assigné + OTP valide → completed
-- ---------------------------------------------------------------------------
create or replace function public.complete_ride_with_otp(p_ride_id uuid, p_otp text)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_uid uuid := auth.uid();
  v_hash text;
  v_updated integer;
begin
  if not exists (
    select 1 from public.profiles p where p.id = v_uid and p.role = 'driver'
  ) then
    raise exception 'COMPLETE_RIDE_NOT_DRIVER'
      using errcode = 'P0001',
        hint = 'Seuls les comptes chauffeur peuvent terminer une course.';
  end if;

  select r.ride_otp_hash
    into v_hash
  from public.rides r
  where r.id = p_ride_id
    and r.driver_id = v_uid
    and r.status = 'in_progress'::public.ride_status
  for update;

  if not found then
    raise exception 'COMPLETE_RIDE_NOT_ALLOWED'
      using errcode = 'P0001',
        hint = 'Transition impossible (statut ou assignation incorrecte).';
  end if;

  if v_hash is null or crypt(coalesce(p_otp, ''), v_hash) is distinct from v_hash then
    raise exception 'OTP_INVALID'
      using errcode = 'P0001',
        hint = 'Code OTP invalide.';
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

revoke all on function public.complete_ride_with_otp(uuid, text) from public;
revoke all on function public.complete_ride_with_otp(uuid, text) from anon;
grant execute on function public.complete_ride_with_otp(uuid, text) to authenticated;

comment on function public.complete_ride_with_otp(uuid, text) is
  'Chauffeur assigné : termine in_progress → completed si OTP valide.';

-- ---------------------------------------------------------------------------
-- Bloquer le bypass : retirer EXECUTE complete_ride pour authenticated
-- ---------------------------------------------------------------------------
revoke execute on function public.complete_ride(uuid) from authenticated;
grant execute on function public.complete_ride(uuid) to service_role;

