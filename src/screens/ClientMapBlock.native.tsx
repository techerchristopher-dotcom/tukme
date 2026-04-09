import Ionicons from '@expo/vector-icons/Ionicons';
import { LinearGradient } from 'expo-linear-gradient';
import { useEffect, useMemo, useRef, useState } from 'react';
import {
  ActivityIndicator,
  Animated,
  Easing,
  Pressable,
  StyleSheet,
  Text,
  View,
} from 'react-native';
import type { Region } from 'react-native-maps';

import {
  type ClientLocationCoords,
  type ClientLocationState,
} from '../hooks/useClientLocation';
import type { RouteMetricsUiState } from '../hooks/useRouteMetrics';
import type { ClientDestination } from '../types/clientDestination';

import { clientMapStyles as styles } from './clientMapStyles';

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

/** Région toujours utilisable par MapView / animateToRegion (pas de NaN, deltas > 0). */
const FALLBACK_MAP_REGION: Region = {
  latitude: -18.914,
  longitude: 47.531,
  latitudeDelta: 0.05,
  longitudeDelta: 0.05,
};

function ensureValidMapRegion(
  originLat: number,
  originLng: number,
  dest: ClientDestination | null
): Region {
  const safeDest =
    dest &&
    typeof dest.latitude === 'number' &&
    typeof dest.longitude === 'number' &&
    Number.isFinite(dest.latitude) &&
    Number.isFinite(dest.longitude)
      ? dest
      : null;

  const lat = Number.isFinite(originLat) ? originLat : FALLBACK_MAP_REGION.latitude;
  const lng = Number.isFinite(originLng) ? originLng : FALLBACK_MAP_REGION.longitude;

  const r = regionIncludingBoth(lat, lng, safeDest);
  if (
    !Number.isFinite(r.latitude) ||
    !Number.isFinite(r.longitude) ||
    !Number.isFinite(r.latitudeDelta) ||
    !Number.isFinite(r.longitudeDelta) ||
    r.latitudeDelta <= 0 ||
    r.longitudeDelta <= 0
  ) {
    return { ...FALLBACK_MAP_REGION };
  }
  return r;
}

/** Remettre à true une fois la carte stable si tu veux le recentrage auto. */
const MAP_AUTO_FOLLOW_USER = false;

function distanceMeters(
  a: { latitude: number; longitude: number },
  b: { latitude: number; longitude: number }
): number {
  const R = 6371_000; // meters
  const toRad = (deg: number) => (deg * Math.PI) / 180;
  const dLat = toRad(b.latitude - a.latitude);
  const dLng = toRad(b.longitude - a.longitude);
  const lat1 = toRad(a.latitude);
  const lat2 = toRad(b.latitude);
  const x =
    Math.sin(dLat / 2) * Math.sin(dLat / 2) +
    Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLng / 2) * Math.sin(dLng / 2);
  const c = 2 * Math.atan2(Math.sqrt(x), Math.sqrt(1 - x));
  return R * c;
}

export function ClientMapBlock(props: {
  location: ClientLocationState;
  pickup?: { latitude: number; longitude: number; label?: string | null } | null;
  destination: ClientDestination | null;
  routeMetrics: RouteMetricsUiState;
  driverLat?: number | null;
  driverLng?: number | null;
  variant?: 'card' | 'fullscreen';
  /**
   * GPS ponctuel + coords retournées pour `animateToRegion` (ex. `refreshGpsOnce` du hook client).
   * Non fourni sur web / pas de carte.
   */
  onMeRecenter?: () => Promise<ClientLocationCoords | null>;
}) {
  const {
    location,
    pickup,
    destination,
    routeMetrics,
    driverLat,
    driverLng,
    variant = 'card',
    onMeRecenter,
  } = props;

  const [meRecenterBusy, setMeRecenterBusy] = useState(false);
  const meRecenterPulse = useRef(new Animated.Value(1)).current;

  const mapRef = useRef<InstanceType<
    typeof import('react-native-maps').default
  > | null>(null);

  const lastCenteredRef = useRef<{ latitude: number; longitude: number } | null>(
    null
  );
  const hasCenteredOnceRef = useRef(false);
  const userInteractingRef = useRef(false);
  const interactionTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(
    null
  );

  useEffect(() => {
    return () => {
      if (interactionTimeoutRef.current) {
        clearTimeout(interactionTimeoutRef.current);
        interactionTimeoutRef.current = null;
      }
    };
  }, []);

  useEffect(() => {
    if (variant !== 'fullscreen' || !onMeRecenter) {
      meRecenterPulse.setValue(1);
      return;
    }

    const loop = Animated.loop(
      Animated.sequence([
        Animated.timing(meRecenterPulse, {
          toValue: 1.09,
          duration: 1400,
          easing: Easing.inOut(Easing.ease),
          useNativeDriver: true,
        }),
        Animated.timing(meRecenterPulse, {
          toValue: 1,
          duration: 1400,
          easing: Easing.inOut(Easing.ease),
          useNativeDriver: true,
        }),
      ])
    );

    loop.start();
    return () => {
      loop.stop();
      meRecenterPulse.setValue(1);
    };
  }, [variant, onMeRecenter, meRecenterPulse]);

  const meRecenterShineOpacity = useMemo(
    () =>
      meRecenterPulse.interpolate({
        inputRange: [1, 1.09],
        outputRange: [0.22, 0.78],
      }),
    [meRecenterPulse]
  );

  useEffect(() => {
    if (!pickup && location.phase !== 'ready') {
      return;
    }
    if (
      !destination ||
      !routeMetrics.polylineCoordinates ||
      routeMetrics.polylineCoordinates.length < 2
    ) {
      return;
    }
    const hasDriver =
      typeof driverLat === 'number' &&
      Number.isFinite(driverLat) &&
      typeof driverLng === 'number' &&
      Number.isFinite(driverLng);
    const id = requestAnimationFrame(() => {
      const coords = hasDriver
        ? [
            ...routeMetrics.polylineCoordinates!,
            { latitude: driverLat as number, longitude: driverLng as number },
          ]
        : routeMetrics.polylineCoordinates!;
      mapRef.current?.fitToCoordinates(coords, {
        edgePadding:
          variant === 'fullscreen'
            ? { top: 120, right: 46, bottom: 320, left: 46 }
            : { top: 52, right: 36, bottom: 88, left: 36 },
        animated: true,
      });
    });
    return () => cancelAnimationFrame(id);
  }, [
    location.phase,
    pickup,
    destination,
    routeMetrics.polylineCoordinates,
    variant,
    driverLat,
    driverLng,
  ]);

  // Keep map centered on user (without fighting the user):
  // - center once on first GPS fix
  // - then only when the user moved significantly
  // - pause recentering briefly after the user pans/zooms
  useEffect(() => {
    if (!MAP_AUTO_FOLLOW_USER) {
      return;
    }
    if (!pickup && location.phase !== 'ready') {
      return;
    }

    // If we have a route, `fitToCoordinates` above is the source of truth.
    if (
      destination &&
      routeMetrics.polylineCoordinates &&
      routeMetrics.polylineCoordinates.length >= 2
    ) {
      return;
    }

    if (!mapRef.current) {
      return;
    }

    if (userInteractingRef.current) {
      return;
    }

    const nextLat =
      pickup?.latitude ?? (location.phase === 'ready' ? location.latitude : null);
    const nextLng =
      pickup?.longitude ?? (location.phase === 'ready' ? location.longitude : null);
    if (nextLat == null || nextLng == null) {
      return;
    }

    const next = { latitude: nextLat, longitude: nextLng };
    const prev = lastCenteredRef.current;

    const moved = prev ? distanceMeters(prev, next) : Infinity;
    const MIN_DIST_M = 12;

    if (hasCenteredOnceRef.current && moved < MIN_DIST_M) {
      return;
    }

    hasCenteredOnceRef.current = true;
    lastCenteredRef.current = next;

    const nextRegion = ensureValidMapRegion(next.latitude, next.longitude, destination);
    mapRef.current.animateToRegion(nextRegion, 450);
  }, [
    pickup?.latitude,
    pickup?.longitude,
    location.phase,
    // only relevant when phase is ready
    location.phase === 'ready' ? location.latitude : null,
    location.phase === 'ready' ? location.longitude : null,
    destination,
    routeMetrics.polylineCoordinates,
  ]);

  if (!pickup && location.phase === 'loading') {
    return (
      <View style={variant === 'fullscreen' ? styles.mapSlotFullscreen : styles.mapSlot}>
        <ActivityIndicator size="large" color="#0f766e" />
        <Text style={styles.mapHint}>Recherche de votre position…</Text>
      </View>
    );
  }

  if (!pickup && (location.phase === 'denied' || location.phase === 'error')) {
    return (
      <View style={variant === 'fullscreen' ? styles.mapSlotFullscreen : styles.mapSlot}>
        <Text style={styles.mapError}>{location.message}</Text>
      </View>
    );
  }

  const latitude = pickup ? pickup.latitude : location.latitude;
  const longitude = pickup ? pickup.longitude : location.longitude;
  const region = ensureValidMapRegion(latitude, longitude, destination);

  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const Maps = require('react-native-maps') as typeof import('react-native-maps');
  const MapView = Maps.default;
  const Marker = Maps.Marker;
  const Polyline = Maps.Polyline;

  const mapTitle = destination
    ? 'Carte — départ et destination'
    : 'Carte — votre position';

  return (
    <View style={variant === 'fullscreen' ? styles.mapFullscreen : styles.mapWrapper}>
      {variant === 'card' ? (
        <>
          <Text style={styles.mapTitle}>{mapTitle}</Text>
          <Text style={styles.coords}>
            Départ : {latitude.toFixed(5)}, {longitude.toFixed(5)}
            {destination
              ? `\nDestination : ${destination.latitude.toFixed(5)}, ${destination.longitude.toFixed(5)}`
              : ''}
          </Text>
        </>
      ) : null}
      <View
        style={
          variant === 'fullscreen'
            ? StyleSheet.absoluteFillObject
            : styles.map
        }
      >
        <MapView
          ref={mapRef}
          style={StyleSheet.absoluteFillObject}
          initialRegion={region}
          onRegionChange={() => {
            userInteractingRef.current = true;
            if (interactionTimeoutRef.current) {
              clearTimeout(interactionTimeoutRef.current);
            }
            interactionTimeoutRef.current = setTimeout(() => {
              userInteractingRef.current = false;
            }, 1800);
          }}
          showsCompass
          showsUserLocation={variant === 'fullscreen'}
          showsMyLocationButton={false}
        >
          <Marker coordinate={{ latitude, longitude }} anchor={{ x: 0.5, y: 0.5 }}>
            <View style={styles.userHalo}>
              <View style={styles.userDot} />
            </View>
          </Marker>
          {typeof driverLat === 'number' &&
          Number.isFinite(driverLat) &&
          typeof driverLng === 'number' &&
          Number.isFinite(driverLng) ? (
            <Marker
              coordinate={{ latitude: driverLat, longitude: driverLng }}
              title="Chauffeur"
              pinColor="#2563eb"
            />
          ) : null}
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
          {routeMetrics.polylineCoordinates &&
          routeMetrics.polylineCoordinates.length >= 2 ? (
            <Polyline
              coordinates={routeMetrics.polylineCoordinates}
              strokeColor="#0f766e"
              strokeWidth={5}
              lineJoin="round"
              lineCap="round"
            />
          ) : null}
        </MapView>
        {variant === 'fullscreen' && onMeRecenter ? (
          <Animated.View
            style={[
              styles.meRecenterFabShadow,
              { transform: [{ scale: meRecenterPulse }] },
            ]}
            pointerEvents="box-none"
          >
            <View style={styles.meRecenterFab} pointerEvents="box-none">
              <Animated.View
                pointerEvents="none"
                style={[
                  styles.meRecenterFabShine,
                  { opacity: meRecenterShineOpacity },
                ]}
              >
                <LinearGradient
                  pointerEvents="none"
                  style={StyleSheet.absoluteFillObject}
                  colors={[
                    'rgba(255, 255, 255, 0.92)',
                    'rgba(255, 255, 255, 0.35)',
                    'rgba(255, 255, 255, 0)',
                  ]}
                  locations={[0, 0.38, 1]}
                  start={{ x: 0.15, y: 0 }}
                  end={{ x: 0.95, y: 1 }}
                />
              </Animated.View>
              <Pressable
                style={({ pressed }) => [
                  styles.meRecenterFabPressable,
                  (pressed || meRecenterBusy) && styles.meRecenterFabPressed,
                ]}
                disabled={meRecenterBusy}
                accessibilityLabel="Me recentrer"
                accessibilityRole="button"
                accessibilityHint="Met à jour votre position et centre la carte"
                onPress={() => {
                  void (async () => {
                    if (meRecenterBusy) return;
                    setMeRecenterBusy(true);
                    try {
                      const fresh = await onMeRecenter();
                      if (!fresh) {
                        return;
                      }
                      if (!mapRef.current) {
                        return;
                      }
                      const r = ensureValidMapRegion(
                        fresh.latitude,
                        fresh.longitude,
                        destination
                      );
                      mapRef.current.animateToRegion(r, 450);
                      if (__DEV__) {
                        console.log(
                          '[me-recenter] animateToRegion after refresh',
                          fresh
                        );
                      }
                    } finally {
                      setMeRecenterBusy(false);
                    }
                  })();
                }}
              >
                <Ionicons
                  name="navigate"
                  size={22}
                  color="#0f766e"
                  style={{ opacity: meRecenterBusy ? 0.5 : 1 }}
                />
              </Pressable>
            </View>
          </Animated.View>
        ) : null}
      </View>
      {variant === 'card' && destination ? (
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
