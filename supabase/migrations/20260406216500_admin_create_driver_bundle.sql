-- Admin: création chauffeur (profile + véhicule + affectation) en une transaction.
-- L'utilisateur auth est créé côté Edge (Admin API) ; ce RPC ne fait que les tables public.

create or replace function public.admin_find_user_id_by_phone(p_phone text)
returns uuid
language sql
stable
security definer
set search_path = public
as $$
  select u.id
  from auth.users u
  where u.phone is not distinct from p_phone
  limit 1;
$$;

revoke all on function public.admin_find_user_id_by_phone(text) from public;
revoke all on function public.admin_find_user_id_by_phone(text) from anon;
revoke all on function public.admin_find_user_id_by_phone(text) from authenticated;
grant execute on function public.admin_find_user_id_by_phone(text) to service_role;

comment on function public.admin_find_user_id_by_phone(text) is
  'Service role: retourne auth.users.id pour un numéro E.164 exact, ou NULL.';

create or replace function public.admin_create_driver_bundle(
  p_user_id uuid,
  p_full_name text,
  p_phone text,
  p_plate text
)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  v_vehicle_id uuid;
  v_plate text;
begin
  if p_user_id is null then
    raise exception 'USER_ID_REQUIRED'
      using errcode = 'P0001', hint = 'p_user_id requis.';
  end if;

  v_plate := upper(trim(p_plate));
  if v_plate = '' then
    raise exception 'PLATE_INVALID'
      using errcode = 'P0001', hint = 'Immatriculation invalide.';
  end if;

  if trim(p_full_name) = '' then
    raise exception 'FULL_NAME_INVALID'
      using errcode = 'P0001', hint = 'Nom complet invalide.';
  end if;

  insert into public.profiles (id, email, role, full_name, phone)
  values (p_user_id, null, 'driver'::text, trim(p_full_name), p_phone)
  on conflict (id) do update
    set role = 'driver',
        full_name = excluded.full_name,
        phone = excluded.phone;

  select v.id
    into v_vehicle_id
  from public.vehicles v
  where v.owner_type = 'driver'::public.vehicle_owner_type
    and v.owner_driver_id = p_user_id
    and v.plate_number is not distinct from v_plate
  limit 1;

  if v_vehicle_id is null then
    insert into public.vehicles (owner_type, owner_driver_id, plate_number, active)
    values ('driver'::public.vehicle_owner_type, p_user_id, v_plate, true)
    returning id into v_vehicle_id;
  end if;

  update public.driver_vehicle_assignments dva
    set ends_at = now()
  where dva.driver_id = p_user_id
    and dva.ends_at is null;

  insert into public.driver_vehicle_assignments (driver_id, vehicle_id, starts_at)
  values (p_user_id, v_vehicle_id, now());

  return p_user_id;
end;
$$;

revoke all on function public.admin_create_driver_bundle(uuid, text, text, text) from public;
revoke all on function public.admin_create_driver_bundle(uuid, text, text, text) from anon;
revoke all on function public.admin_create_driver_bundle(uuid, text, text, text) from authenticated;
grant execute on function public.admin_create_driver_bundle(uuid, text, text, text) to service_role;

comment on function public.admin_create_driver_bundle(uuid, text, text, text) is
  'Service role: upsert profile driver, véhicule (owner driver + plaque), affectation active. Transactionnel.';
