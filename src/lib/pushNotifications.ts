import { Platform } from 'react-native';
import Constants from 'expo-constants';
import * as Notifications from 'expo-notifications';

import { supabase } from './supabase';

const LOG = '[push]';

Notifications.setNotificationHandler({
  handleNotification: async () => ({
    shouldShowAlert: true,
    shouldPlaySound: true,
    shouldSetBadge: false,
  }),
});

function getExpoProjectId(): string | null {
  const anyConst = Constants as unknown as {
    expoConfig?: { extra?: { eas?: { projectId?: string } } };
    easConfig?: { projectId?: string };
  };
  const fromEas = anyConst.easConfig?.projectId;
  const fromExtra = anyConst.expoConfig?.extra?.eas?.projectId;
  return (fromEas ?? fromExtra ?? null) ? String(fromEas ?? fromExtra) : null;
}

export async function registerForPushNotificationsIfPossible(userId: string): Promise<{
  ok: boolean;
  token?: string;
  message?: string;
}> {
  if (!userId.trim()) {
    return { ok: false, message: 'missing user id' };
  }
  if (Platform.OS === 'web') {
    return { ok: false, message: 'web not supported' };
  }

  const perms = await Notifications.getPermissionsAsync();
  let status = perms.status;
  if (status !== 'granted') {
    const req = await Notifications.requestPermissionsAsync();
    status = req.status;
  }
  if (status !== 'granted') {
    return { ok: false, message: 'permission denied' };
  }

  const projectId = getExpoProjectId();
  if (!projectId) {
    // Without projectId, getExpoPushTokenAsync may fail on some setups.
    return { ok: false, message: 'missing Expo projectId (EAS)' };
  }

  const tokenRes = await Notifications.getExpoPushTokenAsync({ projectId });
  const expoPushToken = tokenRes.data?.trim();
  if (!expoPushToken) {
    return { ok: false, message: 'token missing' };
  }

  // Upsert token row (RLS: user_id must be auth.uid()).
  const { error } = await supabase.from('push_tokens').upsert(
    {
      user_id: userId,
      expo_push_token: expoPushToken,
      platform: Platform.OS,
      device_id: null,
    },
    { onConflict: 'expo_push_token' }
  );

  if (error) {
    if (__DEV__) {
      // eslint-disable-next-line no-console
      console.warn(`${LOG} upsert failed`, error.message);
    }
    return { ok: false, message: error.message };
  }

  return { ok: true, token: expoPushToken };
}

export function wirePushListeners(params: {
  onTap?: (data: Record<string, unknown>) => void;
}): { remove: () => void } {
  const received = Notifications.addNotificationReceivedListener(() => {
    // MVP: no-op (UI handled by OS). Kept for future in-app banners.
  });

  const response = Notifications.addNotificationResponseReceivedListener((resp) => {
    const data = (resp.notification.request.content.data ?? {}) as Record<string, unknown>;
    params.onTap?.(data);
  });

  return {
    remove: () => {
      received.remove();
      response.remove();
    },
  };
}

export async function notifyRideEvent(params: {
  event: 'ride_created' | 'ride_accepted' | 'driver_arrived' | 'ride_cancelled';
  rideId: string;
}): Promise<void> {
  if (Platform.OS === 'web') return;
  const ride_id = params.rideId.trim();
  if (!ride_id) return;
  const { error } = await supabase.functions.invoke('notify-ride-event', {
    body: { event: params.event, ride_id },
  });
  if (error && __DEV__) {
    // eslint-disable-next-line no-console
    console.warn(`${LOG} notify-ride-event failed`, error.message);
  }
}

