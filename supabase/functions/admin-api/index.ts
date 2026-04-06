import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.49.1';

type JsonValue = null | boolean | number | string | JsonValue[] | { [k: string]: JsonValue };

const corsHeaders: Record<string, string> = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'GET,POST,DELETE,OPTIONS',
};

function jsonResponse(
  status: number,
  body: { data: JsonValue; error: JsonValue },
  extraHeaders?: Record<string, string>
): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, 'Content-Type': 'application/json', ...(extraHeaders ?? {}) },
  });
}

function parseLimitOffset(url: URL): { limit: number; offset: number } {
  const limitRaw = url.searchParams.get('limit');
  const offsetRaw = url.searchParams.get('offset');
  const limit = Math.min(
    100,
    Math.max(1, Number.parseInt(limitRaw ?? '50', 10) || 50)
  );
  const offset = Math.max(0, Number.parseInt(offsetRaw ?? '0', 10) || 0);
  return { limit, offset };
}

function getStringParam(url: URL, key: string, fallback: string | null = null): string | null {
  const v = url.searchParams.get(key);
  if (!v) {
    return fallback;
  }
  const t = v.trim();
  return t ? t : fallback;
}

function mustBeMadagascarTz(tz: string | null): string {
  const t = (tz ?? 'Indian/Antananarivo').trim() || 'Indian/Antananarivo';
  if (t !== 'Indian/Antananarivo') {
    // MVP guardrail: keep a single business timezone to avoid subtle reporting bugs.
    throw new Error("Unsupported tz (MVP supports only 'Indian/Antananarivo').");
  }
  return t;
}

function parseBusinessDateOrThrow(dateStr: string | null): string {
  if (!dateStr) {
    throw new Error('Missing required query param: date (YYYY-MM-DD).');
  }
  if (!/^\d{4}-\d{2}-\d{2}$/.test(dateStr)) {
    throw new Error('Invalid date format, expected YYYY-MM-DD.');
  }
  return dateStr;
}

function isUuid(v: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
    v.trim()
  );
}

function normalizePathId(raw: string): string {
  try {
    return decodeURIComponent(raw).trim();
  } catch {
    return raw.trim();
  }
}

function asNonEmptyString(v: unknown): string | null {
  return typeof v === 'string' && v.trim() ? v.trim() : null;
}

function asInt(v: unknown): number | null {
  if (typeof v === 'number') {
    return Number.isInteger(v) ? v : null;
  }
  if (typeof v === 'string' && v.trim()) {
    const n = Number.parseInt(v.trim(), 10);
    return Number.isInteger(n) ? n : null;
  }
  return null;
}

async function readJsonBody(req: Request): Promise<Record<string, unknown>> {
  const ct = (req.headers.get('content-type') ?? '').toLowerCase();
  if (!ct.includes('application/json')) {
    throw Object.assign(new Error('Expected application/json body'), { status: 415 });
  }
  const body = await req.json().catch(() => null);
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    throw Object.assign(new Error('Invalid JSON body'), { status: 400 });
  }
  return body as Record<string, unknown>;
}

/** E.164 : + puis 1–15 chiffres (national number), premier chiffre ≠ 0. */
function normalizePhoneE164(raw: string): string {
  const compact = raw.replace(/[\s().-]/g, '').trim();
  if (!compact) {
    throw Object.assign(new Error('phone requis'), { status: 400 });
  }
  if (!compact.startsWith('+')) {
    throw Object.assign(
      new Error('Numéro invalide : format E.164 obligatoire (ex: +261xxxxxxxxx).'),
      { status: 400 }
    );
  }
  if (!/^\+[1-9]\d{1,14}$/.test(compact)) {
    throw Object.assign(new Error('Numéro invalide : format E.164 incorrect.'), { status: 400 });
  }
  return compact;
}

function assertOneOf(paramName: string, value: string | null, allowed: readonly string[]) {
  if (value == null) return;
  if (!allowed.includes(value)) {
    throw Object.assign(
      new Error(`${paramName} must be one of: ${allowed.join(', ')}`),
      { status: 400 }
    );
  }
}

function buildUtcDayRangeForMadagascar(businessDate: string): { startIso: string; endIso: string } {
  // Madagascar is UTC+3 with no DST. For a local day [00:00, 24:00),
  // UTC range is [21:00Z previous day, 21:00Z same day).
  const [y, m, d] = businessDate.split('-').map((x) => Number.parseInt(x, 10));
  const startUtcMs = Date.UTC(y, m - 1, d, 0, 0, 0) - 3 * 60 * 60 * 1000;
  const endUtcMs = startUtcMs + 24 * 60 * 60 * 1000;
  return { startIso: new Date(startUtcMs).toISOString(), endIso: new Date(endUtcMs).toISOString() };
}

function parseAllowlistEmails(): Set<string> {
  // MVP: keep allowlist controlled via env, but also support a minimal built-in fallback
  // to avoid locking yourself out if secrets are not configured yet.
  const fallback = ['techerchristopher@gmail.com'];
  const raw = (Deno.env.get('ADMIN_EMAILS') ?? '').trim();
  const fromEnv = raw
    ? raw
        .split(',')
        .map((s) => s.trim().toLowerCase())
        .filter(Boolean)
    : [];
  return new Set([...fallback.map((s) => s.toLowerCase()), ...fromEnv]);
}

async function requireAdmin(req: Request): Promise<{
  adminClient: ReturnType<typeof createClient>;
  userEmail: string;
}> {
  const authHeader = req.headers.get('Authorization');
  const hasAuth = !!authHeader;
  const hasBearer = !!authHeader?.startsWith('Bearer ');
  const rawToken = hasBearer ? authHeader!.slice('Bearer '.length).trim() : '';
  console.log('[admin-api] auth header present:', hasAuth);
  console.log('[admin-api] bearer prefix ok:', hasBearer);
  console.log('[admin-api] token length:', rawToken.length);

  if (!hasAuth) {
    throw Object.assign(new Error('AUTH_HEADER_MISSING'), { status: 401 });
  }
  if (!hasBearer) {
    throw Object.assign(new Error('AUTH_BEARER_MISSING'), { status: 401 });
  }
  if (!rawToken) {
    throw Object.assign(new Error('AUTH_TOKEN_EMPTY'), { status: 401 });
  }
  if (rawToken.length < 20) {
    throw Object.assign(new Error('AUTH_TOKEN_TOO_SHORT'), { status: 401 });
  }

  const supabaseUrl = Deno.env.get('SUPABASE_URL') ?? '';
  const supabaseAnon = Deno.env.get('SUPABASE_ANON_KEY') ?? '';
  const serviceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? '';
  if (!supabaseUrl || !supabaseAnon || !serviceKey) {
    throw Object.assign(new Error('Server misconfigured (missing Supabase env vars)'), {
      status: 500,
    });
  }

  const allow = parseAllowlistEmails();
  if (allow.size === 0) {
    throw Object.assign(new Error('Admin allowlist is empty (ADMIN_EMAILS).'), { status: 500 });
  }

  // Verify JWT robustly by passing the raw token (not "Bearer ...") to getUser(token).
  // This avoids any accidental double-prefixing or header handling quirks.
  const userClient = createClient(supabaseUrl, supabaseAnon);
  const {
    data: { user },
    error: userErr,
  } = await userClient.auth.getUser(rawToken);
  if (userErr || !user) {
    console.log('[admin-api] getUser error:', userErr?.message ?? 'unknown');
    throw Object.assign(new Error('AUTH_GETUSER_FAILED'), { status: 401 });
  }
  console.log('[admin-api] getUser ok, user id present:', !!user.id);

  const email = String(user.email ?? '').trim().toLowerCase();
  if (!email || !allow.has(email)) {
    throw Object.assign(new Error('Forbidden'), { status: 403 });
  }

  const adminClient = createClient(supabaseUrl, serviceKey);
  return { adminClient, userEmail: email };
}

async function handlePlatformDailySummary(req: Request, url: URL) {
  const date = parseBusinessDateOrThrow(getStringParam(url, 'date'));
  const tz = mustBeMadagascarTz(getStringParam(url, 'tz', 'Indian/Antananarivo'));

  const { adminClient } = await requireAdmin(req);
  const { startIso, endIso } = buildUtcDayRangeForMadagascar(date);

  const { data: summary, error } = await adminClient.rpc('admin_platform_daily_summary', {
    p_business_date: date,
    p_tz: tz,
  });
  if (error) {
    console.error('[admin-api] admin_platform_daily_summary', error.message);
    return jsonResponse(500, { data: null, error: { message: 'Internal error' } });
  }

  const { count: nonFinalizedCount, error: nfErr } = await adminClient
    .from('rides')
    .select('id', { count: 'exact', head: true })
    .eq('status', 'completed')
    .eq('is_financials_finalized', false)
    .gte('ride_completed_at', startIso)
    .lt('ride_completed_at', endIso);

  if (nfErr) {
    console.error('[admin-api] non-finalized rides count', nfErr.message);
    return jsonResponse(500, { data: null, error: { message: 'Internal error' } });
  }

  const row = Array.isArray(summary) ? (summary[0] ?? null) : summary;
  return jsonResponse(200, {
    data: {
      ...row,
      non_finalized_completed_rides_count: nonFinalizedCount ?? 0,
    },
    error: null,
  });
}

async function handleDriversDailySummary(req: Request, url: URL) {
  const date = parseBusinessDateOrThrow(getStringParam(url, 'date'));
  const tz = mustBeMadagascarTz(getStringParam(url, 'tz', 'Indian/Antananarivo'));
  const rawStatus = (getStringParam(url, 'driver_status', 'active') ?? 'active').trim().toLowerCase();
  if (rawStatus !== 'active' && rawStatus !== 'inactive' && rawStatus !== 'all') {
    throw Object.assign(
      new Error('driver_status must be one of: active, inactive, all'),
      { status: 400 }
    );
  }

  const { adminClient } = await requireAdmin(req);
  const { data, error } = await adminClient.rpc('admin_driver_daily_summary', {
    p_business_date: date,
    p_tz: tz,
    p_status: rawStatus,
  });
  if (error) {
    console.error('[admin-api] admin_driver_daily_summary', error.message);
    return jsonResponse(500, { data: null, error: { message: 'Internal error' } });
  }
  return jsonResponse(200, { data, error: null });
}

type RpcDriverDayRow = { driver_id?: string | null };

async function handleDriverDetail(req: Request, url: URL, driverIdRaw: string) {
  const driverId = normalizePathId(driverIdRaw);
  if (!isUuid(driverId)) {
    return jsonResponse(400, { data: null, error: { message: 'Invalid driverId' } });
  }
  const date = parseBusinessDateOrThrow(getStringParam(url, 'date'));
  const tz = mustBeMadagascarTz(getStringParam(url, 'tz', 'Indian/Antananarivo'));
  const { limit, offset } = parseLimitOffset(url);

  const { adminClient } = await requireAdmin(req);

  const { data: profile, error: profErr } = await adminClient
    .from('profiles')
    .select('id, full_name, phone, email, role, created_at, deleted_at')
    .eq('id', driverId)
    .maybeSingle();
  if (profErr) {
    console.error('[admin-api] driver profile', profErr.message);
    return jsonResponse(500, { data: null, error: { message: 'Internal error' } });
  }
  if (!profile || profile.role !== 'driver') {
    return jsonResponse(404, { data: null, error: { message: 'Driver not found' } });
  }

  const { data: balance, error: balErr } = await adminClient
    .from('driver_balances')
    .select('*')
    .eq('driver_id', driverId)
    .maybeSingle();
  if (balErr) {
    console.error('[admin-api] driver balance', balErr.message);
    return jsonResponse(500, { data: null, error: { message: 'Internal error' } });
  }

  const { data: dayRows, error: dayErr } = await adminClient.rpc('admin_driver_daily_summary', {
    p_business_date: date,
    p_tz: tz,
    p_status: 'all',
  });
  if (dayErr) {
    console.error('[admin-api] driver daily summary', dayErr.message);
    return jsonResponse(500, { data: null, error: { message: 'Internal error' } });
  }
  const today = Array.isArray(dayRows)
    ? dayRows.find((r: RpcDriverDayRow) => String(r?.driver_id ?? '') === driverId) ?? null
    : null;

  const ridesQ = adminClient
    .from('admin_completed_rides_financial')
    .select('*', { count: 'exact' })
    .eq('driver_id', driverId)
    .order('ride_completed_at', { ascending: false })
    .range(offset, offset + limit - 1);

  const payoutsQ = adminClient
    .from('admin_driver_payouts_detailed')
    .select('*', { count: 'exact' })
    .eq('driver_id', driverId)
    .order('paid_at', { ascending: false, nullsFirst: false })
    .order('created_at', { ascending: false })
    .range(offset, offset + limit - 1);

  const rentsQ = adminClient
    .from('admin_driver_daily_rents_detailed')
    .select('*', { count: 'exact' })
    .eq('driver_id', driverId)
    .order('business_date', { ascending: false })
    .range(offset, offset + limit - 1);

  const [{ data: rides, count: ridesCount, error: ridesErr }, { data: payouts, count: payoutsCount, error: payoutsErr }, { data: rents, count: rentsCount, error: rentsErr }] =
    await Promise.all([ridesQ, payoutsQ, rentsQ]);

  if (ridesErr) {
    console.error('[admin-api] driver detail rides', ridesErr.message);
    return jsonResponse(500, { data: null, error: { message: 'Internal error' } });
  }
  if (payoutsErr) {
    console.error('[admin-api] driver detail payouts', payoutsErr.message);
    return jsonResponse(500, { data: null, error: { message: 'Internal error' } });
  }
  if (rentsErr) {
    console.error('[admin-api] driver detail rents', rentsErr.message);
    return jsonResponse(500, { data: null, error: { message: 'Internal error' } });
  }

  return jsonResponse(200, {
    data: {
      driver: profile,
      balance: balance ?? { driver_id: driverId, total_credits_ariary: 0, total_debits_ariary: 0, driver_balance_ariary: 0 },
      today,
      rides: { items: rides ?? [], count: ridesCount ?? 0, limit, offset },
      payouts: { items: payouts ?? [], count: payoutsCount ?? 0, limit, offset },
      rents: { items: rents ?? [], count: rentsCount ?? 0, limit, offset },
    },
    error: null,
  });
}

type CreatePayoutInput = {
  driver_id: string;
  amount_ariary: number;
  method: 'cash' | 'orange_money';
  reference?: string | null;
  notes?: string | null;
};

async function handleCreatePayout(req: Request): Promise<Response> {
  const { adminClient } = await requireAdmin(req);
  const body = await readJsonBody(req);

  const driverId = asNonEmptyString(body.driver_id);
  if (!driverId || !isUuid(driverId)) {
    throw Object.assign(new Error('driver_id must be a valid UUID'), { status: 400 });
  }

  const { data: prof, error: profErr } = await adminClient
    .from('profiles')
    .select('deleted_at')
    .eq('id', driverId.trim())
    .maybeSingle();
  if (profErr) {
    console.error('[admin-api] payout profile check', profErr.message);
    return jsonResponse(500, { data: null, error: { message: 'Internal error' } });
  }
  if (prof?.deleted_at != null) {
    return jsonResponse(400, {
      data: null,
      error: { message: 'Chauffeur désactivé : enregistrement de payout impossible.' },
    });
  }

  const amount = asInt(body.amount_ariary);
  if (amount == null || amount <= 0) {
    throw Object.assign(new Error('amount_ariary must be an integer > 0'), { status: 400 });
  }

  const method = asNonEmptyString(body.method);
  if (method !== 'cash' && method !== 'orange_money') {
    throw Object.assign(new Error("method must be one of: cash, orange_money"), { status: 400 });
  }

  const reference = asNonEmptyString(body.reference);
  const notes = asNonEmptyString(body.notes);

  const input: CreatePayoutInput = {
    driver_id: driverId.trim(),
    amount_ariary: amount,
    method,
    reference: reference ?? null,
    notes: notes ?? null,
  };

  const { data: payoutId, error } = await adminClient.rpc('record_driver_payout', {
    p_driver_id: input.driver_id,
    p_amount_ariary: input.amount_ariary,
    p_method: input.method,
    p_status: 'recorded',
    p_paid_at: null,
    p_reference: input.reference,
    p_notes: input.notes,
  });

  if (error) {
    const msg = String(error.message ?? 'RPC error');
    // Bubble up friendly Postgres-raised messages where possible.
    if (msg.includes('PAYOUT_INVALID_AMOUNT')) {
      throw Object.assign(new Error('Montant payout invalide.'), { status: 400 });
    }
    console.error('[admin-api] record_driver_payout', msg);
    return jsonResponse(500, { data: null, error: { message: 'Internal error' } });
  }

  return jsonResponse(200, { data: { payout_id: payoutId }, error: null });
}

async function handleCreateDriver(req: Request): Promise<Response> {
  const { adminClient } = await requireAdmin(req);
  const body = await readJsonBody(req);

  const firstName = asNonEmptyString(body.first_name);
  const lastName = asNonEmptyString(body.last_name);
  const phoneRaw = asNonEmptyString(body.phone);
  const plateRaw = asNonEmptyString(body.vehicle_plate);

  if (!firstName || !lastName) {
    throw Object.assign(new Error('first_name et last_name sont obligatoires'), { status: 400 });
  }
  if (!phoneRaw) {
    throw Object.assign(new Error('phone est obligatoire'), { status: 400 });
  }
  if (!plateRaw) {
    throw Object.assign(new Error('vehicle_plate est obligatoire'), { status: 400 });
  }

  const phone = normalizePhoneE164(phoneRaw);
  const fullName = `${firstName.trim()} ${lastName.trim()}`.trim();

  const { data: existingId, error: findErr } = await adminClient.rpc('admin_find_user_id_by_phone', {
    p_phone: phone,
  });
  if (findErr) {
    console.error('[admin-api] admin_find_user_id_by_phone', findErr.message);
    return jsonResponse(500, { data: null, error: { message: 'Internal error' } });
  }

  let userId = typeof existingId === 'string' && isUuid(existingId) ? existingId : null;
  let createdNewAuthUser = false;

  if (!userId) {
    const { data: created, error: cuErr } = await adminClient.auth.admin.createUser({
      phone,
      phone_confirm: true,
    });
    if (cuErr || !created?.user?.id) {
      const msg = String(cuErr?.message ?? 'createUser failed');
      const { data: retryId } = await adminClient.rpc('admin_find_user_id_by_phone', {
        p_phone: phone,
      });
      if (typeof retryId === 'string' && isUuid(retryId)) {
        userId = retryId;
      } else {
        if (/duplicate|already|exists|registered/i.test(msg)) {
          return jsonResponse(409, {
            data: null,
            error: { message: 'Ce numéro est déjà utilisé (auth).' },
          });
        }
        console.error('[admin-api] auth.admin.createUser', msg);
        return jsonResponse(500, { data: null, error: { message: 'Internal error' } });
      }
    } else {
      userId = created.user.id;
      createdNewAuthUser = true;
    }
  }

  if (!userId) {
    return jsonResponse(500, { data: null, error: { message: 'Internal error' } });
  }

  const { data: driverId, error: bundleErr } = await adminClient.rpc('admin_create_driver_bundle', {
    p_user_id: userId,
    p_full_name: fullName,
    p_phone: phone,
    p_plate: plateRaw.trim(),
  });

  if (bundleErr) {
    if (createdNewAuthUser) {
      const { error: delErr } = await adminClient.auth.admin.deleteUser(userId);
      if (delErr) {
        console.error('[admin-api] rollback deleteUser', delErr.message);
      }
    }
    const bmsg = String(bundleErr.message ?? '');
    if (bmsg.includes('PLATE_INVALID')) {
      return jsonResponse(400, { data: null, error: { message: 'Immatriculation invalide.' } });
    }
    if (bmsg.includes('FULL_NAME_INVALID')) {
      return jsonResponse(400, { data: null, error: { message: 'Nom complet invalide.' } });
    }
    if (bmsg.includes('PROFILE_DEACTIVATED')) {
      return jsonResponse(409, {
        data: null,
        error: {
          message: 'Ce numéro est lié à un chauffeur désactivé.',
        },
      });
    }
    console.error('[admin-api] admin_create_driver_bundle', bmsg);
    return jsonResponse(500, { data: null, error: { message: 'Internal error' } });
  }

  return jsonResponse(200, { data: { driver_id: driverId }, error: null });
}

async function handleDeactivateDriver(req: Request, driverIdRaw: string): Promise<Response> {
  const driverId = normalizePathId(driverIdRaw);
  if (!isUuid(driverId)) {
    return jsonResponse(400, { data: null, error: { message: 'Invalid driverId' } });
  }

  const { adminClient } = await requireAdmin(req);

  const { error: rpcErr } = await adminClient.rpc('admin_deactivate_driver', {
    p_driver_id: driverId,
  });
  if (rpcErr) {
    const msg = String(rpcErr.message ?? '');
    if (msg.includes('DRIVER_NOT_FOUND')) {
      return jsonResponse(404, { data: null, error: { message: 'Chauffeur introuvable.' } });
    }
    console.error('[admin-api] admin_deactivate_driver', msg);
    return jsonResponse(500, { data: null, error: { message: 'Internal error' } });
  }

  const { error: banErr } = await adminClient.auth.admin.updateUserById(driverId, {
    ban_duration: '876600h',
  });
  if (banErr) {
    console.error('[admin-api] ban user after deactivate', banErr.message);
  }

  return jsonResponse(200, { data: { ok: true }, error: null });
}

async function handleReactivateDriver(req: Request, driverIdRaw: string): Promise<Response> {
  const driverId = normalizePathId(driverIdRaw);
  if (!isUuid(driverId)) {
    return jsonResponse(400, { data: null, error: { message: 'Invalid driverId' } });
  }

  const { adminClient } = await requireAdmin(req);

  const { error: rpcErr } = await adminClient.rpc('admin_reactivate_driver', {
    p_driver_id: driverId,
  });
  if (rpcErr) {
    const msg = String(rpcErr.message ?? '');
    if (msg.includes('DRIVER_NOT_FOUND')) {
      return jsonResponse(404, { data: null, error: { message: 'Chauffeur introuvable.' } });
    }
    console.error('[admin-api] admin_reactivate_driver', msg);
    return jsonResponse(500, { data: null, error: { message: 'Internal error' } });
  }

  const { error: unbanErr } = await adminClient.auth.admin.updateUserById(driverId, {
    ban_duration: 'none',
  });
  if (unbanErr) {
    console.error('[admin-api] unban user after reactivate', unbanErr.message);
  }

  return jsonResponse(200, { data: { ok: true }, error: null });
}

async function handleCompletedRides(req: Request, url: URL) {
  const date = getStringParam(url, 'date');
  const finalized = getStringParam(url, 'finalized', 'all');
  const { limit, offset } = parseLimitOffset(url);

  const { adminClient } = await requireAdmin(req);

  assertOneOf('finalized', finalized, ['all', 'true', 'false'] as const);

  let q = adminClient
    .from('admin_completed_rides_financial')
    .select('*', { count: 'exact' })
    .order('ride_completed_at', { ascending: false })
    .range(offset, offset + limit - 1);

  if (finalized === 'true') q = q.eq('is_financials_finalized', true);
  if (finalized === 'false') q = q.eq('is_financials_finalized', false);

  if (date) {
    const d = parseBusinessDateOrThrow(date);
    const { startIso, endIso } = buildUtcDayRangeForMadagascar(d);
    q = q.gte('ride_completed_at', startIso).lt('ride_completed_at', endIso);
  }

  const { data, count, error } = await q;
  if (error) {
    console.error('[admin-api] completed rides', error.message);
    return jsonResponse(500, { data: null, error: { message: 'Internal error' } });
  }
  return jsonResponse(200, { data: { items: data ?? [], count: count ?? 0, limit, offset }, error: null });
}

async function handlePayouts(req: Request, url: URL) {
  const { limit, offset } = parseLimitOffset(url);
  const driverId = getStringParam(url, 'driverId');
  const method = getStringParam(url, 'method');
  const status = getStringParam(url, 'status');
  const dateFrom = getStringParam(url, 'dateFrom');
  const dateTo = getStringParam(url, 'dateTo');
  void mustBeMadagascarTz(getStringParam(url, 'tz', 'Indian/Antananarivo'));

  const { adminClient } = await requireAdmin(req);

  if (driverId && !isUuid(driverId)) {
    return jsonResponse(400, { data: null, error: { message: 'Invalid driverId' } });
  }
  assertOneOf('method', method, ['cash', 'orange_money'] as const);
  assertOneOf('status', status, ['recorded', 'sent', 'confirmed', 'cancelled'] as const);

  let q = adminClient
    .from('admin_driver_payouts_detailed')
    .select('*', { count: 'exact' })
    .order('paid_at', { ascending: false, nullsFirst: false })
    .order('created_at', { ascending: false })
    .range(offset, offset + limit - 1);

  if (driverId) q = q.eq('driver_id', driverId);
  if (method) q = q.eq('method', method);
  if (status) q = q.eq('status', status);

  if (dateFrom || dateTo) {
    const from = dateFrom ? buildUtcDayRangeForMadagascar(parseBusinessDateOrThrow(dateFrom)).startIso : null;
    const to = dateTo ? buildUtcDayRangeForMadagascar(parseBusinessDateOrThrow(dateTo)).endIso : null;

    // Filter on (paid_at in range) OR (paid_at is null AND created_at in range)
    const paidCond: string[] = [];
    const createdCond: string[] = [];

    if (from) {
      paidCond.push(`paid_at.gte.${from}`);
      createdCond.push(`created_at.gte.${from}`);
    }
    if (to) {
      paidCond.push(`paid_at.lt.${to}`);
      createdCond.push(`created_at.lt.${to}`);
    }

    const paidExpr = paidCond.join(',');
    const createdExpr = createdCond.join(',');
    const orExpr = [
      paidExpr ? `and(${paidExpr})` : '',
      createdExpr ? `and(paid_at.is.null,${createdExpr})` : 'paid_at.is.null',
    ].filter(Boolean);

    q = q.or(orExpr.join(','));
  }

  const { data, count, error } = await q;
  if (error) {
    console.error('[admin-api] payouts list', error.message);
    return jsonResponse(500, { data: null, error: { message: 'Internal error' } });
  }
  return jsonResponse(200, { data: { items: data ?? [], count: count ?? 0, limit, offset }, error: null });
}

async function handleRents(req: Request, url: URL) {
  const { limit, offset } = parseLimitOffset(url);
  const driverId = getStringParam(url, 'driverId');
  const status = getStringParam(url, 'status');
  const date = getStringParam(url, 'date');

  const { adminClient } = await requireAdmin(req);

  if (driverId && !isUuid(driverId)) {
    return jsonResponse(400, { data: null, error: { message: 'Invalid driverId' } });
  }
  assertOneOf('status', status, ['due', 'paid', 'waived'] as const);

  let q = adminClient
    .from('admin_driver_daily_rents_detailed')
    .select('*', { count: 'exact' })
    .order('business_date', { ascending: false })
    .range(offset, offset + limit - 1);

  if (driverId) q = q.eq('driver_id', driverId);
  if (status) q = q.eq('status', status);
  if (date) q = q.eq('business_date', parseBusinessDateOrThrow(date));

  const { data, count, error } = await q;
  if (error) {
    console.error('[admin-api] rents list', error.message);
    return jsonResponse(500, { data: null, error: { message: 'Internal error' } });
  }
  return jsonResponse(200, { data: { items: data ?? [], count: count ?? 0, limit, offset }, error: null });
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') {
    return new Response('ok', { headers: corsHeaders });
  }

  if (req.method !== 'GET' && req.method !== 'POST' && req.method !== 'DELETE') {
    return jsonResponse(405, { data: null, error: { message: 'Method not allowed' } });
  }

  try {
    const url = new URL(req.url);
    const path = url.pathname.replace(/\/+$/, '');
    const parts = path.split('/').filter(Boolean);

    // Expect: /admin-api/<scope>/...
    const idx = parts.findIndex((p) => p === 'admin-api');
    const rel = idx >= 0 ? parts.slice(idx + 1) : parts;
    const [scope, ...rest] = rel;

    if (!scope) {
      return jsonResponse(404, { data: null, error: { message: 'Not found' } });
    }

    if (scope === 'platform') {
      if (rest[0] === 'daily-summary') return await handlePlatformDailySummary(req, url);
      return jsonResponse(404, { data: null, error: { message: 'Not found' } });
    }

    if (scope === 'drivers') {
      if (rest[0] === 'daily-summary') return await handleDriversDailySummary(req, url);
      if (rest.length >= 2 && rest[1] === 'detail') {
        const driverId = normalizePathId(rest[0] ?? '');
        return await handleDriverDetail(req, url, driverId);
      }
      if (rest.length === 2 && rest[1] === 'reactivate' && req.method === 'POST') {
        const driverId = normalizePathId(rest[0] ?? '');
        if (!isUuid(driverId)) {
          return jsonResponse(400, { data: null, error: { message: 'Invalid driverId' } });
        }
        return await handleReactivateDriver(req, driverId);
      }
      if (rest.length === 1 && req.method === 'DELETE') {
        const driverId = normalizePathId(rest[0] ?? '');
        if (!isUuid(driverId)) {
          return jsonResponse(400, { data: null, error: { message: 'Invalid driverId' } });
        }
        return await handleDeactivateDriver(req, driverId);
      }
      if (rest.length === 0 && req.method === 'POST') return await handleCreateDriver(req);
      return jsonResponse(404, { data: null, error: { message: 'Not found' } });
    }

    if (scope === 'rides') {
      if (rest[0] === 'completed') return await handleCompletedRides(req, url);
      return jsonResponse(404, { data: null, error: { message: 'Not found' } });
    }

    if (scope === 'payouts') {
      if (rest.length === 0) {
        if (req.method === 'GET') return await handlePayouts(req, url);
        if (req.method === 'POST') return await handleCreatePayout(req);
      }
      return jsonResponse(404, { data: null, error: { message: 'Not found' } });
    }

    if (scope === 'rents') {
      if (rest.length === 0) return await handleRents(req, url);
      return jsonResponse(404, { data: null, error: { message: 'Not found' } });
    }

    return jsonResponse(404, { data: null, error: { message: 'Not found' } });
  } catch (e) {
    const status =
      e !== null &&
      typeof e === 'object' &&
      'status' in e &&
      typeof (e as { status: unknown }).status === 'number'
        ? (e as { status: number }).status
        : 500;
    const msg = e instanceof Error ? e.message : 'Unknown error';
    if (status >= 500) {
      console.error('[admin-api] unhandled error', e);
      return jsonResponse(status, { data: null, error: { message: 'Internal error' } });
    }
    return jsonResponse(status, { data: null, error: { message: msg } });
  }
});

