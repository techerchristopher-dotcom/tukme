import { supabase } from './supabase';

const LOG = '[ride-payment-expiry]';

/** Demande au serveur de passer la ride en `expired` si le délai est dépassé (idempotent). */
export async function syncRidePaymentExpiryIfDue(rideId: string): Promise<void> {
  const { error } = await supabase.rpc('client_sync_ride_payment_expiry', {
    p_ride_id: rideId,
  });
  if (error) {
    if (__DEV__) {
      console.warn(`${LOG}`, error.message);
    }
  }
}
