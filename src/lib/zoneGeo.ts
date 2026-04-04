/**
 * Détection de zone : noms Supabase + bounding boxes.
 * Priorité métier : texte (libellé / reverse geocode) puis GPS.
 *
 * `getZoneFromCoords` : première zone dont la bbox contient le point,
 * selon `match_priority` croissant (comme l’ordre renvoyé par Supabase).
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

export type ZoneResolutionDiagnostic = {
  fromText: string | null;
  fromCoords: string | null;
  zone: string | null;
};

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Normalise pour comparaison : accents, casse, tirets/underscores,
 * ponctuation courante → espaces, espaces multiples.
 */
export function normalizeForMatch(value: string): string {
  return value
    .normalize('NFD')
    .replace(/\p{M}/gu, '')
    .toLowerCase()
    .replace(/[_\-]+/g, ' ')
    .replace(/[.,;:!?'"()[\]{}|/\\]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Vérifie si le nom de zone apparaît comme « mot(s) » dans le texte
 * (évite les faux positifs type sous-chaîne collée à d’autres lettres).
 * Gère les noms multi-mots (ex. Dar es Salam, Hell-Ville → hell ville).
 */
export function zoneNameMatchesHaystack(
  haystackNormalized: string,
  zoneNameNormalized: string
): boolean {
  if (!zoneNameNormalized || !haystackNormalized) {
    return false;
  }
  if (haystackNormalized === zoneNameNormalized) {
    return true;
  }
  const words = zoneNameNormalized.split(/\s+/).filter(Boolean);
  if (words.length === 0) {
    return false;
  }
  const body = words.map((w) => escapeRegExp(w)).join('\\s+');
  const re = new RegExp(`(^|\\s)${body}(\\s|$)`, 'u');
  return re.test(haystackNormalized);
}

/**
 * Première zone (par `match_priority` croissant) dont le nom matche le texte.
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
    if (needle && zoneNameMatchesHaystack(haystack, needle)) {
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
  const ordered = [...zones].sort(
    (a, b) => a.match_priority - b.match_priority
  );
  for (const z of ordered) {
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

/**
 * Stratégie unifiée : libellé (si présent) puis coordonnées.
 * Utilisé pour départ (reverse geocode optionnel) et destination (Places).
 */
export function resolveZoneFromLabelAndCoords(
  label: string | null | undefined,
  lat: number | null | undefined,
  lng: number | null | undefined,
  zones: ZoneRow[]
): ZoneResolutionDiagnostic {
  const fromText = getZoneFromAddress(label, zones);
  const fromCoords =
    lat != null &&
    lng != null &&
    Number.isFinite(lat) &&
    Number.isFinite(lng)
      ? getZoneFromCoords(lat, lng, zones)
      : null;
  return {
    fromText,
    fromCoords,
    zone: fromText ?? fromCoords,
  };
}
