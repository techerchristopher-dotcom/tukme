import { supabase } from '../../lib/supabase';
import type { Place } from '../../types/place';

export async function savePlaceToHistory(
  userId: string,
  place: Place
): Promise<{ placeId: string; lastUsedAt: string }> {
  const uid = userId?.trim();
  if (!uid) {
    throw new Error('savePlaceToHistory: userId manquant');
  }

  const placeId = place.place_id?.trim();
  const label = place.label?.trim();
  const address = place.address?.trim();
  const lat = place.lat;
  const lng = place.lng;

  if (!placeId) throw new Error('savePlaceToHistory: place_id manquant');
  if (!label) throw new Error('savePlaceToHistory: label manquant');
  if (!address) throw new Error('savePlaceToHistory: address manquant');
  if (!Number.isFinite(lat) || lat < -90 || lat > 90) {
    throw new Error('savePlaceToHistory: lat invalide');
  }
  if (!Number.isFinite(lng) || lng < -180 || lng > 180) {
    throw new Error('savePlaceToHistory: lng invalide');
  }

  const now = new Date().toISOString();

  const { data, error } = await supabase
    .from('user_places_history')
    .upsert(
      {
        user_id: uid,
        place_id: placeId,
        label,
        address,
        lat,
        lng,
        last_used_at: now,
        updated_at: now,
      },
      { onConflict: 'user_id,place_id' }
    )
    .select('place_id,last_used_at')
    .single();

  if (error) {
    throw error;
  }

  return { placeId: data.place_id, lastUsedAt: data.last_used_at };
}

