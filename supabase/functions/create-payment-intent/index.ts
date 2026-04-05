import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.49.1';
import Stripe from 'https://esm.sh/stripe@14.21.0?target=deno';

const corsHeaders: Record<string, string> = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers':
    'authorization, x-client-info, apikey, content-type',
};

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
    const authHeader = req.headers.get('Authorization');
    if (!authHeader?.startsWith('Bearer ')) {
      return new Response(JSON.stringify({ error: 'Unauthorized' }), {
        status: 401,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }

    const supabaseUrl = Deno.env.get('SUPABASE_URL')!;
    const supabaseAnon = Deno.env.get('SUPABASE_ANON_KEY')!;
    const serviceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;

    const userClient = createClient(supabaseUrl, supabaseAnon, {
      global: { headers: { Authorization: authHeader } },
    });

    const {
      data: { user },
      error: userErr,
    } = await userClient.auth.getUser();
    if (userErr || !user) {
      return new Response(JSON.stringify({ error: 'Invalid session' }), {
        status: 401,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }

    const body = (await req.json()) as { ride_id?: string };
    const rideId = body.ride_id?.trim();
    if (!rideId) {
      return new Response(JSON.stringify({ error: 'ride_id required' }), {
        status: 400,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }

    const admin = createClient(supabaseUrl, serviceKey);

    await admin.rpc('expire_rides_past_payment_deadline');

    const { data: ride, error: rideErr } = await admin
      .from('rides')
      .select(
        'id, client_id, status, estimated_price_eur, destination_label, payment_expires_at'
      )
      .eq('id', rideId)
      .maybeSingle();

    if (rideErr || !ride) {
      return new Response(JSON.stringify({ error: 'Ride not found' }), {
        status: 404,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }

    if (ride.client_id !== user.id) {
      return new Response(JSON.stringify({ error: 'Forbidden' }), {
        status: 403,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }

    if (ride.status !== 'awaiting_payment') {
      return new Response(
        JSON.stringify({ error: 'Ride is not awaiting payment' }),
        { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      );
    }

    const expiresAt = ride.payment_expires_at
      ? Date.parse(String(ride.payment_expires_at))
      : NaN;
    if (Number.isFinite(expiresAt) && expiresAt <= Date.now()) {
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
        return new Response(JSON.stringify({ error: 'Payment intent invalid' }), {
          status: 500,
          headers: { ...corsHeaders, 'Content-Type': 'application/json' },
        });
      }
      clientSecret = existing.client_secret;
    } else {
      const eur = Number(ride.estimated_price_eur);
      const amountCents = Math.max(50, Math.round(eur * 100));

      const pi = await stripe.paymentIntents.create({
        amount: amountCents,
        currency: 'eur',
        automatic_payment_methods: { enabled: true },
        metadata: {
          ride_id: rideId,
          client_id: ride.client_id,
        },
      });

      if (!pi.client_secret) {
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
    return new Response(JSON.stringify({ error: msg }), {
      status: 500,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });
  }
});
