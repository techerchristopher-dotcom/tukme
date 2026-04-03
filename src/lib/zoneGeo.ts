/**
 * Détection de zone par coordonnées — données fournies par Supabase (table `zones`).
 * `zones` doit être trié par `match_priority` croissant (première boîte qui contient le point gagne).
 *
 * Détection par texte : compare les `name` Supabase au libellé (ex. Places), pour les POI
 * hors bounding box ou boîtes trop étroites.
 */

export type ZoneRow = {
  id: string;
  name: string;
  min_lat: number;
  max_lat: number;
  min_lng: number;
  max_lng: number;
  match_priority: number;
};

function normalizeForMatch(value: string): string {
  return value
    .normalize('NFD')
    .replace(/\p{M}/gu, '')
    .toLowerCase()
    .replace(/[_\-]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Première zone (par `match_priority` croissant) dont le nom apparaît dans l’adresse / libellé.
 */
export function getZoneFromAddress(
  address: string | null | undefined,
  zones: ZoneRow[]
): string | null {
  if (!address?.trim() || zones.length === 0) {
    return null;
  }
  const haystack = normalizeForMatch(address);
  if (!haystack) {
    return null;
  }
  const ordered = [...zones].sort(
    (a, b) => a.match_priority - b.match_priority
  );
  for (const z of ordered) {
    const needle = normalizeForMatch(z.name);
    if (needle && haystack.includes(needle)) {
      return z.name;
    }
  }
  return null;
}

export function getZoneFromCoords(
  lat: number,
  lng: number,
  zones: ZoneRow[]
): string | null {
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) {
    return null;
  }
  for (const z of zones) {
    if (
      lat >= z.min_lat &&
      lat <= z.max_lat &&
      lng >= z.min_lng &&
      lng <= z.max_lng
    ) {
      return z.name;
    }
  }
  return null;
}
