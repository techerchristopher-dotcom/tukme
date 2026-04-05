import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.49.1';
import Stripe from 'https://esm.sh/stripe@14.21.0?target=deno';

const stripe = new Stripe(Deno.env.get('STRIPE_SECRET_KEY') ?? '', {
  apiVersion: '2023-10-16',
  httpClient: Stripe.createFetchHttpClient(),
});

const webhookSecret = Deno.env.get('STRIPE_WEBHOOK_SECRET') ?? '';

Deno.serve(async (req) => {
  const signature = req.headers.get('stripe-signature');
  if (!signature) {
    return new Response('No signature', { status: 400 });
  }

  const body = await req.text();

  let event: Stripe.Event;
  try {
    event = stripe.webhooks.constructEvent(body, signature, webhookSecret);
  } catch {
    return new Response('Invalid signature', { status: 400 });
  }

  const supabaseUrl = Deno.env.get('SUPABASE_URL')!;
  const serviceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
  const admin = createClient(supabaseUrl, serviceKey);

  try {
    if (event.type === 'payment_intent.succeeded') {
      const pi = event.data.object as Stripe.PaymentIntent;
      const { error } = await admin.rpc('mark_ride_paid_after_stripe', {
        p_provider_payment_intent_id: pi.id,
      });
      if (error) {
        console.error('[stripe-webhook] mark paid', error.message);
        return new Response(error.message, { status: 500 });
      }
    }

    if (event.type === 'payment_intent.payment_failed') {
      const pi = event.data.object as Stripe.PaymentIntent;
      const { error } = await admin.rpc('mark_payment_failed_from_stripe', {
        p_provider_payment_intent_id: pi.id,
      });
      if (error) {
        console.error('[stripe-webhook] mark failed', error.message);
      }
    }

    if (event.type === 'payment_intent.canceled') {
      const pi = event.data.object as Stripe.PaymentIntent;
      await admin
        .from('payments')
        .update({ status: 'canceled' })
        .eq('provider_payment_intent_id', pi.id);
    }
  } catch (e) {
    console.error('[stripe-webhook]', e);
    return new Response('Handler error', { status: 500 });
  }

  return new Response(JSON.stringify({ received: true }), {
    headers: { 'Content-Type': 'application/json' },
  });
});
