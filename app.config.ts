import type { ExpoConfig, ConfigContext } from 'expo/config';
import fs from 'node:fs';
import path from 'node:path';
import dotenv from 'dotenv';

function loadDotEnv(projectRoot: string): void {
  // Charge explicitement .env (robuste, même si l’injection automatique Expo est contournée)
  dotenv.config({ path: path.join(projectRoot, '.env') });
}

function readAppJson(projectRoot: string): ExpoConfig {
  const raw = fs.readFileSync(path.join(projectRoot, 'app.json'), 'utf8');
  const parsed = JSON.parse(raw) as { expo?: ExpoConfig };
  if (!parsed.expo) {
    throw new Error('app.json invalide: clé "expo" manquante');
  }
  return parsed.expo;
}

export default ({ projectRoot }: ConfigContext): ExpoConfig => {
  loadDotEnv(projectRoot);
  const base = readAppJson(projectRoot);

  const stripePublishableKey =
    process.env.EXPO_PUBLIC_STRIPE_PUBLISHABLE_KEY?.trim() ?? '';
  const supabaseUrl = process.env.EXPO_PUBLIC_SUPABASE_URL?.trim() ?? '';
  const supabaseAnonKey = process.env.EXPO_PUBLIC_SUPABASE_ANON_KEY?.trim() ?? '';
  const googlePlacesApiKey =
    process.env.EXPO_PUBLIC_GOOGLE_PLACES_API_KEY?.trim() ?? '';

  return {
    ...base,
    extra: {
      ...(base.extra ?? {}),
      publicEnv: {
        stripePublishableKey,
        supabaseUrl,
        supabaseAnonKey,
        googlePlacesApiKey,
      },
    },
  };
};
