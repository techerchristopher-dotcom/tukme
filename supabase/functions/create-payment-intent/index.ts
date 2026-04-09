import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.49.1';
import Stripe from 'https://esm.sh/stripe@14.21.0?target=deno';

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
    const stripeKey = Deno.env.get('STRIPE_SECRET_KEY')?.trim() ?? '';
    if (!stripeKey) {
      console.error(`${LOG} missing STRIPE_SECRET_KEY`);
      return new Response(
        JSON.stringify({ error: 'Missing STRIPE_SECRET_KEY' }),
        { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      );
    }

    const authHeaderValue = req.headers.get('Authorization') ?? '';
    if (!authHeaderValue) {
      console.error(`${LOG} missing Authorization header`);
      return new Response(JSON.stringify({ error: 'Unauthorized' }), {
        status: 401,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }

    const supabaseUrl = Deno.env.get('SUPABASE_URL')?.trim() ?? '';
    const supabaseAnon = Deno.env.get('SUPABASE_ANON_KEY')?.trim() ?? '';
    const serviceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')?.trim() ?? '';
    if (!supabaseUrl || !supabaseAnon || !serviceKey) {
      console.error(`${LOG} missing Supabase env`, {
        hasUrl: !!supabaseUrl,
        hasAnon: !!supabaseAnon,
        hasServiceRole: !!serviceKey,
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
          Authorization: authHeaderValue,
        },
      },
    });

    const {
      data: { user },
      error: userError,
    } = await supabase.auth.getUser();

    if (!user) {
      console.error(`${LOG} User not authenticated via context`, {
        hasAuthHeader: authHeaderValue.length > 0,
        authHeaderLength: authHeaderValue.length,
        userErrorMessage: userError?.message ?? null,
      });
      return new Response(JSON.stringify({ error: 'Invalid session' }), {
        status: 401,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
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

    console.log(`${LOG} request`, { userId: user.id, rideId });

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
        'id, client_id, status, estimated_price_eur, destination_label, payment_expires_at'
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

    const { data: openRow } = await admin
      .from('payments')
      .select('provider_payment_intent_id')
      .eq('ride_id', rideId)
      .in('status', ['requires_payment_method', 'processing'])
      .maybeSingle();

    let clientSecret: string;

    if (openRow?.provider_payment_intent_id) {
      const existing = await stripe.paymentIntents.retrieve(
        openRow.provider_payment_intent_id
      );
      if (existing.status === 'succeeded') {
        await admin.rpc('mark_ride_paid_after_stripe', {
          p_provider_payment_intent_id: existing.id,
        });
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
      clientSecret = existing.client_secret;
    } else {
      const eur = Number(ride.estimated_price_eur);
      const amountCents = Math.max(50, Math.round(eur * 100));

      let pi: Stripe.PaymentIntent;
      try {
        pi = await stripe.paymentIntents.create({
          amount: amountCents,
          currency: 'eur',
          automatic_payment_methods: { enabled: true },
          metadata: {
            ride_id: rideId,
            client_id: ride.client_id,
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

    return new Response(JSON.stringify({ clientSecret }), {
      status: 200,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });
  } catch (e) {
    const msg = e instanceof Error ? e.message : 'Server error';
    console.error(`${LOG} unhandled`, msg);
    return new Response(JSON.stringify({ error: msg }), {
      status: 500,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });
  }
});
