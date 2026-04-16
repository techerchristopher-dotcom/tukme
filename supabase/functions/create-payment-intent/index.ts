import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.49.1';
// denonext évite la couche Node (`processTicksAndRejections` / runMicrotasks) incompatible avec l’Edge Runtime.
import Stripe from 'https://esm.sh/stripe@14.21.0?target=denonext';

const corsHeaders: Record<string, string> = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers':
    'authorization, x-client-info, apikey, content-type',
};

const LOG = '[create-payment-intent]';

const stripe = new Stripe(Deno.env.get('STRIPE_SECRET_KEY') ?? '', {
  apiVersion: '2023-10-16',
  httpClient: Stripe.createFetchHttpClient(),
});

async function getOrCreateStripeCustomerId(args: {
  admin: ReturnType<typeof createClient>;
  stripe: Stripe;
  userId: string;
  email?: string | null;
}): Promise<string> {
  const { admin, userId, email } = args;

  const { data: profile, error: profErr } = await admin
    .from('profiles')
    .select('stripe_customer_id')
    .eq('id', userId)
    .maybeSingle();

  if (profErr) {
    throw new Error(`PROFILE_READ_FAILED: ${profErr.message}`);
  }

  const existing =
    typeof profile?.stripe_customer_id === 'string'
      ? profile.stripe_customer_id.trim()
      : '';
  if (existing) {
    return existing;
  }

  // Idempotent per user: prevents duplicate Stripe Customers if called concurrently.
  const idempotencyKey = `tukme_customer_${userId}`;
  const customer = await args.stripe.customers.create(
    {
      ...(email?.trim() ? { email: email.trim() } : {}),
      metadata: { supabase_user_id: userId },
    },
    { idempotencyKey }
  );

  const stripeCustomerId = customer.id?.trim();
  if (!stripeCustomerId) {
    throw new Error('STRIPE_CUSTOMER_CREATE_FAILED');
  }

  // Persist if still null (race-safe).
  const { error: updErr } = await admin
    .from('profiles')
    .update({ stripe_customer_id: stripeCustomerId })
    .eq('id', userId)
    .is('stripe_customer_id', null);

  if (updErr) {
    throw new Error(`PROFILE_UPDATE_FAILED: ${updErr.message}`);
  }

  // Read back to return the persisted value (handles races where another request wins).
  const { data: profile2, error: profErr2 } = await admin
    .from('profiles')
    .select('stripe_customer_id')
    .eq('id', userId)
    .maybeSingle();

  if (profErr2) {
    throw new Error(`PROFILE_READ_FAILED: ${profErr2.message}`);
  }

  const persisted =
    typeof profile2?.stripe_customer_id === 'string'
      ? profile2.stripe_customer_id.trim()
      : '';

  if (!persisted) {
    throw new Error('STRIPE_CUSTOMER_NOT_PERSISTED');
  }

  return persisted;
}

function mapPiStatus(s: Stripe.PaymentIntent.Status): string {
  switch (s) {
    case 'succeeded':
      return 'succeeded';
    case 'canceled':
      return 'canceled';
    case 'processing':
      return 'processing';
    default:
      return 'requires_payment_method';
  }
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') {
    return new Response('ok', { headers: corsHeaders });
  }

  if (req.method !== 'POST') {
    return new Response(JSON.stringify({ error: 'Method not allowed' }), {
      status: 405,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });
  }

  try {
    console.log(`${LOG} enter`, { method: req.method });

    const authHeader = req.headers.get('Authorization') ?? '';
    const hasAuthHeader = authHeader.trim().length > 0;

    const stripeKey = Deno.env.get('STRIPE_SECRET_KEY')?.trim() ?? '';
    if (!stripeKey) {
      console.error(`${LOG} missing STRIPE_SECRET_KEY`);
      return new Response(
        JSON.stringify({ error: 'Missing STRIPE_SECRET_KEY' }),
        { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      );
    }

    const supabaseUrl = Deno.env.get('SUPABASE_URL')?.trim() ?? '';
    const supabaseAnon = Deno.env.get('SUPABASE_ANON_KEY')?.trim() ?? '';
    const serviceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')?.trim() ?? '';
    if (!supabaseUrl || !supabaseAnon || !serviceKey) {
      console.error(`${LOG} missing Supabase env`, {
        hasUrl: !!supabaseUrl,
        hasAnon: !!supabaseAnon,
        hasServiceRole: !!serviceKey,
        hasAuthHeader,
      });
      return new Response(
        JSON.stringify({
          error:
            'Missing SUPABASE_URL / SUPABASE_ANON_KEY / SUPABASE_SERVICE_ROLE_KEY',
        }),
        { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      );
    }

    const supabase = createClient(supabaseUrl, supabaseAnon, {
      global: {
        headers: {
          Authorization: authHeader,
        },
      },
    });

    const {
      data: { user },
      error: userError,
    } = await supabase.auth.getUser();

    if (!user) {
      console.log('[create-payment-intent] 401 cause: user not resolved');
      console.error(`${LOG} 401 User not authenticated via context`, {
        hasAuthHeader,
        authHeaderLength: authHeader.length,
        userResolved: false,
        stripeKeyPresent: !!stripeKey,
        supabaseUrlPresent: !!supabaseUrl,
        userErrorMessage: userError?.message ?? null,
        branch: 'auth.getUser() returned null user',
      });
      return new Response(
        JSON.stringify({ error: 'User not authenticated via context' }),
        { status: 401, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      );
    }

    let body: { ride_id?: string } = {};
    try {
      body = (await req.json()) as { ride_id?: string };
    } catch (e) {
      console.error(`${LOG} invalid json`, e);
      return new Response(JSON.stringify({ error: 'Invalid JSON body' }), {
        status: 400,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }
    const rideId = body.ride_id?.trim();
    if (!rideId) {
      console.error(`${LOG} ride_id required`, body);
      return new Response(JSON.stringify({ error: 'ride_id required' }), {
        status: 400,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }

    console.log(`${LOG} request`, {
      userId: user.id,
      rideId,
      hasAuthHeader,
      userResolved: true,
      stripeKeyPresent: !!stripeKey,
    });

    const admin = createClient(supabaseUrl, serviceKey);

    const { error: expireErr } = await admin.rpc(
      'expire_rides_past_payment_deadline'
    );
    if (expireErr) {
      console.error(`${LOG} expire rpc failed`, expireErr.message);
    }

    const { data: ride, error: rideErr } = await admin
      .from('rides')
      .select(
        'id, client_id, status, estimated_price_eur, destination_label, payment_expires_at, payment_method'
      )
      .eq('id', rideId)
      .maybeSingle();

    if (rideErr || !ride) {
      console.error(`${LOG} ride not found`, { rideId, rideErr: rideErr?.message });
      return new Response(JSON.stringify({ error: 'Ride not found' }), {
        status: 404,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }

    if (ride.client_id !== user.id) {
      console.error(`${LOG} forbidden`, {
        rideId,
        rideClientId: ride.client_id,
        userId: user.id,
      });
      return new Response(JSON.stringify({ error: 'Forbidden' }), {
        status: 403,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }

    if (ride.status !== 'awaiting_payment') {
      console.error(`${LOG} invalid ride status`, { rideId, status: ride.status });
      return new Response(
        JSON.stringify({ error: 'Ride is not awaiting payment' }),
        { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      );
    }

    const payMethod = String((ride as { payment_method?: string }).payment_method ?? 'card');
    if (payMethod === 'cash') {
      console.error(`${LOG} cash ride, no PaymentIntent`, { rideId });
      return new Response(
        JSON.stringify({
          error:
            'Cette course est en paiement espèces. Aucun paiement par carte n’est nécessaire.',
        }),
        { status: 409, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      );
    }

    const { data: cashRow } = await admin
      .from('payments')
      .select('id')
      .eq('ride_id', rideId)
      .eq('provider', 'cash')
      .eq('status', 'pending_collection')
      .maybeSingle();

    if (cashRow) {
      console.error(`${LOG} cash payment row exists`, { rideId });
      return new Response(
        JSON.stringify({
          error:
            'Un paiement espèces est déjà enregistré pour cette course. Utilisez le flux espèces.',
        }),
        { status: 409, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      );
    }

    const expiresAt = ride.payment_expires_at
      ? Date.parse(String(ride.payment_expires_at))
      : NaN;
    if (Number.isFinite(expiresAt) && expiresAt <= Date.now()) {
      console.error(`${LOG} payment window expired`, { rideId, expiresAt });
      return new Response(
        JSON.stringify({ error: 'Payment window has expired' }),
        { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      );
    }

    const { data: paid } = await admin
      .from('payments')
      .select('id')
      .eq('ride_id', rideId)
      .eq('status', 'succeeded')
      .maybeSingle();

    if (paid) {
      console.error(`${LOG} already paid`, { rideId });
      return new Response(JSON.stringify({ error: 'Already paid' }), {
        status: 409,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }

    // Phase 2: attach the payment to a persistent Stripe Customer so Stripe can save the card.
    let stripeCustomerId = '';
    try {
      stripeCustomerId = await getOrCreateStripeCustomerId({
        admin,
        stripe,
        userId: user.id,
        email: user.email ?? null,
      });
    } catch (e) {
      const msg = e instanceof Error ? e.message : 'customer error';
      console.error(`${LOG} getOrCreateStripeCustomerId failed`, { rideId, userId: user.id, msg });
      return new Response(
        JSON.stringify({ error: 'Impossible de préparer le paiement (client Stripe).' }),
        { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      );
    }

    const { data: openRow } = await admin
      .from('payments')
      .select('id, status, provider_payment_intent_id')
      .eq('ride_id', rideId)
      .in('status', ['requires_payment_method', 'processing'])
      .maybeSingle();

    let clientSecret: string;
    let piIsAttachedToCustomer = true;

    if (openRow?.provider_payment_intent_id) {
      console.log(`${LOG} stripe.retrieve`, { rideId, piId: openRow.provider_payment_intent_id });
      const existing = await stripe.paymentIntents.retrieve(
        openRow.provider_payment_intent_id
      );
      if (existing.status === 'succeeded') {
        await admin.rpc('mark_ride_paid_after_stripe', {
          p_provider_payment_intent_id: existing.id,
        });
        console.log(`${LOG} response`, { status: 409, rideId, branch: 'already_paid_existing_pi' });
        return new Response(JSON.stringify({ error: 'Already paid' }), {
          status: 409,
          headers: { ...corsHeaders, 'Content-Type': 'application/json' },
        });
      }
      if (!existing.client_secret) {
        console.error(`${LOG} missing client_secret on existing PI`, {
          rideId,
          piId: existing.id,
        });
        return new Response(JSON.stringify({ error: 'Payment intent invalid' }), {
          status: 500,
          headers: { ...corsHeaders, 'Content-Type': 'application/json' },
        });
      }

      // If the existing PI is not associated to our Customer, Stripe can't reliably save the card for future usage.
      // Safe fallback: keep the existing PI if it's already processing; otherwise recreate if it's still awaiting a method.
      const existingCustomer =
        typeof existing.customer === 'string'
          ? existing.customer
          : (existing.customer as { id?: string } | null)?.id ?? null;
      const canRecreate =
        openRow.status === 'requires_payment_method' &&
        existing.status === 'requires_payment_method';

      if (existingCustomer && existingCustomer === stripeCustomerId) {
        clientSecret = existing.client_secret;
      } else if (!canRecreate) {
        // Preserve current behavior for in-flight payments to avoid breaking existing flow.
        piIsAttachedToCustomer = false;
        clientSecret = existing.client_secret;
      } else {
        console.log(`${LOG} recreate PI to attach customer`, {
          rideId,
          piId: existing.id,
          existingCustomer,
          stripeCustomerId,
        });

        // Cancel old PI (best effort) and mark the payment row as canceled so we can create a new active row.
        await stripe.paymentIntents.cancel(existing.id).catch(() => undefined);
        if (openRow.id) {
          await admin
            .from('payments')
            .update({ status: 'canceled' })
            .eq('id', openRow.id)
            .catch(() => undefined);
        }

        // Create a fresh PI associated with Customer + setup_future_usage.
        const eur = Number(ride.estimated_price_eur);
        const amountCents = Math.max(50, Math.round(eur * 100));
        const receiptEmail = user.email?.trim() || undefined;

        let pi2: Stripe.PaymentIntent;
        try {
          console.log(`${LOG} stripe.paymentIntents.create start`, {
            rideId,
            amountCents,
            currency: 'eur',
            branch: 'recreate_with_customer',
          });
          pi2 = await stripe.paymentIntents.create({
            amount: amountCents,
            currency: 'eur',
            customer: stripeCustomerId,
            setup_future_usage: 'off_session',
            automatic_payment_methods: { enabled: true, allow_redirects: 'never' },
            ...(receiptEmail ? { receipt_email: receiptEmail } : {}),
            metadata: {
              ride_id: rideId,
              client_id: ride.client_id,
              supabase_user_id: user.id,
            },
          });
        } catch (e) {
          const msg = e instanceof Error ? e.message : 'Stripe error';
          console.error(`${LOG} stripe.paymentIntents.create failed`, msg);
          return new Response(JSON.stringify({ error: msg }), {
            status: 500,
            headers: { ...corsHeaders, 'Content-Type': 'application/json' },
          });
        }

        if (!pi2.client_secret) {
          console.error(`${LOG} missing client_secret from stripe`, { rideId, piId: pi2.id });
          return new Response(JSON.stringify({ error: 'Stripe error' }), {
            status: 500,
            headers: { ...corsHeaders, 'Content-Type': 'application/json' },
          });
        }

        const { error: insErr2 } = await admin.from('payments').insert({
          ride_id: rideId,
          client_id: ride.client_id,
          provider: 'stripe',
          provider_payment_intent_id: pi2.id,
          amount: amountCents,
          currency: 'eur',
          status: mapPiStatus(pi2.status),
        });

        if (insErr2) {
          console.error(`${LOG} insert payment failed`, insErr2.message);
          await stripe.paymentIntents.cancel(pi2.id).catch(() => undefined);
          return new Response(JSON.stringify({ error: insErr2.message }), {
            status: 500,
            headers: { ...corsHeaders, 'Content-Type': 'application/json' },
          });
        }

        clientSecret = pi2.client_secret;
      }
    } else {
      const eur = Number(ride.estimated_price_eur);
      const amountCents = Math.max(50, Math.round(eur * 100));

      let pi: Stripe.PaymentIntent;
      try {
        console.log(`${LOG} stripe.paymentIntents.create start`, {
          rideId,
          amountCents,
          currency: 'eur',
        });
        const receiptEmail = user.email?.trim() || undefined;
        pi = await stripe.paymentIntents.create({
          amount: amountCents,
          currency: 'eur',
          customer: stripeCustomerId,
          // Phase 2: let Stripe attach the payment method to the Customer for future use.
          setup_future_usage: 'off_session',
          // MVP mobile : pas de moyens « redirect » (Bancontact, iDEAL, etc.) → évite Safari/hooks.stripe.com bloqué.
          automatic_payment_methods: { enabled: true, allow_redirects: 'never' },
          ...(receiptEmail ? { receipt_email: receiptEmail } : {}),
          metadata: {
            ride_id: rideId,
            client_id: ride.client_id,
            supabase_user_id: user.id,
          },
        });
        console.log(`${LOG} stripe.paymentIntents.create ok`, {
          rideId,
          piId: pi.id,
          piStatus: pi.status,
        });
      } catch (e) {
        const msg = e instanceof Error ? e.message : 'Stripe error';
        console.error(`${LOG} stripe.paymentIntents.create failed`, msg);
        return new Response(JSON.stringify({ error: msg }), {
          status: 500,
          headers: { ...corsHeaders, 'Content-Type': 'application/json' },
        });
      }

      if (!pi.client_secret) {
        console.error(`${LOG} missing client_secret from stripe`, { rideId, piId: pi.id });
        return new Response(JSON.stringify({ error: 'Stripe error' }), {
          status: 500,
          headers: { ...corsHeaders, 'Content-Type': 'application/json' },
        });
      }

      const { error: insErr } = await admin.from('payments').insert({
        ride_id: rideId,
        client_id: ride.client_id,
        provider: 'stripe',
        provider_payment_intent_id: pi.id,
        amount: amountCents,
        currency: 'eur',
        status: mapPiStatus(pi.status),
      });

      if (insErr) {
        console.error(`${LOG} insert payment failed`, insErr.message);
        await stripe.paymentIntents.cancel(pi.id).catch(() => undefined);
        return new Response(JSON.stringify({ error: insErr.message }), {
          status: 500,
          headers: { ...corsHeaders, 'Content-Type': 'application/json' },
        });
      }

      clientSecret = pi.client_secret;
    }

    // PaymentSheet saved cards require customer + ephemeral key, and the PI must be attached to that customer.
    let customerId: string | undefined;
    let customerEphemeralKeySecret: string | undefined;
    if (piIsAttachedToCustomer) {
      try {
        const eph = await stripe.ephemeralKeys.create(
          { customer: stripeCustomerId },
          { apiVersion: '2023-10-16' }
        );
        customerId = stripeCustomerId;
        customerEphemeralKeySecret = eph.secret ?? undefined;
      } catch (e) {
        const msg = e instanceof Error ? e.message : 'Stripe error';
        console.error(`${LOG} stripe.ephemeralKeys.create failed`, msg);
        return new Response(JSON.stringify({ error: 'Stripe error' }), {
          status: 500,
          headers: { ...corsHeaders, 'Content-Type': 'application/json' },
        });
      }
    }

    console.log(`${LOG} response`, {
      status: 200,
      rideId,
      branch: 'client_secret',
    });
    return new Response(
      JSON.stringify({
        clientSecret,
        ...(customerId ? { customerId } : {}),
        ...(customerEphemeralKeySecret
          ? { customerEphemeralKeySecret }
          : {}),
      }),
      {
      status: 200,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      }
    );
  } catch (e) {
    const msg = e instanceof Error ? e.message : 'Server error';
    console.error(`${LOG} unhandled`, msg);
    return new Response(JSON.stringify({ error: msg }), {
      status: 500,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });
  }
});
