-- FIX OTP production-safe:
-- `start_ride()` a été redéfini plus tard sans génération OTP, ce qui casse
-- `get_ride_otp_for_client` (OTP_NOT_READY) et bloque la fin de course.
--
-- Objectif : une version UNIQUE de `start_ride()` qui :
-- - vérifie arrived + chauffeur assigné
-- - passe in_progress
-- - génère un OTP 4 chiffres
-- - stocke ride_otp_hash + ride_otp_encrypted (base64) + ride_otp_generated_at
-- - garantit ride_otp_encrypted non NULL / non vide après l’appel
--
-- Contraintes respectées :
-- - ne modifie pas `get_ride_otp_for_client`
-- - ne modifie pas `complete_ride_with_otp`
-- - ne change pas les noms de colonnes

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

  -- Verrouille la ligne au statut arrived pour garantir cohérence OTP + transition.
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

  -- Transition arrived → in_progress (inchangée vs flow post-paid).
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

  -- OTP : garantit `ride_otp_encrypted` NON NULL après `start_ride`.
  -- On ne régénère pas si tout est déjà présent (idempotence).
  if v_existing_hash is null or v_existing_enc is null or v_existing_enc = '' then
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

