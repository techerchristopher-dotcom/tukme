/**
 * Appels Places API (New) — autocomplétion + détails lieu.
 * @see https://developers.google.com/maps/documentation/places/web-service/place-autocomplete
 */

const AUTOCOMPLETE_URL = 'https://places.googleapis.com/v1/places:autocomplete';

const AUTOCOMPLETE_FIELD_MASK =
  'suggestions.placePrediction.placeId,suggestions.placePrediction.text,suggestions.placePrediction.structuredFormat';

/** Contexte transport : biais autour du client (rayon max API : 50 km). */
const DEFAULT_BIAS_RADIUS_M = 40_000;

export type LatLng = {
  latitude: number;
  longitude: number;
};

export type PlaceSuggestionItem = {
  placeId: string;
  primaryText: string;
  secondaryText: string;
  /** Texte complet affichable si besoin. */
  fullDescription: string;
};

export function isPlacesConfigured(): boolean {
  return !!process.env.EXPO_PUBLIC_GOOGLE_PLACES_API_KEY?.trim();
}

function getApiKey(): string {
  const key = process.env.EXPO_PUBLIC_GOOGLE_PLACES_API_KEY?.trim();
  if (!key) {
    throw new Error('EXPO_PUBLIC_GOOGLE_PLACES_API_KEY manquante');
  }
  return key;
}

function newSessionToken(): string {
  const cryptoRef = globalThis.crypto;
  if (cryptoRef && typeof cryptoRef.randomUUID === 'function') {
    return cryptoRef.randomUUID();
  }
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
    const r = (Math.random() * 16) | 0;
    const v = c === 'x' ? r : (r & 0x3) | 0x8;
    return v.toString(16);
  });
}

export { newSessionToken };

type AutocompleteRaw = {
  suggestions?: {
    placePrediction?: {
      placeId: string;
      text?: { text?: string };
      structuredFormat?: {
        mainText?: { text?: string };
        secondaryText?: { text?: string };
      };
    };
  }[];
};

function parseSuggestions(raw: AutocompleteRaw): PlaceSuggestionItem[] {
  const out: PlaceSuggestionItem[] = [];
  for (const s of raw.suggestions ?? []) {
    const p = s.placePrediction;
    if (!p?.placeId) {
      continue;
    }
    const fullDescription = p.text?.text?.trim() ?? '';
    const primary =
      p.structuredFormat?.mainText?.text?.trim() ??
      fullDescription.split(',')[0]?.trim() ??
      fullDescription;
    const secondary =
      p.structuredFormat?.secondaryText?.text?.trim() ?? '';
    out.push({
      placeId: p.placeId,
      primaryText: primary || 'Lieu',
      secondaryText: secondary,
      fullDescription: fullDescription || primary,
    });
  }
  return out;
}

type GoogleRpcErrorBody = {
  error?: {
    message?: string;
    status?: string;
    code?: number;
    details?: { reason?: string; domain?: string; metadata?: Record<string, string> }[];
  };
};

function explainPlacesBlockMessage(raw: string): string {
  const lower = raw.toLowerCase();
  if (
    lower.includes('blocked') ||
    lower.includes('permission_denied') ||
    lower.includes('request_denied')
  ) {
    return `${raw}\n\n` +
      'Côté Google Cloud : ouvre la console, clé API utilisée → vérifie « Restrictions d’API » ' +
      '(Places API (New) / Autocomplete, Place Details) et « Restrictions d’application » ' +
      '(Expo Go = bundle host.exp.Exponent, ou clé sans restriction appli uniquement en dev). ' +
      'Facturation du projet aussi requise.';
  }
  return raw;
}

async function readPlacesError(res: Response): Promise<string> {
  try {
    const body = (await res.json()) as GoogleRpcErrorBody;
    const err = body.error;
    const msg = err?.message ?? err?.status;
    if (msg) {
      return explainPlacesBlockMessage(msg);
    }
  } catch {
    /* ignore */
  }
  return `Erreur HTTP ${res.status}`;
}

/**
 * Suggestions avec biais autour de `biasAround` + origine pour le classement.
 */
export async function fetchPlaceSuggestions(params: {
  input: string;
  sessionToken: string;
  /** Si absent, l’API s’appuie sur la localisation IP (moins fiable). */
  biasAround?: LatLng | null;
  languageCode?: string;
  regionCode?: string;
}): Promise<PlaceSuggestionItem[]> {
  const key = getApiKey();
  const input = params.input.trim();
  if (!input) {
    return [];
  }

  const body: Record<string, unknown> = {
    input,
    sessionToken: params.sessionToken,
    languageCode: params.languageCode ?? 'fr',
  };

  if (params.regionCode) {
    body.regionCode = params.regionCode;
  }

  if (params.biasAround) {
    body.locationBias = {
      circle: {
        center: {
          latitude: params.biasAround.latitude,
          longitude: params.biasAround.longitude,
        },
        radius: DEFAULT_BIAS_RADIUS_M,
      },
    };
    body.origin = {
      latitude: params.biasAround.latitude,
      longitude: params.biasAround.longitude,
    };
  }

  const res = await fetch(AUTOCOMPLETE_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Goog-Api-Key': key,
      'X-Goog-FieldMask': AUTOCOMPLETE_FIELD_MASK,
    },
    body: JSON.stringify(body),
  });

  if (!res.ok) {
    throw new Error(await readPlacesError(res));
  }

  const raw = (await res.json()) as AutocompleteRaw;
  return parseSuggestions(raw);
}

type PlaceDetailsRaw = {
  id?: string;
  displayName?: { text?: string };
  formattedAddress?: string;
  location?: { latitude?: number; longitude?: number };
  photos?: { name?: string }[];
};

export async function fetchPlaceDetails(params: {
  placeId: string;
  sessionToken: string;
}): Promise<{
  label: string;
  latitude: number;
  longitude: number;
  placeId: string;
  photoName?: string | null;
}> {
  const key = getApiKey();
  const id = encodeURIComponent(params.placeId);
  const token = encodeURIComponent(params.sessionToken);
  const url = `https://places.googleapis.com/v1/places/${id}?sessionToken=${token}`;

  const res = await fetch(url, {
    method: 'GET',
    headers: {
      'X-Goog-Api-Key': key,
      'X-Goog-FieldMask': 'id,displayName,formattedAddress,location,photos',
    },
  });

  if (!res.ok) {
    throw new Error(await readPlacesError(res));
  }

  const raw = (await res.json()) as PlaceDetailsRaw;
  const lat = raw.location?.latitude;
  const lng = raw.location?.longitude;
  if (typeof lat !== 'number' || typeof lng !== 'number') {
    throw new Error('Coordonnées introuvables pour ce lieu.');
  }

  const label =
    raw.formattedAddress?.trim() ||
    raw.displayName?.text?.trim() ||
    'Destination';

  const photoName = raw.photos?.[0]?.name ?? null;

  return {
    label,
    latitude: lat,
    longitude: lng,
    placeId: raw.id?.replace(/^places\//, '') ?? params.placeId,
    photoName,
  };
}
