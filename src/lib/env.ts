import Constants from 'expo-constants';

type PublicEnv = {
  stripePublishableKey: string;
  supabaseUrl: string;
  supabaseAnonKey: string;
  googlePlacesApiKey: string;
  /** Activer des logs temporaires (sans secrets) en build. */
  diagPayments: string;
};

function readPublicEnvFromExtra(): Partial<PublicEnv> | null {
  const extra =
    Constants.expoConfig?.extra ??
    // Fallback older manifests / edge cases
    (Constants as unknown as { manifest?: { extra?: Record<string, unknown> } })
      .manifest?.extra;

  const maybe = (extra as { publicEnv?: unknown } | undefined)?.publicEnv;
  if (!maybe || typeof maybe !== 'object') {
    return null;
  }
  return maybe as Partial<PublicEnv>;
}

function normalize(v: unknown): string {
  return typeof v === 'string' ? v.trim() : '';
}

export function getPublicEnv(): PublicEnv {
  const fromExtra = readPublicEnvFromExtra();

  return {
    stripePublishableKey: normalize(
      fromExtra?.stripePublishableKey ??
        process.env.EXPO_PUBLIC_STRIPE_PUBLISHABLE_KEY
    ),
    supabaseUrl: normalize(
      fromExtra?.supabaseUrl ?? process.env.EXPO_PUBLIC_SUPABASE_URL
    ),
    supabaseAnonKey: normalize(
      fromExtra?.supabaseAnonKey ?? process.env.EXPO_PUBLIC_SUPABASE_ANON_KEY
    ),
    googlePlacesApiKey: normalize(
      fromExtra?.googlePlacesApiKey ??
        process.env.EXPO_PUBLIC_GOOGLE_PLACES_API_KEY
    ),
    diagPayments: normalize(
      fromExtra?.diagPayments ?? process.env.EXPO_PUBLIC_DIAG_PAYMENTS
    ),
  };
}

export function getStripePublishableKey(): string {
  return getPublicEnv().stripePublishableKey;
}

export function getGooglePlacesApiKey(): string {
  return getPublicEnv().googlePlacesApiKey;
}

export function getSupabaseUrl(): string {
  return getPublicEnv().supabaseUrl;
}

export function getSupabaseAnonKey(): string {
  return getPublicEnv().supabaseAnonKey;
}

export function diagPaymentsEnabled(): boolean {
  const v = getPublicEnv().diagPayments.toLowerCase();
  return v === '1' || v === 'true' || v === 'yes' || v === 'on';
}

