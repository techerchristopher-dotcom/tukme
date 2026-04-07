import { useEffect, useRef } from 'react';
import { ActivityIndicator, Text, View } from 'react-native';
import type { Region } from 'react-native-maps';

import { type ClientLocationState } from '../hooks/useClientLocation';
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

export function ClientMapBlock(props: {
  location: ClientLocationState;
  pickup?: { latitude: number; longitude: number; label?: string | null } | null;
  destination: ClientDestination | null;
  routeMetrics: RouteMetricsUiState;
  driverLat?: number | null;
  driverLng?: number | null;
}) {
  const { location, pickup, destination, routeMetrics, driverLat, driverLng } = props;

  const mapRef = useRef<InstanceType<
    typeof import('react-native-maps').default
  > | null>(null);

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
    const id = requestAnimationFrame(() => {
      mapRef.current?.fitToCoordinates(routeMetrics.polylineCoordinates!, {
        edgePadding: { top: 52, right: 36, bottom: 88, left: 36 },
        animated: true,
      });
    });
    return () => cancelAnimationFrame(id);
  }, [location.phase, pickup, destination, routeMetrics.polylineCoordinates]);

  if (!pickup && location.phase === 'loading') {
    return (
      <View style={styles.mapSlot}>
        <ActivityIndicator size="large" color="#0f766e" />
        <Text style={styles.mapHint}>Recherche de votre position…</Text>
      </View>
    );
  }

  if (!pickup && (location.phase === 'denied' || location.phase === 'error')) {
    return (
      <View style={styles.mapSlot}>
        <Text style={styles.mapError}>{location.message}</Text>
      </View>
    );
  }

  const latitude = pickup ? pickup.latitude : location.latitude;
  const longitude = pickup ? pickup.longitude : location.longitude;
  const region = regionIncludingBoth(latitude, longitude, destination);

  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const Maps = require('react-native-maps') as typeof import('react-native-maps');
  const MapView = Maps.default;
  const Marker = Maps.Marker;
  const Polyline = Maps.Polyline;

  const mapTitle = destination
    ? 'Carte — départ et destination'
    : 'Carte — votre position';

  return (
    <View style={styles.mapWrapper}>
      <Text style={styles.mapTitle}>{mapTitle}</Text>
      <Text style={styles.coords}>
        Départ : {latitude.toFixed(5)}, {longitude.toFixed(5)}
        {destination
          ? `\nDestination : ${destination.latitude.toFixed(5)}, ${destination.longitude.toFixed(5)}`
          : ''}
      </Text>
      <MapView
        ref={mapRef}
        style={styles.map}
        initialRegion={region}
        showsCompass
      >
        <Marker
          coordinate={{ latitude, longitude }}
          title={pickup ? 'Point de départ' : 'Vous êtes ici'}
          description={pickup?.label ?? undefined}
        />
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
