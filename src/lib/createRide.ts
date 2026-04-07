import { supabase } from './supabase';

const LOG = '[ride-create]';

/** Violation de l’index unique « une ride ouverte par client » (Postgres 23505). */
export const OPEN_RIDE_CONFLICT_MESSAGE =
  'Vous avez déjà une course en cours. Annulez-la ou attendez sa fin avant d’en demander une autre.';

/** Ligne `rides` au moment de la demande (alignée sur la migration Supabase). */
export type RequestedRideInsert = {
  client_id: string;
  status: 'requested';
  pickup_lat: number;
  pickup_lng: number;
  pickup_label: string | null;
  destination_lat: number;
  destination_lng: number;
  destination_label: string;
  destination_place_id: string | null;
  pickup_zone: string | null;
  destination_zone: string | null;
  /** Nombre de passagers (MVP : 1–4), aligné `rides.passenger_count`. */
  passenger_count: number;
  estimated_price_ariary: number;
  estimated_price_eur: number;
  pricing_mode: 'normal' | 'fallback';
  estimated_distance_m: number;
  estimated_duration_s: number;
  route_polyline: string | null;
};

export async function insertRequestedRide(
  row: RequestedRideInsert
): Promise<{ id: string }> {
  if (__DEV__) {
    console.log(`${LOG} payload`, JSON.stringify(row));
  }

  const { data, error } = await supabase
    .from('rides')
    .insert(row)
    .select('id')
    .single();

  if (error) {
    if (__DEV__) {
      console.error(`${LOG} error`, error.message, error.code);
    }
    if (error.code === '23505') {
      throw new Error(OPEN_RIDE_CONFLICT_MESSAGE);
    }
    throw new Error(error.message || 'Impossible d’enregistrer la course.');
  }

  if (__DEV__) {
    console.log(`${LOG} success`, data?.id);
  }

  if (!data?.id) {
    throw new Error('Réponse Supabase inattendue.');
  }

  return { id: data.id };
}
