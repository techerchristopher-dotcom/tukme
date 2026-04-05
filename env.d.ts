/// <reference types="expo/types" />

declare namespace NodeJS {
  interface ProcessEnv {
    EXPO_PUBLIC_SUPABASE_URL?: string;
    EXPO_PUBLIC_SUPABASE_ANON_KEY?: string;
    /** Clé Maps Platform avec Places API (New) — restreindre par bundle iOS / SHA Android. */
    EXPO_PUBLIC_GOOGLE_PLACES_API_KEY?: string;
    /** Stripe publishable key (pk_test_… / pk_live_…) — jamais la clé secrète. */
    EXPO_PUBLIC_STRIPE_PUBLISHABLE_KEY?: string;
  }
}
