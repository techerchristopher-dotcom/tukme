import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.49.1';
import Stripe from 'https://esm.sh/stripe@14.21.0?target=denonext';

const corsHeaders: Record<string, string> = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers':
    'authorization, x-client-info, apikey, content-type',
};

const LOG = '[sync-stripe-payment-for-ride]';

const stripe = new Stripe(Deno.env.get('STRIPE_SECRET_KEY') ?? '', {
  apiVersion: '2023-10-16',
  httpClient: Stripe.createFetchHttpClient(),
});

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
    const authHeader = req.headers.get('Authorization') ?? '';
    const stripeKey = Deno.env.get('STRIPE_SECRET_KEY')?.trim() ?? '';
    const supabaseUrl = Deno.env.get('SUPABASE_URL')?.trim() ?? '';
    const supabaseAnon = Deno.env.get('SUPABASE_ANON_KEY')?.trim() ?? '';
    const serviceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')?.trim() ?? '';

    if (!stripeKey || !supabaseUrl || !supabaseAnon || !serviceKey) {
      console.error(`${LOG} missing env`);
      return new Response(JSON.stringify({ error: 'Server misconfigured' }), {
        status: 500,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }

    const supabaseUser = createClient(supabaseUrl, supabaseAnon, {
      global: { headers: { Authorization: authHeader } },
    });
    const {
      data: { user },
    } = await supabaseUser.auth.getUser();
    if (!user) {
      return new Response(JSON.stringify({ error: 'Unauthorized' }), {
        status: 401,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }

    let body: { ride_id?: string } = {};
    try {
      body = (await req.json()) as { ride_id?: string };
    } catch {
      return new Response(JSON.stringify({ error: 'Invalid JSON' }), {
        status: 400,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }
    const rideId = body.ride_id?.trim();
    if (!rideId) {
      return new Response(JSON.stringify({ error: 'ride_id required' }), {
        status: 400,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }

    const admin = createClient(supabaseUrl, serviceKey);

    const { data: ride, error: rideErr } = await admin
      .from('rides')
      .select('id, client_id, status')
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

    const { data: payRow } = await admin
      .from('payments')
      .select('provider_payment_intent_id')
      .eq('ride_id', rideId)
      .eq('provider', 'stripe')
      .order('created_at', { ascending: false })
      .limit(1)
      .maybeSingle();

    const piId = payRow?.provider_payment_intent_id?.trim();
    if (!piId) {
      return new Response(JSON.stringify({ error: 'No Stripe payment for ride' }), {
        status: 404,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }

    const pi = await stripe.paymentIntents.retrieve(piId);
    if (pi.status !== 'succeeded') {
      console.log(`${LOG} PI not succeeded yet`, { rideId, piId, status: pi.status });
      return new Response(
        JSON.stringify({ ok: false, stripeStatus: pi.status }),
        { status: 200, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      );
    }

    const { error: rpcErr } = await admin.rpc('mark_ride_paid_after_stripe', {
      p_provider_payment_intent_id: piId,
    });
    if (rpcErr) {
      console.error(`${LOG} mark_ride_paid_after_stripe`, rpcErr.message);
      return new Response(JSON.stringify({ error: rpcErr.message }), {
        status: 500,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }

    console.log(`${LOG} ok`, { rideId, piId });
    return new Response(JSON.stringify({ ok: true }), {
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
