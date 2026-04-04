import type { Session } from '@supabase/supabase-js';
import * as Location from 'expo-location';
import { type ReactNode, useEffect, useMemo, useState } from 'react';
import {
  ActivityIndicator,
  Keyboard,
  Pressable,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';
import type { Region } from 'react-native-maps';

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
import { formatAriary } from '../lib/taxiPricing';
import type { ClientDestination } from '../types/clientDestination';
import type { RidePricingEstimate } from '../types/ridePricing';
import type { Profile } from '../types/profile';

type Props = {
  session: Session;
  profile: Profile;
  onDevResetRole: () => Promise<void>;
};

function formatCurrentPositionText(location: ClientLocationState): string {
  if (location.phase === 'loading') {
    return 'Recherche en cours…';
  }
  if (location.phase === 'denied' || location.phase === 'error') {
    return 'Non disponible';
  }
  return `${location.latitude.toFixed(5)}, ${location.longitude.toFixed(5)}`;
}

function regionIncludingBoth(
  originLat: number,
  originLng: number,
  dest: ClientDestination | null
): Region {
  if (!dest) {
    return {
      latitude: originLat,
      longitude: originLng,
      latitudeDelta: 0.012,
      longitudeDelta: 0.012,
    };
  }

  const minLat = Math.min(originLat, dest.latitude);
  const maxLat = Math.max(originLat, dest.latitude);
  const minLng = Math.min(originLng, dest.longitude);
  const maxLng = Math.max(originLng, dest.longitude);

  const midLat = (minLat + maxLat) / 2;
  const midLng = (minLng + maxLng) / 2;
  const rawLatDelta = (maxLat - minLat) * 1.6;
  const rawLngDelta = (maxLng - minLng) * 1.6;

  return {
    latitude: midLat,
    longitude: midLng,
    latitudeDelta: Math.max(rawLatDelta, 0.025),
    longitudeDelta: Math.max(rawLngDelta, 0.025),
  };
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

function ClientMapBlock(props: {
  location: ClientLocationState;
  destination: ClientDestination | null;
  routeMetrics: ReturnType<typeof useRouteMetrics>;
}) {
  const { location, destination, routeMetrics } = props;

  if (location.phase === 'loading') {
    return (
      <View style={styles.mapSlot}>
        <ActivityIndicator size="large" color="#0f766e" />
        <Text style={styles.mapHint}>Recherche de votre position…</Text>
      </View>
    );
  }

  if (location.phase === 'denied' || location.phase === 'error') {
    return (
      <View style={styles.mapSlot}>
        <Text style={styles.mapError}>{location.message}</Text>
      </View>
    );
  }

  const { latitude, longitude } = location;
  const region = regionIncludingBoth(latitude, longitude, destination);

  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const Maps = require('react-native-maps') as typeof import('react-native-maps');
  const MapView = Maps.default;
  const Marker = Maps.Marker;

  const mapTitle = destination
    ? 'Carte — départ et destination'
    : 'Carte — votre position';

  return (
    <View style={styles.mapWrapper}>
      <Text style={styles.mapTitle}>{mapTitle}</Text>
      <Text style={styles.coords}>
        Vous : {latitude.toFixed(5)}, {longitude.toFixed(5)}
        {destination
          ? `\nDestination : ${destination.latitude.toFixed(5)}, ${destination.longitude.toFixed(5)}`
          : ''}
      </Text>
      <MapView style={styles.map} region={region} showsCompass>
        <Marker coordinate={{ latitude, longitude }} title="Vous êtes ici" />
        {destination ? (
          <Marker
            coordinate={{
              latitude: destination.latitude,
              longitude: destination.longitude,
            }}
            title="Destination"
            description={destination.label}
            pinColor="#b45309"
          />
        ) : null}
      </MapView>
      {destination ? (
        <View style={styles.mapRouteRow}>
          {routeMetrics.loading ? (
            <View style={styles.mapRouteLoading}>
              <ActivityIndicator size="small" color="#0f766e" />
              <Text style={styles.mapRouteMuted}>Calcul de l’itinéraire…</Text>
            </View>
          ) : routeMetrics.error ? (
            <Text style={styles.mapRouteError} numberOfLines={3}>
              Itinéraire : {routeMetrics.error}
            </Text>
          ) : routeMetrics.distanceKm != null &&
            routeMetrics.durationMinutes != null ? (
            <Text style={styles.mapRouteStats}>
              Environ {routeMetrics.distanceKm.toLocaleString('fr-FR')} km ·{' '}
              {routeMetrics.durationMinutes} min
            </Text>
          ) : null}
        </View>
      ) : null}
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

function ClientHomeMiddleContent() {
  const location = useClientLocation();
  const [searchInput, setSearchInput] = useState('');
  const [structuredDestination, setStructuredDestination] =
    useState<ClientDestination | null>(null);
  const [suggestionsSuspended, setSuggestionsSuspended] = useState(false);
  const [pickingPlace, setPickingPlace] = useState(false);
  const [sessionToken, setSessionToken] = useState(newSessionToken);
  const [detailsError, setDetailsError] = useState<string | null>(null);
  const [pickupLabel, setPickupLabel] = useState<string | null>(null);

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
    destination: structuredDestination,
  });

  const routeMetrics = useRouteMetrics({
    originLat: pickupLat,
    originLng: pickupLng,
    destination: structuredDestination,
  });

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
    if (structuredDestination) {
      setStructuredDestination(null);
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
        destination={structuredDestination}
      />
      <ClientMapBlock
        location={location}
        destination={structuredDestination}
        routeMetrics={routeMetrics}
      />
      <ZonePricingCard
        estimate={ridePricing}
        hasDestination={structuredDestination !== null}
      />
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
  return (
    <SignedInShell
      session={session}
      profile={profile}
      headline="Espace client"
      onDevResetRole={onDevResetRole}
      middleContent={<ClientHomeMiddleContent />}
    />
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
  mapWrapper: {
    width: '100%',
    maxWidth: 400,
    marginBottom: 20,
  },
  mapTitle: {
    fontSize: 16,
    fontWeight: '600',
    color: '#0f172a',
    marginBottom: 6,
    alignSelf: 'flex-start',
  },
  coords: {
    fontSize: 13,
    color: '#64748b',
    marginBottom: 10,
    alignSelf: 'flex-start',
  },
  map: {
    width: '100%',
    height: 260,
    borderRadius: 12,
    overflow: 'hidden',
    borderWidth: 1,
    borderColor: '#e2e8f0',
  },
  mapRouteRow: {
    marginTop: 10,
    minHeight: 22,
  },
  mapRouteLoading: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
  },
  mapRouteMuted: {
    fontSize: 13,
    color: '#64748b',
  },
  mapRouteStats: {
    fontSize: 14,
    fontWeight: '600',
    color: '#0f766e',
  },
  mapRouteError: {
    fontSize: 12,
    color: '#b45309',
    lineHeight: 18,
  },
  mapSlot: {
    width: '100%',
    maxWidth: 400,
    minHeight: 160,
    marginBottom: 20,
    padding: 20,
    borderRadius: 12,
    backgroundColor: '#fff',
    borderWidth: 1,
    borderColor: '#e2e8f0',
    alignItems: 'center',
    justifyContent: 'center',
  },
  mapHint: {
    marginTop: 12,
    fontSize: 14,
    color: '#64748b',
    textAlign: 'center',
  },
  mapError: {
    fontSize: 14,
    color: '#b91c1c',
    textAlign: 'center',
    lineHeight: 20,
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
});
