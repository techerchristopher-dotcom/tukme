/// <reference types="expo/types" />

declare namespace NodeJS {
  interface ProcessEnv {
    EXPO_PUBLIC_SUPABASE_URL?: string;
    EXPO_PUBLIC_SUPABASE_ANON_KEY?: string;
    /** Clé Maps Platform avec Places API (New) — restreindre par bundle iOS / SHA Android. */
    EXPO_PUBLIC_GOOGLE_PLACES_API_KEY?: string;
  }
}
