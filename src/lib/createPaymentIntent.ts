import { supabase } from './supabase';

const LOG = '[stripe-pi]';

export type CreatePaymentIntentResult =
  | { ok: true; clientSecret: string }
  | { ok: false; message: string; status?: number };

export async function invokeCreatePaymentIntent(
  rideId: string
): Promise<CreatePaymentIntentResult> {
  const { data, error } = await supabase.functions.invoke<{
    clientSecret?: string;
    error?: string;
  }>('create-payment-intent', { body: { ride_id: rideId } });

  if (error) {
    if (__DEV__) {
      console.error(`${LOG} invoke`, error.message);
    }
    return { ok: false, message: error.message };
  }

  const body = data as { clientSecret?: string; error?: string } | null;
  const secret = body?.clientSecret?.trim();
  if (secret) {
    return { ok: true, clientSecret: secret };
  }

  let msg = body?.error?.trim() || 'Impossible de préparer le paiement.';
  if (msg.includes('Payment window has expired')) {
    msg = 'Le délai de paiement est dépassé.';
  } else if (msg.includes('Ride is not awaiting payment')) {
    msg = 'La course n’est plus en attente de paiement.';
  }
  if (__DEV__) {
    console.error(`${LOG} response`, body);
  }
  return { ok: false, message: msg };
}
