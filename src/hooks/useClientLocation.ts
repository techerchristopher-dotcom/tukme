import * as Location from 'expo-location';
import { useCallback, useEffect, useRef, useState } from 'react';
import { Platform } from 'react-native';

export type ClientLocationState =
  | { phase: 'loading' }
  | { phase: 'denied'; message: string }
  | { phase: 'ready'; latitude: number; longitude: number }
  | { phase: 'error'; message: string };

const WEB_MESSAGE =
  'La carte et la position GPS sont disponibles sur l’app iOS et Android (Expo Go ou build natif).';

/** TEMP diagnostic simulateur : toute position valide passe en `setState`. Remettre à `false` après test. */
const WATCH_THROTTLE_DISABLED = true;

function distanceMeters(
  a: { latitude: number; longitude: number },
  b: { latitude: number; longitude: number }
): number {
  const R = 6371_000; // meters
  const toRad = (deg: number) => (deg * Math.PI) / 180;
  const dLat = toRad(b.latitude - a.latitude);
  const dLng = toRad(b.longitude - a.longitude);
  const lat1 = toRad(a.latitude);
  const lat2 = toRad(b.latitude);
  const x =
    Math.sin(dLat / 2) * Math.sin(dLat / 2) +
    Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLng / 2) * Math.sin(dLng / 2);
  const c = 2 * Math.atan2(Math.sqrt(x), Math.sqrt(1 - x));
  return R * c;
}

export type ClientLocationCoords = { latitude: number; longitude: number };

export function useClientLocation(): {
  location: ClientLocationState;
  /** Lecture ponctuelle GPS + mise à jour du même state que le watcher. Retourne les coords appliquées, ou `null`. */
  refreshGpsOnce: () => Promise<ClientLocationCoords | null>;
} {
  const [state, setState] = useState<ClientLocationState>(() =>
    Platform.OS === 'web'
      ? { phase: 'error', message: WEB_MESSAGE }
      : { phase: 'loading' }
  );

  const subRef = useRef<Location.LocationSubscription | null>(null);
  const lastEmitAtRef = useRef<number>(0);
  const lastCoordsRef = useRef<{ latitude: number; longitude: number } | null>(
    null
  );

  const refreshGpsOnce = useCallback(async (): Promise<ClientLocationCoords | null> => {
    console.log('[refresh-gps] requesting current position ...');
    if (Platform.OS === 'web') {
      console.log('[refresh-gps] skipped (web)');
      return null;
    }
    try {
      const { status } = await Location.requestForegroundPermissionsAsync();
      if (status !== Location.PermissionStatus.GRANTED) {
        console.warn('[refresh-gps] permission not granted');
        return null;
      }
      const position = await Location.getCurrentPositionAsync({
        accuracy: Location.Accuracy.Balanced,
      });
      const latitude = position.coords.latitude;
      const longitude = position.coords.longitude;
      console.log('[refresh-gps] received coords ...', { latitude, longitude });
      if (!Number.isFinite(latitude) || !Number.isFinite(longitude)) {
        console.warn('[refresh-gps] invalid coords, skip state update');
        return null;
      }
      lastCoordsRef.current = { latitude, longitude };
      lastEmitAtRef.current = Date.now();
      setState({ phase: 'ready', latitude, longitude });
      console.log('[refresh-gps] state updated ...');
      return { latitude, longitude };
    } catch (e) {
      console.warn(
        '[refresh-gps] error',
        e instanceof Error ? e.message : e
      );
      return null;
    }
  }, []);

  useEffect(() => {
    if (Platform.OS === 'web') {
      return;
    }

    let cancelled = false;

    void (async () => {
      try {
        const { status } = await Location.requestForegroundPermissionsAsync();
        if (cancelled) {
          return;
        }
        if (status !== Location.PermissionStatus.GRANTED) {
          setState({
            phase: 'denied',
            message:
              'Accès à la localisation refusé. Autorisez la localisation dans les réglages de l’appareil pour afficher votre position sur la carte.',
          });
          return;
        }

        // Avoid double watcher.
        if (subRef.current) {
          return;
        }

        const sub = await Location.watchPositionAsync(
          {
            accuracy: Location.Accuracy.Balanced,
            timeInterval: 1000,
            distanceInterval: 1,
          },
          (pos) => {
            if (cancelled) return;

            const latitude = pos.coords.latitude;
            const longitude = pos.coords.longitude;
            if (!Number.isFinite(latitude) || !Number.isFinite(longitude)) {
              return;
            }

            // Throttle to avoid excessive re-renders and downstream recomputations.
            // - always emit the first fix
            // - then only if moved enough OR enough time passed
            const now = Date.now();
            const next = { latitude, longitude };
            const prev = lastCoordsRef.current;

            const moved = prev ? distanceMeters(prev, next) : Infinity;
            const timeSince = now - lastEmitAtRef.current;

            const MIN_TIME_MS = 2000;
            const MIN_DIST_M = 8;

            if (__DEV__) {
              console.log('[client-location-watch] tick (before throttle)', {
                latitude,
                longitude,
                movedMeters: prev ? moved : null,
                timeSinceLastEmitMs: prev ? timeSince : null,
              });
            }

            if (
              !WATCH_THROTTLE_DISABLED &&
              prev &&
              timeSince < MIN_TIME_MS &&
              moved < MIN_DIST_M
            ) {
              if (__DEV__) {
                console.log('[client-location-watch] throttled (ignored)', {
                  latitude,
                  longitude,
                  movedMeters: moved,
                  timeSinceLastEmitMs: timeSince,
                  requireMinMeters: MIN_DIST_M,
                  requireMinMs: MIN_TIME_MS,
                });
              }
              return;
            }

            if (__DEV__) {
              console.log('[client-location-watch] accepted → setState', {
                latitude,
                longitude,
                movedMeters: prev ? moved : null,
                timeSinceLastEmitMs: prev ? timeSince : null,
              });
            }

            lastEmitAtRef.current = now;
            lastCoordsRef.current = next;
            setState({ phase: 'ready', latitude, longitude });
          }
        );

        if (cancelled) {
          sub.remove();
          return;
        }

        subRef.current = sub;
      } catch (e) {
        if (cancelled) {
          return;
        }
        const msg =
          e instanceof Error
            ? e.message
            : 'Impossible de récupérer votre position.';
        setState({ phase: 'error', message: msg });
      }
    })();

    return () => {
      cancelled = true;
      if (subRef.current) {
        subRef.current.remove();
        subRef.current = null;
      }
    };
  }, []);

  return { location: state, refreshGpsOnce };
}
