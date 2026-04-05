import { ActivityIndicator, Text, View } from 'react-native';

import { type ClientLocationState } from '../hooks/useClientLocation';
import type { RouteMetricsUiState } from '../hooks/useRouteMetrics';
import type { ClientDestination } from '../types/clientDestination';

import { clientMapStyles as styles } from './clientMapStyles';

/** Pas de react-native-maps sur web — évite codegenNativeCommands / crash bundle. */
export function ClientMapBlock(props: {
  location: ClientLocationState;
  destination: ClientDestination | null;
  routeMetrics: RouteMetricsUiState;
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
      <View style={styles.mapPlaceholder}>
        <Text style={styles.mapPlaceholderText}>
          La carte interactive est disponible sur l’application mobile
          (iOS/Android). Sur le web, vous pouvez commander et suivre la course
          via le texte ci-dessus.
        </Text>
      </View>
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
