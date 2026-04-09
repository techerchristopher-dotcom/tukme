import { getSupabaseUrl } from './env';
import { supabase } from './supabase';

const FUNCTION_NAME = 'create-payment-intent';

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

function invokeHttpStatus(err: unknown): number | undefined {
  return (err as { context?: { status?: number } } | null)?.context?.status;
}

export async function invokeCreatePaymentIntent(
  rideId: string
): Promise<CreatePaymentIntentResult> {
  const supabaseUrl = getSupabaseUrl();
  const payload = { ride_id: rideId };

  const {
    data: { session },
  } = await supabase.auth.getSession();
  const userId = session?.user?.id ?? null;
  const jwt = session?.access_token?.trim();

  console.log('[stripe-pi] pre-invoke', {
    userId,
    sessionExists: !!session,
    accessTokenPresent: !!session?.access_token,
    supabaseHost: supabaseUrl,
    payload,
  });

  if (!jwt) {
    if (__DEV__) {
      console.error('[stripe-pi] missing jwt: user not authenticated');
    }
    return {
      ok: false,
      status: 401,
      message: 'Session invalide. Reconnectez-vous puis réessayez.',
    };
  }

  const invokeOnce = async (accessToken: string) =>
    supabase.functions.invoke<{
      clientSecret?: string;
      error?: string;
    }>(FUNCTION_NAME, {
      body: payload,
      headers: { Authorization: `Bearer ${accessToken}` },
    });

  let { data, error } = await invokeOnce(jwt);
  let status = invokeHttpStatus(error);
  console.log('[stripe-pi] post-invoke', { status, error });

  if (error && status === 401) {
    console.log('[stripe-pi] retry after refreshSession');
    try {
      await supabase.auth.refreshSession();
      const {
        data: { session: refreshed },
      } = await supabase.auth.getSession();
      const jwt2 = refreshed?.access_token?.trim() ?? '';
      if (jwt2) {
        const res2 = await invokeOnce(jwt2);
        data = res2.data;
        error = res2.error;
        status = invokeHttpStatus(error);
        console.log('[stripe-pi] post-invoke', { status, error });
      }
    } catch (e) {
      console.log('[stripe-pi] refreshSession failed', {
        message: e instanceof Error ? e.message : String(e),
      });
    }
  }

  if (error) {
    const anyErr = error as unknown as {
      message: string;
      context?: { status?: number; body?: unknown };
    };
    const rawStatus = anyErr.context?.status;
    const rawBody = anyErr.context?.body;

    let errorField = '(none)';
    let debugField = '(none)';
    let bodyExact = '';

    if (rawBody != null && typeof rawBody === 'object') {
      const o = rawBody as {
        error?: unknown;
        message?: unknown;
        debug?: unknown;
      };
      if (typeof o.error === 'string' && o.error.length > 0) {
        errorField = o.error;
      } else if (typeof o.message === 'string' && o.message.length > 0) {
        errorField = o.message;
      }
      if (o.debug !== undefined) {
        debugField = JSON.stringify(o.debug);
      }
      bodyExact = JSON.stringify(rawBody);
    } else if (typeof rawBody === 'string') {
      bodyExact = rawBody;
      try {
        const parsed = JSON.parse(rawBody) as {
          error?: unknown;
          debug?: unknown;
        };
        if (typeof parsed.error === 'string' && parsed.error.length > 0) {
          errorField = parsed.error;
        }
        if (parsed.debug !== undefined) {
          debugField = JSON.stringify(parsed.debug);
        }
      } catch {
        errorField = rawBody;
      }
    }

    const statusField =
      typeof rawStatus === 'number' ? String(rawStatus) : '(unknown)';

    const message = [
      `error=${errorField}`,
      `debug=${debugField}`,
      `status=${statusField}`,
      bodyExact ? `body=${bodyExact}` : '',
    ]
      .filter(Boolean)
      .join(' | ');

    return {
      ok: false,
      status: rawStatus,
      message,
    };
  }

  const body = data as { clientSecret?: string; error?: string } | null;
  const secret = body?.clientSecret?.trim();
  if (secret) {
    return { ok: true, clientSecret: secret };
  }

  const msg = normalizeErrorMessage(body?.error ?? '');
  if (__DEV__) {
    console.error('[stripe-pi] response missing clientSecret', body);
  }
  return { ok: false, message: msg };
}
