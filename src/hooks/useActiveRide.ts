import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import { supabase } from '../lib/supabase';
import type { ClientRideSnapshot, ClientRideStatus } from '../types/clientRide';

const LOG = '[ride-realtime]';

const OPEN_STATUSES: ClientRideStatus[] = [
  'requested',
  'accepted',
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

function mapRow(row: Record<string, unknown>): ClientRideSnapshot | null {
  const id = row.id;
  const status = row.status;
  const updated_at = row.updated_at;
  if (typeof id !== 'string' || typeof status !== 'string' || typeof updated_at !== 'string') {
    return null;
  }
  const driverRaw = row.driver_id;
  const driver_id =
    driverRaw === null || typeof driverRaw === 'string' ? (driverRaw as string | null) : null;
  return {
    id,
    status: status as ClientRideStatus,
    driver_id,
    updated_at,
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
      .select('id, status, driver_id, updated_at')
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
    const snap = row ? mapRow(row) : null;
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

  useEffect(() => {
    if (!ride || !isOpenStatus(ride.status)) {
      removeChannel();
      return;
    }

    const id = ride.id;
    if (__DEV__) {
      console.log(`${LOG} subscribe`, id);
    }
    setRealtimeError(null);
    removeChannel();

    const channel = supabase
      .channel(`ride:${id}`)
      .on(
        'postgres_changes',
        {
          event: 'UPDATE',
          schema: 'public',
          table: 'rides',
          filter: `id=eq.${id}`,
        },
        (payload) => {
          const next = mapRow(payload.new as Record<string, unknown>);
          if (!next) {
            if (__DEV__) {
              console.warn(`${LOG} update`, 'unmapped payload');
            }
            return;
          }
          if (__DEV__) {
            console.log(`${LOG} update`, next.status);
          }
          setRide(next);
          if (isTerminalStatus(next.status)) {
            removeChannel();
            scheduleTerminalDismiss();
          }
        }
      )
      .subscribe((status, err) => {
        if (status === 'SUBSCRIBED') {
          return;
        }
        if (status === 'CHANNEL_ERROR' || status === 'TIMED_OUT') {
          const msg =
            err?.message ??
            (status === 'TIMED_OUT'
              ? 'Temps réel : délai dépassé. Vérifiez la connexion ou l’activation Realtime sur la table rides.'
              : 'Temps réel indisponible. Vérifiez que la table rides est publiée pour Realtime.');
          if (__DEV__) {
            console.error(`${LOG} error`, 'subscribe', status, msg);
          }
          setRealtimeError(msg);
        }
      });

    channelRef.current = channel;

    return () => {
      removeChannel();
    };
  }, [ride?.id, ride?.status, removeChannel, scheduleTerminalDismiss]);

  const registerRideAfterCreate = useCallback(
    async (rideId: string) => {
      if (__DEV__) {
        console.log(`${LOG} fetch`, 'after create', rideId);
      }
      const { data, error } = await supabase
        .from('rides')
        .select('id, status, driver_id, updated_at')
        .eq('id', rideId)
        .maybeSingle();

      if (error) {
        if (__DEV__) {
          console.error(`${LOG} error`, 'afterCreate', error.message);
        }
        setRide({
          id: rideId,
          status: 'requested',
          driver_id: null,
          updated_at: new Date().toISOString(),
        });
        return;
      }
      const row = data as Record<string, unknown> | null;
      const snap = row ? mapRow(row) : null;
      if (snap) {
        setRide(snap);
      } else {
        setRide({
          id: rideId,
          status: 'requested',
          driver_id: null,
          updated_at: new Date().toISOString(),
        });
      }
    },
    []
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
