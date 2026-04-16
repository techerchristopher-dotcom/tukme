import { supabase } from './supabase';

const FUNCTION_NAME = 'get-or-create-stripe-customer';

export type GetOrCreateStripeCustomerResult =
  | { ok: true; stripeCustomerId: string }
  | { ok: false; message: string; status?: number };

function invokeHttpStatus(err: unknown): number | undefined {
  return (err as { context?: { status?: number } } | null)?.context?.status;
}

export async function getOrCreateStripeCustomer(): Promise<GetOrCreateStripeCustomerResult> {
  const {
    data: { session },
  } = await supabase.auth.getSession();
  const jwt = session?.access_token?.trim();
  if (!jwt) {
    return {
      ok: false,
      status: 401,
      message: 'Session invalide. Reconnectez-vous puis réessayez.',
    };
  }

  const { data, error } = await supabase.functions.invoke<{
    ok?: boolean;
    stripeCustomerId?: string;
    error?: string;
  }>(FUNCTION_NAME, {
    body: {},
    headers: { Authorization: `Bearer ${jwt}` },
  });

  if (error) {
    return {
      ok: false,
      status: invokeHttpStatus(error),
      message: error.message,
    };
  }

  const stripeCustomerId = data?.stripeCustomerId?.trim() ?? '';
  if (data?.ok === true && stripeCustomerId) {
    return { ok: true, stripeCustomerId };
  }

  return {
    ok: false,
    message: (data as { error?: string } | null)?.error?.trim() || 'Stripe indisponible.',
  };
}

