import 'react-native-url-polyfill/auto';

import AsyncStorage from '@react-native-async-storage/async-storage';
import { createClient } from '@supabase/supabase-js';

const url = process.env.EXPO_PUBLIC_SUPABASE_URL;
const anonKey = process.env.EXPO_PUBLIC_SUPABASE_ANON_KEY;

if (!url || !anonKey) {
  throw new Error(
    'Variables manquantes : définissez EXPO_PUBLIC_SUPABASE_URL et EXPO_PUBLIC_SUPABASE_ANON_KEY (voir .env.example).'
  );
}

export const supabase = createClient(url, anonKey, {
  auth: {
    storage: AsyncStorage,
    autoRefreshToken: true,
    persistSession: true,
    detectSessionInUrl: false,
  },
});

/**
 * Pousse le JWT Auth vers le client Realtime avant une subscription `postgres_changes`.
 * Le client Supabase n’appelle `realtime.setAuth` que sur SIGNED_IN / TOKEN_REFRESHED,
 * pas sur INITIAL_SESSION : au premier chargement, la jointure pouvait partir avec la
 * clé anon → RLS `authenticated` sur `rides` → CHANNEL_ERROR côté client.
 */
export async function syncRealtimeAuth(): Promise<boolean> {
  const {
    data: { session },
  } = await supabase.auth.getSession();
  const token = session?.access_token;
  if (!token) {
    await supabase.realtime.setAuth();
    return false;
  }
  await supabase.realtime.setAuth(token);
  return true;
}

void syncRealtimeAuth();

supabase.auth.onAuthStateChange((event, session) => {
  if (
    session?.access_token &&
    (event === 'INITIAL_SESSION' ||
      event === 'SIGNED_IN' ||
      event === 'TOKEN_REFRESHED')
  ) {
    void supabase.realtime.setAuth(session.access_token);
  } else if (event === 'SIGNED_OUT') {
    void supabase.realtime.setAuth();
  }
});
