import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.49.1';

type NotifyEvent =
  | 'ride_created'
  | 'ride_accepted'
  | 'driver_arrived'
  | 'ride_cancelled';

type RequestBody = {
  event?: NotifyEvent;
  ride_id?: string;
};

type ExpoMessage = {
  to: string;
  title: string;
  body: string;
  data?: Record<string, unknown>;
  sound?: 'default';
  priority?: 'default' | 'normal' | 'high';
};

const corsHeaders: Record<string, string> = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers':
    'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST,OPTIONS',
};

function json(status: number, body: Record<string, unknown>): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, 'Content-Type': 'application/json' },
  });
}

function isUuid(v: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
    v.trim()
  );
}

function isExpoPushToken(v: string): boolean {
  return (
    typeof v === 'string' &&
    (v.startsWith('ExponentPushToken[') || v.startsWith('ExpoPushToken[')) &&
    v.endsWith(']')
  );
}

async function expoSend(messages: ExpoMessage[]): Promise<{
  ok: boolean;
  invalidTokens: string[];
  tickets: unknown;
  error?: string;
}> {
  if (messages.length === 0) {
    return { ok: true, invalidTokens: [], tickets: [] };
  }

  const res = await fetch('https://exp.host/--/api/v2/push/send', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(messages),
  });

  const payload = await res.json().catch(() => null);
  if (!res.ok) {
    return {
      ok: false,
      invalidTokens: [],
      tickets: payload,
      error: `Expo push HTTP ${res.status}`,
    };
  }

  const data = payload as {
    data?: { status?: string; details?: { error?: string } }[];
  };

  const invalidTokens: string[] = [];
  const tickets = data?.data ?? [];

  // Expo returns one ticket per message.
  for (let i = 0; i < tickets.length; i++) {
    const t = tickets[i];
    const err = t?.details?.error;
    if (err === 'DeviceNotRegistered') {
      const tok = messages[i]?.to;
      if (tok) invalidTokens.push(tok);
    }
  }

  return { ok: true, invalidTokens, tickets };
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') {
    return new Response('ok', { headers: corsHeaders });
  }
  if (req.method !== 'POST') {
    return json(405, { error: 'Method not allowed' });
  }

  const authHeader = req.headers.get('Authorization') ?? '';
  if (!authHeader.startsWith('Bearer ')) {
    return json(401, { error: 'Unauthorized' });
  }

  const supabaseUrl = Deno.env.get('SUPABASE_URL') ?? '';
  const supabaseAnon = Deno.env.get('SUPABASE_ANON_KEY') ?? '';
  const serviceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? '';
  if (!supabaseUrl || !supabaseAnon || !serviceKey) {
    return json(500, { error: 'Server misconfigured' });
  }

  // Validate user session.
  const userClient = createClient(supabaseUrl, supabaseAnon, {
    global: { headers: { Authorization: authHeader } },
  });
  const {
    data: { user },
    error: userErr,
  } = await userClient.auth.getUser();
  if (userErr || !user?.id) {
    return json(401, { error: 'Invalid session' });
  }

  const body = (await req.json().catch(() => null)) as RequestBody | null;
  const event = body?.event;
  const rideId = (body?.ride_id ?? '').trim();
  if (
    !event ||
    !['ride_created', 'ride_accepted', 'driver_arrived', 'ride_cancelled'].includes(
      event
    )
  ) {
    return json(400, { error: 'event required' });
  }
  if (!rideId || !isUuid(rideId)) {
    return json(400, { error: 'ride_id required' });
  }

  const admin = createClient(supabaseUrl, serviceKey);

  const { data: ride, error: rideErr } = await admin
    .from('rides')
    .select('id, client_id, driver_id, status, destination_label, pickup_label')
    .eq('id', rideId)
    .maybeSingle();

  if (rideErr || !ride) {
    return json(404, { error: 'Ride not found' });
  }

  const callerId = user.id;
  const status = String(ride.status ?? '');
  const clientId = String(ride.client_id ?? '');
  const driverId = ride.driver_id ? String(ride.driver_id) : null;

  // Authorization & routing.
  let recipientUserIds: string[] = [];
  let title = 'Tukme';
  let msg = '';
  let data: Record<string, unknown> = { ride_id: rideId, event };

  if (event === 'ride_created') {
    if (callerId !== clientId) {
      return json(403, { error: 'Forbidden' });
    }
    title = 'Nouvelle course';
    msg = 'Une nouvelle course est disponible.';

    const { data: drivers, error: dErr } = await admin
      .from('profiles')
      .select('id')
      .eq('role', 'driver')
      .is('deleted_at', null);
    if (dErr) {
      return json(500, { error: dErr.message });
    }
    recipientUserIds = (drivers ?? [])
      .map((r: { id?: string }) => String(r.id ?? '').trim())
      .filter((id) => isUuid(id));
  }

  if (event === 'ride_accepted') {
    if (!driverId || callerId !== driverId) {
      return json(403, { error: 'Forbidden' });
    }
    title = 'Chauffeur trouvé';
    msg = 'Un chauffeur a accepté votre course.';
    recipientUserIds = [clientId];
  }

  if (event === 'driver_arrived') {
    if (!driverId || callerId !== driverId) {
      return json(403, { error: 'Forbidden' });
    }
    title = 'Chauffeur arrivé';
    msg = 'Votre chauffeur est arrivé au point de départ.';
    recipientUserIds = [clientId];
  }

  if (event === 'ride_cancelled') {
    if (callerId !== clientId) {
      return json(403, { error: 'Forbidden' });
    }
    if (!driverId) {
      // No driver assigned: nothing to notify.
      return json(200, { ok: true, sent: 0, skipped: 'no_driver' });
    }
    title = 'Course annulée';
    msg = 'La course assignée a été annulée.';
    recipientUserIds = [driverId];
  }

  // Fetch tokens.
  const { data: rows, error: tokErr } = await admin
    .from('push_tokens')
    .select('expo_push_token')
    .in('user_id', recipientUserIds);
  if (tokErr) {
    return json(500, { error: tokErr.message });
  }

  const tokens = (rows ?? [])
    .map((r: { expo_push_token?: string }) => String(r.expo_push_token ?? '').trim())
    .filter((t) => isExpoPushToken(t));

  const messages: ExpoMessage[] = tokens.map((t) => ({
    to: t,
    title,
    body: msg,
    data,
    sound: 'default',
    priority: 'high',
  }));

  const sentBefore = messages.length;
  const res = await expoSend(messages);

  // Cleanup invalid tokens.
  if (res.invalidTokens.length > 0) {
    await admin.from('push_tokens').delete().in('expo_push_token', res.invalidTokens);
  }

  return json(200, {
    ok: res.ok,
    status,
    ride: {
      id: rideId,
      destination_label: ride.destination_label ?? null,
      pickup_label: ride.pickup_label ?? null,
    },
    recipients: recipientUserIds.length,
    tokens: tokens.length,
    sent: sentBefore,
    invalid_tokens_removed: res.invalidTokens.length,
    tickets: res.tickets,
    error: res.error ?? null,
  });
});

