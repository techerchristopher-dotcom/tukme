import { useCallback, useEffect, useMemo, useState } from 'react';

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
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [offset, setOffset] = useState(0);
  const [hasMore, setHasMore] = useState(true);

  const enabled = useMemo(() => !!userId.trim(), [userId]);

  const fetchPage = useCallback(
    async (nextOffset: number, mode: 'replace' | 'append') => {
      if (!enabled) {
        setItems([]);
        setLoading(false);
        setError(null);
        setHasMore(false);
        return;
      }

      const q = supabase
        .from('rides')
        .select(
          'id, created_at, status, pickup_label, destination_label, estimated_price_eur, passenger_count, ride_completed_at'
        )
        .eq('client_id', userId)
        .in('status', TERMINAL)
        .order('created_at', { ascending: false })
        .range(nextOffset, nextOffset + PAGE_SIZE - 1);

      const { data, error: e } = await q;
      if (e) {
        setError(e.message || 'Impossible de charger votre historique.');
        if (mode === 'replace') {
          setItems([]);
          setHasMore(false);
        }
        return;
      }

      const rows = (data ?? []) as ClientRideHistoryRow[];
      setError(null);
      setHasMore(rows.length >= PAGE_SIZE);
      setItems((prev) => (mode === 'replace' ? rows : [...prev, ...rows]));
      setOffset(nextOffset + rows.length);
    },
    [enabled, userId]
  );

  useEffect(() => {
    setLoading(true);
    setOffset(0);
    setHasMore(true);
    void fetchPage(0, 'replace').finally(() => setLoading(false));
  }, [fetchPage]);

  const refresh = useCallback(async () => {
    if (!enabled) return;
    setRefreshing(true);
    setOffset(0);
    setHasMore(true);
    try {
      await fetchPage(0, 'replace');
    } finally {
      setRefreshing(false);
    }
  }, [enabled, fetchPage]);

  const loadMore = useCallback(async () => {
    if (!enabled || loading || refreshing || !hasMore) return;
    await fetchPage(offset, 'append');
  }, [enabled, loading, refreshing, hasMore, fetchPage, offset]);

  return { items, loading, refreshing, error, hasMore, refresh, loadMore };
}

