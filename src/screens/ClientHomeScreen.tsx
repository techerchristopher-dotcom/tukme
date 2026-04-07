import type { Session } from '@supabase/supabase-js';
import * as Location from 'expo-location';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { ClientMapBlock } from './ClientMapBlock';
import Ionicons from '@expo/vector-icons/Ionicons';
import { LinearGradient } from 'expo-linear-gradient';
import {
  ClientStripeRoot,
  useClientStripeSheet,
} from './ClientHomeStripeBridge';
import {
  type ReactNode,
  useEffect,
  useCallback,
  useMemo,
  useRef,
  useState,
} from 'react';
import {
  ActivityIndicator,
  Animated,
  Easing,
  Keyboard,
  Modal,
  Platform,
  Pressable,
  SafeAreaView,
  ScrollView,
  StatusBar,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';
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

/** Couleur primaire Tukme (alignée sur les CTA existants). */
const BRAND_PRIMARY = '#0f766e';
const ICON_INACTIVE = '#64748b';
const NAV_ICON_SIZE = 22;

function usePressScale(toScale = 0.98) {
  const scale = useRef(new Animated.Value(1)).current;
  const onPressIn = useCallback(() => {
    Animated.spring(scale, {
      toValue: toScale,
      speed: 28,
      bounciness: 0,
      useNativeDriver: true,
    }).start();
  }, [scale, toScale]);
  const onPressOut = useCallback(() => {
    Animated.spring(scale, {
      toValue: 1,
      speed: 28,
      bounciness: 0,
      useNativeDriver: true,
    }).start();
  }, [scale]);
  return { scale, onPressIn, onPressOut };
}

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

  const [destInputFocused, setDestInputFocused] = useState(false);

  return (
    <View style={styles.destinationBlock}>
      <Text style={styles.destinationTitle}>Où allez-vous ?</Text>
      <Text style={styles.destinationHint}>Choisissez une destination.</Text>

      {configError ? (
        <Text style={styles.geocodeError}>{configError}</Text>
      ) : null}

      {location.phase !== 'ready' ? (
        <Text style={styles.positionWait}>Localisation en cours…</Text>
      ) : null}

      <View
        style={[
          styles.destinationInputRow,
          destInputFocused && styles.destinationInputRowFocused,
        ]}
      >
        <Ionicons
          name={destInputFocused ? 'search' : 'search-outline'}
          size={NAV_ICON_SIZE}
          color={destInputFocused ? BRAND_PRIMARY : ICON_INACTIVE}
        />
        <TextInput
          style={styles.destinationInputField}
          value={searchInput}
          onChangeText={onSearchChange}
          placeholder="Adresse, lieu, arrêt…"
          placeholderTextColor="#94a3b8"
          returnKeyType="search"
          autoCorrect={false}
          autoCapitalize="none"
          editable={!pickingPlace && !configError}
          onFocus={() => setDestInputFocused(true)}
          onBlur={() => setDestInputFocused(false)}
        />
      </View>

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
      <Text style={styles.destinationHint}>Choisissez un point de départ.</Text>

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
        style={styles.pickupSearchInput}
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

function ClientItineraryModal(props: {
  visible: boolean;
  location: ClientLocationState;
  pickupQuery: string;
  onPickupQueryChange: (v: string) => void;
  pickupIsGps: boolean;
  destinationQuery: string;
  onDestinationQueryChange: (v: string) => void;
  onClose: () => void;
  onUseCurrentLocation: () => void;
  onPickPickup: (item: PlaceSuggestionItem) => Promise<void>;
  onPickDestination: (item: PlaceSuggestionItem) => Promise<void>;
}) {
  const {
    visible,
    location,
    pickupQuery,
    onPickupQueryChange,
    pickupIsGps,
    destinationQuery,
    onDestinationQueryChange,
    onClose,
    onUseCurrentLocation,
    onPickPickup,
    onPickDestination,
  } = props;

  const pickupRef = useRef<TextInput>(null);
  const destRef = useRef<TextInput>(null);
  // UX: étape 1 = pickup, étape 2 = destination.
  const [active, setActive] = useState<'pickup' | 'destination'>('pickup');
  const [pickupToken, setPickupToken] = useState(newSessionToken);
  const [destToken, setDestToken] = useState(newSessionToken);
  const [pickupSuspended, setPickupSuspended] = useState(false);
  const [destSuspended, setDestSuspended] = useState(false);
  const [picking, setPicking] = useState(false);
  const [detailsError, setDetailsError] = useState<string | null>(null);

  const pickupRowScale = useRef(new Animated.Value(1)).current;
  const destRowScale = useRef(new Animated.Value(1)).current;

  useEffect(() => {
    if (!visible) return;
    setActive('pickup');
    const t = setTimeout(() => pickupRef.current?.focus(), 200);
    return () => clearTimeout(t);
  }, [visible]);

  useEffect(() => {
    Animated.parallel([
      Animated.spring(pickupRowScale, {
        toValue: active === 'pickup' ? 1.015 : 1,
        speed: 22,
        bounciness: 5,
        useNativeDriver: true,
      }),
      Animated.spring(destRowScale, {
        toValue: active === 'destination' ? 1.015 : 1,
        speed: 22,
        bounciness: 5,
        useNativeDriver: true,
      }),
    ]).start();
  }, [active, pickupRowScale, destRowScale]);

  const configError = useMemo(() => {
    if (isPlacesConfigured()) return null;
    return 'Ajoutez EXPO_PUBLIC_GOOGLE_PLACES_API_KEY dans votre fichier .env, puis redémarrez Expo.';
  }, []);

  const biasLat = location.phase === 'ready' ? location.latitude : null;
  const biasLng = location.phase === 'ready' ? location.longitude : null;

  const pickupSuggest = usePlacesSuggestions({
    query: pickupQuery,
    sessionToken: pickupToken,
    biasLat,
    biasLng,
    suspended: pickupSuspended || active !== 'pickup',
  });
  const destSuggest = usePlacesSuggestions({
    query: destinationQuery,
    sessionToken: destToken,
    biasLat,
    biasLng,
    suspended: destSuspended || active !== 'destination',
  });

  const current = active === 'pickup' ? pickupSuggest : destSuggest;
  const showSuggestions =
    !picking && current.suggestions.length > 0 && !(active === 'pickup' ? pickupSuspended : destSuspended);

  async function handlePick(item: PlaceSuggestionItem) {
    Keyboard.dismiss();
    if (configError) return;
    setPicking(true);
    setDetailsError(null);
    try {
      if (active === 'pickup') {
        await onPickPickup(item);
        setPickupSuspended(true);
        setPickupToken(newSessionToken());
        // Move focus to destination after choosing pickup (Uber-like flow).
        setActive('destination');
        setTimeout(() => destRef.current?.focus(), 120);
      } else {
        await onPickDestination(item);
        setDestSuspended(true);
        setDestToken(newSessionToken());
        onClose();
      }
    } catch (e) {
      setDetailsError(
        e instanceof Error ? e.message : 'Impossible de récupérer ce lieu.'
      );
    } finally {
      setPicking(false);
    }
  }

  return (
    <Modal
      visible={visible}
      animationType="slide"
      presentationStyle="pageSheet"
      onRequestClose={onClose}
    >
      <SafeAreaView style={styles.itinRoot}>
        <View style={styles.itinHeader}>
          <Pressable
            style={({ pressed }) => [styles.itinClose, pressed && styles.itinPressed]}
            onPress={onClose}
          >
            <Ionicons name="close" size={22} color="#0f172a" />
          </Pressable>
          <Text style={styles.itinTitle}>Itinéraire</Text>
          <View style={styles.itinHeaderRight} />
        </View>

        <View style={styles.itinInputsCard}>
          <View style={styles.itinLeftRail}>
            <View style={[styles.itinDot, styles.itinDotFilled]} />
            <View style={styles.itinRailLine} />
            <View style={[styles.itinDot, styles.itinDotHollow]} />
          </View>

          <View style={styles.itinFields}>
            <Animated.View
              style={[
                styles.itinRowSlot,
                active === 'pickup' && styles.itinRowSlotActive,
                { transform: [{ scale: pickupRowScale }] },
              ]}
            >
              <View style={styles.itinRow}>
                <Text
                  style={[
                    styles.itinRowLabel,
                    active === 'pickup' && styles.itinRowLabelActive,
                  ]}
                >
                  Prise en charge
                </Text>
                <TextInput
                  ref={pickupRef}
                  style={styles.itinPickupInput}
                  value={pickupQuery}
                  onChangeText={(v) => {
                    onPickupQueryChange(v);
                    setPickupSuspended(false);
                    setDetailsError(null);
                  }}
                  placeholder="Lieu de prise en charge"
                  placeholderTextColor="#9ca3af"
                  returnKeyType="next"
                  autoCorrect={false}
                  autoCapitalize="none"
                  editable={!picking && !configError}
                  onFocus={() => setActive('pickup')}
                onSubmitEditing={() => {
                  if (pickupQuery.trim()) {
                    setActive('destination');
                    destRef.current?.focus();
                  } else {
                    pickupRef.current?.focus();
                  }
                }}
                />
              </View>
            </Animated.View>

            <View style={styles.itinDivider} />

            <Animated.View
              style={[
                styles.itinRowSlot,
                active === 'destination' && styles.itinRowSlotActive,
                { transform: [{ scale: destRowScale }] },
              ]}
            >
              <View style={styles.itinRow}>
                <Text
                  style={[
                    styles.itinRowLabel,
                    active === 'destination' && styles.itinRowLabelActive,
                  ]}
                >
                  Destination
                </Text>
                <TextInput
                  ref={destRef}
                  style={styles.itinDestinationInput}
                  value={destinationQuery}
                  onChangeText={(v) => {
                    onDestinationQueryChange(v);
                    setDestSuspended(false);
                    setDetailsError(null);
                  }}
                  placeholder="Lieu d’arrivée"
                  placeholderTextColor="#9ca3af"
                  returnKeyType="search"
                  autoCorrect={false}
                  autoCapitalize="none"
                  editable={!picking && !configError}
                  onFocus={() => setActive('destination')}
                />
              </View>
            </Animated.View>
          </View>
        </View>

        {configError ? <Text style={styles.itinError}>{configError}</Text> : null}
        {current.error ? <Text style={styles.itinError}>{current.error}</Text> : null}
        {detailsError ? <Text style={styles.itinError}>{detailsError}</Text> : null}

        {current.loading ? (
          <View style={styles.itinLoadingRow}>
            <ActivityIndicator size="small" color={BRAND_PRIMARY} />
            <Text style={styles.itinLoadingText}>Recherche…</Text>
          </View>
        ) : null}

        <View style={styles.itinSuggestions}>
          <Pressable
            style={({ pressed }) => [
              styles.itinSuggestRow,
              pressed && styles.itinSuggestRowPressed,
            ]}
            onPress={() => {
              onUseCurrentLocation();
              setPickupSuspended(true);
              setActive('destination');
              setTimeout(() => destRef.current?.focus(), 120);
            }}
          >
            <Text style={styles.itinSuggestPrimary}>
              📍 Emplacement actuel
            </Text>
            <Text style={styles.itinSuggestSecondary} numberOfLines={1}>
              {pickupIsGps ? 'Utilisé actuellement' : 'Utiliser la position GPS'}
            </Text>
          </Pressable>

          {showSuggestions
            ? current.suggestions.map((s) => (
              <Pressable
                key={s.placeId}
                style={({ pressed }) => [
                  styles.itinSuggestRow,
                  pressed && styles.itinSuggestRowPressed,
                ]}
                onPress={() => void handlePick(s)}
              >
                <Text style={styles.itinSuggestPrimary}>{s.primaryText}</Text>
                {s.secondaryText ? (
                  <Text style={styles.itinSuggestSecondary}>{s.secondaryText}</Text>
                ) : null}
              </Pressable>
            ))
            : null}
        </View>
      </SafeAreaView>
    </Modal>
  );
}

function ClientHomeMiddleContent(props: {
  userId: string;
  stripePublishableConfigured: boolean;
  profile: Profile;
  onDevResetRole: () => Promise<void>;
}) {
  const { userId, stripePublishableConfigured, profile, onDevResetRole } = props;
  const [tab, setTab] = useState<'home' | 'trips' | 'account'>('home');
  const [itineraryOpen, setItineraryOpen] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false);
  const [signingOut, setSigningOut] = useState(false);
  const [resettingRole, setResettingRole] = useState(false);
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
    if (ride && tab !== 'home') {
      setTab('home');
    }
  }, [ride, tab]);
  const location = useClientLocation();
  const [searchInput, setSearchInput] = useState('');
  const [structuredDestination, setStructuredDestination] =
    useState<ClientDestination | null>(null);
  const [pickupMode, setPickupMode] = useState<'gps' | 'manual'>('gps');
  /**
   * UX Itinéraire: le champ pickup reste vide tant que l’utilisateur n’a pas
   * choisi explicitement un pickup (GPS ou manuel). Les coords GPS restent la
   * valeur par défaut pour commander, mais l’input n’est pas auto-rempli.
   */
  const [pickupChoice, setPickupChoice] = useState<'unset' | 'gps' | 'manual'>(
    'unset'
  );
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

  const sheetAnim = useRef(new Animated.Value(0)).current;
  useEffect(() => {
    Animated.timing(sheetAnim, {
      toValue: 1,
      duration: 280,
      easing: Easing.out(Easing.cubic),
      useNativeDriver: true,
    }).start();
  }, [sheetAnim]);

  const orderCta = usePressScale(0.98);
  const payCta = usePressScale(0.98);

  // État “trajet déjà choisi” = destination fixée, pas encore de ride.
  // Il doit basculer sur un écran résumé (type Bolt) sans aucune UI de saisie.
  const showBoltTripSummary = !ride && structuredDestination != null;

  function splitAddress(label: string): { primary: string; secondary: string | null } {
    const raw = label.trim();
    if (!raw) return { primary: '—', secondary: null };
    const parts = raw.split(',').map((p) => p.trim()).filter(Boolean);
    if (parts.length <= 1) return { primary: raw, secondary: null };
    return { primary: parts[0], secondary: parts.slice(1).join(', ') };
  }

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
    (nextTab: 'home' | 'trips' | 'account' = 'home') => {
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
      setPickupChoice('unset');
      setPickupSuggestionsSuspended(false);
      setPickupDetailsError(null);
      if (location.phase === 'ready') {
        setPickupMode('gps');
      } else {
        setPickupMode('manual');
      }

      setTerminalSummary(null);
      setShowCompletionModal(false);
      setTab(nextTab);

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

  function resetTripSelection() {
    setStructuredDestination(null);
    setSearchInput('');
    setSuggestionsSuspended(false);
    setDetailsError(null);
    setOrderError(null);
    // Pickup: on garde la géoloc dispo, mais on revient à l’intention “non choisi”.
    setStructuredPickup(null);
    setPickupSearchInput('');
    setPickupChoice('unset');
    setPickupSuggestionsSuspended(false);
    setPickupDetailsError(null);
    if (location.phase === 'ready') {
      setPickupMode('gps');
    } else {
      setPickupMode('manual');
    }
  }

  function openItineraryFromSummary() {
    setItineraryOpen(true);
  }

  function handlePickupSearchChange(value: string) {
    setPickupSearchInput(value);
    setPickupChoice('manual');
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
        // IMPORTANT UX: garder le libellé exact choisi par le client si possible.
        pickup_label: pickupForUi?.label ?? pickupLabel,
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
      // UX: conserver le libellé choisi par l’utilisateur (suggestion), pas une
      // adresse normalisée/générique renvoyée par Place Details.
      const displayLabel = item.fullDescription?.trim() || details.label;
      setStructuredDestination({
        label: displayLabel,
        latitude: details.latitude,
        longitude: details.longitude,
        placeId: details.placeId,
      });
      setSearchInput(displayLabel);
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
    setPickupChoice('manual');
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
      // UX: idem pickup — conserver le libellé choisi par le client.
      const displayLabel = item.fullDescription?.trim() || details.label;
      setStructuredPickup({
        label: displayLabel,
        latitude: details.latitude,
        longitude: details.longitude,
        placeId: details.placeId,
      });
      setPickupSearchInput(displayLabel);
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

  async function handleSignOut() {
    setSigningOut(true);
    try {
      await supabase.auth.signOut();
    } finally {
      setSigningOut(false);
    }
  }

  async function handleDevResetRole() {
    setResettingRole(true);
    try {
      await onDevResetRole();
      setMenuOpen(false);
    } finally {
      setResettingRole(false);
    }
  }

  return (
    <View style={styles.boltRoot}>
      <ClientMapBlock
        location={location}
        variant="fullscreen"
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

      <LinearGradient
        pointerEvents="none"
        colors={[
          'rgba(255,255,255,0)',
          'rgba(255,255,255,0.65)',
          'rgba(255,255,255,1)',
        ]}
        locations={[0, 0.55, 1]}
        style={styles.mapScrim}
      />

      <SafeAreaView pointerEvents="box-none" style={styles.safeTop}>
        <Pressable
          style={({ pressed }) => [
            styles.floatingMenuButton,
            pressed && styles.floatingMenuButtonPressed,
          ]}
          onPress={() => setMenuOpen(true)}
        >
          <Text style={styles.floatingMenuIcon}>≡</Text>
        </Pressable>
      </SafeAreaView>

      {showBoltTripSummary ? (
        <SafeAreaView pointerEvents="box-none" style={styles.tripSummarySafeTop}>
          <View style={styles.tripSummaryBar}>
            <Pressable
              style={({ pressed }) => [
                styles.tripSummaryIconBtn,
                pressed && styles.tripSummaryIconBtnPressed,
              ]}
              onPress={openItineraryFromSummary}
            >
              <Ionicons name="close" size={18} color="#0f172a" />
            </Pressable>

            <View style={styles.tripSummaryTextWrap}>
              <Text style={styles.tripSummaryText} numberOfLines={1}>
                {(pickupForUi?.label?.trim() || 'Emplacement actuel') + ' → ' + (destinationForUi?.label?.trim() || 'Destination')}
              </Text>
            </View>

            <Pressable
              style={({ pressed }) => [
                styles.tripSummaryIconBtn,
                pressed && styles.tripSummaryIconBtnPressed,
              ]}
              onPress={() => undefined}
            >
              <Ionicons name="add" size={18} color="#0f172a" />
            </Pressable>
          </View>
        </SafeAreaView>
      ) : null}

      <Modal
        visible={menuOpen}
        transparent
        animationType="fade"
        onRequestClose={() => setMenuOpen(false)}
      >
        <Pressable
          style={styles.menuBackdrop}
          onPress={() => setMenuOpen(false)}
        >
          <Pressable style={styles.menuCard} onPress={() => undefined}>
            <Text style={styles.menuTitle}>Menu</Text>
            <Pressable
              style={({ pressed }) => [
                styles.menuItem,
                pressed && styles.menuItemPressed,
              ]}
              onPress={() => {
                setMenuOpen(false);
                setTab('account');
              }}
            >
              <Text style={styles.menuItemText}>Compte</Text>
            </Pressable>
            <Pressable
              style={({ pressed }) => [
                styles.menuItem,
                pressed && styles.menuItemPressed,
              ]}
              onPress={() => {
                setMenuOpen(false);
                setTab('trips');
              }}
            >
              <Text style={styles.menuItemText}>Trajets</Text>
            </Pressable>
            <Pressable
              style={({ pressed }) => [
                styles.menuItem,
                pressed && styles.menuItemPressed,
              ]}
              disabled={signingOut}
              onPress={() => void handleSignOut()}
            >
              <Text style={styles.menuItemText}>
                {signingOut ? 'Déconnexion…' : 'Se déconnecter'}
              </Text>
            </Pressable>
            <Pressable
              style={({ pressed }) => [
                styles.menuItem,
                pressed && styles.menuItemPressed,
              ]}
              disabled={resettingRole}
              onPress={() => void handleDevResetRole()}
            >
              <Text style={styles.menuItemMuted}>
                {resettingRole ? 'Reset rôle…' : 'Réinitialiser le rôle (dev)'}
              </Text>
            </Pressable>
          </Pressable>
        </Pressable>
      </Modal>

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

      <ClientItineraryModal
        visible={itineraryOpen}
        location={location}
        pickupQuery={
          pickupChoice === 'manual'
            ? pickupSearchInput
            : pickupChoice === 'gps'
              ? pickupForUi?.label?.trim() || ''
              : ''
        }
        onPickupQueryChange={handlePickupSearchChange}
        pickupIsGps={pickupChoice === 'gps'}
        destinationQuery={searchInput}
        onDestinationQueryChange={handleSearchChange}
        onClose={() => setItineraryOpen(false)}
        onUseCurrentLocation={() => {
          setPickupMode('gps');
          setPickupChoice('gps');
          setStructuredPickup(null);
          setPickupSearchInput('');
          setPickupSuggestionsSuspended(false);
          setPickupDetailsError(null);
        }}
        onPickPickup={async (item) => {
          await handlePickPickupSuggestion(item);
        }}
        onPickDestination={async (item) => {
          await handlePickSuggestion(item);
        }}
      />

      <View style={styles.bottomSheet}>
        <View style={styles.sheetGrabber} />

        {tab === 'trips' ? (
          <View style={styles.sheetBody}>
            <ClientRideHistoryScreen userId={userId} onBack={() => setTab('home')} />
          </View>
        ) : tab === 'account' ? (
          <View style={styles.sheetBody}>
            <Text style={styles.sheetTitle}>Compte</Text>
            <View style={styles.accountCard}>
              <Text style={styles.accountLabel}>Nom</Text>
              <Text style={styles.accountValue}>
                {profile.full_name?.trim() ? profile.full_name : '—'}
              </Text>
              <Text style={[styles.accountLabel, styles.accountLabelSpaced]}>
                Téléphone
              </Text>
              <Text style={styles.accountValue}>
                {profile.phone?.trim() ? profile.phone : '—'}
              </Text>
              <Text style={[styles.accountLabel, styles.accountLabelSpaced]}>
                Rôle
              </Text>
              <Text style={styles.accountValue}>{profile.role}</Text>
            </View>
            <Text style={styles.sheetHint}>
              MVP : cet onglet affichera plus d’options bientôt.
            </Text>
          </View>
        ) : (
          <Animated.ScrollView
            style={[
              styles.sheetBody,
              {
                opacity: sheetAnim,
                transform: [
                  {
                    translateY: sheetAnim.interpolate({
                      inputRange: [0, 1],
                      outputRange: [18, 0],
                    }),
                  },
                ],
              },
            ]}
            contentContainerStyle={styles.sheetContent}
            keyboardShouldPersistTaps="handled"
            keyboardDismissMode="on-drag"
            showsVerticalScrollIndicator={false}
          >
            {!ride && !structuredDestination ? (
              <>
                <View style={styles.itinTeaserHeader}>
                  <Text style={styles.sheetTitle}>Où allez-vous ?</Text>
                  <Text style={styles.sheetHint}>
                    Départ : {pickupForUi?.label?.trim() || 'Position actuelle'}
                  </Text>
                </View>

                <Pressable
                  style={({ pressed }) => [
                    styles.itinTeaserCard,
                    pressed && styles.itinTeaserCardPressed,
                  ]}
                  onPress={() => setItineraryOpen(true)}
                >
                  <View style={styles.itinTeaserLeftRail}>
                    <View style={[styles.itinDot, styles.itinDotFilled]} />
                    <View style={styles.itinRailLine} />
                    <View style={[styles.itinDot, styles.itinDotHollow]} />
                  </View>
                  <View style={styles.itinTeaserTexts}>
                    <Text style={styles.itinTeaserPickup} numberOfLines={1}>
                      {pickupForUi?.label?.trim() || 'Lieu de prise en charge'}
                    </Text>
                    <Text style={styles.itinTeaserDestination} numberOfLines={1}>
                      Lieu d’arrivée
                    </Text>
                  </View>
                  <Ionicons
                    name="chevron-forward"
                    size={20}
                    color="#94a3b8"
                  />
                </Pressable>
              </>
            ) : showBoltTripSummary ? (
              <>
                <View style={styles.boltPriceCard}>
                  <Text style={styles.boltPriceLabel}>Estimation</Text>

                  <View style={styles.boltTripRow}>
                    <View style={styles.boltTripColLeft}>
                      <View style={styles.boltTripLabelRow}>
                        <View
                          style={[styles.boltTripDot, styles.boltTripDotPickup]}
                        />
                        <Text style={styles.boltTripLabel} numberOfLines={1}>
                          Départ
                        </Text>
                      </View>
                      {(() => {
                        const label =
                          pickupForUi?.label?.trim() || 'Emplacement actuel';
                        const a = splitAddress(label);
                        return (
                          <>
                            <Text style={styles.boltTripValuePrimary} numberOfLines={1}>
                              {a.primary}
                            </Text>
                            {a.secondary ? (
                              <Text style={styles.boltTripValueSecondary} numberOfLines={1}>
                                {a.secondary}
                              </Text>
                            ) : null}
                          </>
                        );
                      })()}
                    </View>

                    <View style={styles.boltTripArrowCol}>
                      <Ionicons
                        name="arrow-forward"
                        size={18}
                        color="#94a3b8"
                      />
                    </View>

                    <View style={styles.boltTripColRight}>
                      <View style={styles.boltTripLabelRowRight}>
                        <Text style={styles.boltTripLabel} numberOfLines={1}>
                          Arrivée
                        </Text>
                        <View
                          style={[styles.boltTripDot, styles.boltTripDotDest]}
                        />
                      </View>
                      {(() => {
                        const label = destinationForUi?.label?.trim() || '—';
                        const a = splitAddress(label);
                        return (
                          <>
                            <Text
                              style={[
                                styles.boltTripValuePrimary,
                                styles.boltTripValueRight,
                              ]}
                              numberOfLines={1}
                            >
                              {a.primary}
                            </Text>
                            {a.secondary ? (
                              <Text
                                style={[
                                  styles.boltTripValueSecondary,
                                  styles.boltTripValueRight,
                                ]}
                                numberOfLines={1}
                              >
                                {a.secondary}
                              </Text>
                            ) : null}
                          </>
                        );
                      })()}
                    </View>
                  </View>

                  <Text style={styles.boltPriceValue}>
                    {ridePricing?.estimatedPriceEuro != null &&
                    Number.isFinite(ridePricing.estimatedPriceEuro)
                      ? `${ridePricing.estimatedPriceEuro.toFixed(2)} €`
                      : '—'}
                  </Text>
                  {ridePricing?.estimatedPriceAriary != null &&
                  Number.isFinite(ridePricing.estimatedPriceAriary) ? (
                    <Text style={styles.boltPriceSub}>
                      {formatAriary(ridePricing.estimatedPriceAriary)} Ar
                    </Text>
                  ) : null}

                </View>
              </>
            ) : (
              <>
                <Text style={styles.sheetTitle}>Où allez-vous ?</Text>
                <Text style={styles.sheetHint}>
                  Départ : {pickupForUi?.label?.trim() || 'Position actuelle'}
                </Text>

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
                    onPickSuggestion={(item) =>
                      void handlePickPickupSuggestion(item)
                    }
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

                <ZonePricingCard
                  estimate={ridePricing}
                  hasDestination={destinationForUi !== null}
                />
              </>
            )}

            {structuredDestination || ride != null ? (
              <View style={styles.orderBlock}>
          {showBoltTripSummary ? null : rideFetchLoading && !ride ? (
            <View style={styles.rideFetchLoadingRow}>
              <ActivityIndicator size="small" color="#0f766e" />
              <Text style={styles.rideFetchLoadingText}>
                Chargement de votre course…
              </Text>
            </View>
          ) : null}
          {showBoltTripSummary ? null : rideFetchError ? (
            <Text style={styles.orderError}>{rideFetchError}</Text>
          ) : null}

          {/* ÉTAT RÉSUMÉ (Bolt): uniquement Commander (pas d’état ride / pas de texte) */}
          {showBoltTripSummary && structuredDestination ? (
            <Animated.View
              style={{
                transform: [{ scale: orderCta.scale }],
              }}
            >
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
                onPressIn={orderCta.onPressIn}
                onPressOut={orderCta.onPressOut}
                onPress={() => void handleOrderPress()}
              >
                {orderLoading ? (
                  <ActivityIndicator color="#fff" />
                ) : (
                  <Text style={styles.orderButtonLabel}>Commander</Text>
                )}
              </Pressable>
            </Animated.View>
          ) : structuredDestination ? (
            <Animated.View
              style={{
                transform: [{ scale: orderCta.scale }],
              }}
            >
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
                onPressIn={orderCta.onPressIn}
                onPressOut={orderCta.onPressOut}
                onPress={() => void handleOrderPress()}
              >
                {orderLoading ? (
                  <ActivityIndicator color="#fff" />
                ) : (
                  <Text style={styles.orderButtonLabel}>Commander</Text>
                )}
              </Pressable>
            </Animated.View>
          ) : null}
          {!destinationForUi && ride != null ? (
            <Text style={styles.orderHint}>
              Une course est en cours sans destination affichable. Vérifiez la
              connexion ou contactez le support.
            </Text>
          ) : null}
          {!showBoltTripSummary &&
          !canOrder &&
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
          {/* En mode résumé: on supprime les messages d’état ride (ils appartiennent aux étapes suivantes). */}
          {!showBoltTripSummary && ride ? (
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
          {!showBoltTripSummary && driverHint ? (
            <Text style={styles.orderHint}>{driverHint}</Text>
          ) : null}
          {!showBoltTripSummary && rideRealtimeError ? (
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
              <Animated.View style={{ transform: [{ scale: payCta.scale }] }}>
                <Pressable
                  style={({ pressed }) => [
                    styles.orderPayButton,
                    paymentSheetLoading && styles.orderButtonDisabled,
                    pressed &&
                      !paymentSheetLoading &&
                      styles.orderPayButtonPressed,
                  ]}
                  disabled={paymentSheetLoading}
                  onPressIn={payCta.onPressIn}
                  onPressOut={payCta.onPressOut}
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
              </Animated.View>
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
          </Animated.ScrollView>
        )}
      </View>

      <SafeAreaView style={styles.bottomNavSafe} pointerEvents="box-none">
        <View style={styles.bottomNav}>
          <Pressable
            style={({ pressed }) => [
              styles.navItem,
              pressed && styles.navItemPressed,
              tab === 'home' && styles.navItemActive,
            ]}
            onPress={() => setTab('home')}
          >
            <Ionicons
              name={tab === 'home' ? 'home' : 'home-outline'}
              size={NAV_ICON_SIZE}
              color={tab === 'home' ? BRAND_PRIMARY : ICON_INACTIVE}
            />
            <Text style={tab === 'home' ? styles.navTextActive : styles.navText}>
              Accueil
            </Text>
          </Pressable>
          <Pressable
            style={({ pressed }) => [
              styles.navItem,
              pressed && styles.navItemPressed,
              tab === 'trips' && styles.navItemActive,
            ]}
            onPress={() => setTab('trips')}
          >
            <Ionicons
              name={tab === 'trips' ? 'time' : 'time-outline'}
              size={NAV_ICON_SIZE}
              color={tab === 'trips' ? BRAND_PRIMARY : ICON_INACTIVE}
            />
            <Text style={tab === 'trips' ? styles.navTextActive : styles.navText}>
              Trajets
            </Text>
          </Pressable>
          <Pressable
            style={({ pressed }) => [
              styles.navItem,
              pressed && styles.navItemPressed,
              tab === 'account' && styles.navItemActive,
            ]}
            onPress={() => setTab('account')}
          >
            <Ionicons
              name={tab === 'account' ? 'person' : 'person-outline'}
              size={NAV_ICON_SIZE}
              color={tab === 'account' ? BRAND_PRIMARY : ICON_INACTIVE}
            />
            <Text
              style={tab === 'account' ? styles.navTextActive : styles.navText}
            >
              Compte
            </Text>
          </Pressable>
        </View>
      </SafeAreaView>

      <StatusBar barStyle="dark-content" />
    </View>
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
      <ClientHomeMiddleContent
        userId={session.user.id}
        stripePublishableConfigured={stripePublishableConfigured}
        profile={profile}
        onDevResetRole={onDevResetRole}
      />
    </ClientStripeRoot>
  );
}

const styles = StyleSheet.create({
  boltRoot: {
    flex: 1,
    backgroundColor: '#000',
  },
  tripSummarySafeTop: {
    position: 'absolute',
    top: 0,
    left: 0,
    right: 0,
    paddingTop: (Platform.OS === 'android' ? StatusBar.currentHeight ?? 0 : 0) + 12,
    paddingHorizontal: 72, // laisse respirer autour du bouton menu
  },
  tripSummaryBar: {
    backgroundColor: '#fff',
    borderRadius: 999,
    paddingVertical: 10,
    paddingHorizontal: 10,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
    shadowColor: '#000',
    shadowOpacity: 0.1,
    shadowRadius: 10,
    shadowOffset: { width: 0, height: 6 },
    elevation: 6,
  },
  tripSummaryIconBtn: {
    width: 36,
    height: 36,
    borderRadius: 999,
    backgroundColor: '#f3f4f6',
    alignItems: 'center',
    justifyContent: 'center',
  },
  tripSummaryIconBtnPressed: {
    opacity: 0.9,
  },
  tripSummaryTextWrap: {
    flex: 1,
  },
  tripSummaryText: {
    fontSize: 14,
    fontWeight: '800',
    color: '#0f172a',
  },
  mapScrim: {
    position: 'absolute',
    left: 0,
    right: 0,
    bottom: 78,
    height: 120,
  },
  safeTop: {
    position: 'absolute',
    top: 0,
    left: 0,
    right: 0,
    paddingTop: (Platform.OS === 'android' ? StatusBar.currentHeight ?? 0 : 0) + 12,
    paddingHorizontal: 16,
  },
  floatingMenuButton: {
    width: 48,
    height: 48,
    borderRadius: 999,
    backgroundColor: '#fff',
    alignItems: 'center',
    justifyContent: 'center',
    shadowColor: '#000',
    shadowOpacity: 0.1,
    shadowRadius: 10,
    shadowOffset: { width: 0, height: 6 },
    elevation: 6,
  },
  floatingMenuButtonPressed: {
    opacity: 0.92,
  },
  floatingMenuIcon: {
    fontSize: 20,
    fontWeight: '900',
    color: '#0f172a',
  },
  menuBackdrop: {
    flex: 1,
    backgroundColor: 'rgba(15, 23, 42, 0.35)',
    padding: 16,
    justifyContent: 'flex-start',
  },
  menuCard: {
    marginTop: 56,
    width: '100%',
    maxWidth: 360,
    borderRadius: 18,
    backgroundColor: '#fff',
    paddingVertical: 10,
    paddingHorizontal: 10,
    borderWidth: 1,
    borderColor: '#e5e7eb',
  },
  menuTitle: {
    fontSize: 14,
    fontWeight: '800',
    color: '#0f172a',
    paddingHorizontal: 10,
    paddingVertical: 8,
  },
  menuItem: {
    paddingVertical: 12,
    paddingHorizontal: 10,
    borderRadius: 12,
  },
  menuItemPressed: {
    backgroundColor: '#f1f5f9',
  },
  menuItemText: {
    fontSize: 15,
    fontWeight: '700',
    color: '#0f172a',
  },
  menuItemMuted: {
    fontSize: 14,
    fontWeight: '600',
    color: '#64748b',
  },
  bottomSheet: {
    position: 'absolute',
    left: 0,
    right: 0,
    bottom: 78,
    maxHeight: '62%',
    backgroundColor: '#fff',
    borderTopLeftRadius: 24,
    borderTopRightRadius: 24,
    paddingTop: 10,
    paddingHorizontal: 20,
    paddingBottom: 14,
    shadowColor: '#000',
    shadowOpacity: 0.1,
    shadowRadius: 12,
    shadowOffset: { width: 0, height: -4 },
    elevation: 8,
  },
  sheetGrabber: {
    alignSelf: 'center',
    width: 40,
    height: 4,
    borderRadius: 999,
    backgroundColor: '#e5e7eb',
    marginBottom: 12,
  },
  sheetBody: {
    paddingHorizontal: 0,
    paddingBottom: 0,
  },
  sheetContent: {
    paddingBottom: 8,
  },
  sheetTitle: {
    fontSize: 22,
    fontWeight: '900',
    color: '#0f172a',
    marginBottom: 4,
  },
  sheetHint: {
    fontSize: 13,
    fontWeight: '600',
    color: '#64748b',
    marginBottom: 14,
  },
  boltPriceCard: {
    borderWidth: 1,
    borderColor: '#e5e7eb',
    borderRadius: 18,
    backgroundColor: '#fff',
    padding: 16,
    marginTop: 6,
    marginBottom: 6,
  },
  boltTripRow: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    justifyContent: 'space-between',
    gap: 12,
    marginBottom: 14,
  },
  boltTripColLeft: {
    width: '40%',
    alignItems: 'flex-start',
  },
  boltTripColRight: {
    width: '40%',
    alignItems: 'flex-end',
  },
  boltTripArrowCol: {
    width: '20%',
    alignItems: 'center',
    justifyContent: 'center',
    paddingTop: 18,
  },
  boltTripLabelRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    marginBottom: 6,
  },
  boltTripLabelRowRight: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    marginBottom: 6,
    justifyContent: 'flex-end',
    alignSelf: 'flex-end',
  },
  boltTripLabel: {
    fontSize: 12,
    fontWeight: '800',
    color: '#64748b',
    textTransform: 'uppercase',
    letterSpacing: 0.5,
    flexShrink: 1,
  },
  boltTripValuePrimary: {
    fontSize: 14,
    fontWeight: '800',
    color: '#0f172a',
    lineHeight: 18,
  },
  boltTripValueSecondary: {
    marginTop: 4,
    fontSize: 13,
    fontWeight: '700',
    color: '#64748b',
    lineHeight: 18,
  },
  boltTripValueRight: {
    textAlign: 'right',
    alignSelf: 'flex-end',
  },
  boltTripDot: {
    width: 10,
    height: 10,
    borderRadius: 999,
  },
  boltTripDotPickup: {
    backgroundColor: BRAND_PRIMARY,
  },
  boltTripDotDest: {
    backgroundColor: '#ef4444',
  },
  boltPriceLabel: {
    fontSize: 12,
    fontWeight: '800',
    color: '#64748b',
    textTransform: 'uppercase',
    letterSpacing: 0.5,
    marginBottom: 8,
  },
  boltPriceValue: {
    fontSize: 28,
    fontWeight: '900',
    color: BRAND_PRIMARY,
    letterSpacing: -0.5,
  },
  boltPriceSub: {
    marginTop: 4,
    fontSize: 14,
    fontWeight: '700',
    color: '#64748b',
  },
  boltZones: {
    marginTop: 10,
    fontSize: 13,
    fontWeight: '600',
    color: '#64748b',
    lineHeight: 18,
  },
  itinTeaserHeader: {
    marginBottom: 12,
  },
  itinTeaserCard: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
    borderWidth: 1,
    borderColor: '#e5e7eb',
    borderRadius: 16,
    paddingHorizontal: 14,
    paddingVertical: 12,
    backgroundColor: '#f8fafc',
    marginBottom: 6,
  },
  itinTeaserCardPressed: {
    opacity: 0.92,
  },
  itinTeaserLeftRail: {
    width: 18,
    alignItems: 'center',
  },
  itinDot: {
    width: 10,
    height: 10,
    borderRadius: 999,
  },
  itinDotFilled: {
    backgroundColor: '#0f172a',
  },
  itinDotHollow: {
    borderWidth: 2,
    borderColor: '#0f172a',
    backgroundColor: 'transparent',
  },
  itinRailLine: {
    width: 2,
    flex: 1,
    backgroundColor: '#cbd5e1',
    marginVertical: 6,
    borderRadius: 999,
    minHeight: 14,
  },
  itinTeaserTexts: {
    flex: 1,
    gap: 8,
  },
  itinTeaserPickup: {
    fontSize: 15,
    fontWeight: '800',
    color: '#0f172a',
  },
  itinTeaserDestination: {
    fontSize: 15,
    fontWeight: '700',
    color: '#9ca3af',
  },
  itinRoot: {
    flex: 1,
    backgroundColor: '#fff',
    paddingHorizontal: 20,
  },
  itinHeader: {
    height: 56,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
  },
  itinClose: {
    width: 44,
    height: 44,
    borderRadius: 999,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: '#f3f4f6',
  },
  itinHeaderRight: {
    width: 44,
    height: 44,
  },
  itinTitle: {
    fontSize: 17,
    fontWeight: '900',
    color: '#0f172a',
  },
  itinPressed: {
    opacity: 0.9,
  },
  itinInputsCard: {
    flexDirection: 'row',
    gap: 12,
    borderRadius: 16,
    backgroundColor: '#f9fafb',
    borderWidth: 1,
    borderColor: '#e5e7eb',
    padding: 14,
    marginTop: 8,
  },
  itinLeftRail: {
    width: 18,
    alignItems: 'center',
    paddingTop: 8,
    paddingBottom: 8,
  },
  itinFields: {
    flex: 1,
    gap: 4,
  },
  itinRowSlot: {
    borderRadius: 12,
    borderWidth: 1.5,
    borderColor: 'transparent',
    backgroundColor: 'transparent',
    paddingHorizontal: 10,
    paddingVertical: 6,
  },
  itinRowSlotActive: {
    borderColor: 'rgba(15, 118, 110, 0.45)',
    backgroundColor: 'rgba(15, 118, 110, 0.07)',
    shadowColor: BRAND_PRIMARY,
    shadowOffset: { width: 0, height: 2 },
    shadowOpacity: 0.08,
    shadowRadius: 6,
    elevation: 2,
  },
  itinRow: {
    minHeight: 56,
    justifyContent: 'center',
  },
  itinRowLabel: {
    fontSize: 12,
    fontWeight: '700',
    color: '#6b7280',
    marginBottom: 4,
  },
  itinRowLabelActive: {
    color: BRAND_PRIMARY,
  },
  itinPickupInput: {
    fontSize: 16,
    fontWeight: '800',
    color: '#0f172a',
    paddingVertical: 0,
  },
  itinDivider: {
    height: 1,
    backgroundColor: '#e5e7eb',
  },
  itinDestinationInput: {
    fontSize: 16,
    fontWeight: '800',
    color: '#0f172a',
    paddingVertical: 0,
  },
  itinError: {
    marginTop: 12,
    color: '#b91c1c',
    fontSize: 13,
    lineHeight: 18,
  },
  itinLoadingRow: {
    marginTop: 14,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
  },
  itinLoadingText: {
    color: '#64748b',
    fontWeight: '600',
  },
  itinSuggestions: {
    marginTop: 12,
    borderWidth: 1,
    borderColor: '#e5e7eb',
    borderRadius: 16,
    overflow: 'hidden',
  },
  itinSuggestRow: {
    paddingVertical: 12,
    paddingHorizontal: 14,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: '#e5e7eb',
    backgroundColor: '#fff',
  },
  itinSuggestRowPressed: {
    backgroundColor: '#f1f5f9',
  },
  itinSuggestPrimary: {
    fontSize: 16,
    fontWeight: '700',
    color: '#0f172a',
  },
  itinSuggestSecondary: {
    marginTop: 2,
    fontSize: 13,
    color: '#64748b',
  },
  accountCard: {
    borderWidth: 1,
    borderColor: '#e5e7eb',
    borderRadius: 18,
    backgroundColor: '#fff',
    padding: 14,
    marginTop: 10,
  },
  accountLabel: {
    fontSize: 12,
    color: '#6b7280',
    fontWeight: '700',
    textTransform: 'uppercase',
    letterSpacing: 0.4,
    marginBottom: 4,
  },
  accountLabelSpaced: {
    marginTop: 12,
  },
  accountValue: {
    fontSize: 16,
    fontWeight: '800',
    color: '#0f172a',
  },
  bottomNavSafe: {
    position: 'absolute',
    left: 0,
    right: 0,
    bottom: 0,
    backgroundColor: 'transparent',
  },
  bottomNav: {
    height: 78,
    backgroundColor: '#fff',
    borderTopWidth: 1,
    borderTopColor: '#e5e7eb',
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-around',
    paddingHorizontal: 12,
    paddingBottom: 8,
  },
  navItem: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    minHeight: 52,
    paddingVertical: 6,
    gap: 4,
    borderRadius: 999,
  },
  navItemPressed: {
    opacity: 0.9,
  },
  navItemActive: {
    backgroundColor: '#f1f5f9',
  },
  navText: {
    fontSize: 12,
    fontWeight: '700',
    color: ICON_INACTIVE,
  },
  navTextActive: {
    fontSize: 12,
    fontWeight: '800',
    color: BRAND_PRIMARY,
  },
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
    marginBottom: 10,
    padding: 0,
    borderRadius: 18,
    backgroundColor: '#fff',
    borderWidth: 0,
  },
  destinationTitle: {
    fontSize: 16,
    fontWeight: '800',
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
  destinationInputRow: {
    flexDirection: 'row',
    alignItems: 'center',
    height: 52,
    borderWidth: 1,
    borderColor: '#e5e7eb',
    borderRadius: 16,
    paddingHorizontal: 12,
    gap: 8,
    backgroundColor: '#f3f4f6',
    marginBottom: 10,
  },
  destinationInputRowFocused: {
    borderColor: BRAND_PRIMARY,
    backgroundColor: '#f8fafc',
  },
  destinationInputField: {
    flex: 1,
    height: 52,
    paddingVertical: 0,
    fontSize: 16,
    color: '#0f172a',
  },
  pickupSearchInput: {
    height: 52,
    borderWidth: 1,
    borderColor: '#e5e7eb',
    borderRadius: 16,
    paddingHorizontal: 16,
    fontSize: 16,
    color: '#0f172a',
    backgroundColor: '#f3f4f6',
    marginBottom: 10,
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
    marginBottom: 8,
    borderWidth: 2,
    borderColor: '#0f766e',
    borderRadius: 999,
    height: 52,
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
    height: 56,
    borderRadius: 999,
    alignItems: 'center',
    justifyContent: 'center',
    minHeight: 48,
    marginTop: 16,
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
    marginTop: 16,
    backgroundColor: '#0f766e',
    height: 56,
    borderRadius: 999,
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
    marginTop: 14,
    height: 52,
    borderRadius: 999,
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
