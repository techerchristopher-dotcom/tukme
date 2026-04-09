import { createClient, type SupabaseClient } from '@supabase/supabase-js';

let cached: SupabaseClient | null = null;
let didLogInit = false;

export function getSupabaseBrowser(): SupabaseClient | null {
  if (cached) return cached;
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL ?? '';
  const anonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ?? '';
  if (!url || !anonKey) {
    if (process.env.NODE_ENV !== 'production' && !didLogInit) {
      didLogInit = true;
      // eslint-disable-next-line no-console
      console.debug('[adminSupabase] missing env:', {
        url_present: !!url,
        anon_key_present: !!anonKey,
      });
    }
    return null;
  }
  cached = createClient(url, anonKey, {
    auth: {
      persistSession: true,
      autoRefreshToken: true,
      detectSessionInUrl: true,
    },
  });
  if (process.env.NODE_ENV !== 'production' && !didLogInit) {
    didLogInit = true;
    // eslint-disable-next-line no-console
    console.debug('[adminSupabase] browser client initialized (explicit auth config)', {
      url_present: !!url,
      anon_key_present: !!anonKey,
    });
  }
  return cached;
}


