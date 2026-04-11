import { supabase } from './supabase';

export type SelectCashPaymentResult =
  | { ok: true }
  | { ok: false; code: string; message: string };

/**
 * Client authentifié : choix espèces (RPC `select_cash_payment_for_ride`).
 * Passe la ride en `paid` et crée `payments` (cash / pending_collection).
 */
export async function selectCashPaymentForRide(
  rideId: string
): Promise<SelectCashPaymentResult> {
  const id = rideId.trim();
  if (!id) {
    return { ok: false, code: 'invalid', message: 'ride_id manquant.' };
  }

  const { error } = await supabase.rpc('select_cash_payment_for_ride', {
    p_ride_id: id,
  });

  if (error) {
    if (__DEV__) {
      console.warn('[selectCashPaymentForRide]', error.message, error.code);
    }
    return {
      ok: false,
      code: error.code ?? 'rpc_error',
      message: error.message || 'Impossible de valider le paiement espèces.',
    };
  }

  if (__DEV__) {
    console.log('[selectCashPaymentForRide]', 'ok', id);
  }
  return { ok: true };
}
