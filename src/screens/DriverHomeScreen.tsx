import type { Session } from '@supabase/supabase-js';
import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  ActivityIndicator,
  Pressable,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';

import { SignedInShell } from '../components/SignedInShell';
import { useDriverLiveLocation } from '../hooks/useDriverLiveLocation';
import {
  driverReleaseRideBeforePayment,
  DriverReleaseRideError,
} from '../lib/driverReleaseRide';
import {
  DriverRideProgressError,
  rpcCompleteRideWithOtp,
  rpcMarkArrived,
  rpcStartEnRoute,
  rpcStartRide,
} from '../lib/driverRideProgress';
import { supabase } from '../lib/supabase';
import type { Profile } from '../types/profile';

type Props = {
  session: Session;
  profile: Profile;
  onDevResetRole: () => Promise<void>;
};

type OpenRideRow = {
  id: string;
  destination_label: string;
  pickup_label: string | null;
  estimated_price_eur: number | null;
  created_at: string;
};

type AssignedRideRow = {
  id: string;
  destination_label: string;
  estimated_price_eur: number | null;
  status: string;
  payment_expires_at: string | null;
};

const SELECT_OPEN =
  'id, destination_label, pickup_label, estimated_price_eur, created_at, status';

const SELECT_ASSIGNED =
  'id, destination_label, estimated_price_eur, status, payment_expires_at, updated_at';

function formatEur(eur: number | null): string {
  if (eur == null || !Number.isFinite(eur)) {
    return '—';
  }
  return `${eur.toFixed(2)} €`;
}

function driverAssignmentStatusMessage(status: string): string {
  switch (status) {
    case 'awaiting_payment':
      return 'En attente de paiement client';
    case 'paid':
      return 'Paiement reçu — vous pouvez partir.';
    case 'en_route':
      return 'En route vers le client';
    case 'arrived':
      return 'Arrivé sur place — démarrez la course quand le client est prêt.';
    case 'expired':
      return 'Paiement expiré';
    case 'in_progress':
      return 'Course en cours';
    case 'completed':
      return 'Course terminée';
    default:
      return `Statut : ${status}`;
  }
}

function DriverMyAssignmentsBlock(props: { driverId: string }) {
  const { driverId } = props;
  const [rides, setRides] = useState<AssignedRideRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [listError, setListError] = useState<string | null>(null);
  const [releasingId, setReleasingId] = useState<string | null>(null);
  const [postPaidActionId, setPostPaidActionId] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [otpInput, setOtpInput] = useState('');
  const [otpRideId, setOtpRideId] = useState<string | null>(null);

  const fetchMine = useCallback(async () => {
    if (!driverId.trim()) {
      setRides([]);
      setLoading(false);
      return;
    }
    setListError(null);
    const { data, error } = await supabase
      .from('rides')
      .select(SELECT_ASSIGNED)
      .eq('driver_id', driverId)
      .in('status', [
        'awaiting_payment',
        'paid',
        'en_route',
        'arrived',
        'expired',
        'in_progress',
        'completed',
      ])
      .order('updated_at', { ascending: false });

    if (error) {
      setListError(error.message || 'Impossible de charger vos courses.');
      setRides([]);
      setLoading(false);
      return;
    }

    const rows = (data ?? []) as AssignedRideRow[];
    setRides(rows.filter((r) => r.id));
    setLoading(false);
  }, [driverId]);

  useEffect(() => {
    void fetchMine();
  }, [fetchMine]);

  const rideForTracking = useMemo(() => {
    return (
      rides.find(
        (r) => r.status === 'paid' || r.status === 'en_route' || r.status === 'arrived'
      ) ?? null
    );
  }, [rides]);

  useDriverLiveLocation({
    rideId: rideForTracking?.id ?? null,
    rideStatus: rideForTracking?.status ?? null,
  });

  useEffect(() => {
    const channel = supabase
      .channel('driver-rides-assigned')
      .on(
        'postgres_changes',
        { event: '*', schema: 'public', table: 'rides' },
        () => {
          void fetchMine();
        }
      )
      .subscribe();

    return () => {
      void supabase.removeChannel(channel);
    };
  }, [fetchMine]);

  async function handlePostPaidStep(
    rideId: string,
    step: 'en_route' | 'arrived' | 'start'
  ) {
    if (postPaidActionId || releasingId) {
      return;
    }
    setActionError(null);
    setPostPaidActionId(rideId);
    try {
      if (step === 'en_route') {
        await rpcStartEnRoute(rideId);
      } else if (step === 'arrived') {
        await rpcMarkArrived(rideId);
      } else {
        await rpcStartRide(rideId);
      }
      void fetchMine();
    } catch (e) {
      setActionError(
        e instanceof DriverRideProgressError
          ? e.message
          : e instanceof Error
            ? e.message
            : 'Action impossible.'
      );
      void fetchMine();
    } finally {
      setPostPaidActionId(null);
    }
  }

  async function handleCompleteWithOtp(rideId: string) {
    if (releasingId || postPaidActionId) {
      return;
    }
    const otp = otpInput.trim();
    if (!otp || otp.length < 4) {
      setActionError('Saisissez le code à 4 chiffres.');
      return;
    }
    setActionError(null);
    setPostPaidActionId(rideId);
    try {
      await rpcCompleteRideWithOtp(rideId, otp);
      void fetchMine();
    } catch (e) {
      setActionError(
        e instanceof DriverRideProgressError
          ? e.message
          : e instanceof Error
            ? e.message
            : 'Action impossible.'
      );
      void fetchMine();
    } finally {
      setPostPaidActionId(null);
    }
  }

  async function handleRelease(rideId: string) {
    if (releasingId || postPaidActionId) {
      return;
    }
    setActionError(null);
    setReleasingId(rideId);
    try {
      await driverReleaseRideBeforePayment(rideId);
      void fetchMine();
    } catch (e) {
      setActionError(
        e instanceof DriverReleaseRideError
          ? e.message
          : e instanceof Error
            ? e.message
            : 'Impossible de libérer la course.'
      );
      void fetchMine();
    } finally {
      setReleasingId(null);
    }
  }

  if (loading) {
    return (
      <View style={[styles.driverBlock, styles.driverBlockSpaced]}>
        <ActivityIndicator color="#0f766e" />
        <Text style={styles.driverHint}>Chargement de vos courses…</Text>
      </View>
    );
  }

  if (listError) {
    return (
      <View style={[styles.driverBlock, styles.driverBlockSpaced]}>
        <Text style={styles.driverError}>{listError}</Text>
        <Pressable style={styles.retryBtn} onPress={() => void fetchMine()}>
          <Text style={styles.retryBtnText}>Réessayer</Text>
        </Pressable>
      </View>
    );
  }

  if (rides.length === 0) {
    return null;
  }

  return (
    <View style={[styles.driverBlock, styles.driverBlockSpaced]}>
      <Text style={styles.driverTitle}>Mes courses</Text>
      {actionError ? (
        <Text style={styles.driverError}>{actionError}</Text>
      ) : null}
      {rides.map((r) => (
        <View key={r.id} style={styles.rideCard}>
          <Text style={styles.rideDest} numberOfLines={2}>
            {r.destination_label || 'Destination'}
          </Text>
          <Text style={styles.ridePrice}>{formatEur(r.estimated_price_eur)}</Text>
          <Text style={styles.assignmentStatus}>
            {driverAssignmentStatusMessage(r.status)}
          </Text>
          {r.status === 'awaiting_payment' && r.payment_expires_at ? (
            <Text style={styles.expiresHint} numberOfLines={1}>
              Paiement avant :{' '}
              {new Date(r.payment_expires_at).toLocaleTimeString('fr-FR', {
                hour: '2-digit',
                minute: '2-digit',
              })}
            </Text>
          ) : null}
          {r.status === 'awaiting_payment' ? (
            <Pressable
              style={({ pressed }) => [
                styles.releaseBtn,
                (releasingId || postPaidActionId) && styles.acceptBtnDisabled,
                pressed && !releasingId && !postPaidActionId && styles.releaseBtnPressed,
              ]}
              disabled={!!releasingId || !!postPaidActionId}
              onPress={() => void handleRelease(r.id)}
            >
              {releasingId === r.id ? (
                <ActivityIndicator color="#0f766e" />
              ) : (
                <Text style={styles.releaseBtnText}>
                  Libérer la course (avant paiement)
                </Text>
              )}
            </Pressable>
          ) : null}
          {r.status === 'paid' ? (
            <Pressable
              style={({ pressed }) => [
                styles.progressBtn,
                postPaidActionId && styles.acceptBtnDisabled,
                pressed && !postPaidActionId && styles.progressBtnPressed,
              ]}
              disabled={!!postPaidActionId || !!releasingId}
              onPress={() => void handlePostPaidStep(r.id, 'en_route')}
            >
              {postPaidActionId === r.id ? (
                <ActivityIndicator color="#fff" />
              ) : (
                <Text style={styles.progressBtnText}>Je pars vers le client</Text>
              )}
            </Pressable>
          ) : null}
          {r.status === 'en_route' ? (
            <Pressable
              style={({ pressed }) => [
                styles.progressBtn,
                postPaidActionId && styles.acceptBtnDisabled,
                pressed && !postPaidActionId && styles.progressBtnPressed,
              ]}
              disabled={!!postPaidActionId || !!releasingId}
              onPress={() => void handlePostPaidStep(r.id, 'arrived')}
            >
              {postPaidActionId === r.id ? (
                <ActivityIndicator color="#fff" />
              ) : (
                <Text style={styles.progressBtnText}>Je suis arrivé</Text>
              )}
            </Pressable>
          ) : null}
          {r.status === 'arrived' ? (
            <Pressable
              style={({ pressed }) => [
                styles.progressBtn,
                postPaidActionId && styles.acceptBtnDisabled,
                pressed && !postPaidActionId && styles.progressBtnPressed,
              ]}
              disabled={!!postPaidActionId || !!releasingId}
              onPress={() => void handlePostPaidStep(r.id, 'start')}
            >
              {postPaidActionId === r.id ? (
                <ActivityIndicator color="#fff" />
              ) : (
                <Text style={styles.progressBtnText}>Démarrer la course</Text>
              )}
            </Pressable>
          ) : null}
          {r.status === 'in_progress' ? (
            <View style={styles.otpBlock}>
              <Text style={styles.otpLabel}>Code de fin de course</Text>
              <TextInput
                style={styles.otpInput}
                value={otpRideId === r.id ? otpInput : ''}
                onFocus={() => setOtpRideId(r.id)}
                onChangeText={(t: string) => {
                  setOtpRideId(r.id);
                  setOtpInput(t.replace(/\D/g, '').slice(0, 4));
                }}
                placeholder="0000"
                keyboardType="number-pad"
                maxLength={4}
              />
              <Pressable
                style={({ pressed }) => [
                  styles.progressBtn,
                  postPaidActionId && styles.acceptBtnDisabled,
                  pressed && !postPaidActionId && styles.progressBtnPressed,
                ]}
                disabled={!!postPaidActionId || !!releasingId}
                onPress={() => void handleCompleteWithOtp(r.id)}
              >
                {postPaidActionId === r.id ? (
                  <ActivityIndicator color="#fff" />
                ) : (
                  <Text style={styles.progressBtnText}>
                    Valider le code et terminer
                  </Text>
                )}
              </Pressable>
            </View>
          ) : null}
        </View>
      ))}
    </View>
  );
}

function DriverRequestsBlock() {
  const [rides, setRides] = useState<OpenRideRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [listError, setListError] = useState<string | null>(null);
  const [acceptingId, setAcceptingId] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);

  const fetchOpen = useCallback(async () => {
    setListError(null);
    const { data, error } = await supabase
      .from('rides')
      .select(SELECT_OPEN)
      .eq('status', 'requested')
      .order('created_at', { ascending: false });

    if (error) {
      setListError(error.message || 'Impossible de charger les demandes.');
      setRides([]);
      setLoading(false);
      return;
    }

    const rows = (data ?? []) as OpenRideRow[];
    setRides(rows.filter((r) => r.id));
    setLoading(false);
  }, []);

  useEffect(() => {
    void fetchOpen();
  }, [fetchOpen]);

  useEffect(() => {
    const channel = supabase
      .channel('driver-rides-open')
      .on(
        'postgres_changes',
        { event: '*', schema: 'public', table: 'rides' },
        () => {
          void fetchOpen();
        }
      )
      .subscribe();

    return () => {
      void supabase.removeChannel(channel);
    };
  }, [fetchOpen]);

  async function handleAccept(rideId: string) {
    if (acceptingId) {
      return;
    }
    setActionError(null);
    setAcceptingId(rideId);
    const { error } = await supabase.rpc('accept_ride_as_driver', {
      p_ride_id: rideId,
    });
    setAcceptingId(null);
    if (error) {
      const raw = error.message ?? '';
      if (raw.includes('ACCEPT_RIDE_NOT_REQUESTED')) {
        setActionError('Cette course n’est plus disponible.');
      } else if (raw.includes('ACCEPT_RIDE_NOT_DRIVER')) {
        setActionError('Compte non autorisé.');
      } else if (raw.includes('ACCEPT_RIDE_OWN_RIDE')) {
        setActionError('Vous ne pouvez pas accepter votre propre demande.');
      } else {
        setActionError(raw.trim() || 'Impossible d’accepter.');
      }
      void fetchOpen();
      return;
    }
    void fetchOpen();
  }

  if (loading) {
    return (
      <View style={styles.driverBlock}>
        <ActivityIndicator color="#0f766e" />
        <Text style={styles.driverHint}>Chargement des demandes…</Text>
      </View>
    );
  }

  if (listError) {
    return (
      <View style={styles.driverBlock}>
        <Text style={styles.driverError}>{listError}</Text>
        <Pressable style={styles.retryBtn} onPress={() => void fetchOpen()}>
          <Text style={styles.retryBtnText}>Réessayer</Text>
        </Pressable>
      </View>
    );
  }

  if (rides.length === 0) {
    return (
      <View style={styles.driverBlock}>
        <Text style={styles.driverTitle}>Demandes ouvertes</Text>
        <Text style={styles.driverHint}>Aucune course en attente pour le moment.</Text>
      </View>
    );
  }

  return (
    <View style={styles.driverBlock}>
      <Text style={styles.driverTitle}>Demandes ouvertes</Text>
      {actionError ? (
        <Text style={styles.driverError}>{actionError}</Text>
      ) : null}
      {rides.map((r) => (
        <View key={r.id} style={styles.rideCard}>
          <Text style={styles.rideDest} numberOfLines={2}>
            {r.destination_label || 'Destination'}
          </Text>
          {r.pickup_label ? (
            <Text style={styles.ridePickup} numberOfLines={1}>
              Départ : {r.pickup_label}
            </Text>
          ) : null}
          <Text style={styles.ridePrice}>{formatEur(r.estimated_price_eur)}</Text>
          <Pressable
            style={({ pressed }) => [
              styles.acceptBtn,
              acceptingId && styles.acceptBtnDisabled,
              pressed && !acceptingId && styles.acceptBtnPressed,
            ]}
            disabled={!!acceptingId}
            onPress={() => void handleAccept(r.id)}
          >
            {acceptingId === r.id ? (
              <ActivityIndicator color="#fff" />
            ) : (
              <Text style={styles.acceptBtnText}>Accepter</Text>
            )}
          </Pressable>
        </View>
      ))}
    </View>
  );
}

export function DriverHomeScreen({
  session,
  profile,
  onDevResetRole,
}: Props) {
  return (
    <SignedInShell
      session={session}
      profile={profile}
      headline="Espace chauffeur"
      onDevResetRole={onDevResetRole}
      middleContent={
        <>
          <DriverMyAssignmentsBlock driverId={session.user.id} />
          <DriverRequestsBlock />
        </>
      }
    />
  );
}

const styles = StyleSheet.create({
  driverBlock: {
    width: '100%',
    maxWidth: 400,
    marginBottom: 20,
    padding: 16,
    borderRadius: 12,
    backgroundColor: '#fff',
    borderWidth: 1,
    borderColor: '#e2e8f0',
    alignItems: 'stretch',
  },
  driverBlockSpaced: {
    marginBottom: 16,
  },
  driverTitle: {
    fontSize: 17,
    fontWeight: '700',
    color: '#0f172a',
    marginBottom: 12,
  },
  driverHint: {
    fontSize: 14,
    color: '#64748b',
    marginTop: 8,
  },
  driverError: {
    fontSize: 14,
    color: '#b91c1c',
    marginBottom: 8,
  },
  retryBtn: {
    marginTop: 8,
    alignSelf: 'flex-start',
    paddingVertical: 8,
    paddingHorizontal: 14,
    borderRadius: 8,
    backgroundColor: '#f1f5f9',
  },
  retryBtnText: {
    color: '#0f766e',
    fontWeight: '600',
  },
  rideCard: {
    paddingVertical: 12,
    borderTopWidth: 1,
    borderTopColor: '#e2e8f0',
  },
  rideDest: {
    fontSize: 16,
    fontWeight: '600',
    color: '#0f172a',
    marginBottom: 4,
  },
  ridePickup: {
    fontSize: 13,
    color: '#64748b',
    marginBottom: 4,
  },
  ridePrice: {
    fontSize: 14,
    color: '#0f766e',
    fontWeight: '600',
    marginBottom: 10,
  },
  assignmentStatus: {
    fontSize: 14,
    color: '#475569',
    marginBottom: 8,
    lineHeight: 20,
  },
  expiresHint: {
    fontSize: 12,
    color: '#64748b',
    marginBottom: 8,
  },
  acceptBtn: {
    backgroundColor: '#0f766e',
    borderRadius: 10,
    paddingVertical: 12,
    alignItems: 'center',
  },
  acceptBtnPressed: {
    opacity: 0.9,
  },
  acceptBtnDisabled: {
    opacity: 0.6,
  },
  acceptBtnText: {
    color: '#fff',
    fontWeight: '700',
    fontSize: 16,
  },
  releaseBtn: {
    marginTop: 4,
    borderWidth: 2,
    borderColor: '#b45309',
    borderRadius: 10,
    paddingVertical: 12,
    alignItems: 'center',
    backgroundColor: '#fffbeb',
  },
  releaseBtnPressed: {
    opacity: 0.88,
  },
  releaseBtnText: {
    color: '#b45309',
    fontWeight: '700',
    fontSize: 15,
  },
  progressBtn: {
    marginTop: 10,
    backgroundColor: '#0f766e',
    borderRadius: 10,
    paddingVertical: 12,
    alignItems: 'center',
  },
  progressBtnPressed: {
    opacity: 0.92,
  },
  progressBtnText: {
    color: '#fff',
    fontWeight: '700',
    fontSize: 16,
  },
  otpBlock: {
    marginTop: 10,
    gap: 8,
  },
  otpLabel: {
    fontSize: 12,
    color: '#64748b',
    textTransform: 'uppercase',
    letterSpacing: 0.4,
  },
  otpInput: {
    borderWidth: 1,
    borderColor: '#e2e8f0',
    borderRadius: 10,
    paddingVertical: 10,
    paddingHorizontal: 12,
    fontSize: 18,
    fontWeight: '700',
    color: '#0f172a',
    backgroundColor: '#fff',
    fontVariant: ['tabular-nums'],
    letterSpacing: 2,
    textAlign: 'center',
  },
});
