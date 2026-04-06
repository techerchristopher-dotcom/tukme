-- Hotfix: pgp_sym_decrypt retourne déjà du text (pas besoin de convert_from).
-- Fixe get_ride_otp_for_client pour éviter l'erreur:
--   function convert_from(text, unknown) does not exist

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
  v_otp := extensions.pgp_sym_decrypt(decode(v_enc, 'base64'), v_key);
  return v_otp;
end;
$$;

revoke all on function public.get_ride_otp_for_client(uuid) from public;
revoke all on function public.get_ride_otp_for_client(uuid) from anon;
grant execute on function public.get_ride_otp_for_client(uuid) to authenticated;

