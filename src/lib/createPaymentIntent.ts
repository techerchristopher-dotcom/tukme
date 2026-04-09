import { supabase } from './supabase';

const LOG = '[stripe-pi]';

export type CreatePaymentIntentResult =
  | { ok: true; clientSecret: string }
  | { ok: false; message: string; status?: number };

function normalizeErrorMessage(raw: string): string {
  const msg = raw.trim();
  if (!msg) {
    return 'Impossible de préparer le paiement.';
  }
  if (msg.includes('Payment window has expired')) {
    return 'Le délai de paiement est dépassé.';
  }
  if (msg.includes('Ride is not awaiting payment')) {
    return 'La course n’est plus en attente de paiement.';
  }
  return msg;
}

export async function invokeCreatePaymentIntent(
  rideId: string
): Promise<CreatePaymentIntentResult> {
  const {
    data: { session },
  } = await supabase.auth.getSession();
  const jwt = session?.access_token?.trim();

  if (!jwt) {
    if (__DEV__) {
      console.error(`${LOG} missing jwt: user not authenticated`);
    }
    return {
      ok: false,
      status: 401,
      message: 'Session invalide. Reconnectez-vous puis réessayez.',
    };
  }

  const { data, error } = await supabase.functions.invoke<{
    clientSecret?: string;
    error?: string;
  }>('create-payment-intent', {
    body: { ride_id: rideId },
    headers: { Authorization: `Bearer ${jwt}` },
  });

  if (error) {
    const anyErr = error as unknown as {
      message: string;
      context?: { status?: number; body?: unknown };
    };
    const status = anyErr.context?.status;
    const body = anyErr.context?.body;

    let backendMsg = '';
    let backendDebug: unknown = undefined;
    if (body && typeof body === 'object') {
      const maybe = body as { error?: unknown; message?: unknown; debug?: unknown };
      backendMsg =
        (typeof maybe.error === 'string' ? maybe.error : '') ||
        (typeof maybe.message === 'string' ? maybe.message : '');
      backendDebug = maybe.debug;
    } else if (typeof body === 'string') {
      backendMsg = body;
    }

    if (__DEV__) {
      console.error(`${LOG} invoke`, {
        status,
        message: error.message,
        body,
      });
    }

    const details =
      body && typeof body === 'object'
        ? JSON.stringify(body)
        : typeof body === 'string'
          ? body
          : '';

    const statusLabel =
      typeof status === 'number' ? `HTTP ${status}` : 'HTTP error';

    const fullMessage = [
      backendMsg || error.message,
      backendDebug != null ? `debug=${JSON.stringify(backendDebug)}` : '',
      details && backendMsg !== details ? `body=${details}` : '',
      statusLabel,
    ]
      .filter(Boolean)
      .join(' | ');

    return {
      ok: false,
      status,
      message: normalizeErrorMessage(fullMessage),
    };
  }

  const body = data as { clientSecret?: string; error?: string } | null;
  const secret = body?.clientSecret?.trim();
  if (secret) {
    return { ok: true, clientSecret: secret };
  }

  const msg = normalizeErrorMessage(body?.error ?? '');
  if (__DEV__) {
    console.error(`${LOG} response`, body);
  }
  return { ok: false, message: msg };
}
