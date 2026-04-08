import * as Location from 'expo-location';
import { useEffect, useMemo, useRef } from 'react';
import { Platform } from 'react-native';

import { supabase } from '../lib/supabase';

const LOG = '[driver-live-location]';

type TrackStatus = 'paid' | 'en_route' | 'arrived';
type StopStatus =
  | 'requested'
  | 'awaiting_payment'
  | 'expired'
  | 'in_progress'
  | 'completed'
  | 'cancelled_by_driver'
  | 'cancelled_by_client';

function shouldTrack(status: string | null): status is TrackStatus {
  return status === 'paid' || status === 'en_route' || status === 'arrived';
}

function shouldStop(status: string | null): status is StopStatus {
  return (
    status === 'in_progress' ||
    status === 'completed' ||
    status === 'cancelled_by_driver' ||
    status === 'cancelled_by_client' ||
    status === 'expired' ||
    status === 'requested' ||
    status === 'awaiting_payment'
  );
}

async function rpcUpdateDriverLocation(
  rideId: string,
  lat: number,
  lng: number
): Promise<void> {
  if (__DEV__) {
    console.log(`${LOG} send`, { rideId, lat, lng });
  }
  const { error } = await supabase.rpc('update_driver_location', {
    p_ride_id: rideId,
    p_lat: lat,
    p_lng: lng,
  });
  if (error) {
    // Erreur attendue si ride pas dans le bon statut / mauvais chauffeur.
    if (__DEV__) {
      console.warn(`${LOG} rpc error`, error.message);
    }
    throw error;
  }
}

/**
 * Tracking live location chauffeur (foreground only).
 * - watchPositionAsync (accuracy Balanced)
 * - throttle envoi RPC à 5s
 * - démarre uniquement en paid/en_route/arrived
 * - stop dès que la ride sort de ces statuts
 */
export function useDriverLiveLocation(params: {
  rideId: string | null;
  rideStatus: string | null;
}) {
  const { rideId, rideStatus } = params;

  const enabled = useMemo(
    () => Platform.OS !== 'web' && !!rideId && shouldTrack(rideStatus),
    [rideId, rideStatus]
  );

  const subRef = useRef<Location.LocationSubscription | null>(null);
  const lastSentAtRef = useRef<number>(0);
  const inFlightRef = useRef(false);

  useEffect(() => {
    if (Platform.OS === 'web') {
      return;
    }

    if (!rideId) {
      if (subRef.current) {
        subRef.current.remove();
        subRef.current = null;
      }
      return;
    }

    if (!enabled || shouldStop(rideStatus)) {
      if (subRef.current) {
        subRef.current.remove();
        subRef.current = null;
      }
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
          if (__DEV__) {
            console.warn(`${LOG} permission denied`);
          }
          return;
        }

        // évite double watcher
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
            if (cancelled) {
              return;
            }
            const now = Date.now();
            if (now - lastSentAtRef.current < 5000) {
              return;
            }
            if (inFlightRef.current) {
              return;
            }

            const lat = pos.coords.latitude;
            const lng = pos.coords.longitude;
            if (!Number.isFinite(lat) || !Number.isFinite(lng)) {
              return;
            }

            inFlightRef.current = true;
            lastSentAtRef.current = now;
            void rpcUpdateDriverLocation(rideId, lat, lng).finally(() => {
              inFlightRef.current = false;
            });
          }
        );

        if (cancelled) {
          sub.remove();
          return;
        }
        subRef.current = sub;
      } catch (e) {
        if (__DEV__) {
          console.warn(`${LOG} watch failed`, e instanceof Error ? e.message : e);
        }
      }
    })();

    return () => {
      cancelled = true;
      if (subRef.current) {
        subRef.current.remove();
        subRef.current = null;
      }
    };
  }, [enabled, rideId, rideStatus]);
}

