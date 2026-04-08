import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import { supabase, syncRealtimeAuth } from '../lib/supabase';
import type { ClientRideSnapshot, ClientRideStatus } from '../types/clientRide';

const LOG = '[ride-realtime]';

const RIDE_SELECT_COLUMNS =
  'id, status, driver_id, updated_at, driver_lat, driver_lng, driver_location_updated_at, driver_display_name, driver_avatar_path, vehicle_type, vehicle_plate, pickup_label, destination_label, destination_lat, destination_lng, destination_place_id, passenger_count, estimated_price_eur, payment_expires_at, ride_completed_at';

const OPEN_STATUSES: ClientRideStatus[] = [
  'requested',
  'awaiting_payment',
  'paid',
  'en_route',
  'arrived',
  'in_progress',
];

const TERMINAL_STATUSES: ClientRideStatus[] = [
  'completed',
  'cancelled_by_client',
  'cancelled_by_driver',
  'expired',
];

const TERMINAL_UI_MS = 4500;

function isOpenStatus(s: ClientRideStatus): boolean {
  return OPEN_STATUSES.includes(s);
}

function isTerminalStatus(s: ClientRideStatus): boolean {
  return TERMINAL_STATUSES.includes(s);
}

function num(v: unknown): number | undefined {
  if (typeof v === 'number' && Number.isFinite(v)) {
    return v;
  }
  if (typeof v === 'string') {
    const n = Number.parseFloat(v);
    return Number.isFinite(n) ? n : undefined;
  }
  return undefined;
}

function intFromRow(v: unknown): number | undefined {
  const n = num(v);
  if (n === undefined) {
    return undefined;
  }
  const t = Math.trunc(n);
  return Number.isFinite(t) ? t : undefined;
}

/**
 * Construit un snapshot à partir d’une ligne (fetch complet ou merge Realtime).
 * Les champs absents de `row` sont repris sur `prev` pour ne pas perdre la destination sur un patch partiel.
 */
function buildRideSnapshot(
  row: Record<string, unknown>,
  prev: ClientRideSnapshot | null
): ClientRideSnapshot | null {
  const id =
    typeof row.id === 'string' ? row.id : prev?.id;
  const statusRaw = row.status;
  const status =
    typeof statusRaw === 'string'
      ? statusRaw === 'accepted'
        ? ('awaiting_payment' as ClientRideStatus)
        : (statusRaw as ClientRideStatus)
      : prev?.status;
  const updated_at =
    typeof row.updated_at === 'string' ? row.updated_at : prev?.updated_at;

  if (!id || !status || !updated_at) {
    return null;
  }

  const driverRaw = row.driver_id;
  let driver_id: string | null;
  if (driverRaw === undefined) {
    driver_id = prev?.driver_id ?? null;
  } else if (driverRaw === null || typeof driverRaw === 'string') {
    driver_id = driverRaw;
  } else {
    driver_id = prev?.driver_id ?? null;
  }

  let driver_lat: number | null;
  if (row.driver_lat === undefined) {
    driver_lat = prev?.driver_lat ?? null;
  } else if (row.driver_lat === null) {
    driver_lat = null;
  } else {
    const v = num(row.driver_lat);
    driver_lat = v ?? null;
  }

  let driver_lng: number | null;
  if (row.driver_lng === undefined) {
    driver_lng = prev?.driver_lng ?? null;
  } else if (row.driver_lng === null) {
    driver_lng = null;
  } else {
    const v = num(row.driver_lng);
    driver_lng = v ?? null;
  }

  let driver_location_updated_at: string | null;
  if (row.driver_location_updated_at === undefined) {
    driver_location_updated_at = prev?.driver_location_updated_at ?? null;
  } else if (
    row.driver_location_updated_at === null ||
    typeof row.driver_location_updated_at === 'string'
  ) {
    driver_location_updated_at = row.driver_location_updated_at as string | null;
  } else {
    driver_location_updated_at = prev?.driver_location_updated_at ?? null;
  }

  const driver_display_name =
    row.driver_display_name === undefined
      ? (prev?.driver_display_name ?? null)
      : typeof row.driver_display_name === 'string'
        ? row.driver_display_name
        : row.driver_display_name === null
          ? null
          : prev?.driver_display_name ?? null;

  const driver_avatar_path =
    row.driver_avatar_path === undefined
      ? (prev?.driver_avatar_path ?? null)
      : typeof row.driver_avatar_path === 'string'
        ? row.driver_avatar_path
        : row.driver_avatar_path === null
          ? null
          : prev?.driver_avatar_path ?? null;

  const vehicle_type =
    row.vehicle_type === undefined
      ? (prev?.vehicle_type ?? null)
      : typeof row.vehicle_type === 'string'
        ? row.vehicle_type
        : row.vehicle_type === null
          ? null
          : prev?.vehicle_type ?? null;

  const vehicle_plate =
    row.vehicle_plate === undefined
      ? (prev?.vehicle_plate ?? null)
      : typeof row.vehicle_plate === 'string'
        ? row.vehicle_plate
        : row.vehicle_plate === null
          ? null
          : prev?.vehicle_plate ?? null;

  const destLabel =
    typeof row.destination_label === 'string'
      ? row.destination_label
      : prev?.destination_label ?? '';
  const destLat = num(row.destination_lat) ?? prev?.destination_lat;
  const destLng = num(row.destination_lng) ?? prev?.destination_lng;
  const destPlace =
    row.destination_place_id === undefined
      ? (prev?.destination_place_id ?? null)
      : row.destination_place_id === null ||
          typeof row.destination_place_id === 'string'
        ? (row.destination_place_id as string | null)
        : prev?.destination_place_id ?? null;

  let passenger_count: number;
  if (row.passenger_count === undefined) {
    passenger_count = prev?.passenger_count ?? 1;
  } else {
    const pc = intFromRow(row.passenger_count);
    passenger_count =
      pc != null && pc >= 1 ? pc : (prev?.passenger_count ?? 1);
  }

  let estimated_price_eur: number | null;
  if (row.estimated_price_eur === undefined) {
    estimated_price_eur = prev?.estimated_price_eur ?? null;
  } else if (row.estimated_price_eur === null) {
    estimated_price_eur = null;
  } else {
    const pe = num(row.estimated_price_eur);
    estimated_price_eur = pe ?? null;
  }

  let payment_expires_at: string | null;
  if (row.payment_expires_at === undefined) {
    payment_expires_at = prev?.payment_expires_at ?? null;
  } else if (
    row.payment_expires_at === null ||
    typeof row.payment_expires_at === 'string'
  ) {
    payment_expires_at = row.payment_expires_at as string | null;
  } else {
    payment_expires_at = prev?.payment_expires_at ?? null;
  }

  const pickup_label =
    row.pickup_label === undefined
      ? (prev?.pickup_label ?? null)
      : row.pickup_label === null || typeof row.pickup_label === 'string'
        ? (row.pickup_label as string | null)
        : prev?.pickup_label ?? null;

  const ride_completed_at =
    row.ride_completed_at === undefined
      ? (prev?.ride_completed_at ?? null)
      : row.ride_completed_at === null || typeof row.ride_completed_at === 'string'
        ? (row.ride_completed_at as string | null)
        : prev?.ride_completed_at ?? null;

  if (destLat === undefined || destLng === undefined) {
    if (__DEV__ && prev) {
      console.warn(`${LOG} merge`, 'missing destination coords, keeping partial');
    }
    return null;
  }

  return {
    id,
    status,
    driver_id,
    updated_at,
    driver_lat,
    driver_lng,
    driver_location_updated_at,
    driver_display_name,
    driver_avatar_path,
    vehicle_type,
    vehicle_plate,
    pickup_label,
    destination_label: destLabel,
    destination_lat: destLat,
    destination_lng: destLng,
    destination_place_id: destPlace,
    passenger_count,
    estimated_price_eur,
    payment_expires_at,
    ride_completed_at,
  };
}

export function useActiveRide(userId: string) {
  const [ride, setRide] = useState<ClientRideSnapshot | null>(null);
  const [fetchLoading, setFetchLoading] = useState(true);
  const [fetchError, setFetchError] = useState<string | null>(null);
  const [realtimeError, setRealtimeError] = useState<string | null>(null);

  const channelRef = useRef<ReturnType<typeof supabase.channel> | null>(null);
  const terminalTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const removeChannel = useCallback(() => {
    if (channelRef.current) {
      if (__DEV__) {
        console.log(`${LOG} cleanup`, 'removeChannel');
      }
      void supabase.removeChannel(channelRef.current);
      channelRef.current = null;
    }
  }, []);

  const clearTerminalTimer = useCallback(() => {
    if (terminalTimerRef.current) {
      clearTimeout(terminalTimerRef.current);
      terminalTimerRef.current = null;
    }
  }, []);

  const scheduleTerminalDismiss = useCallback(() => {
    clearTerminalTimer();
    terminalTimerRef.current = setTimeout(() => {
      if (__DEV__) {
        console.log(`${LOG} cleanup`, 'terminalDismiss');
      }
      setRide(null);
      terminalTimerRef.current = null;
    }, TERMINAL_UI_MS);
  }, [clearTerminalTimer]);

  const fetchOpenRide = useCallback(async () => {
    if (!userId.trim()) {
      setFetchLoading(false);
      setFetchError(null);
      setRide(null);
      return;
    }

    setFetchLoading(true);
    setFetchError(null);

    if (__DEV__) {
      console.log(`${LOG} fetch`, 'open rides');
    }

    const { data, error } = await supabase
      .from('rides')
      .select(RIDE_SELECT_COLUMNS)
      .in('status', OPEN_STATUSES)
      .order('created_at', { ascending: false })
      .limit(1)
      .maybeSingle();

    if (error) {
      if (__DEV__) {
        console.error(`${LOG} error`, 'fetch', error.message);
      }
      setFetchError(
        error.message || 'Impossible de charger votre course en cours.'
      );
      setRide(null);
      setFetchLoading(false);
      return;
    }

    const row = data as Record<string, unknown> | null;
    if (__DEV__) {
      console.log(`${LOG} initial fetch ride data`, row ? JSON.stringify(row) : 'null');
    }

    const snap = row ? buildRideSnapshot(row, null) : null;
    if (__DEV__) {
      if (snap) {
        console.log(`${LOG} hydrated ride`, snap.id, snap.status);
      } else if (row) {
        console.warn(`${LOG} hydrated ride`, 'failed to map row');
      }
    }
    setRide(snap);
    setFetchLoading(false);
  }, [userId]);

  useEffect(() => {
    void fetchOpenRide();
  }, [fetchOpenRide]);

  useEffect(() => {
    return () => {
      clearTerminalTimer();
      removeChannel();
    };
  }, [clearTerminalTimer, removeChannel]);

  /** Si le statut passe en terminal hors callback Realtime (ex. refetch), fermer le canal. */
  useEffect(() => {
    const st = ride?.status;
    if (st == null) {
      return;
    }
    if (isOpenStatus(st)) {
      return;
    }
    removeChannel();
  }, [ride?.id, ride?.status, removeChannel]);

  useEffect(() => {
    const rid = ride?.id;
    const st = ride?.status;
    if (!rid || !st || !isOpenStatus(st)) {
      removeChannel();
      return;
    }

    const id = rid;
    let cancelled = false;

    void (async () => {
      const authed = await syncRealtimeAuth();
      if (cancelled) {
        return;
      }
      if (!authed) {
        setRealtimeError(
          'Temps réel : session indisponible. Reconnectez-vous ou rafraîchissez l’application.'
        );
        return;
      }

      if (__DEV__) {
        console.log(`${LOG} subscribe`, id);
      }
      setRealtimeError(null);
      removeChannel();
      if (cancelled) {
        return;
      }

      // Pas de `filter` côté serveur : Realtime renvoie des bindings qui doivent
      // matcher exactement le client ; un écart (ex. normalisation UUID) déclenche
      // CHANNEL_ERROR « mismatch between server and client bindings ». RLS limite
      // déjà les lignes visibles ; on filtre par `id` dans le callback.
      const channel = supabase
        .channel(`ride:${id}`)
        .on(
          'postgres_changes',
          {
            event: 'UPDATE',
            schema: 'public',
            table: 'rides',
          },
          (payload) => {
            const raw = payload.new as Record<string, unknown>;
            if (typeof raw.id !== 'string' || raw.id !== id) {
              return;
            }
            setRide((prev) => {
              const next = buildRideSnapshot(raw, prev);
              if (!next) {
                if (__DEV__) {
                  console.warn(`${LOG} update`, 'unmapped payload');
                }
                return prev;
              }
              if (__DEV__) {
                console.log(`${LOG} update`, next.status);
              }
              if (isTerminalStatus(next.status)) {
                queueMicrotask(() => {
                  removeChannel();
                  scheduleTerminalDismiss();
                });
              }
              return next;
            });
          }
        )
        .subscribe((status, err) => {
          if (status === 'SUBSCRIBED') {
            return;
          }
          if (status === 'CHANNEL_ERROR' || status === 'TIMED_OUT') {
            const detail = err?.message?.trim();
            const msg =
              detail ||
              (status === 'TIMED_OUT'
                ? 'Temps réel : délai dépassé. Vérifiez la connexion ou l’activation Realtime sur la table rides.'
                : 'Temps réel indisponible. Vérifiez que la table rides est publiée pour Realtime.');
            if (__DEV__) {
              console.error(`${LOG} error`, 'subscribe', status, msg);
            }
            setRealtimeError(msg);
          }
        });

      if (cancelled) {
        void supabase.removeChannel(channel);
        return;
      }
      channelRef.current = channel;
    })();

    return () => {
      cancelled = true;
      removeChannel();
    };
    // Objet `ride` exclu : chaque patch Realtime recrée le snapshot → boucle de resubscribe.
    // eslint-disable-next-line react-hooks/exhaustive-deps -- ride?.id suffit pour cibler la course.
  }, [ride?.id, removeChannel, scheduleTerminalDismiss]);

  const registerRideAfterCreate = useCallback(
    async (rideId: string) => {
      if (__DEV__) {
        console.log(`${LOG} fetch`, 'after create', rideId);
      }
      const { data, error } = await supabase
        .from('rides')
        .select(RIDE_SELECT_COLUMNS)
        .eq('id', rideId)
        .maybeSingle();

      if (error) {
        if (__DEV__) {
          console.error(`${LOG} error`, 'afterCreate', error.message);
        }
        await fetchOpenRide();
        return;
      }
      const row = data as Record<string, unknown> | null;
      const snap = row ? buildRideSnapshot(row, null) : null;
      if (snap) {
        setRide(snap);
        if (__DEV__) {
          console.log(`${LOG} hydrated ride`, 'after create', snap.id);
        }
      } else {
        await fetchOpenRide();
      }
    },
    [fetchOpenRide]
  );

  /** Après annulation client réussie : pas d’attente Realtime, pas de message terminal prolongé. */
  const dismissRide = useCallback(() => {
    if (__DEV__) {
      console.log(`${LOG} cleanup`, 'dismissRide');
    }
    clearTerminalTimer();
    removeChannel();
    setRide(null);
  }, [clearTerminalTimer, removeChannel]);

  const hasOpenRide = useMemo(
    () => !!(ride && isOpenStatus(ride.status)),
    [ride]
  );

  return {
    ride,
    fetchLoading,
    fetchError,
    realtimeError,
    hasOpenRide,
    registerRideAfterCreate,
    dismissRide,
    refetchOpenRide: fetchOpenRide,
  };
}
