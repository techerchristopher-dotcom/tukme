import type { Session } from '@supabase/supabase-js';
import * as Location from 'expo-location';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { ClientMapBlock } from './ClientMapBlock';
import {
  ClientStripeRoot,
  useClientStripeSheet,
} from './ClientHomeStripeBridge';
import {
  type ReactNode,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import {
  ActivityIndicator,
  Keyboard,
  Modal,
  Platform,
  Pressable,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';
import { SignedInShell } from '../components/SignedInShell';
import {
  type ClientLocationState,
  useClientLocation,
} from '../hooks/useClientLocation';
import {
  type PlaceSuggestionItem,
  usePlacesSuggestions,
} from '../hooks/usePlacesSuggestions';
import {
  fetchPlaceDetails,
  isPlacesConfigured,
  newSessionToken,
} from '../lib/googlePlaces';
import { useRideZonePricing } from '../hooks/useRideZonePricing';
import { useRouteMetrics } from '../hooks/useRouteMetrics';
import {
  cancelRideAsClient,
  CancelRideError,
} from '../lib/cancelRide';
import { invokeCreatePaymentIntent } from '../lib/createPaymentIntent';
import { insertRequestedRide } from '../lib/createRide';
import { notifyRideEvent } from '../lib/pushNotifications';
import { syncRidePaymentExpiryIfDue } from '../lib/syncRidePaymentExpiry';
import { useActiveRide } from '../hooks/useActiveRide';
import { formatAriary } from '../lib/taxiPricing';
import { supabase } from '../lib/supabase';
import type { ClientRideStatus } from '../types/clientRide';
import type { ClientDestination } from '../types/clientDestination';
import type { RidePricingEstimate } from '../types/ridePricing';
import type { Profile } from '../types/profile';
import { ClientRideHistoryScreen } from './ClientRideHistoryScreen';

const RIDE_RT_LOG = '[ride-realtime]';

type Props = {
  session: Session;
  profile: Profile;
  onDevResetRole: () => Promise<void>;
};

/** Retour 3DS / wallets — aligné sur app.json expo.scheme */
const STRIPE_RETURN_URL = 'tukme://stripe-redirect';

function clientRideStatusMessage(status: ClientRideStatus): string {
  switch (status) {
    case 'requested':
      return 'Demande envoyée — recherche d’un chauffeur.';
    case 'awaiting_payment':
      return 'Chauffeur trouvé — paiement requis.';
    case 'paid':
      return 'Chauffeur prêt.';
    case 'en_route':
      return 'Chauffeur en route.';
    case 'arrived':
      return 'Chauffeur arrivé.';
    case 'in_progress':
      return 'Course en cours.';
    case 'completed':
      return 'Course terminée.';
    case 'cancelled_by_client':
      return 'Course annulée.';
    case 'cancelled_by_driver':
      return 'Course annulée par le chauffeur.';
    case 'expired':
      return 'Paiement expiré.';
    default:
      return 'État de la course mis à jour.';
  }
}

function parseIsoMs(iso: string | null | undefined): number | null {
  if (!iso) {
    return null;
  }
  const ms = Date.parse(iso);
  return Number.isFinite(ms) ? ms : null;
}

async function fetchRideOtpForClient(rideId: string): Promise<string> {
  const { data, error } = await supabase.rpc('get_ride_otp_for_client', {
    p_ride_id: rideId,
  });
  if (error) {
    throw error;
  }
  const otp = typeof data === 'string' ? data.trim() : '';
  if (!otp) {
    throw new Error('OTP manquant');
  }
  return otp;
}

function otpStorageKey(rideId: string): string {
  return `ride:otp:${rideId}`;
}

function formatCurrentPositionText(location: ClientLocationState): string {
  if (location.phase === 'loading') {
    return 'Recherche en cours…';
  }
  if (location.phase === 'denied' || location.phase === 'error') {
    return 'Non disponible';
  }
  return `${location.latitude.toFixed(5)}, ${location.longitude.toFixed(5)}`;
}

function TripSummaryCard(props: {
  location: ClientLocationState;
  pickupMode?: 'gps' | 'manual';
  pickup: ClientDestination | null;
  destination: ClientDestination | null;
}) {
  const { location, pickupMode, pickup, destination } = props;
  const positionLine = formatCurrentPositionText(location);

  const pickupBlock = pickup ? (
    <>
      <Text style={styles.summaryValue}>{pickup.label}</Text>
      <Text style={styles.summaryCoords}>
        {pickup.latitude.toFixed(5)}, {pickup.longitude.toFixed(5)}
      </Text>
      {pickupMode === 'manual' ? (
        <Text style={styles.summaryHint}>Départ choisi manuellement</Text>
      ) : null}
    </>
  ) : (
    <Text style={styles.summaryValue}>
      {pickupMode === 'manual'
        ? 'Choisissez un point de départ.'
        : 'Position en cours…'}
    </Text>
  );

  let destinationBlock: ReactNode;
  if (!destination) {
    destinationBlock = (
      <Text style={styles.summaryValue}>
        Aucune destination choisie pour le moment.
      </Text>
    );
  } else {
    destinationBlock = (
      <>
        <Text style={styles.summaryValue}>{destination.label}</Text>
        <Text style={styles.summaryCoords}>
          {destination.latitude.toFixed(5)}, {destination.longitude.toFixed(5)}
        </Text>
      </>
    );
  }

  return (
    <View style={styles.summaryCard}>
      <Text style={styles.summaryTitle}>Votre trajet</Text>
      <Text style={styles.summaryLabel}>Position actuelle</Text>
      <Text style={styles.summaryValue}>{positionLine}</Text>
      <Text style={[styles.summaryLabel, styles.summaryLabelSpaced]}>
        Départ
      </Text>
      {pickupBlock}
      <Text style={[styles.summaryLabel, styles.summaryLabelSpaced]}>
        Destination
      </Text>
      {destinationBlock}
    </View>
  );
}

function ZonePricingCard(props: {
  estimate: RidePricingEstimate | null;
  hasDestination: boolean;
}) {
  const { estimate, hasDestination } = props;

  if (!hasDestination) {
    return null;
  }

  if (!estimate) {
    return null;
  }

  const {
    pickupZone,
    destinationZone,
    estimatedPriceAriary,
    estimatedPriceEuro,
    pricingMode,
  } = estimate;

  return (
    <View style={styles.pricingCard}>
      <Text style={styles.pricingTitle}>Estimation Nosy Be (zones)</Text>
      <Text style={styles.pricingLine}>
        <Text style={styles.pricingLabel}>Zone départ : </Text>
        <Text style={styles.pricingValue}>
          {pickupZone ?? '—'}
        </Text>
      </Text>
      <Text style={styles.pricingLine}>
        <Text style={styles.pricingLabel}>Zone destination : </Text>
        <Text style={styles.pricingValue}>
          {destinationZone ?? '—'}
        </Text>
      </Text>
      {pricingMode === 'fallback' ? (
        <Text style={styles.pricingFallbackHint}>
          Tarif indicatif : zone non couverte par les boîtes GPS, ou trajet non
          défini dans Supabase (prix forfaitaire).
        </Text>
      ) : null}
      {pricingMode === 'loading' ? (
        <View style={styles.pricingLoadingRow}>
          <ActivityIndicator size="small" color="#0f766e" />
          <Text style={styles.pricingLoadingText}>Chargement du tarif…</Text>
        </View>
      ) : (
        <View style={styles.pricingAmountBlock}>
          <Text style={styles.pricingEuroMain}>
            €{Math.round(estimatedPriceEuro)}
          </Text>
          <Text style={styles.pricingAriarySub}>
            ({formatAriary(estimatedPriceAriary)} Ar)
          </Text>
        </View>
      )}
    </View>
  );
}

function PlacesDestinationSection(props: {
  location: ClientLocationState;
  searchInput: string;
  onSearchChange: (value: string) => void;
  suggestionsSuspended: boolean;
  sessionToken: string;
  onPickSuggestion: (item: PlaceSuggestionItem) => void;
  pickingPlace: boolean;
  configError: string | null;
  detailsError: string | null;
}) {
  const {
    location,
    searchInput,
    onSearchChange,
    suggestionsSuspended,
    sessionToken,
    onPickSuggestion,
    pickingPlace,
    configError,
    detailsError,
  } = props;

  const biasLat =
    location.phase === 'ready' ? location.latitude : null;
  const biasLng =
    location.phase === 'ready' ? location.longitude : null;

  const { suggestions, loading, error } = usePlacesSuggestions({
    query: searchInput,
    sessionToken,
    biasLat,
    biasLng,
    suspended: suggestionsSuspended,
  });

  const showSuggestions =
    !suggestionsSuspended && suggestions.length > 0 && !pickingPlace;

  return (
    <View style={styles.destinationBlock}>
      <Text style={styles.destinationTitle}>Où allez-vous ?</Text>
      <Text style={styles.destinationHint}>
        Recherche Google Places, priorisée autour de votre position. Choisissez
        une suggestion pour fixer la destination sur la carte.
      </Text>

      {configError ? (
        <Text style={styles.geocodeError}>{configError}</Text>
      ) : null}

      {location.phase !== 'ready' ? (
        <Text style={styles.positionWait}>
          Localisation en cours… Les suggestions seront moins précises jusqu’à
          ce que votre position soit connue.
        </Text>
      ) : null}

      <TextInput
        style={styles.destinationInput}
        value={searchInput}
        onChangeText={onSearchChange}
        placeholder="Adresse, lieu, arrêt…"
        placeholderTextColor="#94a3b8"
        returnKeyType="search"
        autoCorrect={false}
        autoCapitalize="none"
        editable={!pickingPlace && !configError}
      />

      {loading ? (
        <View style={styles.suggestLoading}>
          <ActivityIndicator size="small" color="#0f766e" />
          <Text style={styles.suggestLoadingText}>Recherche…</Text>
        </View>
      ) : null}

      {error ? <Text style={styles.geocodeError}>{error}</Text> : null}

      {detailsError ? (
        <Text style={styles.geocodeError}>{detailsError}</Text>
      ) : null}

      {showSuggestions ? (
        <View style={styles.suggestionsBox}>
          {suggestions.map((item) => (
            <Pressable
              key={item.placeId}
              style={({ pressed }) => [
                styles.suggestionRow,
                pressed && styles.suggestionRowPressed,
              ]}
              onPress={() => onPickSuggestion(item)}
            >
              <Text style={styles.suggestionPrimary}>{item.primaryText}</Text>
              {item.secondaryText ? (
                <Text style={styles.suggestionSecondary}>
                  {item.secondaryText}
                </Text>
              ) : null}
            </Pressable>
          ))}
        </View>
      ) : null}

      {pickingPlace ? (
        <View style={styles.pickingRow}>
          <ActivityIndicator size="small" color="#0f766e" />
          <Text style={styles.pickingText}>Récupération du lieu…</Text>
        </View>
      ) : null}
    </View>
  );
}

function PlacesPickupSection(props: {
  location: ClientLocationState;
  searchInput: string;
  onSearchChange: (value: string) => void;
  suggestionsSuspended: boolean;
  sessionToken: string;
  onPickSuggestion: (item: PlaceSuggestionItem) => void;
  pickingPlace: boolean;
  configError: string | null;
  detailsError: string | null;
  onUseGpsPress: () => void;
}) {
  const {
    location,
    searchInput,
    onSearchChange,
    suggestionsSuspended,
    sessionToken,
    onPickSuggestion,
    pickingPlace,
    configError,
    detailsError,
    onUseGpsPress,
  } = props;

  const biasLat = location.phase === 'ready' ? location.latitude : null;
  const biasLng = location.phase === 'ready' ? location.longitude : null;

  const { suggestions, loading, error } = usePlacesSuggestions({
    query: searchInput,
    sessionToken,
    biasLat,
    biasLng,
    suspended: suggestionsSuspended,
  });

  const showSuggestions =
    !suggestionsSuspended && suggestions.length > 0 && !pickingPlace;

  return (
    <View style={styles.destinationBlock}>
      <Text style={styles.destinationTitle}>Point de départ</Text>
      <Text style={styles.destinationHint}>
        Par défaut, Tukme utilise votre position actuelle. Vous pouvez choisir un
        autre point de récupération via Google Places.
      </Text>

      <Pressable
        style={({ pressed }) => [
          styles.pickupGpsButton,
          pressed && styles.pickupGpsButtonPressed,
        ]}
        onPress={onUseGpsPress}
      >
        <Text style={styles.pickupGpsButtonText}>Utiliser ma position actuelle</Text>
      </Pressable>

      {configError ? <Text style={styles.geocodeError}>{configError}</Text> : null}

      <TextInput
        style={styles.destinationInput}
        value={searchInput}
        onChangeText={onSearchChange}
        placeholder="Chercher un point de départ…"
        placeholderTextColor="#94a3b8"
        returnKeyType="search"
        autoCorrect={false}
        autoCapitalize="none"
        editable={!pickingPlace && !configError}
      />

      {loading ? (
        <View style={styles.suggestLoading}>
          <ActivityIndicator size="small" color="#0f766e" />
          <Text style={styles.suggestLoadingText}>Recherche…</Text>
        </View>
      ) : null}

      {error ? <Text style={styles.geocodeError}>{error}</Text> : null}

      {detailsError ? <Text style={styles.geocodeError}>{detailsError}</Text> : null}

      {showSuggestions ? (
        <View style={styles.suggestionsBox}>
          {suggestions.map((item) => (
            <Pressable
              key={item.placeId}
              style={({ pressed }) => [
                styles.suggestionRow,
                pressed && styles.suggestionRowPressed,
              ]}
              onPress={() => onPickSuggestion(item)}
            >
              <Text style={styles.suggestionPrimary}>{item.primaryText}</Text>
              {item.secondaryText ? (
                <Text style={styles.suggestionSecondary}>{item.secondaryText}</Text>
              ) : null}
            </Pressable>
          ))}
        </View>
      ) : null}

      {pickingPlace ? (
        <View style={styles.pickingRow}>
          <ActivityIndicator size="small" color="#0f766e" />
          <Text style={styles.pickingText}>Récupération du lieu…</Text>
        </View>
      ) : null}
    </View>
  );
}

function ClientHomeMiddleContent(props: {
  userId: string;
  stripePublishableConfigured: boolean;
}) {
  const { userId, stripePublishableConfigured } = props;
  const [view, setView] = useState<'home' | 'history'>('home');
  const { initPaymentSheet, presentPaymentSheet } = useClientStripeSheet();
  const {
    ride,
    fetchLoading: rideFetchLoading,
    fetchError: rideFetchError,
    realtimeError: rideRealtimeError,
    hasOpenRide,
    registerRideAfterCreate,
    dismissRide,
    refetchOpenRide,
  } = useActiveRide(userId);

  useEffect(() => {
    if (ride && view === 'history') {
      setView('home');
    }
  }, [ride, view]);
  const location = useClientLocation();
  const [searchInput, setSearchInput] = useState('');
  const [structuredDestination, setStructuredDestination] =
    useState<ClientDestination | null>(null);
  const [pickupMode, setPickupMode] = useState<'gps' | 'manual'>('gps');
  const [pickupSearchInput, setPickupSearchInput] = useState('');
  const [structuredPickup, setStructuredPickup] =
    useState<ClientDestination | null>(null);
  const [pickupSuggestionsSuspended, setPickupSuggestionsSuspended] =
    useState(false);
  const [pickupPickingPlace, setPickupPickingPlace] = useState(false);
  const [pickupSessionToken, setPickupSessionToken] = useState(newSessionToken);
  const [pickupDetailsError, setPickupDetailsError] = useState<string | null>(
    null
  );
  const [suggestionsSuspended, setSuggestionsSuspended] = useState(false);
  const [pickingPlace, setPickingPlace] = useState(false);
  const [sessionToken, setSessionToken] = useState(newSessionToken);
  const [detailsError, setDetailsError] = useState<string | null>(null);
  const [pickupLabel, setPickupLabel] = useState<string | null>(null);
  const [orderLoading, setOrderLoading] = useState(false);
  const [orderError, setOrderError] = useState<string | null>(null);
  const [cancelLoading, setCancelLoading] = useState(false);
  const [cancelError, setCancelError] = useState<string | null>(null);
  /** Bloque les double clics avant le prochain rendu (setState asynchrone). */
  const orderRequestInFlightRef = useRef(false);
  const cancelRequestInFlightRef = useRef(false);
  const paymentInFlightRef = useRef(false);
  const searchHydratedForRideIdRef = useRef<string | null>(null);
  const [paymentError, setPaymentError] = useState<string | null>(null);
  const [paymentSheetLoading, setPaymentSheetLoading] = useState(false);
  /** Après succès Payment Sheet : attente webhook → statut `paid` (Realtime). */
  const [paymentConfirmPending, setPaymentConfirmPending] = useState(false);
  /** Horloge pour le compte à rebours (alignée sur `payment_expires_at` serveur). */
  const [payClock, setPayClock] = useState(() => Date.now());
  const paymentExpirySyncDoneRef = useRef<string | null>(null);
  const terminalCleanupForRideIdRef = useRef<string | null>(null);

  const [terminalSummary, setTerminalSummary] = useState<{
    rideId: string;
    pickup_label: string | null;
    destination_label: string;
    estimated_price_eur: number | null;
    ride_completed_at: string | null;
  } | null>(null);
  const [showCompletionModal, setShowCompletionModal] = useState(false);

  const destinationForUi = useMemo((): ClientDestination | null => {
    if (structuredDestination) {
      return structuredDestination;
    }
    if (
      ride &&
      Number.isFinite(ride.destination_lat) &&
      Number.isFinite(ride.destination_lng)
    ) {
      const label =
        ride.destination_label?.trim() || 'Destination enregistrée';
      if (__DEV__) {
        console.log(`${RIDE_RT_LOG} structuredDestination missing`);
        console.log(`${RIDE_RT_LOG} destination from active ride`, label);
        console.log(`${RIDE_RT_LOG} UI using active ride fallback`);
      }
      return {
        label,
        latitude: ride.destination_lat,
        longitude: ride.destination_lng,
        placeId: ride.destination_place_id ?? undefined,
      };
    }
    return null;
  }, [structuredDestination, ride]);

  useEffect(() => {
    if (pickupMode === 'gps' && (location.phase === 'denied' || location.phase === 'error')) {
      setPickupMode('manual');
    }
  }, [pickupMode, location.phase]);

  const pickupForUi = useMemo((): ClientDestination | null => {
    if (pickupMode === 'manual') {
      return structuredPickup;
    }
    if (location.phase === 'ready') {
      const label = pickupLabel?.trim() || 'Position actuelle';
      return {
        label,
        latitude: location.latitude,
        longitude: location.longitude,
        placeId: undefined,
      };
    }
    return null;
  }, [pickupMode, structuredPickup, location, pickupLabel]);

  const resetAfterRide = useCallback(
    (nextView: 'home' | 'history' = 'home') => {
      // Débloque immédiatement une nouvelle commande.
      orderRequestInFlightRef.current = false;
      cancelRequestInFlightRef.current = false;
      paymentInFlightRef.current = false;

      setOrderLoading(false);
      setOrderError(null);
      setCancelLoading(false);
      setCancelError(null);
      setPaymentError(null);
      setPaymentSheetLoading(false);
      setPaymentConfirmPending(false);
      setRideOtp(null);
      setRideOtpError(null);
      otpFetchedForRideIdRef.current = null;

      // Réinitialise la sélection destination/pickup (la position GPS reste intacte).
      setStructuredDestination(null);
      setSearchInput('');
      setSuggestionsSuspended(false);
      setDetailsError(null);
      setStructuredPickup(null);
      setPickupSearchInput('');
      setPickupSuggestionsSuspended(false);
      setPickupDetailsError(null);
      if (location.phase === 'ready') {
        setPickupMode('gps');
      } else {
        setPickupMode('manual');
      }

      setTerminalSummary(null);
      setShowCompletionModal(false);
      setView(nextView);

      dismissRide();
    },
    [dismissRide, location.phase]
  );

  useEffect(() => {
    const rideId = ride?.id ?? null;
    const st = ride?.status ?? null;
    const isTerminal =
      st === 'completed' ||
      st === 'cancelled_by_client' ||
      st === 'cancelled_by_driver' ||
      st === 'expired';
    if (!rideId || !isTerminal) {
      terminalCleanupForRideIdRef.current = null;
      return;
    }
    if (terminalCleanupForRideIdRef.current === rideId) {
      return;
    }
    terminalCleanupForRideIdRef.current = rideId;

    // UX fin de course : pour completed, on affiche un récap et on diffère le reset.
    if (st === 'completed') {
      setTerminalSummary({
        rideId,
        pickup_label: ride?.pickup_label ?? null,
        destination_label: ride?.destination_label ?? 'Destination',
        estimated_price_eur: ride?.estimated_price_eur ?? null,
        ride_completed_at: ride?.ride_completed_at ?? null,
      });
      setShowCompletionModal(true);
      return;
    }

    // Autres statuts terminaux: reset immédiat (MVP stable).
    resetAfterRide('home');
  }, [
    ride?.id,
    ride?.status,
    ride?.pickup_label,
    ride?.destination_label,
    ride?.estimated_price_eur,
    ride?.ride_completed_at,
    resetAfterRide,
  ]);

  useEffect(() => {
    if (!ride || !hasOpenRide) {
      searchHydratedForRideIdRef.current = null;
      return;
    }
    if (structuredDestination) {
      return;
    }
    if (!ride.destination_label?.trim()) {
      return;
    }
    if (searchHydratedForRideIdRef.current === ride.id) {
      return;
    }
    setSearchInput(ride.destination_label);
    setSuggestionsSuspended(true);
    searchHydratedForRideIdRef.current = ride.id;
    if (__DEV__) {
      console.log(`${RIDE_RT_LOG} hydrate search from ride`, ride.id);
    }
  }, [ride, hasOpenRide, structuredDestination]);

  useEffect(() => {
    if (ride?.status === 'paid') {
      setPaymentConfirmPending(false);
      setPaymentSheetLoading(false);
    }
  }, [ride?.status]);

  useEffect(() => {
    if (ride?.status !== 'awaiting_payment') {
      paymentExpirySyncDoneRef.current = null;
    }
  }, [ride?.status]);

  useEffect(() => {
    if (ride?.status !== 'awaiting_payment' || !ride.payment_expires_at) {
      return;
    }
    setPayClock(Date.now());
    const id = setInterval(() => {
      setPayClock(Date.now());
    }, 1000);
    return () => clearInterval(id);
  }, [ride?.status, ride?.payment_expires_at, ride?.id]);

  const paymentDeadlineMs =
    ride?.status === 'awaiting_payment' && ride.payment_expires_at
      ? Date.parse(ride.payment_expires_at)
      : NaN;
  const paymentWindowExpired =
    Number.isFinite(paymentDeadlineMs) && payClock >= paymentDeadlineMs;
  const paymentCountdownMmSs = Number.isFinite(paymentDeadlineMs)
    ? (() => {
        const rem = Math.max(
          0,
          Math.ceil((paymentDeadlineMs - payClock) / 1000)
        );
        const mm = Math.floor(rem / 60);
        const ss = rem % 60;
        return `${String(mm).padStart(2, '0')}:${String(ss).padStart(2, '0')}`;
      })()
    : null;

  useEffect(() => {
    if (
      !ride ||
      ride.status !== 'awaiting_payment' ||
      !ride.payment_expires_at ||
      !paymentWindowExpired
    ) {
      return;
    }
    if (paymentExpirySyncDoneRef.current === ride.id) {
      return;
    }
    paymentExpirySyncDoneRef.current = ride.id;
    void syncRidePaymentExpiryIfDue(ride.id);
  }, [ride?.id, ride?.status, ride?.payment_expires_at, paymentWindowExpired]); // eslint-disable-line react-hooks/exhaustive-deps -- ride utilisé sous garde

  const pickupLat = pickupForUi ? pickupForUi.latitude : null;
  const pickupLng = pickupForUi ? pickupForUi.longitude : null;

  useEffect(() => {
    if (pickupMode !== 'gps') {
      return;
    }
    if (pickupLat == null || pickupLng == null) {
      setPickupLabel(null);
      return;
    }

    let cancelled = false;

    void (async () => {
      try {
        const rows = await Location.reverseGeocodeAsync({
          latitude: pickupLat,
          longitude: pickupLng,
        });
        if (cancelled || rows.length === 0) {
          return;
        }
        const a = rows[0];
        const parts = [
          a.formattedAddress,
          a.name,
          a.street,
          a.district,
          a.city,
          a.subregion,
          a.region,
        ].filter((p): p is string => !!p?.trim());
        const unique = [...new Set(parts)];
        setPickupLabel(unique.join(' ').trim() || null);
      } catch {
        if (!cancelled) {
          setPickupLabel(null);
        }
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [pickupMode, pickupLat, pickupLng]);

  const ridePricing = useRideZonePricing({
    pickupLat,
    pickupLng,
    pickupLabel,
    destination: destinationForUi,
  });

  const routeMetrics = useRouteMetrics({
    originLat: pickupLat,
    originLng: pickupLng,
    destination: destinationForUi,
  });

  const [rideOtp, setRideOtp] = useState<string | null>(null);
  const [rideOtpError, setRideOtpError] = useState<string | null>(null);
  const otpFetchedForRideIdRef = useRef<string | null>(null);

  useEffect(() => {
    const rideId = ride?.id ?? null;
    if (!rideId || ride?.status !== 'in_progress') {
      setRideOtp(null);
      setRideOtpError(null);
      otpFetchedForRideIdRef.current = null;
      return;
    }
    if (otpFetchedForRideIdRef.current === rideId) {
      return;
    }
    otpFetchedForRideIdRef.current = rideId;
    setRideOtp(null);
    setRideOtpError(null);
    void (async () => {
      try {
        const cached = await AsyncStorage.getItem(otpStorageKey(rideId));
        if (cached?.trim()) {
          setRideOtp(cached.trim());
          return;
        }
      } catch {
        // ignore cache read errors
      }
      try {
        const otp = await fetchRideOtpForClient(rideId);
        setRideOtp(otp);
        void AsyncStorage.setItem(otpStorageKey(rideId), otp).catch(() => undefined);
      } catch (e) {
        const raw = e instanceof Error ? e.message : '';
        if (__DEV__) {
          console.error('[ride-otp] get_ride_otp_for_client failed', {
            rideId,
            status: ride?.status,
            message: raw,
          });
        }
        setRideOtpError(raw || 'Impossible de récupérer le code.');
      }
    })();
  }, [ride?.id, ride?.status]);

  const showDriverLiveHint =
    ride?.status === 'paid' || ride?.status === 'en_route' || ride?.status === 'arrived';
  const driverHasCoords =
    ride?.driver_lat != null &&
    Number.isFinite(ride.driver_lat) &&
    ride?.driver_lng != null &&
    Number.isFinite(ride.driver_lng);
  const driverUpdatedMs = parseIsoMs(ride?.driver_location_updated_at);
  const driverStale =
    driverUpdatedMs != null ? Date.now() - driverUpdatedMs > 15_000 : false;
  const driverHint =
    !showDriverLiveHint
      ? null
      : !driverHasCoords
        ? 'Position du chauffeur en cours…'
        : driverStale
          ? 'Position en attente…'
          : null;

  const canOrder = useMemo(() => {
    if (!userId.trim()) {
      return false;
    }
    if (!destinationForUi) {
      return false;
    }
    if (pickupLat == null || pickupLng == null) {
      return false;
    }
    if (!ridePricing || ridePricing.pricingMode === 'loading') {
      return false;
    }
    if (routeMetrics.loading || routeMetrics.error) {
      return false;
    }
    if (
      routeMetrics.distanceMeters == null ||
      routeMetrics.durationSeconds == null
    ) {
      return false;
    }
    return true;
  }, [
    userId,
    destinationForUi,
    pickupLat,
    pickupLng,
    ridePricing,
    routeMetrics.loading,
    routeMetrics.error,
    routeMetrics.distanceMeters,
    routeMetrics.durationSeconds,
  ]);

  const configError = useMemo(() => {
    if (isPlacesConfigured()) {
      return null;
    }
    return 'Ajoutez EXPO_PUBLIC_GOOGLE_PLACES_API_KEY dans votre fichier .env (clé avec Places API activée), puis redémarrez Expo.';
  }, []);

  function handleSearchChange(value: string) {
    setSearchInput(value);
    setSuggestionsSuspended(false);
    setDetailsError(null);
    setOrderError(null);
    setCancelError(null);
    orderRequestInFlightRef.current = false;
    if (structuredDestination) {
      setStructuredDestination(null);
    }
  }

  function handlePickupSearchChange(value: string) {
    setPickupSearchInput(value);
    setPickupSuggestionsSuspended(false);
    setPickupDetailsError(null);
    setOrderError(null);
    setCancelError(null);
    orderRequestInFlightRef.current = false;
    if (structuredPickup) {
      setStructuredPickup(null);
    }
    if (pickupMode !== 'manual') {
      setPickupMode('manual');
    }
  }

  async function handleOrderPress() {
    if (
      !canOrder ||
      !destinationForUi ||
      pickupLat == null ||
      pickupLng == null ||
      !ridePricing ||
      ridePricing.pricingMode === 'loading'
    ) {
      return;
    }
    if (
      routeMetrics.distanceMeters == null ||
      routeMetrics.durationSeconds == null
    ) {
      return;
    }

    const pricingMode = ridePricing.pricingMode;
    if (pricingMode !== 'normal' && pricingMode !== 'fallback') {
      return;
    }

    if (hasOpenRide) {
      if (__DEV__) {
        console.log('[ride-create] locked after success');
      }
      return;
    }

    if (orderRequestInFlightRef.current) {
      if (__DEV__) {
        console.log('[ride-create] ignored duplicate click');
      }
      return;
    }

    orderRequestInFlightRef.current = true;
    setOrderLoading(true);
    setOrderError(null);

    try {
      const { id } = await insertRequestedRide({
        client_id: userId,
        status: 'requested',
        pickup_lat: pickupLat,
        pickup_lng: pickupLng,
        pickup_label: pickupLabel,
        destination_lat: destinationForUi.latitude,
        destination_lng: destinationForUi.longitude,
        destination_label: destinationForUi.label,
        destination_place_id: destinationForUi.placeId ?? null,
        pickup_zone: ridePricing.pickupZone,
        destination_zone: ridePricing.destinationZone,
        estimated_price_ariary: ridePricing.estimatedPriceAriary,
        estimated_price_eur: ridePricing.estimatedPriceEuro,
        pricing_mode: pricingMode,
        estimated_distance_m: Math.round(routeMetrics.distanceMeters),
        estimated_duration_s: Math.round(routeMetrics.durationSeconds),
        route_polyline: routeMetrics.encodedPolyline,
      });
      await registerRideAfterCreate(id);
      void notifyRideEvent({ event: 'ride_created', rideId: id });
      setCancelError(null);
    } catch (e) {
      setOrderError(
        e instanceof Error ? e.message : 'Impossible d’enregistrer la course.'
      );
    } finally {
      orderRequestInFlightRef.current = false;
      setOrderLoading(false);
    }
  }

  async function handleCancelPress() {
    const rideId = ride?.id;
    const canCancel =
      ride?.status === 'requested' || ride?.status === 'awaiting_payment';
    if (
      !rideId ||
      !canCancel ||
      cancelLoading ||
      cancelRequestInFlightRef.current
    ) {
      return;
    }
    cancelRequestInFlightRef.current = true;
    setCancelLoading(true);
    setCancelError(null);
    try {
      await cancelRideAsClient(rideId);
      void notifyRideEvent({ event: 'ride_cancelled', rideId });
      dismissRide();
      orderRequestInFlightRef.current = false;
    } catch (e) {
      if (e instanceof CancelRideError) {
        setCancelError(e.message);
        if (e.clearPendingRide) {
          dismissRide();
          orderRequestInFlightRef.current = false;
        }
      } else {
        setCancelError(
          e instanceof Error
            ? e.message
            : 'Impossible d’annuler la course pour le moment.'
        );
      }
    } finally {
      cancelRequestInFlightRef.current = false;
      setCancelLoading(false);
    }
  }

  async function handlePayPress() {
    if (Platform.OS === 'web') {
      setPaymentError(
        'Le paiement sécurisé est disponible sur l’application mobile (iOS/Android), pas dans le navigateur.'
      );
      return;
    }
    if (
      !ride ||
      ride.status !== 'awaiting_payment' ||
      paymentInFlightRef.current ||
      paymentSheetLoading
    ) {
      return;
    }
    const rideId = ride.id;
    if (!stripePublishableConfigured) {
      setPaymentError(
        'Ajoutez EXPO_PUBLIC_STRIPE_PUBLISHABLE_KEY dans .env (clé publishable Stripe).'
      );
      return;
    }

    const deadline = ride.payment_expires_at
      ? Date.parse(ride.payment_expires_at)
      : NaN;
    if (Number.isFinite(deadline) && Date.now() >= deadline) {
      setPaymentError('Le délai de paiement est dépassé.');
      void syncRidePaymentExpiryIfDue(rideId);
      return;
    }

    paymentInFlightRef.current = true;
    setPaymentError(null);
    setPaymentSheetLoading(true);

    try {
      const pi = await invokeCreatePaymentIntent(rideId);
      if (!pi.ok) {
        setPaymentError(pi.message);
        return;
      }

      const { error: initErr } = await initPaymentSheet({
        merchantDisplayName: 'Tukme',
        paymentIntentClientSecret: pi.clientSecret,
        returnURL: STRIPE_RETURN_URL,
      });

      if (initErr) {
        setPaymentError(initErr.message);
        return;
      }

      const { error: presentErr } = await presentPaymentSheet();

      if (presentErr) {
        if (presentErr.code === 'Canceled') {
          setPaymentError(null);
        } else {
          setPaymentError(presentErr.message);
        }
        return;
      }

      setPaymentConfirmPending(true);
      void refetchOpenRide();
    } finally {
      paymentInFlightRef.current = false;
      setPaymentSheetLoading(false);
    }
  }

  async function handlePickSuggestion(item: PlaceSuggestionItem) {
    Keyboard.dismiss();
    if (configError) {
      return;
    }
    setPickingPlace(true);
    setDetailsError(null);
    try {
      const token = sessionToken;
      const details = await fetchPlaceDetails({
        placeId: item.placeId,
        sessionToken: token,
      });
      setOrderError(null);
      setCancelError(null);
      orderRequestInFlightRef.current = false;
      setStructuredDestination({
        label: details.label,
        latitude: details.latitude,
        longitude: details.longitude,
        placeId: details.placeId,
      });
      setSearchInput(details.label);
      setSuggestionsSuspended(true);
      setSessionToken(newSessionToken());
    } catch (e) {
      setStructuredDestination(null);
      setSearchInput(item.fullDescription);
      setSuggestionsSuspended(false);
      setDetailsError(
        e instanceof Error
          ? e.message
          : 'Impossible de récupérer ce lieu. Réessayez.'
      );
    } finally {
      setPickingPlace(false);
    }
  }

  async function handlePickPickupSuggestion(item: PlaceSuggestionItem) {
    Keyboard.dismiss();
    if (configError) {
      return;
    }
    setPickupMode('manual');
    setPickupPickingPlace(true);
    setPickupDetailsError(null);
    try {
      const token = pickupSessionToken;
      const details = await fetchPlaceDetails({
        placeId: item.placeId,
        sessionToken: token,
      });
      setOrderError(null);
      setCancelError(null);
      orderRequestInFlightRef.current = false;
      setStructuredPickup({
        label: details.label,
        latitude: details.latitude,
        longitude: details.longitude,
        placeId: details.placeId,
      });
      setPickupSearchInput(details.label);
      setPickupSuggestionsSuspended(true);
      setPickupSessionToken(newSessionToken());
    } catch (e) {
      setStructuredPickup(null);
      setPickupSearchInput(item.fullDescription);
      setPickupSuggestionsSuspended(false);
      setPickupDetailsError(
        e instanceof Error ? e.message : 'Impossible de récupérer ce lieu. Réessayez.'
      );
    } finally {
      setPickupPickingPlace(false);
    }
  }

  if (view === 'history') {
    return (
      <ClientRideHistoryScreen
        userId={userId}
        onBack={() => setView('home')}
      />
    );
  }

  return (
    <>
      <Modal
        visible={showCompletionModal}
        transparent
        animationType="fade"
        onRequestClose={() => resetAfterRide('home')}
      >
        <Pressable
          style={styles.modalBackdrop}
          onPress={() => resetAfterRide('home')}
        >
          <Pressable style={styles.modalCard} onPress={() => undefined}>
            <Text style={styles.modalTitle}>Course terminée</Text>
            <Text style={styles.modalRoute} numberOfLines={3}>
              {(terminalSummary?.pickup_label?.trim() || pickupForUi?.label || 'Départ') +
                ' → ' +
                (terminalSummary?.destination_label?.trim() || destinationForUi?.label || 'Destination')}
            </Text>
            <Text style={styles.modalLine}>
              Estimation :{' '}
              {terminalSummary?.estimated_price_eur != null &&
              Number.isFinite(terminalSummary.estimated_price_eur)
                ? `${terminalSummary.estimated_price_eur.toFixed(2)} €`
                : '—'}
            </Text>
            <Text style={styles.modalLine}>
              {(() => {
                const raw = terminalSummary?.ride_completed_at?.trim();
                const ms = raw ? Date.parse(raw) : NaN;
                const d = Number.isFinite(ms) ? new Date(ms) : new Date();
                return `Terminée le ${d.toLocaleString('fr-FR', {
                  dateStyle: 'medium',
                  timeStyle: 'short',
                })}`;
              })()}
            </Text>

            <View style={styles.modalButtons}>
              <Pressable
                style={({ pressed }) => [
                  styles.modalBtnSecondary,
                  pressed && styles.modalBtnPressed,
                ]}
                onPress={() => resetAfterRide('home')}
              >
                <Text style={styles.modalBtnSecondaryText}>Fermer</Text>
              </Pressable>
              <Pressable
                style={({ pressed }) => [
                  styles.modalBtnSecondary,
                  pressed && styles.modalBtnPressed,
                ]}
                onPress={() => resetAfterRide('history')}
              >
                <Text style={styles.modalBtnSecondaryText}>Voir mes courses</Text>
              </Pressable>
              <Pressable
                style={({ pressed }) => [
                  styles.modalBtnPrimary,
                  pressed && styles.modalBtnPressed,
                ]}
                onPress={() => resetAfterRide('home')}
              >
                <Text style={styles.modalBtnPrimaryText}>Commander à nouveau</Text>
              </Pressable>
            </View>
          </Pressable>
        </Pressable>
      </Modal>

      <TripSummaryCard
        location={location}
        pickupMode={pickupMode}
        pickup={pickupForUi}
        destination={destinationForUi}
      />
      <Pressable
        style={({ pressed }) => [
          styles.historyButton,
          pressed && styles.historyButtonPressed,
        ]}
        onPress={() => setView('history')}
      >
        <Text style={styles.historyButtonText}>Mes courses</Text>
      </Pressable>
      <ClientMapBlock
        location={location}
        pickup={
          pickupForUi
            ? {
                latitude: pickupForUi.latitude,
                longitude: pickupForUi.longitude,
                label: pickupForUi.label,
              }
            : null
        }
        destination={destinationForUi}
        routeMetrics={routeMetrics}
        driverLat={ride?.driver_lat ?? null}
        driverLng={ride?.driver_lng ?? null}
      />
      <ZonePricingCard
        estimate={ridePricing}
        hasDestination={destinationForUi !== null}
      />
      {structuredDestination || ride != null ? (
        <View style={styles.orderBlock}>
          {rideFetchLoading && !ride ? (
            <View style={styles.rideFetchLoadingRow}>
              <ActivityIndicator size="small" color="#0f766e" />
              <Text style={styles.rideFetchLoadingText}>
                Chargement de votre course…
              </Text>
            </View>
          ) : null}
          {rideFetchError ? (
            <Text style={styles.orderError}>{rideFetchError}</Text>
          ) : null}
          {structuredDestination ? (
            <Pressable
              style={({ pressed }) => [
                styles.orderButton,
                (!canOrder || orderLoading || hasOpenRide) &&
                  styles.orderButtonDisabled,
                pressed &&
                  canOrder &&
                  !orderLoading &&
                  !hasOpenRide &&
                  styles.orderButtonPressed,
              ]}
              disabled={!canOrder || orderLoading || hasOpenRide}
              onPress={() => void handleOrderPress()}
            >
              {orderLoading ? (
                <ActivityIndicator color="#fff" />
              ) : (
                <Text style={styles.orderButtonLabel}>Commander</Text>
              )}
            </Pressable>
          ) : null}
          {!destinationForUi && ride != null ? (
            <Text style={styles.orderHint}>
              Une course est en cours sans destination affichable. Vérifiez la
              connexion ou contactez le support.
            </Text>
          ) : null}
          {!canOrder &&
          !orderLoading &&
          !hasOpenRide &&
          structuredDestination ? (
            <Text style={styles.orderHint}>
              {!userId.trim()
                ? 'Session invalide.'
                : pickupLat == null || pickupLng == null
                  ? 'Position de départ requise.'
                  : !ridePricing
                    ? 'Estimation tarif indisponible.'
                    : ridePricing.pricingMode === 'loading'
                      ? 'Tarif en cours de chargement…'
                      : routeMetrics.loading
                        ? 'Itinéraire en cours de calcul…'
                        : routeMetrics.error
                          ? 'Itinéraire indisponible.'
                          : routeMetrics.distanceMeters == null ||
                              routeMetrics.durationSeconds == null
                            ? 'Métriques d’itinéraire manquantes.'
                            : 'Complétez les conditions pour commander.'}
            </Text>
          ) : null}
          {ride ? (
            <Text
              style={
                ride.status === 'requested' ||
                ride.status === 'awaiting_payment' ||
                ride.status === 'paid' ||
                ride.status === 'en_route' ||
                ride.status === 'arrived' ||
                ride.status === 'in_progress'
                  ? styles.orderSuccess
                  : styles.orderRideTerminal
              }
            >
              {clientRideStatusMessage(ride.status)}
            </Text>
          ) : null}
          {ride?.status === 'in_progress' ? (
            rideOtp ? (
              <Text style={styles.orderHint}>
                Code de fin de course : {rideOtp}
                {'\n'}
                Donnez ce code au chauffeur.
              </Text>
            ) : rideOtpError ? (
              <Text style={styles.orderHint}>{rideOtpError}</Text>
            ) : (
              <Text style={styles.orderHint}>Chargement du code de fin de course…</Text>
            )
          ) : null}
          {driverHint ? <Text style={styles.orderHint}>{driverHint}</Text> : null}
          {rideRealtimeError ? (
            <Text style={styles.orderRealtimeWarning}>{rideRealtimeError}</Text>
          ) : null}
          {paymentConfirmPending && ride?.status === 'awaiting_payment' ? (
            <Text style={styles.orderHint}>
              Validation du paiement en cours…
            </Text>
          ) : null}
          {ride?.status === 'awaiting_payment' && ride.payment_expires_at ? (
            <Text style={styles.orderPaymentTimer}>
              {paymentWindowExpired
                ? 'Délai de paiement dépassé — mise à jour…'
                : `Paiement requis — expire dans ${paymentCountdownMmSs ?? '--:--'}`}
            </Text>
          ) : null}
          {ride?.status === 'awaiting_payment' &&
          (!ride.payment_expires_at || !paymentWindowExpired) ? (
            Platform.OS === 'web' ? (
              <Text style={styles.orderHint}>
                Le paiement sécurisé est disponible sur l’application mobile
                (iOS/Android), pas dans le navigateur.
              </Text>
            ) : (
              <Pressable
                style={({ pressed }) => [
                  styles.orderPayButton,
                  paymentSheetLoading && styles.orderButtonDisabled,
                  pressed &&
                    !paymentSheetLoading &&
                    styles.orderPayButtonPressed,
                ]}
                disabled={paymentSheetLoading}
                onPress={() => void handlePayPress()}
              >
                {paymentSheetLoading ? (
                  <ActivityIndicator color="#fff" />
                ) : (
                  <Text style={styles.orderPayButtonLabel}>
                    Payer
                    {ride.estimated_price_eur != null &&
                    Number.isFinite(ride.estimated_price_eur)
                      ? ` (${ride.estimated_price_eur.toFixed(2)} €)`
                      : ''}
                  </Text>
                )}
              </Pressable>
            )
          ) : null}
          {paymentError ? (
            <Text style={styles.orderError}>{paymentError}</Text>
          ) : null}
          {ride?.status === 'requested' ||
          ride?.status === 'awaiting_payment' ? (
            <Pressable
              style={({ pressed }) => [
                styles.orderCancelButton,
                cancelLoading && styles.orderButtonDisabled,
                pressed && !cancelLoading && styles.orderCancelButtonPressed,
              ]}
              disabled={cancelLoading}
              onPress={() => void handleCancelPress()}
            >
              {cancelLoading ? (
                <ActivityIndicator color="#0f766e" />
              ) : (
                <Text style={styles.orderCancelLabel}>Annuler la course</Text>
              )}
            </Pressable>
          ) : null}
          {cancelError ? (
            <Text style={styles.orderError}>{cancelError}</Text>
          ) : null}
          {orderError ? (
            <Text style={styles.orderError}>{orderError}</Text>
          ) : null}
        </View>
      ) : null}
      <PlacesDestinationSection
        location={location}
        searchInput={searchInput}
        onSearchChange={handleSearchChange}
        suggestionsSuspended={suggestionsSuspended}
        sessionToken={sessionToken}
        onPickSuggestion={(item) => void handlePickSuggestion(item)}
        pickingPlace={pickingPlace}
        configError={configError}
        detailsError={detailsError}
      />
      {pickupMode === 'manual' ? (
        <PlacesPickupSection
          location={location}
          searchInput={pickupSearchInput}
          onSearchChange={handlePickupSearchChange}
          suggestionsSuspended={pickupSuggestionsSuspended}
          sessionToken={pickupSessionToken}
          onPickSuggestion={(item) => void handlePickPickupSuggestion(item)}
          pickingPlace={pickupPickingPlace}
          configError={configError}
          detailsError={pickupDetailsError}
          onUseGpsPress={() => {
            setPickupMode('gps');
            setStructuredPickup(null);
            setPickupSearchInput('');
            setPickupSuggestionsSuspended(false);
            setPickupDetailsError(null);
          }}
        />
      ) : (
        <Pressable
          style={({ pressed }) => [
            styles.pickupManualButton,
            pressed && styles.pickupManualButtonPressed,
          ]}
          onPress={() => setPickupMode('manual')}
        >
          <Text style={styles.pickupManualButtonText}>
            Choisir un autre point de départ
          </Text>
        </Pressable>
      )}
    </>
  );
}

export function ClientHomeScreen({
  session,
  profile,
  onDevResetRole,
}: Props) {
  const stripePk = process.env.EXPO_PUBLIC_STRIPE_PUBLISHABLE_KEY?.trim() ?? '';
  const stripePublishableConfigured = stripePk.length > 0;
  const stripePublishableKey =
    stripePk ||
    'pk_test_0000000000000000000000000000000000000000000000000000000000000000';

  return (
    <ClientStripeRoot publishableKey={stripePublishableKey}>
      <SignedInShell
        session={session}
        profile={profile}
        headline="Espace client"
        onDevResetRole={onDevResetRole}
        middleContent={
          <ClientHomeMiddleContent
            userId={session.user.id}
            stripePublishableConfigured={stripePublishableConfigured}
          />
        }
      />
    </ClientStripeRoot>
  );
}

const styles = StyleSheet.create({
  summaryCard: {
    width: '100%',
    maxWidth: 400,
    marginBottom: 16,
    padding: 16,
    borderRadius: 12,
    backgroundColor: '#fff',
    borderWidth: 1,
    borderColor: '#e2e8f0',
  },
  summaryTitle: {
    fontSize: 17,
    fontWeight: '700',
    color: '#0f172a',
    marginBottom: 14,
  },
  summaryLabel: {
    fontSize: 12,
    color: '#64748b',
    textTransform: 'uppercase',
    letterSpacing: 0.4,
    marginBottom: 4,
  },
  summaryLabelSpaced: {
    marginTop: 12,
  },
  summaryValue: {
    fontSize: 16,
    fontWeight: '600',
    color: '#0f172a',
    lineHeight: 22,
  },
  summaryCoords: {
    fontSize: 14,
    color: '#64748b',
    marginTop: 4,
    fontVariant: ['tabular-nums'],
  },
  summaryHint: {
    marginTop: 6,
    fontSize: 12,
    color: '#64748b',
  },
  destinationBlock: {
    width: '100%',
    maxWidth: 400,
    marginBottom: 8,
    padding: 16,
    borderRadius: 12,
    backgroundColor: '#fff',
    borderWidth: 1,
    borderColor: '#e2e8f0',
  },
  destinationTitle: {
    fontSize: 16,
    fontWeight: '600',
    color: '#0f172a',
    marginBottom: 6,
  },
  destinationHint: {
    fontSize: 13,
    color: '#64748b',
    lineHeight: 18,
    marginBottom: 12,
  },
  positionWait: {
    fontSize: 13,
    color: '#b45309',
    lineHeight: 18,
    marginBottom: 10,
  },
  destinationInput: {
    borderWidth: 1,
    borderColor: '#e2e8f0',
    borderRadius: 10,
    paddingHorizontal: 14,
    paddingVertical: 12,
    fontSize: 16,
    color: '#0f172a',
    backgroundColor: '#f8fafc',
    marginBottom: 8,
  },
  historyButton: {
    width: '100%',
    maxWidth: 400,
    marginBottom: 12,
    paddingVertical: 12,
    borderRadius: 12,
    backgroundColor: '#0f766e',
    alignItems: 'center',
    justifyContent: 'center',
  },
  historyButtonPressed: {
    opacity: 0.92,
  },
  historyButtonText: {
    color: '#fff',
    fontWeight: '800',
    fontSize: 16,
  },
  modalBackdrop: {
    flex: 1,
    backgroundColor: 'rgba(15, 23, 42, 0.55)',
    alignItems: 'center',
    justifyContent: 'flex-end',
    padding: 16,
  },
  modalCard: {
    width: '100%',
    maxWidth: 420,
    borderRadius: 16,
    backgroundColor: '#fff',
    borderWidth: 1,
    borderColor: '#e2e8f0',
    padding: 16,
  },
  modalTitle: {
    fontSize: 18,
    fontWeight: '800',
    color: '#0f172a',
    marginBottom: 10,
  },
  modalRoute: {
    fontSize: 15,
    fontWeight: '700',
    color: '#0f172a',
    lineHeight: 21,
    marginBottom: 10,
  },
  modalLine: {
    fontSize: 13,
    color: '#475569',
    lineHeight: 18,
    marginBottom: 6,
  },
  modalButtons: {
    marginTop: 12,
    gap: 10,
  },
  modalBtnPrimary: {
    backgroundColor: '#0f766e',
    borderRadius: 12,
    paddingVertical: 12,
    alignItems: 'center',
    justifyContent: 'center',
  },
  modalBtnPrimaryText: {
    color: '#fff',
    fontWeight: '800',
    fontSize: 16,
  },
  modalBtnSecondary: {
    borderWidth: 2,
    borderColor: '#0f766e',
    borderRadius: 12,
    paddingVertical: 11,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: '#fff',
  },
  modalBtnSecondaryText: {
    color: '#0f766e',
    fontWeight: '800',
    fontSize: 15,
  },
  modalBtnPressed: {
    opacity: 0.92,
  },
  pickupManualButton: {
    width: '100%',
    maxWidth: 400,
    marginBottom: 8,
    borderWidth: 2,
    borderColor: '#0f766e',
    borderRadius: 12,
    paddingVertical: 12,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: '#fff',
  },
  pickupManualButtonPressed: {
    backgroundColor: '#f0fdfa',
    opacity: 0.92,
  },
  pickupManualButtonText: {
    color: '#0f766e',
    fontWeight: '700',
    fontSize: 16,
  },
  pickupGpsButton: {
    alignSelf: 'flex-start',
    paddingVertical: 8,
    paddingHorizontal: 12,
    borderRadius: 10,
    backgroundColor: '#f1f5f9',
    marginBottom: 10,
  },
  pickupGpsButtonPressed: {
    opacity: 0.9,
  },
  pickupGpsButtonText: {
    color: '#0f766e',
    fontWeight: '700',
    fontSize: 14,
  },
  geocodeError: {
    fontSize: 13,
    color: '#b91c1c',
    lineHeight: 18,
    marginBottom: 12,
  },
  suggestLoading: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    marginBottom: 8,
  },
  suggestLoadingText: {
    fontSize: 13,
    color: '#64748b',
  },
  suggestionsBox: {
    borderWidth: 1,
    borderColor: '#e2e8f0',
    borderRadius: 10,
    overflow: 'hidden',
    marginBottom: 8,
    backgroundColor: '#fff',
  },
  suggestionRow: {
    paddingVertical: 12,
    paddingHorizontal: 12,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: '#e2e8f0',
  },
  suggestionRowPressed: {
    backgroundColor: '#f1f5f9',
  },
  suggestionPrimary: {
    fontSize: 16,
    fontWeight: '600',
    color: '#0f172a',
  },
  suggestionSecondary: {
    fontSize: 13,
    color: '#64748b',
    marginTop: 2,
  },
  pickingRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    marginTop: 4,
  },
  pickingText: {
    fontSize: 13,
    color: '#64748b',
  },
  pricingCard: {
    width: '100%',
    maxWidth: 400,
    marginBottom: 16,
    padding: 16,
    borderRadius: 12,
    backgroundColor: '#ecfdf5',
    borderWidth: 1,
    borderColor: '#a7f3d0',
  },
  pricingTitle: {
    fontSize: 15,
    fontWeight: '700',
    color: '#0f172a',
    marginBottom: 10,
  },
  pricingLine: {
    fontSize: 14,
    color: '#0f172a',
    marginBottom: 6,
    lineHeight: 20,
  },
  pricingLabel: {
    color: '#64748b',
    fontWeight: '500',
  },
  pricingValue: {
    fontWeight: '700',
    color: '#0f172a',
  },
  pricingFallbackHint: {
    marginTop: 4,
    marginBottom: 6,
    fontSize: 13,
    color: '#b45309',
    lineHeight: 18,
  },
  pricingLoadingRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
    marginTop: 12,
  },
  pricingLoadingText: {
    fontSize: 14,
    color: '#64748b',
  },
  pricingAmountBlock: {
    marginTop: 10,
  },
  pricingEuroMain: {
    fontSize: 28,
    fontWeight: '800',
    color: '#0f766e',
    letterSpacing: -0.5,
  },
  pricingAriarySub: {
    marginTop: 4,
    fontSize: 14,
    color: '#64748b',
    fontWeight: '500',
  },
  orderBlock: {
    width: '100%',
    maxWidth: 400,
    marginBottom: 16,
  },
  orderButton: {
    backgroundColor: '#0f766e',
    paddingVertical: 14,
    borderRadius: 12,
    alignItems: 'center',
    justifyContent: 'center',
    minHeight: 48,
  },
  orderButtonPressed: {
    opacity: 0.92,
  },
  orderButtonDisabled: {
    backgroundColor: '#94a3b8',
  },
  orderButtonLabel: {
    fontSize: 17,
    fontWeight: '700',
    color: '#fff',
  },
  orderHint: {
    marginTop: 8,
    fontSize: 13,
    color: '#64748b',
    lineHeight: 18,
  },
  orderSuccess: {
    marginTop: 10,
    fontSize: 14,
    fontWeight: '600',
    color: '#047857',
    lineHeight: 20,
  },
  orderRideTerminal: {
    marginTop: 10,
    fontSize: 14,
    fontWeight: '600',
    color: '#475569',
    lineHeight: 20,
  },
  orderRealtimeWarning: {
    marginTop: 8,
    fontSize: 13,
    color: '#b45309',
    lineHeight: 18,
  },
  rideFetchLoadingRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
    marginBottom: 12,
  },
  rideFetchLoadingText: {
    fontSize: 14,
    color: '#64748b',
  },
  orderError: {
    marginTop: 10,
    fontSize: 14,
    color: '#b91c1c',
    lineHeight: 20,
  },
  orderPayButton: {
    marginTop: 12,
    backgroundColor: '#0f766e',
    paddingVertical: 14,
    borderRadius: 12,
    alignItems: 'center',
    justifyContent: 'center',
    minHeight: 48,
  },
  orderPayButtonPressed: {
    opacity: 0.92,
  },
  orderPayButtonLabel: {
    fontSize: 17,
    fontWeight: '700',
    color: '#fff',
  },
  orderPaymentTimer: {
    marginTop: 8,
    fontSize: 14,
    fontWeight: '600',
    color: '#b45309',
    lineHeight: 20,
  },
  orderCancelButton: {
    marginTop: 12,
    paddingVertical: 12,
    borderRadius: 12,
    borderWidth: 2,
    borderColor: '#0f766e',
    alignItems: 'center',
    justifyContent: 'center',
    minHeight: 44,
    backgroundColor: '#fff',
  },
  orderCancelButtonPressed: {
    opacity: 0.88,
    backgroundColor: '#f0fdfa',
  },
  orderCancelLabel: {
    fontSize: 16,
    fontWeight: '700',
    color: '#0f766e',
  },
});
