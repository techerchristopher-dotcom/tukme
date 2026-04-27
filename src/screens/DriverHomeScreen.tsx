import type { Session } from '@supabase/supabase-js';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  ActivityIndicator,
  AppState,
  KeyboardAvoidingView,
  Platform,
  Pressable,
  SafeAreaView,
  ScrollView,
  StatusBar,
  StyleSheet,
  Text,
  TextInput,
  TouchableWithoutFeedback,
  View,
} from 'react-native';

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
import { notifyRideEvent } from '../lib/pushNotifications';
import { supabase, syncRealtimeAuth } from '../lib/supabase';
import { formatAriary } from '../lib/taxiPricing';
import type { Profile } from '../types/profile';

// ─── TYPES ────────────────────────────────────────────────────────────────────
type TabId = 'inbox' | 'rides' | 'profile';

type OpenRideRow = {
  id: string;
  destination_label: string;
  pickup_label: string | null;
  estimated_price_ariary: number | null;
  passenger_count: number;
  created_at: string;
};

type AssignedRideRow = {
  id: string;
  destination_label: string;
  pickup_label: string | null;
  estimated_price_ariary: number | null;
  passenger_count: number;
  status: string;
  payment_expires_at: string | null;
  payment_method: 'card' | 'cash' | null;
};

type BtnVariant = 'primary' | 'outline' | 'ghost' | 'danger' | 'dangerOutline';

type Props = {
  session: Session;
  profile: Profile;
  onDevResetRole: () => Promise<void>;
};

// ─── TOKENS ───────────────────────────────────────────────────────────────────
const C = {
  brand:      '#0f766e',
  brandLight: '#e0f2f0',
  bg:         '#f8fafc',
  surface:    '#ffffff',
  text:       '#0f172a',
  textSec:    '#64748b',
  textTer:    '#94a3b8',
  border:     '#e2e8f0',
  red:        '#ef4444',
  redLight:   '#fef2f2',
  orange:     '#f97316',
  green:      '#22c55e',
  greenLight: '#f0fdf4',
  amber:      '#f59e0b',
  amberLight: '#fffbeb',
} as const;

// ─── STATUS CONFIG ─────────────────────────────────────────────────────────────
const STATUS_CONFIG: Record<string, { label: string; color: string; bg: string; icon: string }> = {
  awaiting_payment:    { label: 'En attente de paiement',             color: C.amber,   bg: C.amberLight, icon: '⏳' },
  paid:                { label: 'Paiement reçu — vous pouvez partir', color: C.green,   bg: C.greenLight, icon: '✓'  },
  en_route:            { label: 'En route vers le client',            color: C.brand,   bg: C.brandLight, icon: '→'  },
  arrived:             { label: 'Arrivé sur place',                   color: C.brand,   bg: C.brandLight, icon: '📍' },
  in_progress:         { label: 'Course en cours',                    color: C.brand,   bg: C.brandLight, icon: '🚗' },
  completed:           { label: 'Course terminée',                    color: C.textSec, bg: '#f1f5f9',    icon: '✓'  },
  expired:             { label: 'Paiement expiré',                    color: C.red,     bg: C.redLight,   icon: '✕'  },
  cancelled_by_client: { label: 'Annulée par le client',              color: C.red,     bg: C.redLight,   icon: '✕'  },
  cancelled_by_driver: { label: 'Annulée par le chauffeur',           color: C.red,     bg: C.redLight,   icon: '✕'  },
};

const TERMINAL = new Set(['completed', 'cancelled_by_client', 'cancelled_by_driver', 'expired']);

// ─── DB SELECTS ────────────────────────────────────────────────────────────────
const SELECT_OPEN =
  'id, destination_label, pickup_label, estimated_price_ariary, passenger_count, created_at';
const SELECT_ASSIGNED =
  'id, destination_label, pickup_label, estimated_price_ariary, passenger_count, status, payment_expires_at, payment_method, updated_at';

// ─── HELPERS ──────────────────────────────────────────────────────────────────
function fmtAr(v: number | null): string {
  if (v == null || !Number.isFinite(v)) return '—';
  return `${formatAriary(Math.round(v))} Ar`;
}

function secsUntil(iso: string | null): number {
  if (!iso) return 0;
  return Math.max(0, Math.floor((new Date(iso).getTime() - Date.now()) / 1000));
}

// ─── PILL ─────────────────────────────────────────────────────────────────────
function Pill({ label, color, bg }: { label: string; color: string; bg?: string }) {
  return (
    <View style={[st.pill, { backgroundColor: bg ?? color + '28' }]}>
      <Text style={[st.pillTxt, { color }]}>{label}</Text>
    </View>
  );
}

// ─── BTN ──────────────────────────────────────────────────────────────────────
function Btn({
  label, variant = 'primary', onPress, disabled, loading, small,
}: {
  label: string; variant?: BtnVariant; onPress: () => void;
  disabled?: boolean; loading?: boolean; small?: boolean;
}) {
  const vs: Record<BtnVariant, object> = {
    primary:       { backgroundColor: disabled ? '#94a3b8' : C.brand },
    outline:       { backgroundColor: 'transparent', borderWidth: 1.5, borderColor: C.brand },
    ghost:         { backgroundColor: '#f1f5f9' },
    danger:        { backgroundColor: C.red },
    dangerOutline: { backgroundColor: 'transparent', borderWidth: 1.5, borderColor: C.red },
  };
  const tc: Record<BtnVariant, string> = {
    primary: '#fff', outline: C.brand, ghost: C.text, danger: '#fff', dangerOutline: C.red,
  };
  return (
    <Pressable
      onPress={disabled || loading ? undefined : onPress}
      style={({ pressed }) => [
        st.btn, small && st.btnSm, vs[variant],
        (disabled || loading) && { opacity: 0.6 },
        pressed && !disabled && !loading && { opacity: 0.85 },
      ]}
    >
      {loading
        ? <ActivityIndicator size="small" color={variant === 'primary' || variant === 'danger' ? '#fff' : C.brand} />
        : <Text style={[st.btnTxt, small && st.btnTxtSm, { color: tc[variant] }]}>{label}</Text>
      }
    </Pressable>
  );
}

// ─── TIMER BADGE ──────────────────────────────────────────────────────────────
function TimerBadge({ expiresAt }: { expiresAt: string | null }) {
  const [secs, setSecs] = useState(() => secsUntil(expiresAt));
  useEffect(() => {
    const t = setInterval(() => setSecs(secsUntil(expiresAt)), 1000);
    return () => clearInterval(t);
  }, [expiresAt]);
  const m  = Math.floor(secs / 60);
  const ss = String(secs % 60).padStart(2, '0');
  const urgent = secs < 60;
  return <Pill label={`⏱ ${m}:${ss}`} color={urgent ? C.red : C.amber} bg={urgent ? C.redLight : C.amberLight} />;
}

// ─── EMPTY STATE ──────────────────────────────────────────────────────────────
function EmptyState({ icon, title, sub, actionLabel, onAction }: {
  icon: string; title: string; sub: string; actionLabel?: string; onAction?: () => void;
}) {
  return (
    <View style={st.emptyWrap}>
      <Text style={st.emptyIcon}>{icon}</Text>
      <Text style={st.emptyTitle}>{title}</Text>
      <Text style={st.emptySub}>{sub}</Text>
      {actionLabel && onAction && <Btn label={actionLabel} variant="outline" onPress={onAction} small />}
    </View>
  );
}

// ─── ERROR BANNER ─────────────────────────────────────────────────────────────
function ErrorBanner({ message, onRetry }: { message: string; onRetry?: () => void }) {
  return (
    <View style={st.errBanner}>
      <View style={{ flex: 1 }}>
        <Text style={st.errTitle}>Erreur de connexion</Text>
        <Text style={st.errMsg}>{message}</Text>
      </View>
      {onRetry && (
        <Pressable onPress={onRetry} style={st.errBtn}>
          <Text style={st.errBtnTxt}>Réessayer</Text>
        </Pressable>
      )}
    </View>
  );
}

// ─── REQUEST CARD ─────────────────────────────────────────────────────────────
function RequestCard({
  ride, onAccept, accepting,
}: { ride: OpenRideRow; onAccept: (id: string) => void; accepting: string | null }) {
  const isLoading  = accepting === ride.id;
  const isDisabled = !!accepting && !isLoading;
  return (
    <View style={st.card}>
      <View style={st.cardRow}>
        <View style={{ flex: 1 }}>
          {ride.pickup_label ? (
            <View style={st.routeRow}>
              <View style={[st.dot, { backgroundColor: C.brand }]} />
              <Text style={st.routeLbl} numberOfLines={1}>{ride.pickup_label}</Text>
            </View>
          ) : null}
          <View style={st.routeRow}>
            <View style={[st.dotSq, { backgroundColor: C.orange }]} />
            <Text style={st.routeMain} numberOfLines={2}>{ride.destination_label}</Text>
          </View>
        </View>
        <View style={st.priceCol}>
          <Text style={st.price}>{fmtAr(ride.estimated_price_ariary)}</Text>
          <Text style={st.age}>il y a {ride.created_at}</Text>
        </View>
      </View>
      <View style={st.cardFoot}>
        <Pill label={`👤 ${ride.passenger_count}`} color={C.textSec} />
        <Btn label="Accepter" onPress={() => onAccept(ride.id)} loading={isLoading} disabled={isDisabled} small />
      </View>
    </View>
  );
}

// ─── ASSIGNED CARD ────────────────────────────────────────────────────────────
function AssignedCard({ ride, onPress }: { ride: AssignedRideRow; onPress: (r: AssignedRideRow) => void }) {
  const sc      = STATUS_CONFIG[ride.status] ?? STATUS_CONFIG.completed;
  const isCash  = ride.payment_method === 'cash';
  const statLbl = isCash && ride.status === 'paid'
    ? 'Paiement en espèces à récupérer — vous pouvez partir.'
    : sc.label;
  return (
    <Pressable
      onPress={() => onPress(ride)}
      style={({ pressed }) => [st.card, st.assignedCard, { borderLeftColor: sc.color }, pressed && { opacity: 0.85 }]}
    >
      <View style={st.cardRow}>
        <View style={{ flex: 1 }}>
          <View style={st.routeRow}>
            <View style={[st.dotSq, { backgroundColor: C.orange }]} />
            <Text style={st.routeMain} numberOfLines={2}>{ride.destination_label}</Text>
          </View>
          <Text style={[st.assignedStat, { color: sc.color }]} numberOfLines={2}>{statLbl}</Text>
        </View>
        <View style={st.priceCol}>
          <Text style={st.price}>{fmtAr(ride.estimated_price_ariary)}</Text>
          {ride.status === 'awaiting_payment' && (
            <View style={{ marginTop: 4 }}>
              <TimerBadge expiresAt={ride.payment_expires_at} />
            </View>
          )}
        </View>
      </View>
      <View style={[st.cardFoot, { flexWrap: 'wrap' }]}>
        <Pill label={`${sc.icon} ${sc.label.split('—')[0].trim()}`} color={sc.color} bg={sc.bg} />
        {isCash && <Pill label="💵 Espèces" color={C.textSec} />}
        <Pill label={`👤 ${ride.passenger_count}`} color={C.textSec} />
      </View>
    </Pressable>
  );
}

// ─── OTP SHEET ─────────────────────────────────────────────────────────────────
function OTPSheet({
  ride, onClose, onBack, onComplete,
}: {
  ride: AssignedRideRow;
  onClose: () => void;
  onBack: () => void;
  onComplete: (rideId: string, otp: string) => Promise<void>;
}) {
  const [digits, setDigits]   = useState(['', '', '', '']);
  const [error, setError]     = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [success, setSuccess] = useState(false);

  // Fixed refs — always 4, safe for hooks rules
  const r0 = useRef<TextInput>(null);
  const r1 = useRef<TextInput>(null);
  const r2 = useRef<TextInput>(null);
  const r3 = useRef<TextInput>(null);
  const refs = [r0, r1, r2, r3];

  const handleDigit = (i: number, v: string) => {
    if (!/^\d?$/.test(v)) return;
    const next = [...digits];
    next[i] = v;
    setDigits(next);
    setError(null);
    if (v && i < 3) refs[i + 1].current?.focus();
  };

  const handleKey = (i: number, key: string) => {
    if (key === 'Backspace' && !digits[i] && i > 0) refs[i - 1].current?.focus();
  };

  const handleSubmit = async () => {
    const code = digits.join('');
    if (code.length < 4) { setError('Entrez les 4 chiffres du code.'); return; }
    setLoading(true);
    setError(null);
    try {
      await onComplete(ride.id, code);
      setSuccess(true);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Code incorrect. Demandez le code au client.');
      setDigits(['', '', '', '']);
      setTimeout(() => r0.current?.focus(), 50);
    } finally {
      setLoading(false);
    }
  };

  return (
    <KeyboardAvoidingView
      behavior={Platform.OS === 'ios' ? 'padding' : undefined}
      style={StyleSheet.absoluteFill}
      pointerEvents="box-none"
    >
      <View style={[st.sheet, { paddingBottom: 32 }]}>
        <View style={st.dragHandle} />
        <View style={{ paddingHorizontal: 16 }}>
          {!success ? (
            <>
              <View style={[st.cardRow, { marginBottom: 20, alignItems: 'center' }]}>
                <Pressable onPress={onBack} style={st.backBtn}>
                  <Text style={{ fontSize: 18, color: C.textSec }}>←</Text>
                </Pressable>
                <Text style={st.sheetTitle}>Code de fin de course</Text>
              </View>
              <Text style={st.otpInstr}>
                Demandez le code à 4 chiffres affiché sur l'écran du client pour terminer la course.
              </Text>
              <View style={st.otpRow}>
                {digits.map((d, i) => (
                  <TextInput
                    key={i}
                    ref={refs[i]}
                    value={d}
                    onChangeText={v => handleDigit(i, v)}
                    onKeyPress={({ nativeEvent: { key } }) => handleKey(i, key)}
                    maxLength={1}
                    keyboardType="number-pad"
                    selectTextOnFocus
                    style={[
                      st.otpBox,
                      error        ? { borderColor: C.red }                                      : {},
                      d && !error  ? { borderColor: C.brand, backgroundColor: C.brandLight }    : {},
                    ]}
                  />
                ))}
              </View>
              {error && (
                <View style={st.inlineErr}>
                  <Text style={st.inlineErrTxt}>⚠ {error}</Text>
                </View>
              )}
              <Btn
                label="Valider et terminer la course"
                onPress={handleSubmit}
                loading={loading}
                disabled={digits.join('').length < 4}
              />
            </>
          ) : (
            <View style={st.successBlock}>
              <View style={st.successIcon}>
                <Text style={{ fontSize: 28 }}>✓</Text>
              </View>
              <Text style={st.successTitle}>Course terminée !</Text>
              <Text style={st.successSub}>Merci pour cette course. Le paiement a été confirmé.</Text>
              <View style={st.successAmt}>
                <Text style={st.successAmtVal}>{fmtAr(ride.estimated_price_ariary)}</Text>
                <Text style={st.successAmtDest}>{ride.destination_label}</Text>
              </View>
              <Btn label="Retour à l'accueil" onPress={onClose} />
            </View>
          )}
        </View>
      </View>
    </KeyboardAvoidingView>
  );
}

// ─── RIDE DETAIL SHEET ─────────────────────────────────────────────────────────
function RideDetailSheet({
  ride, onClose, onAction, actionLoading,
}: {
  ride: AssignedRideRow;
  onClose: () => void;
  onAction: (rideId: string, action: string) => Promise<void>;
  actionLoading: string | null;
}) {
  const [otpOpen, setOtpOpen] = useState(false);
  const sc     = STATUS_CONFIG[ride.status] ?? STATUS_CONFIG.completed;
  const isCash = ride.payment_method === 'cash';
  const statLbl = isCash && ride.status === 'paid'
    ? 'Paiement en espèces à récupérer — vous pouvez partir.'
    : sc.label;

  const ACTION_MAP: Record<string, { label: string; action: string; variant: BtnVariant }[]> = {
    paid:             [{ label: 'En route vers le client',  action: 'en_route',    variant: 'primary' }],
    en_route:         [{ label: 'Je suis arrivé',           action: 'arrived',     variant: 'primary' }],
    arrived:          [{ label: 'Démarrer la course',       action: 'in_progress', variant: 'primary' }],
    in_progress:      [{ label: 'Terminer la course (OTP)', action: 'otp',         variant: 'primary' }],
    awaiting_payment: [{ label: 'Relâcher la course',       action: 'release',     variant: 'dangerOutline' }],
  };
  const btns = ACTION_MAP[ride.status] ?? [];

  const handleOTPComplete = async (rideId: string, otp: string) => {
    await onAction(rideId, `otp:${otp}`);
  };

  if (otpOpen) {
    return (
      <OTPSheet
        ride={ride}
        onClose={() => { setOtpOpen(false); onClose(); }}
        onBack={() => setOtpOpen(false)}
        onComplete={handleOTPComplete}
      />
    );
  }

  return (
    <View style={st.sheet}>
      <View style={st.dragHandle} />
      <View style={[st.cardRow, { paddingHorizontal: 16, paddingBottom: 12, paddingTop: 4 }]}>
        <Text style={st.sheetTitle}>Détails de la course</Text>
        <Pressable onPress={onClose} style={st.closeBtn}>
          <Text style={{ color: C.textSec, fontSize: 14 }}>✕</Text>
        </Pressable>
      </View>
      <ScrollView showsVerticalScrollIndicator={false}>
        {/* Status banner */}
        <View style={[st.statusBanner, { backgroundColor: sc.bg, borderColor: sc.color + '30' }]}>
          <Text style={[st.statusBannerTxt, { color: sc.color, flex: 1 }]}>{statLbl}</Text>
          {ride.status === 'awaiting_payment' && <TimerBadge expiresAt={ride.payment_expires_at} />}
        </View>
        {/* Route */}
        <View style={st.routeBlock}>
          <Text style={st.sectionLbl}>ITINÉRAIRE</Text>
          {ride.pickup_label ? (
            <View style={[st.routeRow, { marginBottom: 10, alignItems: 'flex-start' }]}>
              <View style={[st.dot, { backgroundColor: C.brand, marginTop: 3 }]} />
              <View>
                <Text style={st.routeItemLbl}>Départ</Text>
                <Text style={st.routeItemVal}>{ride.pickup_label}</Text>
              </View>
            </View>
          ) : null}
          <View style={[st.routeRow, { alignItems: 'flex-start' }]}>
            <View style={[st.dotSq, { backgroundColor: C.orange, marginTop: 3 }]} />
            <View>
              <Text style={st.routeItemLbl}>Destination</Text>
              <Text style={st.routeItemVal}>{ride.destination_label}</Text>
            </View>
          </View>
        </View>
        {/* Info grid */}
        <View style={st.infoGrid}>
          {([
            { label: 'Prix',      value: fmtAr(ride.estimated_price_ariary) },
            { label: 'Passagers', value: `${ride.passenger_count}` },
            { label: 'Paiement',  value: isCash ? '💵 Espèces' : '💳 Carte' },
          ] as const).map(item => (
            <View key={item.label} style={st.infoCell}>
              <Text style={st.infoCellLbl}>{item.label}</Text>
              <Text style={st.infoCellVal}>{item.value}</Text>
            </View>
          ))}
        </View>
        {/* Actions */}
        {btns.length > 0 && (
          <View style={st.sheetActions}>
            {btns.map(b => (
              <Btn
                key={b.action}
                label={b.label}
                variant={b.variant}
                loading={actionLoading === b.action}
                disabled={!!actionLoading && actionLoading !== b.action}
                onPress={() => b.action === 'otp' ? setOtpOpen(true) : void onAction(ride.id, b.action)}
              />
            ))}
          </View>
        )}
      </ScrollView>
    </View>
  );
}

// ─── BOTTOM NAV ────────────────────────────────────────────────────────────────
function BottomNav({ tab, onTab }: { tab: TabId; onTab: (t: TabId) => void }) {
  const TABS: { id: TabId; icon: string; label: string }[] = [
    { id: 'inbox',   icon: '📋', label: 'Demandes'    },
    { id: 'rides',   icon: '🛺', label: 'Mes courses' },
    { id: 'profile', icon: '👤', label: 'Profil'      },
  ];
  return (
    <View style={st.bottomNav}>
      {TABS.map(t => (
        <Pressable key={t.id} onPress={() => onTab(t.id)} style={st.navItem}>
          <View style={[st.navPill, tab === t.id && st.navPillOn]}>
            <Text style={{ fontSize: 18 }}>{t.icon}</Text>
          </View>
          <Text style={[st.navLbl, tab === t.id && st.navLblOn]}>{t.label}</Text>
        </Pressable>
      ))}
    </View>
  );
}

// ─── INBOX SCREEN ─────────────────────────────────────────────────────────────
function InboxScreen({ driverId }: { driverId: string }) {
  const [rides, setRides]           = useState<OpenRideRow[]>([]);
  const [loading, setLoading]       = useState(true);
  const [listError, setListError]   = useState<string | null>(null);
  const [rtError, setRtError]       = useState<string | null>(null);
  const [subscribed, setSubscribed] = useState(false);
  const [accepting, setAccepting]   = useState<string | null>(null);
  const [actError, setActError]     = useState<string | null>(null);
  const inFlightRef = useRef(false);
  const queuedRef   = useRef(false);
  const timerRef    = useRef<ReturnType<typeof setTimeout> | null>(null);

  const runFetch = useCallback(async () => {
    if (inFlightRef.current) { queuedRef.current = true; return; }
    inFlightRef.current = true;
    setListError(null);
    const { data, error } = await supabase
      .from('rides').select(SELECT_OPEN).eq('status', 'requested').order('created_at', { ascending: false });
    if (error) {
      setListError(error.message || 'Impossible de charger les demandes.');
      setRides([]); setLoading(false); inFlightRef.current = false; return;
    }
    setRides(((data ?? []) as OpenRideRow[]).filter(r => r.id));
    setActError(null); setLoading(false); inFlightRef.current = false;
    if (queuedRef.current) { queuedRef.current = false; void runFetch(); }
  }, []);

  const fetch = useCallback(() => {
    if (timerRef.current) return;
    timerRef.current = setTimeout(() => { timerRef.current = null; void runFetch(); }, 250);
  }, [runFetch]);

  useEffect(() => { fetch(); }, [fetch]);

  // Fallback polling when Realtime unavailable
  useEffect(() => {
    if (subscribed) return;
    const id = setInterval(() => fetch(), 4000);
    return () => clearInterval(id);
  }, [fetch, subscribed]);

  useEffect(() => {
    const sub = AppState.addEventListener('change', s => { if (s === 'active') fetch(); });
    return () => sub.remove();
  }, [fetch]);

  useEffect(() => {
    let cancelled = false;
    let channel: ReturnType<typeof supabase.channel> | null = null;
    void (async () => {
      const ok = await syncRealtimeAuth();
      if (cancelled) return;
      if (!ok) { setRtError('Session introuvable. Reconnectez-vous.'); return; }
      channel = supabase.channel('driver-inbox-v2')
        .on('postgres_changes', { event: '*', schema: 'public', table: 'rides' }, () => fetch())
        .subscribe((status, err) => {
          if (status === 'SUBSCRIBED') { setRtError(null); setSubscribed(true); return; }
          if (status === 'CHANNEL_ERROR' || status === 'TIMED_OUT') {
            setRtError(err?.message?.trim() || 'Temps réel indisponible — mode polling actif (30s).');
            setSubscribed(false); fetch();
          }
        });
    })();
    return () => {
      cancelled = true; setSubscribed(false);
      if (timerRef.current) { clearTimeout(timerRef.current); timerRef.current = null; }
      if (channel) void supabase.removeChannel(channel);
    };
  }, [fetch]);

  async function handleAccept(rideId: string) {
    if (accepting) return;
    setActError(null); setAccepting(rideId);
    const { error } = await supabase.rpc('accept_ride_as_driver', { p_ride_id: rideId });
    setAccepting(null);
    if (error) {
      const raw = error.message ?? '';
      if      (raw.includes('ACCEPT_RIDE_NOT_REQUESTED')) setActError('Cette course n\u2019est plus disponible.');
      else if (raw.includes('ACCEPT_RIDE_NOT_DRIVER'))    setActError('Compte non autorisé.');
      else if (raw.includes('ACCEPT_RIDE_OWN_RIDE'))      setActError('Vous ne pouvez pas accepter votre propre demande.');
      else                                                 setActError(raw.trim() || 'Impossible d\u2019accepter.');
      void fetch(); return;
    }
    void notifyRideEvent({ event: 'ride_accepted', rideId });
    void fetch();
  }

  return (
    <ScrollView style={{ flex: 1 }} contentContainerStyle={st.screenPad} showsVerticalScrollIndicator={false}>
      <View style={st.screenHdr}>
        <View>
          <Text style={st.screenTitle}>Demandes ouvertes</Text>
          <Text style={st.screenSub}>Mise à jour en temps réel</Text>
        </View>
        <View style={st.rtDot}>
          <View style={[st.dot, { backgroundColor: rtError ? C.red : C.green }]} />
          <Text style={[st.rtLbl, { color: rtError ? C.red : C.green }]}>
            {rtError ? 'Hors ligne' : 'En ligne'}
          </Text>
        </View>
      </View>
      {rtError  && <ErrorBanner message={rtError} />}
      {actError && <ErrorBanner message={actError} />}
      {loading && (
        <View style={{ gap: 10 }}>
          <View style={st.skel} /><View style={st.skel} />
        </View>
      )}
      {!loading && listError && <ErrorBanner message={listError} onRetry={() => void runFetch()} />}
      {!loading && !listError && rides.length === 0 && (
        <EmptyState
          icon="🛺"
          title="Aucune demande pour l'instant"
          sub="Les nouvelles courses apparaîtront ici automatiquement."
        />
      )}
      {!loading && !listError && rides.map(r => (
        <RequestCard key={r.id} ride={r} onAccept={handleAccept} accepting={accepting} />
      ))}
    </ScrollView>
  );
}

// ─── MY RIDES SCREEN ──────────────────────────────────────────────────────────
function MyRidesScreen({ driverId, onDetail }: { driverId: string; onDetail: (r: AssignedRideRow) => void }) {
  const [rides, setRides]         = useState<AssignedRideRow[]>([]);
  const [loading, setLoading]     = useState(true);
  const [listError, setListError] = useState<string | null>(null);
  const [rtError, setRtError]     = useState<string | null>(null);
  const inFlightRef = useRef(false);
  const queuedRef   = useRef(false);
  const timerRef    = useRef<ReturnType<typeof setTimeout> | null>(null);

  const runFetch = useCallback(async () => {
    if (inFlightRef.current) { queuedRef.current = true; return; }
    if (!driverId.trim()) { setRides([]); setLoading(false); return; }
    inFlightRef.current = true;
    setListError(null);
    const { data, error } = await supabase
      .from('rides').select(SELECT_ASSIGNED).eq('driver_id', driverId)
      .in('status', ['awaiting_payment','paid','en_route','arrived','expired','in_progress','completed','cancelled_by_client'])
      .order('updated_at', { ascending: false });
    if (error) {
      setListError(error.message || 'Impossible de charger vos courses.');
      setRides([]); setLoading(false); inFlightRef.current = false; return;
    }
    setRides(((data ?? []) as AssignedRideRow[]).filter(r => r.id));
    setLoading(false); inFlightRef.current = false;
    if (queuedRef.current) { queuedRef.current = false; void runFetch(); }
  }, [driverId]);

  const fetch = useCallback(() => {
    if (timerRef.current) return;
    timerRef.current = setTimeout(() => { timerRef.current = null; void runFetch(); }, 250);
  }, [runFetch]);

  useEffect(() => { fetch(); }, [fetch]);
  useEffect(() => {
    const sub = AppState.addEventListener('change', s => { if (s === 'active') fetch(); });
    return () => sub.remove();
  }, [fetch]);

  const rideForTracking = useMemo(
    () => rides.find(r => r.status === 'paid' || r.status === 'en_route' || r.status === 'arrived') ?? null,
    [rides],
  );
  useDriverLiveLocation({ rideId: rideForTracking?.id ?? null, rideStatus: rideForTracking?.status ?? null });

  useEffect(() => {
    let cancelled = false;
    let channel: ReturnType<typeof supabase.channel> | null = null;
    void (async () => {
      const ok = await syncRealtimeAuth();
      if (cancelled) return;
      if (!ok) { setRtError('Session introuvable. Reconnectez-vous.'); return; }
      channel = supabase.channel('driver-rides-v2')
        .on('postgres_changes', { event: '*', schema: 'public', table: 'rides' }, () => fetch())
        .subscribe((status, err) => {
          if (status === 'SUBSCRIBED') { setRtError(null); return; }
          if (status === 'CHANNEL_ERROR' || status === 'TIMED_OUT') {
            setRtError(err?.message?.trim() || 'Temps réel indisponible.');
            fetch();
          }
        });
    })();
    return () => {
      cancelled = true;
      if (timerRef.current) { clearTimeout(timerRef.current); timerRef.current = null; }
      if (channel) void supabase.removeChannel(channel);
    };
  }, [fetch]);

  const active  = rides.filter(r => !TERMINAL.has(r.status));
  const history = rides.filter(r =>  TERMINAL.has(r.status));

  return (
    <ScrollView style={{ flex: 1 }} contentContainerStyle={st.screenPad} showsVerticalScrollIndicator={false}>
      <Text style={[st.screenTitle, { marginBottom: 14 }]}>Mes courses</Text>
      {rtError   && <ErrorBanner message={rtError}   />}
      {listError && <ErrorBanner message={listError} onRetry={() => void runFetch()} />}
      {loading && (
        <View style={{ gap: 10 }}>
          <View style={[st.skel, { height: 90 }]} /><View style={[st.skel, { height: 90 }]} />
        </View>
      )}
      {!loading && !listError && rides.length === 0 && (
        <EmptyState
          icon="🏁"
          title="Aucune course assignée"
          sub="Acceptez une demande dans l'onglet Demandes pour la voir apparaître ici."
        />
      )}
      {!loading && !listError && rides.length > 0 && (
        <>
          {active.length > 0 && (
            <>
              <Text style={st.sectionLbl}>EN COURS</Text>
              {active.map(r => <AssignedCard key={r.id} ride={r} onPress={onDetail} />)}
            </>
          )}
          {history.length > 0 && (
            <>
              <Text style={[st.sectionLbl, { marginTop: 14 }]}>HISTORIQUE</Text>
              {history.map(r => <AssignedCard key={r.id} ride={r} onPress={onDetail} />)}
            </>
          )}
        </>
      )}
    </ScrollView>
  );
}

// ─── PROFILE SCREEN ────────────────────────────────────────────────────────────
function ProfileScreen({ profile, onDevResetRole }: { profile: Profile; onDevResetRole: () => Promise<void> }) {
  const [online, setOnline]       = useState(true);
  const [signingOut, setSigningOut] = useState(false);

  async function handleSignOut() {
    setSigningOut(true);
    await supabase.auth.signOut();
    setSigningOut(false);
  }

  return (
    <ScrollView style={{ flex: 1 }} contentContainerStyle={st.screenPad} showsVerticalScrollIndicator={false}>
      <Text style={[st.screenTitle, { marginBottom: 16 }]}>Mon profil</Text>
      {/* Avatar */}
      <View style={[st.card, st.profileCard]}>
        <View style={st.avatar}>
          <Text style={{ fontSize: 22 }}>🧑</Text>
        </View>
        <View>
          <Text style={st.profileName}>{profile.full_name ?? 'Chauffeur'}</Text>
          <Text style={st.profileSub}>Tuk-tuk{profile.phone ? ` • ${profile.phone}` : ''}</Text>
          <View style={{ marginTop: 4 }}>
            <Pill label={online ? '● Disponible' : '● Hors ligne'} color={online ? C.green : C.textSec} />
          </View>
        </View>
      </View>
      {/* Toggle */}
      <View style={[st.card, { marginBottom: 12 }]}>
        <Text style={st.toggleSecLbl}>Disponibilité</Text>
        <View style={st.toggleRow}>
          <Text style={st.toggleTxt}>Accepter des courses</Text>
          <Pressable onPress={() => setOnline(o => !o)} style={[st.toggle, online && st.toggleOn]}>
            <View style={[st.toggleThumb, online && st.toggleThumbOn]} />
          </Pressable>
        </View>
      </View>
      <Btn label={signingOut ? 'Déconnexion…' : 'Se déconnecter'} variant="ghost" onPress={handleSignOut} loading={signingOut} />
      {__DEV__ && (
        <View style={{ marginTop: 12 }}>
          <Btn label="[DEV] Réinitialiser le rôle" variant="dangerOutline" onPress={onDevResetRole} />
        </View>
      )}
    </ScrollView>
  );
}

// ─── MAIN ─────────────────────────────────────────────────────────────────────
export function DriverHomeScreen({ session, profile, onDevResetRole }: Props) {
  const [tab, setTab]               = useState<TabId>('inbox');
  const [detailRide, setDetailRide] = useState<AssignedRideRow | null>(null);
  const [actionLd, setActionLd]     = useState<string | null>(null);

  const handleTabChange = (t: TabId) => { setTab(t); setDetailRide(null); };

  async function handleRideAction(rideId: string, action: string) {
    const otpMatch = action.match(/^otp:(.+)$/);
    if (otpMatch) {
      setActionLd('otp');
      try {
        await rpcCompleteRideWithOtp(rideId, otpMatch[1]);
        setDetailRide(null);
      } catch (e) {
        throw e instanceof DriverRideProgressError ? e : new Error(e instanceof Error ? e.message : 'Action impossible.');
      } finally { setActionLd(null); }
      return;
    }
    setActionLd(action);
    try {
      if      (action === 'en_route')    { await rpcStartEnRoute(rideId); }
      else if (action === 'arrived')     { await rpcMarkArrived(rideId); void notifyRideEvent({ event: 'driver_arrived', rideId }); }
      else if (action === 'in_progress') { await rpcStartRide(rideId); }
      else if (action === 'release')     { await driverReleaseRideBeforePayment(rideId); setDetailRide(null); }
      // Optimistic UI update
      const next: Record<string, string> = { en_route: 'en_route', arrived: 'arrived', in_progress: 'in_progress' };
      if (next[action] && detailRide?.id === rideId) {
        setDetailRide(r => r ? { ...r, status: next[action] } : r);
      }
    } catch (e) {
      throw e instanceof DriverRideProgressError || e instanceof DriverReleaseRideError
        ? e : new Error(e instanceof Error ? e.message : 'Action impossible.');
    } finally { setActionLd(null); }
  }

  return (
    <SafeAreaView style={st.root}>
      <StatusBar barStyle="light-content" backgroundColor={C.brand} />
      {/* Top bar */}
      <View style={st.topBar}>
        <Text style={st.topTitle}>TukMe</Text>
        <Text style={st.topSub}>Chauffeur</Text>
      </View>
      {/* Screens */}
      <View style={{ flex: 1 }}>
        {tab === 'inbox'   && <InboxScreen   driverId={session.user.id} />}
        {tab === 'rides'   && <MyRidesScreen driverId={session.user.id} onDetail={setDetailRide} />}
        {tab === 'profile' && <ProfileScreen profile={profile} onDevResetRole={onDevResetRole} />}
      </View>
      <BottomNav tab={tab} onTab={handleTabChange} />
      {/* Sheet overlay */}
      {detailRide && (
        <>
          <TouchableWithoutFeedback onPress={() => setDetailRide(null)}>
            <View style={st.overlay} />
          </TouchableWithoutFeedback>
          <RideDetailSheet
            ride={detailRide}
            onClose={() => setDetailRide(null)}
            onAction={handleRideAction}
            actionLoading={actionLd}
          />
        </>
      )}
    </SafeAreaView>
  );
}

// ─── STYLES ───────────────────────────────────────────────────────────────────
const st = StyleSheet.create({
  // Root
  root:    { flex: 1, backgroundColor: C.bg },
  topBar:  { backgroundColor: C.brand, paddingHorizontal: 16, paddingVertical: 10, flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  topTitle:{ fontSize: 15, fontWeight: '800', color: '#fff', letterSpacing: 0.4 },
  topSub:  { fontSize: 12, color: 'rgba(255,255,255,0.8)', fontWeight: '500' },
  // Screen
  screenPad:  { padding: 16, paddingBottom: 24 },
  screenHdr:  { flexDirection: 'row', alignItems: 'flex-start', justifyContent: 'space-between', marginBottom: 14 },
  screenTitle:{ fontSize: 18, fontWeight: '800', color: C.text },
  screenSub:  { fontSize: 12, color: C.textSec, marginTop: 2 },
  rtDot:      { flexDirection: 'row', alignItems: 'center', gap: 6 },
  rtLbl:      { fontSize: 11, fontWeight: '600' },
  sectionLbl: { fontSize: 11, fontWeight: '700', color: C.textTer, letterSpacing: 0.6, textTransform: 'uppercase', marginBottom: 8 },
  skel:       { height: 100, backgroundColor: '#f1f5f9', borderRadius: 16 },
  // Cards
  card:       { backgroundColor: C.surface, borderRadius: 16, padding: 14, marginBottom: 10, borderWidth: 1, borderColor: C.border, shadowColor: '#000', shadowOpacity: 0.04, shadowRadius: 6, shadowOffset: { width: 0, height: 1 }, elevation: 1 },
  assignedCard: { borderLeftWidth: 3 },
  profileCard:  { flexDirection: 'row', alignItems: 'center', gap: 14 },
  cardRow:    { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: 10 },
  cardFoot:   { flexDirection: 'row', alignItems: 'center', gap: 6 },
  priceCol:   { alignItems: 'flex-end', flexShrink: 0, marginLeft: 12 },
  price:      { fontSize: 15, fontWeight: '700', color: C.brand },
  age:        { fontSize: 11, color: C.textTer, marginTop: 1 },
  assignedStat: { fontSize: 12, fontWeight: '600', marginTop: 4 },
  // Route
  routeRow:  { flexDirection: 'row', alignItems: 'center', gap: 6, marginBottom: 5 },
  routeLbl:  { fontSize: 12, color: C.textSec, lineHeight: 18, flex: 1 },
  routeMain: { fontSize: 14, color: C.text, fontWeight: '600', lineHeight: 20, flex: 1 },
  dot:   { width: 8, height: 8, borderRadius: 4, flexShrink: 0 },
  dotSq: { width: 8, height: 8, borderRadius: 2, flexShrink: 0 },
  // Pill
  pill:   { borderRadius: 100, paddingVertical: 3, paddingHorizontal: 10, alignSelf: 'flex-start' },
  pillTxt:{ fontSize: 11, fontWeight: '600', letterSpacing: 0.2 },
  // Btn
  btn:     { width: '100%', paddingVertical: 14, paddingHorizontal: 20, borderRadius: 100, alignItems: 'center', justifyContent: 'center', flexDirection: 'row' },
  btnSm:   { width: 'auto', paddingVertical: 9, paddingHorizontal: 20 },
  btnTxt:  { fontSize: 15, fontWeight: '700', letterSpacing: 0.1 },
  btnTxtSm:{ fontSize: 13 },
  // Empty
  emptyWrap: { alignItems: 'center', justifyContent: 'center', paddingVertical: 40, paddingHorizontal: 24 },
  emptyIcon: { fontSize: 40, marginBottom: 16 },
  emptyTitle:{ fontSize: 15, fontWeight: '700', color: C.text, marginBottom: 6, textAlign: 'center' },
  emptySub:  { fontSize: 13, color: C.textSec, lineHeight: 19, textAlign: 'center', marginBottom: 20 },
  // Error banner
  errBanner: { backgroundColor: C.redLight, borderWidth: 1, borderColor: C.red + '30', borderRadius: 12, padding: 12, marginBottom: 12, flexDirection: 'row', alignItems: 'center', gap: 10 },
  errTitle:  { fontSize: 12, fontWeight: '700', color: C.red, marginBottom: 2 },
  errMsg:    { fontSize: 11, color: C.textSec },
  errBtn:    { backgroundColor: C.red, borderRadius: 8, paddingVertical: 6, paddingHorizontal: 12 },
  errBtnTxt: { color: '#fff', fontSize: 11, fontWeight: '700' },
  // Bottom nav
  bottomNav: { flexDirection: 'row', backgroundColor: C.surface, borderTopWidth: 1, borderTopColor: C.border, paddingBottom: Platform.OS === 'ios' ? 0 : 4 },
  navItem:   { flex: 1, alignItems: 'center', paddingVertical: 8, paddingHorizontal: 4 },
  navPill:   { width: 48, height: 32, borderRadius: 100, alignItems: 'center', justifyContent: 'center' },
  navPillOn: { backgroundColor: C.brandLight },
  navLbl:    { fontSize: 10, color: C.textSec, marginTop: 2 },
  navLblOn:  { color: C.brand, fontWeight: '700' },
  // Overlay + sheet
  overlay: { position: 'absolute', top: 0, left: 0, right: 0, bottom: 0, backgroundColor: 'rgba(0,0,0,0.3)', zIndex: 90 },
  sheet:   { position: 'absolute', bottom: 0, left: 0, right: 0, backgroundColor: C.surface, borderTopLeftRadius: 20, borderTopRightRadius: 20, shadowColor: '#000', shadowOpacity: 0.15, shadowRadius: 30, shadowOffset: { width: 0, height: -4 }, elevation: 20, maxHeight: '82%', zIndex: 100 },
  dragHandle: { width: 36, height: 4, backgroundColor: '#cbd5e1', borderRadius: 2, alignSelf: 'center', marginTop: 8, marginBottom: 4 },
  sheetTitle: { fontSize: 16, fontWeight: '700', color: C.text, flex: 1 },
  closeBtn:   { width: 28, height: 28, borderRadius: 14, backgroundColor: '#f1f5f9', alignItems: 'center', justifyContent: 'center' },
  backBtn:    { width: 32, height: 32, borderRadius: 16, backgroundColor: '#f1f5f9', alignItems: 'center', justifyContent: 'center', marginRight: 10 },
  // Sheet internals
  statusBanner:   { marginHorizontal: 16, marginBottom: 14, padding: 12, borderRadius: 12, borderWidth: 1, flexDirection: 'row', alignItems: 'center' },
  statusBannerTxt:{ fontSize: 13, fontWeight: '700' },
  routeBlock:     { marginHorizontal: 16, marginBottom: 14, padding: 14, backgroundColor: '#f8fafc', borderRadius: 12, borderWidth: 1, borderColor: C.border },
  routeItemLbl:   { fontSize: 10, color: C.textSec, fontWeight: '600', textTransform: 'uppercase', letterSpacing: 0.5 },
  routeItemVal:   { fontSize: 13, color: C.text, fontWeight: '500', marginTop: 1 },
  infoGrid:       { marginHorizontal: 16, marginBottom: 16, flexDirection: 'row', gap: 8 },
  infoCell:       { flex: 1, backgroundColor: '#f8fafc', borderRadius: 10, padding: 10, alignItems: 'center', borderWidth: 1, borderColor: C.border },
  infoCellLbl:    { fontSize: 10, color: C.textTer, marginBottom: 3 },
  infoCellVal:    { fontSize: 13, fontWeight: '700', color: C.text },
  sheetActions:   { paddingHorizontal: 16, paddingBottom: 20, gap: 8 },
  // OTP
  otpInstr:   { fontSize: 13, color: C.textSec, lineHeight: 20, marginBottom: 24 },
  otpRow:     { flexDirection: 'row', gap: 12, justifyContent: 'center', marginBottom: 24 },
  otpBox:     { width: 56, height: 64, textAlign: 'center', fontSize: 28, fontWeight: '700', borderWidth: 2, borderColor: C.border, borderRadius: 14, backgroundColor: '#f8fafc', color: C.text },
  inlineErr:  { backgroundColor: C.redLight, borderWidth: 1, borderColor: C.red + '30', borderRadius: 10, padding: 10, marginBottom: 16 },
  inlineErrTxt: { fontSize: 13, color: C.red, fontWeight: '500' },
  successBlock:   { alignItems: 'center', paddingVertical: 20 },
  successIcon:    { width: 64, height: 64, backgroundColor: C.greenLight, borderRadius: 32, alignItems: 'center', justifyContent: 'center', marginBottom: 16 },
  successTitle:   { fontSize: 20, fontWeight: '700', color: C.text, marginBottom: 8 },
  successSub:     { fontSize: 14, color: C.textSec, textAlign: 'center', lineHeight: 22, marginBottom: 24 },
  successAmt:     { backgroundColor: C.greenLight, borderRadius: 12, padding: 12, width: '100%', alignItems: 'center', marginBottom: 24, borderWidth: 1, borderColor: C.green + '30' },
  successAmtVal:  { fontSize: 22, fontWeight: '800', color: C.green },
  successAmtDest: { fontSize: 12, color: C.textSec, marginTop: 2 },
  // Profile
  avatar:        { width: 52, height: 52, borderRadius: 26, backgroundColor: C.brandLight, alignItems: 'center', justifyContent: 'center' },
  profileName:   { fontSize: 15, fontWeight: '700', color: C.text },
  profileSub:    { fontSize: 12, color: C.textSec },
  toggleSecLbl:  { fontSize: 12, color: C.textSec, fontWeight: '600', marginBottom: 12 },
  toggleRow:     { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  toggleTxt:     { fontSize: 14, color: C.text },
  toggle:        { width: 48, height: 26, borderRadius: 13, backgroundColor: '#cbd5e1' },
  toggleOn:      { backgroundColor: C.brand },
  toggleThumb:   { position: 'absolute', top: 3, left: 3, width: 20, height: 20, borderRadius: 10, backgroundColor: '#fff', shadowColor: '#000', shadowOpacity: 0.2, shadowRadius: 4, shadowOffset: { width: 0, height: 1 }, elevation: 2 },
  toggleThumbOn: { left: 25 },
});
