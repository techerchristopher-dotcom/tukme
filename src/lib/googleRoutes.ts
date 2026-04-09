/**
 * Routes API (REST) — calcul distance / durée (remplace l’usage Directions API legacy).
 * Même clé que Places : activer « Routes API » sur le projet Google Cloud.
 *
 * @see https://developers.google.com/maps/documentation/routes/compute_route_directions
 */

import { getGooglePlacesApiKey } from './env';

const COMPUTE_ROUTES_URL =
  'https://routes.googleapis.com/directions/v2:computeRoutes';

const FIELD_MASK =
  'routes.duration,routes.distanceMeters,routes.polyline.encodedPolyline';

export type LatLngPoint = {
  latitude: number;
  longitude: number;
};

export type RouteMetrics = {
  distanceMeters: number;
  durationSeconds: number;
  /** Polyline telle que renvoyée par Routes API (persistable en base). */
  encodedPolyline: string | null;
  /** Points du tracé ; vide si l’API n’a pas renvoyé de polyline. */
  coordinates: LatLngPoint[];
};

function getApiKey(): string {
  const key = getGooglePlacesApiKey();
  if (!key) {
    throw new Error('EXPO_PUBLIC_GOOGLE_PLACES_API_KEY manquante');
  }
  return key;
}

export function isRoutesApiConfigured(): boolean {
  return getGooglePlacesApiKey().length > 0;
}

function parseDurationSeconds(duration: unknown): number | null {
  if (typeof duration === 'string' && duration.endsWith('s')) {
    const n = Number.parseInt(duration.slice(0, -1), 10);
    return Number.isFinite(n) ? n : null;
  }
  return null;
}

type ComputeRoutesResponse = {
  routes?: {
    distanceMeters?: number;
    duration?: string;
    polyline?: { encodedPolyline?: string };
  }[];
  error?: {
    code?: number;
    message?: string;
    status?: string;
  };
};

/**
 * Décode une polyline encodée (algorithme Google / précision 1e5).
 * @see https://developers.google.com/maps/documentation/utilities/polylinealgorithm
 */
export function decodeEncodedPolyline(encoded: string): LatLngPoint[] {
  const coordinates: LatLngPoint[] = [];
  let index = 0;
  let lat = 0;
  let lng = 0;
  while (index < encoded.length) {
    let b: number;
    let shift = 0;
    let result = 0;
    do {
      b = encoded.charCodeAt(index++) - 63;
      result |= (b & 0x1f) << shift;
      shift += 5;
    } while (b >= 0x20);
    const dlat = (result & 1) !== 0 ? ~(result >> 1) : result >> 1;
    lat += dlat;
    shift = 0;
    result = 0;
    do {
      b = encoded.charCodeAt(index++) - 63;
      result |= (b & 0x1f) << shift;
      shift += 5;
    } while (b >= 0x20);
    const dlng = (result & 1) !== 0 ? ~(result >> 1) : result >> 1;
    lng += dlng;
    coordinates.push({ latitude: lat / 1e5, longitude: lng / 1e5 });
  }
  return coordinates;
}

/**
 * POST `directions/v2:computeRoutes` — origine / destination en lat/lng.
 */
export async function computeRouteMetrics(params: {
  origin: LatLngPoint;
  destination: LatLngPoint;
}): Promise<RouteMetrics> {
  const apiKey = getApiKey();
  const body = {
    origin: {
      location: {
        latLng: {
          latitude: params.origin.latitude,
          longitude: params.origin.longitude,
        },
      },
    },
    destination: {
      location: {
        latLng: {
          latitude: params.destination.latitude,
          longitude: params.destination.longitude,
        },
      },
    },
    travelMode: 'DRIVE',
    routingPreference: 'TRAFFIC_AWARE',
    computeAlternativeRoutes: false,
    languageCode: 'fr',
    units: 'METRIC',
  };

  const res = await fetch(COMPUTE_ROUTES_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Goog-Api-Key': apiKey,
      'X-Goog-FieldMask': FIELD_MASK,
    },
    body: JSON.stringify(body),
  });

  const raw = (await res.json()) as ComputeRoutesResponse;

  if (!res.ok) {
    const msg =
      raw.error?.message ??
      raw.error?.status ??
      `Routes API HTTP ${res.status}`;
    throw new Error(msg);
  }

  const route = raw.routes?.[0];
  if (!route || route.distanceMeters == null) {
    const msg =
      raw.error?.message ??
      'Aucun itinéraire renvoyé (vérifiez les coordonnées ou activez Routes API).';
    throw new Error(msg);
  }

  const durationSeconds = parseDurationSeconds(route.duration);
  if (durationSeconds == null) {
    throw new Error('Durée de trajet absente ou invalide dans la réponse.');
  }

  const encoded = route.polyline?.encodedPolyline?.trim();
  let coordinates: LatLngPoint[] = [];
  if (encoded) {
    try {
      coordinates = decodeEncodedPolyline(encoded);
    } catch {
      coordinates = [];
    }
  }

  return {
    distanceMeters: route.distanceMeters,
    durationSeconds,
    encodedPolyline: encoded && encoded.length > 0 ? encoded : null,
    coordinates,
  };
}
