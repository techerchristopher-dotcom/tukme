import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.49.1';
// denonext avoids Node microtasks incompatibilities in Edge runtime
import Stripe from 'https://esm.sh/stripe@14.21.0?target=denonext';

const corsHeaders: Record<string, string> = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers':
    'authorization, x-client-info, apikey, content-type',
};

const LOG = '[get-or-create-stripe-customer]';

const stripe = new Stripe(Deno.env.get('STRIPE_SECRET_KEY') ?? '', {
  apiVersion: '2023-10-16',
  httpClient: Stripe.createFetchHttpClient(),
});

type OkResponse = { ok: true; stripeCustomerId: string };
type ErrResponse = { ok: false; error: string };

function json(status: number, body: OkResponse | ErrResponse): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, 'Content-Type': 'application/json' },
  });
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') {
    return new Response('ok', { headers: corsHeaders });
  }
  if (req.method !== 'POST') {
    return json(405, { ok: false, error: 'Method not allowed' });
  }

  try {
    const authHeader = req.headers.get('Authorization') ?? '';
    const stripeKey = Deno.env.get('STRIPE_SECRET_KEY')?.trim() ?? '';
    const supabaseUrl = Deno.env.get('SUPABASE_URL')?.trim() ?? '';
    const supabaseAnon = Deno.env.get('SUPABASE_ANON_KEY')?.trim() ?? '';
    const serviceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')?.trim() ?? '';

    if (!stripeKey || !supabaseUrl || !supabaseAnon || !serviceKey) {
      console.error(`${LOG} missing env`);
      return json(500, { ok: false, error: 'Server misconfigured' });
    }

    const supabase = createClient(supabaseUrl, supabaseAnon, {
      global: { headers: { Authorization: authHeader } },
    });

    const {
      data: { user },
      error: userErr,
    } = await supabase.auth.getUser();
    if (!user) {
      console.error(`${LOG} unauthorized`, userErr?.message ?? null);
      return json(401, { ok: false, error: 'Unauthorized' });
    }

    const admin = createClient(supabaseUrl, serviceKey);

    const { data: profile, error: profErr } = await admin
      .from('profiles')
      .select('id, stripe_customer_id')
      .eq('id', user.id)
      .maybeSingle();

    if (profErr) {
      console.error(`${LOG} profile select failed`, profErr.message);
      return json(500, { ok: false, error: 'Profile read failed' });
    }

    const existing =
      typeof profile?.stripe_customer_id === 'string'
        ? profile.stripe_customer_id.trim()
        : '';

    if (existing) {
      return json(200, { ok: true, stripeCustomerId: existing });
    }

    // Stripe idempotency ensures only one Customer is created per user,
    // even if this endpoint is called concurrently.
    const idempotencyKey = `tukme_customer_${user.id}`;

    console.log(`${LOG} creating customer`, { userId: user.id });

    const customer = await stripe.customers.create(
      {
        ...(user.email?.trim() ? { email: user.email.trim() } : {}),
        metadata: {
          supabase_user_id: user.id,
        },
      },
      { idempotencyKey }
    );

    const stripeCustomerId = customer.id?.trim();
    if (!stripeCustomerId) {
      console.error(`${LOG} customer id missing`);
      return json(500, { ok: false, error: 'Stripe error' });
    }

    // Persist. Use a null-guarded update to avoid overriding if another request won the race.
    const { error: updErr } = await admin
      .from('profiles')
      .update({ stripe_customer_id: stripeCustomerId })
      .eq('id', user.id)
      .is('stripe_customer_id', null);

    if (updErr) {
      console.error(`${LOG} profile update failed`, updErr.message);
      return json(500, { ok: false, error: 'Profile update failed' });
    }

    // Read back to return the persisted value (handles races).
    const { data: profile2, error: profErr2 } = await admin
      .from('profiles')
      .select('stripe_customer_id')
      .eq('id', user.id)
      .maybeSingle();

    if (profErr2) {
      console.error(`${LOG} profile reselect failed`, profErr2.message);
      return json(500, { ok: false, error: 'Profile read failed' });
    }

    const persisted =
      typeof profile2?.stripe_customer_id === 'string'
        ? profile2.stripe_customer_id.trim()
        : '';

    if (!persisted) {
      console.error(`${LOG} stripe_customer_id not persisted`, { userId: user.id });
      return json(500, { ok: false, error: 'Customer not persisted' });
    }

    return json(200, { ok: true, stripeCustomerId: persisted });
  } catch (e) {
    const msg = e instanceof Error ? e.message : 'Server error';
    console.error(`${LOG} unhandled`, msg);
    return json(500, { ok: false, error: 'Server error' });
  }
});

