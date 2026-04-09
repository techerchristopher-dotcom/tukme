-- Admin: actions véhicule courant chauffeur (retirer / set-remplacer).
-- Règle produit: 1 chauffeur = 1 seul véhicule actif.
-- Source de vérité: driver_vehicle_assignments (ends_at is null).
-- IMPORTANT: on ne supprime jamais physiquement une ligne vehicles pour ces actions.

create or replace function public.admin_retire_current_vehicle(p_driver_id uuid)
returns boolean
language plpgsql
security definer
set search_path = public
as $$
begin
  if p_driver_id is null then
    raise exception 'DRIVER_ID_REQUIRED'
      using errcode = 'P0001', hint = 'p_driver_id requis.';
  end if;

  -- Close ALL active assignments (defensive: handle multiple actives).
  update public.driver_vehicle_assignments a
    set ends_at = now()
  where a.driver_id = p_driver_id
    and a.ends_at is null;

  return true;
end;
$$;

revoke all on function public.admin_retire_current_vehicle(uuid) from public;
revoke all on function public.admin_retire_current_vehicle(uuid) from anon;
revoke all on function public.admin_retire_current_vehicle(uuid) from authenticated;
grant execute on function public.admin_retire_current_vehicle(uuid) to service_role;

comment on function public.admin_retire_current_vehicle(uuid) is
  'Service role: clôture l''assignation véhicule active (ends_at=now()) pour un chauffeur. Ne supprime aucun véhicule.';


create or replace function public.admin_set_current_vehicle(
  p_driver_id uuid,
  p_kind text,
  p_plate_number text
)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  v_vehicle_id uuid;
  v_plate text;
  v_kind text;
begin
  if p_driver_id is null then
    raise exception 'DRIVER_ID_REQUIRED'
      using errcode = 'P0001', hint = 'p_driver_id requis.';
  end if;

  v_plate := upper(trim(coalesce(p_plate_number, '')));
  if v_plate = '' then
    raise exception 'PLATE_INVALID'
      using errcode = 'P0001', hint = 'Immatriculation invalide.';
  end if;

  v_kind := nullif(trim(coalesce(p_kind, '')), '');

  -- Close ALL active assignments (defensive: handle multiple actives).
  update public.driver_vehicle_assignments a
    set ends_at = now()
  where a.driver_id = p_driver_id
    and a.ends_at is null;

  -- Create a new vehicle owned by this driver.
  insert into public.vehicles (owner_type, owner_driver_id, kind, plate_number, active)
  values ('driver'::public.vehicle_owner_type, p_driver_id, v_kind, v_plate, true)
  returning id into v_vehicle_id;

  -- Create the new active assignment.
  insert into public.driver_vehicle_assignments (driver_id, vehicle_id, starts_at)
  values (p_driver_id, v_vehicle_id, now());

  return v_vehicle_id;
end;
$$;

revoke all on function public.admin_set_current_vehicle(uuid, text, text) from public;
revoke all on function public.admin_set_current_vehicle(uuid, text, text) from anon;
revoke all on function public.admin_set_current_vehicle(uuid, text, text) from authenticated;
grant execute on function public.admin_set_current_vehicle(uuid, text, text) to service_role;

comment on function public.admin_set_current_vehicle(uuid, text, text) is
  'Service role: clôture l''assignation active puis crée un nouveau véhicule driver (kind/plate, active=true) et crée une nouvelle assignation active. Retourne vehicle_id.';

