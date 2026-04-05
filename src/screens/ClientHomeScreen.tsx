import type { Session } from '@supabase/supabase-js';
import * as Location from 'expo-location';
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
import { syncRidePaymentExpiryIfDue } from '../lib/syncRidePaymentExpiry';
import { useActiveRide } from '../hooks/useActiveRide';
import { formatAriary } from '../lib/taxiPricing';
import type { ClientRideStatus } from '../types/clientRide';
import type { ClientDestination } from '../types/clientDestination';
import type { RidePricingEstimate } from '../types/ridePricing';
import type { Profile } from '../types/profile';

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
    case 'accepted':
      return 'Chauffeur trouvé — paiement requis.';
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
  destination: ClientDestination | null;
}) {
  const { location, destination } = props;
  const positionLine = formatCurrentPositionText(location);

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

function ClientHomeMiddleContent(props: {
  userId: string;
  stripePublishableConfigured: boolean;
}) {
  const { userId, stripePublishableConfigured } = props;
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
  const location = useClientLocation();
  const [searchInput, setSearchInput] = useState('');
  const [structuredDestination, setStructuredDestination] =
    useState<ClientDestination | null>(null);
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

  const pickupLat =
    location.phase === 'ready' ? location.latitude : null;
  const pickupLng =
    location.phase === 'ready' ? location.longitude : null;

  useEffect(() => {
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
  }, [pickupLat, pickupLng]);

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

  return (
    <>
      <TripSummaryCard
        location={location}
        destination={destinationForUi}
      />
      <ClientMapBlock
        location={location}
        destination={destinationForUi}
        routeMetrics={routeMetrics}
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
                ride.status === 'accepted' ||
                ride.status === 'in_progress'
                  ? styles.orderSuccess
                  : styles.orderRideTerminal
              }
            >
              {clientRideStatusMessage(ride.status)}
            </Text>
          ) : null}
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
