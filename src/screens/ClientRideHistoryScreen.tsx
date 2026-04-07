import { useMemo } from 'react';
import {
  ActivityIndicator,
  FlatList,
  Pressable,
  StyleSheet,
  Text,
  View,
} from 'react-native';

import {
  type ClientRideHistoryRow,
  useClientRideHistory,
} from '../hooks/useClientRideHistory';

function formatWhen(iso: string, completedAt: string | null): string {
  const raw = completedAt?.trim() ? completedAt : iso;
  const ms = Date.parse(raw);
  if (!Number.isFinite(ms)) return raw;
  const d = new Date(ms);
  return d.toLocaleString('fr-FR', { dateStyle: 'medium', timeStyle: 'short' });
}

function statusLabel(s: string): string {
  switch (s) {
    case 'completed':
      return 'Terminée';
    case 'cancelled_by_client':
      return 'Annulée';
    case 'cancelled_by_driver':
      return 'Annulée (chauffeur)';
    case 'expired':
      return 'Expirée';
    default:
      return s;
  }
}

function statusColor(s: string): { bg: string; border: string; text: string } {
  switch (s) {
    case 'completed':
      return { bg: '#ecfdf5', border: '#a7f3d0', text: '#047857' };
    case 'expired':
      return { bg: '#fffbeb', border: '#fde68a', text: '#92400e' };
    default:
      return { bg: '#f1f5f9', border: '#e2e8f0', text: '#475569' };
  }
}

function formatEur(v: number | null): string {
  if (v == null || !Number.isFinite(v)) return '—';
  return `${v.toFixed(2)} €`;
}

function RideRow({ item }: { item: ClientRideHistoryRow }) {
  const badge = statusColor(item.status);
  const from = item.pickup_label?.trim() || 'Départ';
  const to = item.destination_label?.trim() || 'Destination';
  const when = formatWhen(item.created_at, item.ride_completed_at);
  return (
    <View style={styles.rideCard}>
      <View style={styles.rideTopRow}>
        <Text style={styles.rideWhen}>{when}</Text>
        <View
          style={[
            styles.badge,
            { backgroundColor: badge.bg, borderColor: badge.border },
          ]}
        >
          <Text style={[styles.badgeText, { color: badge.text }]}>
            {statusLabel(item.status)}
          </Text>
        </View>
      </View>
      <Text style={styles.rideRoute} numberOfLines={2}>
        {from} → {to}
      </Text>
      <Text style={styles.ridePrice}>Estimation : {formatEur(item.estimated_price_eur)}</Text>
    </View>
  );
}

export function ClientRideHistoryScreen(props: {
  userId: string;
  onBack: () => void;
}) {
  const { userId, onBack } = props;
  const { items, loading, refreshing, error, hasMore, refresh, loadMore } =
    useClientRideHistory(userId);

  const header = useMemo(() => {
    return (
      <View style={styles.header}>
        <Pressable style={styles.backBtn} onPress={onBack}>
          <Text style={styles.backBtnText}>Retour</Text>
        </Pressable>
        <Text style={styles.title}>Mes courses</Text>
      </View>
    );
  }, [onBack]);

  if (loading) {
    return (
      <View style={styles.root}>
        {header}
        <View style={styles.center}>
          <ActivityIndicator color="#0f766e" />
          <Text style={styles.hint}>Chargement de l’historique…</Text>
        </View>
      </View>
    );
  }

  return (
    <View style={styles.root}>
      {header}
      {error ? <Text style={styles.error}>{error}</Text> : null}
      {items.length === 0 && !error ? (
        <Text style={styles.empty}>Aucune course pour le moment.</Text>
      ) : (
        <FlatList
          data={items}
          keyExtractor={(it) => it.id}
          renderItem={({ item }) => <RideRow item={item} />}
          contentContainerStyle={styles.list}
          refreshing={refreshing}
          onRefresh={() => void refresh()}
          onEndReachedThreshold={0.25}
          onEndReached={() => void loadMore()}
          ListFooterComponent={
            hasMore ? (
              <View style={styles.footer}>
                <ActivityIndicator color="#0f766e" />
              </View>
            ) : null
          }
        />
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  root: {
    width: '100%',
    maxWidth: 420,
  },
  header: {
    width: '100%',
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
    marginBottom: 12,
  },
  backBtn: {
    paddingVertical: 8,
    paddingHorizontal: 12,
    borderRadius: 10,
    backgroundColor: '#f1f5f9',
  },
  backBtnText: {
    color: '#0f766e',
    fontWeight: '700',
  },
  title: {
    fontSize: 18,
    fontWeight: '800',
    color: '#0f172a',
  },
  center: {
    paddingVertical: 24,
    alignItems: 'center',
    gap: 10,
  },
  hint: {
    color: '#64748b',
  },
  error: {
    marginBottom: 10,
    color: '#b91c1c',
    fontSize: 13,
    lineHeight: 18,
  },
  empty: {
    color: '#64748b',
    fontSize: 14,
    lineHeight: 20,
    paddingVertical: 12,
  },
  list: {
    paddingBottom: 12,
  },
  rideCard: {
    borderWidth: 1,
    borderColor: '#e2e8f0',
    backgroundColor: '#fff',
    borderRadius: 12,
    padding: 12,
    marginBottom: 10,
  },
  rideTopRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: 10,
  },
  rideWhen: {
    color: '#64748b',
    fontSize: 12,
    fontWeight: '600',
  },
  badge: {
    paddingVertical: 4,
    paddingHorizontal: 8,
    borderRadius: 999,
    borderWidth: 1,
  },
  badgeText: {
    fontSize: 12,
    fontWeight: '800',
  },
  rideRoute: {
    marginTop: 8,
    fontSize: 14,
    fontWeight: '700',
    color: '#0f172a',
    lineHeight: 20,
  },
  ridePrice: {
    marginTop: 6,
    color: '#0f766e',
    fontWeight: '700',
  },
  footer: {
    paddingVertical: 12,
    alignItems: 'center',
  },
});

