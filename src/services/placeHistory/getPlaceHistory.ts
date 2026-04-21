import { supabase } from '../../lib/supabase';
import type { Place } from '../../types/place';

function isValidLatLng(lat: unknown, lng: unknown): lat is number {
  if (typeof lat !== 'number' || typeof lng !== 'number') return false;
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) return false;
  if (lat < -90 || lat > 90) return false;
  if (lng < -180 || lng > 180) return false;
  return true;
}

function normalizeTextForSyntheticId(s: string): string {
  // MVP deterministic:
  // - trim
  // - lower
  // - collapse whitespace
  // - cap length to avoid huge ids
  return s.trim().toLowerCase().replace(/\s+/g, ' ').slice(0, 160);
}

/**
 * MVP: on n'a pas toujours un `place_id` Google en provenance de `rides` (ex: pickup).
 * On fabrique donc un identifiant stable (dédup) depuis les coordonnées + adresse/label.
 */
function makeSyntheticPlaceId(params: {
  kind: 'pickup' | 'destination';
  address: string;
  lat: number;
  lng: number;
}): string {
  // Arrondi stable pour réduire les micro-variations
  const roundedLat = params.lat.toFixed(5);
  const roundedLng = params.lng.toFixed(5);
  const normalizedText = normalizeTextForSyntheticId(params.address);
  return `synthetic:ride:${params.kind}:${normalizedText}:${roundedLat}:${roundedLng}`;
}

export async function getPlaceHistory(userId: string): Promise<Place[]> {
  const uid = userId?.trim();
  if (!uid) {
    throw new Error('getPlaceHistory: userId manquant');
  }

  // MVP: construire l'historique depuis les rides récentes (source réelle).
  // On lit plus large que 10 pour pouvoir dédupliquer ensuite.
  const { data, error } = await supabase
    .from('rides')
    .select(
      [
        'created_at',
        // pickup
        'pickup_lat',
        'pickup_lng',
        'pickup_label',
        // destination
        'destination_lat',
        'destination_lng',
        'destination_label',
        'destination_place_id',
      ].join(',')
    )
    .eq('client_id', uid)
    .order('created_at', { ascending: false })
    .limit(50);

  if (error) {
    throw error;
  }

  const rows = (data ?? []) as Array<{
    created_at: string;
    pickup_lat: number;
    pickup_lng: number;
    pickup_label: string | null;
    destination_lat: number;
    destination_lng: number;
    destination_label: string | null;
    destination_place_id: string | null;
  }>;

  // Dédup: on prend les lieux les plus récents, uniques, jusqu'à 10.
  const seen = new Set<string>();
  const out: Place[] = [];

  for (const r of rows) {
    // Pickup
    if (r.pickup_label && isValidLatLng(r.pickup_lat, r.pickup_lng)) {
      const label = r.pickup_label.trim();
      const place: Place = {
        place_id: makeSyntheticPlaceId({
          kind: 'pickup',
          address: label,
          lat: r.pickup_lat,
          lng: r.pickup_lng,
        }),
        label,
        address: label,
        lat: r.pickup_lat,
        lng: r.pickup_lng,
      };
      if (!seen.has(place.place_id)) {
        seen.add(place.place_id);
        out.push(place);
      }
    }

    // Destination
    if (r.destination_label && isValidLatLng(r.destination_lat, r.destination_lng)) {
      const label = r.destination_label.trim();
      const placeId =
        r.destination_place_id?.trim() ||
        makeSyntheticPlaceId({
          kind: 'destination',
          address: label,
          lat: r.destination_lat,
          lng: r.destination_lng,
        });
      const place: Place = {
        place_id: placeId,
        label,
        address: label,
        lat: r.destination_lat,
        lng: r.destination_lng,
      };
      if (!seen.has(place.place_id)) {
        seen.add(place.place_id);
        out.push(place);
      }
    }

    if (out.length >= 10) break;
  }

  return out.slice(0, 10);
}

