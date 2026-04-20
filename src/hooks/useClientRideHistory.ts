import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import { supabase } from '../lib/supabase';
import type { ClientRideStatus } from '../types/clientRide';

export type ClientRideHistoryRow = {
  id: string;
  created_at: string;
  status: ClientRideStatus;
  pickup_label: string | null;
  destination_label: string;
  estimated_price_eur: number | null;
  /** Stocké pour usage futur (liste MVP inchangée). */
  passenger_count: number | null;
  ride_completed_at: string | null;
};

const TERMINAL: ClientRideStatus[] = [
  'completed',
  'cancelled_by_client',
  'cancelled_by_driver',
  'expired',
];

const PAGE_SIZE = 20;

type RideCursor = {
  createdAt: string;
  id: string;
};

function mergeRidesById(
  prev: ClientRideHistoryRow[],
  incoming: ClientRideHistoryRow[],
  mode: 'replace' | 'append'
): ClientRideHistoryRow[] {
  const map = new Map<string, ClientRideHistoryRow>();
  if (mode === 'append') {
    for (const it of prev) map.set(it.id, it);
  }
  for (const it of incoming) map.set(it.id, it);
  return Array.from(map.values());
}

function getDuplicateIds(ids: string[]): string[] {
  const seen = new Set<string>();
  const dup = new Set<string>();
  for (const id of ids) {
    if (seen.has(id)) dup.add(id);
    seen.add(id);
  }
  return Array.from(dup.values());
}

export function useClientRideHistory(userId: string): {
  items: ClientRideHistoryRow[];
  loading: boolean;
  refreshing: boolean;
  error: string | null;
  hasMore: boolean;
  refresh: () => Promise<void>;
  loadMore: () => Promise<void>;
} {
  const [items, setItems] = useState<ClientRideHistoryRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [cursor, setCursor] = useState<RideCursor | null>(null);
  const [hasMore, setHasMore] = useState(true);

  const enabled = useMemo(() => !!userId.trim(), [userId]);
  const debug =
    __DEV__ && (process.env.EXPO_PUBLIC_DEBUG_RIDE_HISTORY ?? '') === '1';

  const inFlightRef = useRef(false);

  const fetchPage = useCallback(
    async (nextCursor: RideCursor | null, mode: 'replace' | 'append') => {
      if (!enabled) {
        setItems([]);
        setLoading(false);
        setLoadingMore(false);
        setError(null);
        setHasMore(false);
        setCursor(null);
        return;
      }

      if (inFlightRef.current) {
        if (debug) {
          // eslint-disable-next-line no-console
          console.log('[rideHistory] skip fetch (in-flight)', {
            mode,
            nextCursor,
          });
        }
        return;
      }

      inFlightRef.current = true;
      if (mode === 'append') setLoadingMore(true);
      if (debug) {
        // eslint-disable-next-line no-console
        console.log('[rideHistory] fetch start', { mode, cursor: nextCursor });
      }

      try {
        let q = supabase
          .from('rides')
          .select(
            'id, created_at, status, pickup_label, destination_label, estimated_price_eur, passenger_count, ride_completed_at'
          )
          .eq('client_id', userId)
          .in('status', TERMINAL)
          .order('created_at', { ascending: false })
          .order('id', { ascending: false })
          .limit(PAGE_SIZE);

        if (nextCursor) {
          // Keyset pagination (DESC): take rows strictly "after" the cursor.
          // after (created_at DESC, id DESC) means:
          // created_at < cursor.createdAt OR (created_at = cursor.createdAt AND id < cursor.id)
          const createdAt = nextCursor.createdAt;
          const id = nextCursor.id;
          const orFilter = `created_at.lt.${createdAt},and(created_at.eq.${createdAt},id.lt.${id})`;
          if (debug) {
            const hasPct = orFilter.includes('%');
            const hasPct3A = orFilter.includes('%3A');
            const hasPct2B = orFilter.includes('%2B');
            // eslint-disable-next-line no-console
            console.log('[rideHistory] keyset filter', {
              cursorRaw: nextCursor,
              orFilter,
              containsPercent: hasPct,
              containsPct3A: hasPct3A,
              containsPct2B: hasPct2B,
            });
          }
          q = q.or(orFilter);
        }

        const { data, error: e } = await q;
        if (e) {
          setError(e.message || 'Impossible de charger votre historique.');
          if (mode === 'replace') {
            setItems([]);
            setHasMore(false);
            setCursor(null);
          }
          if (debug) {
            // eslint-disable-next-line no-console
            console.log('[rideHistory] fetch error', {
              mode,
              cursor: nextCursor,
              message: e.message,
            });
          }
          return;
        }

        const rows = (data ?? []) as ClientRideHistoryRow[];
        setError(null);
        setHasMore(rows.length >= PAGE_SIZE);
        if (rows.length > 0) {
          const last = rows[rows.length - 1];
          setCursor({ createdAt: last.created_at, id: last.id });
        }
        setItems((prev) => {
          const merged = mergeRidesById(prev, rows, mode);
          if (debug) {
            const ids = merged.map((x) => x.id);
            const dup = getDuplicateIds(ids);
            // eslint-disable-next-line no-console
            console.log('[rideHistory] fetch result', {
              mode,
              cursor: nextCursor,
              received: rows.length,
              total: merged.length,
              receivedIds: rows.map((x) => x.id),
              duplicateIdsInState: dup,
              firstReceived:
                rows.length > 0
                  ? { id: rows[0].id, created_at: rows[0].created_at }
                  : null,
              lastReceived:
                rows.length > 0
                  ? {
                      id: rows[rows.length - 1].id,
                      created_at: rows[rows.length - 1].created_at,
                    }
                  : null,
            });
          }
          return merged;
        });
      } finally {
        inFlightRef.current = false;
        setLoadingMore(false);
        if (debug) {
          // eslint-disable-next-line no-console
          console.log('[rideHistory] fetch end', { mode, cursor: nextCursor });
        }
      }
    },
    [enabled, userId]
  );

  useEffect(() => {
    setLoading(true);
    setCursor(null);
    setHasMore(true);
    void fetchPage(null, 'replace').finally(() => setLoading(false));
  }, [fetchPage]);

  const refresh = useCallback(async () => {
    if (!enabled) return;
    setRefreshing(true);
    setCursor(null);
    setHasMore(true);
    try {
      await fetchPage(null, 'replace');
    } finally {
      setRefreshing(false);
    }
  }, [enabled, fetchPage]);

  const loadMore = useCallback(async () => {
    if (!enabled || loading || loadingMore || refreshing || !hasMore) return;
    await fetchPage(cursor, 'append');
  }, [enabled, loading, loadingMore, refreshing, hasMore, fetchPage, cursor]);

  return { items, loading, refreshing, error, hasMore, refresh, loadMore };
}

