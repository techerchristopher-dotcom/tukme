import { useEffect, useState } from 'react';

import {
  computeRouteMetrics,
  isRoutesApiConfigured,
  type LatLngPoint,
} from '../lib/googleRoutes';
import type { ClientDestination } from '../types/clientDestination';

export type RouteMetricsUiState = {
  loading: boolean;
  error: string | null;
  /** Mètres (Routes API), pour persistance. */
  distanceMeters: number | null;
  /** Secondes (Routes API), pour persistance. */
  durationSeconds: number | null;
  /** Polyline encodée (Routes API), pour `rides.route_polyline`. */
  encodedPolyline: string | null;
  /** Arrondi 0,1 km pour l’affichage */
  distanceKm: number | null;
  /** Durée arrondie en minutes (≥ 1 si > 0 s) */
  durationMinutes: number | null;
  /** Tracé décodé pour `Polyline` ; null si absent ou vide. */
  polylineCoordinates: LatLngPoint[] | null;
};

const initial: RouteMetricsUiState = {
  loading: false,
  error: null,
  distanceMeters: null,
  durationSeconds: null,
  encodedPolyline: null,
  distanceKm: null,
  durationMinutes: null,
  polylineCoordinates: null,
};

export function useRouteMetrics(params: {
  originLat: number | null;
  originLng: number | null;
  destination: ClientDestination | null;
}): RouteMetricsUiState {
  const { originLat, originLng, destination } = params;
  const [state, setState] = useState<RouteMetricsUiState>(initial);

  useEffect(() => {
    if (
      originLat == null ||
      originLng == null ||
      !destination ||
      !isRoutesApiConfigured()
    ) {
      setState(initial);
      return;
    }

    let cancelled = false;
    setState({
      loading: true,
      error: null,
      distanceMeters: null,
      durationSeconds: null,
      encodedPolyline: null,
      distanceKm: null,
      durationMinutes: null,
      polylineCoordinates: null,
    });

    void (async () => {
      try {
        const metrics = await computeRouteMetrics({
          origin: { latitude: originLat, longitude: originLng },
          destination: {
            latitude: destination.latitude,
            longitude: destination.longitude,
          },
        });
        if (cancelled) {
          return;
        }
        const km = Math.round((metrics.distanceMeters / 1000) * 10) / 10;
        const minutes = Math.max(
          1,
          Math.round(metrics.durationSeconds / 60)
        );
        setState({
          loading: false,
          error: null,
          distanceMeters: metrics.distanceMeters,
          durationSeconds: metrics.durationSeconds,
          encodedPolyline: metrics.encodedPolyline,
          distanceKm: km,
          durationMinutes: minutes,
          polylineCoordinates:
            metrics.coordinates.length > 0 ? metrics.coordinates : null,
        });
      } catch (e) {
        if (cancelled) {
          return;
        }
        const message =
          e instanceof Error
            ? e.message
            : 'Impossible de calculer l’itinéraire.';
        setState({
          loading: false,
          error: message,
          distanceMeters: null,
          durationSeconds: null,
          encodedPolyline: null,
          distanceKm: null,
          durationMinutes: null,
          polylineCoordinates: null,
        });
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [originLat, originLng, destination]);

  return state;
}
