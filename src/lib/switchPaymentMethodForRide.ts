import { supabase } from './supabase';
import type { RidePaymentMethod } from '../types/clientRide';

export type SwitchPaymentMethodResult =
  | { ok: true }
  | { ok: false; code: string; message: string };

export async function switchPaymentMethodForRide(
  rideId: string,
  method: RidePaymentMethod
): Promise<SwitchPaymentMethodResult> {
  const id = rideId.trim();
  if (!id) {
    return { ok: false, code: 'invalid', message: 'ride_id manquant.' };
  }

  const { error } = await supabase.rpc('switch_payment_method_for_ride', {
    p_ride_id: id,
    p_method: method,
  });

  if (error) {
    if (__DEV__) {
      console.warn('[switchPaymentMethodForRide]', method, error.code, error.message);
    }
    return {
      ok: false,
      code: error.code ?? 'rpc_error',
      message: error.message || 'Impossible de changer le mode de paiement.',
    };
  }

  return { ok: true };
}

