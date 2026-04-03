import * as Location from 'expo-location';
import { useEffect, useState } from 'react';
import { Platform } from 'react-native';

export type ClientLocationState =
  | { phase: 'loading' }
  | { phase: 'denied'; message: string }
  | { phase: 'ready'; latitude: number; longitude: number }
  | { phase: 'error'; message: string };

const WEB_MESSAGE =
  'La carte et la position GPS sont disponibles sur l’app iOS et Android (Expo Go ou build natif).';

export function useClientLocation(): ClientLocationState {
  const [state, setState] = useState<ClientLocationState>(() =>
    Platform.OS === 'web'
      ? { phase: 'error', message: WEB_MESSAGE }
      : { phase: 'loading' }
  );

  useEffect(() => {
    if (Platform.OS === 'web') {
      return;
    }

    let cancelled = false;

    void (async () => {
      try {
        const { status } = await Location.requestForegroundPermissionsAsync();
        if (cancelled) {
          return;
        }
        if (status !== Location.PermissionStatus.GRANTED) {
          setState({
            phase: 'denied',
            message:
              'Accès à la localisation refusé. Autorisez la localisation dans les réglages de l’appareil pour afficher votre position sur la carte.',
          });
          return;
        }

        const position = await Location.getCurrentPositionAsync({
          accuracy: Location.Accuracy.Balanced,
        });
        if (cancelled) {
          return;
        }
        setState({
          phase: 'ready',
          latitude: position.coords.latitude,
          longitude: position.coords.longitude,
        });
      } catch (e) {
        if (cancelled) {
          return;
        }
        const msg =
          e instanceof Error
            ? e.message
            : 'Impossible de récupérer votre position.';
        setState({ phase: 'error', message: msg });
      }
    })();

    return () => {
      cancelled = true;
    };
  }, []);

  return state;
}
