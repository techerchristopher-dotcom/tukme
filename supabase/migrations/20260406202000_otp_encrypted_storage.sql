-- OTP fin de course (MVP robuste) :
-- - OTP généré au passage arrived → in_progress (start_ride)
-- - Persistance : hash (bcrypt) + encrypted (pgcrypto) + generated_at
-- - Lecture côté client : get_ride_otp_for_client (déchiffre uniquement pour le client propriétaire)
-- - Validation côté chauffeur : complete_ride_with_otp (via hash)

create extension if not exists pgcrypto with schema extensions;
create extension if not exists supabase_vault with schema vault;

alter table public.rides
  add column if not exists ride_otp_hash text null,
  add column if not exists ride_otp_encrypted text null,
  add column if not exists ride_otp_generated_at timestamptz null;

comment on column public.rides.ride_otp_hash is
  'Hash OTP fin de course (bcrypt via pgcrypto.crypt). OTP en clair non stocké.';
comment on column public.rides.ride_otp_encrypted is
  'OTP fin de course chiffré (pgcrypto.pgp_sym_encrypt) encodé en base64.';
comment on column public.rides.ride_otp_generated_at is
  'Horodatage de génération OTP fin de course (arrived → in_progress).';

-- Secret côté DB pour chiffrer/déchiffrer l'OTP (non committé : généré en base).
do $$
begin
  if not exists (select 1 from vault.secrets s where s.name = 'ride_otp_key') then
    perform vault.create_secret(
      encode(extensions.gen_random_bytes(32), 'hex'),
      'ride_otp_key',
      'Ride OTP encryption key (server-side)'
    );
  end if;
end $$;

create or replace function public._get_ride_otp_key()
returns text
language plpgsql
security definer
set search_path = public, vault
as $$
declare
  v_key text;
begin
  select ds.decrypted_secret
    into v_key
  from vault.decrypted_secrets ds
  where ds.name = 'ride_otp_key'
  limit 1;

  if v_key is null or length(v_key) < 16 then
    raise exception 'OTP_KEY_MISSING'
      using errcode = 'P0001',
        hint = 'Secret OTP absent/invalide dans vault (ride_otp_key).';
  end if;
  return v_key;
end;
$$;

revoke all on function public._get_ride_otp_key() from public;
revoke all on function public._get_ride_otp_key() from anon;
revoke all on function public._get_ride_otp_key() from authenticated;

-- ---------------------------------------------------------------------------
-- Patch start_ride : génération OTP (hash + encrypted) au passage in_progress
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
  v_existing_hash text;
  v_existing_enc text;
  v_otp text;
  v_key text;
begin
  if not exists (
    select 1 from public.profiles p where p.id = v_uid and p.role = 'driver'
  ) then
    raise exception 'START_RIDE_NOT_DRIVER'
      using errcode = 'P0001',
        hint = 'Seuls les comptes chauffeur peuvent démarrer la course.';
  end if;

  select r.ride_otp_hash, r.ride_otp_encrypted
    into v_existing_hash, v_existing_enc
  from public.rides r
  where r.id = p_ride_id
    and r.driver_id = v_uid
    and r.status = 'arrived'::public.ride_status
  for update;

  if not found then
    raise exception 'START_RIDE_NOT_ALLOWED'
      using errcode = 'P0001',
        hint = 'Transition impossible (pas arrivé ou mauvais chauffeur).';
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

  -- OTP 4 chiffres : généré uniquement si (hash ET encrypted) absents.
  if v_existing_hash is null and v_existing_enc is null then
    v_key := public._get_ride_otp_key();
    v_otp := lpad((floor(random() * 10000))::int::text, 4, '0');
    update public.rides
    set
      ride_otp_hash = extensions.crypt(v_otp, extensions.gen_salt('bf')),
      ride_otp_encrypted = encode(extensions.pgp_sym_encrypt(v_otp, v_key), 'base64'),
      ride_otp_generated_at = coalesce(ride_otp_generated_at, now())
    where id = p_ride_id;
  end if;
end;
$$;

revoke all on function public.start_ride(uuid) from public;
grant execute on function public.start_ride(uuid) to authenticated;

comment on function public.start_ride(uuid) is
  'Chauffeur assigné : arrived → in_progress (génère ride_otp_hash + ride_otp_encrypted si absents).';

-- ---------------------------------------------------------------------------
-- RPC client : lire le code OTP (en clair) uniquement pour le client propriétaire.
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
  v_enc text;
  v_key text;
  v_otp text;
begin
  select r.client_id, r.status, r.ride_otp_encrypted
    into v_client_id, v_status, v_enc
  from public.rides r
  where r.id = p_ride_id;

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

  if v_enc is null or v_enc = '' then
    raise exception 'OTP_NOT_READY'
      using errcode = 'P0001',
        hint = 'Le code n''est pas encore disponible. Réessayez dans un instant.';
  end if;

  v_key := public._get_ride_otp_key();
  v_otp := convert_from(
    extensions.pgp_sym_decrypt(decode(v_enc, 'base64'), v_key),
    'utf8'
  );
  return v_otp;
end;
$$;

revoke all on function public.get_ride_otp_for_client(uuid) from public;
revoke all on function public.get_ride_otp_for_client(uuid) from anon;
grant execute on function public.get_ride_otp_for_client(uuid) to authenticated;

comment on function public.get_ride_otp_for_client(uuid) is
  'Client propriétaire : retourne le code OTP fin de course (déchiffré) pendant in_progress.';

