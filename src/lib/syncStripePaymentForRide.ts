import { supabase } from './supabase';

const FUNCTION_NAME = 'sync-stripe-payment-for-ride';

/**
 * Après succès du Payment Sheet : vérifie auprès de Stripe que le PI est `succeeded`
 * et applique `mark_ride_paid_after_stripe` (secours si webhook retardé / absent).
 */
export async function syncStripePaymentForRide(rideId: string): Promise<void> {
  const {
    data: { session },
  } = await supabase.auth.getSession();
  const jwt = session?.access_token?.trim();
  if (!jwt) {
    return;
  }

  const { error } = await supabase.functions.invoke(FUNCTION_NAME, {
    body: { ride_id: rideId },
    headers: { Authorization: `Bearer ${jwt}` },
  });

  if (error && __DEV__) {
    console.warn('[syncStripePaymentForRide]', error.message);
  }
}
