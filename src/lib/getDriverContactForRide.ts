import { supabase } from './supabase';

const LOG = '[driver-contact]';

export type DriverContactResult =
  | { ok: true; phone: string }
  | { ok: true; phone: null }
  | { ok: false; message: string };

export async function getDriverContactForRide(
  rideId: string
): Promise<DriverContactResult> {
  const id = rideId.trim();
  if (!id) {
    return { ok: false, message: 'rideId manquant' };
  }

  const { data, error } = await supabase.rpc('get_driver_contact_for_ride', {
    p_ride_id: id,
  });

  if (error) {
    if (__DEV__) {
      console.error(`${LOG} rpc error`, error.message);
    }
    return {
      ok: false,
      message: error.message?.trim() || 'Erreur RPC get_driver_contact_for_ride',
    };
  }

  // PostgREST retourne souvent un tableau pour RETURNS TABLE.
  const rows = Array.isArray(data) ? (data as unknown[]) : [];
  const first = rows[0] as Record<string, unknown> | undefined;
  const phoneRaw =
    first && typeof first.driver_phone === 'string' ? first.driver_phone : null;
  const phone = phoneRaw?.trim() ? phoneRaw.trim() : null;

  if (__DEV__) {
    console.log(`${LOG} rpc ok`, { rideId: id, hasPhone: !!phone });
  }

  return { ok: true, phone };
}

