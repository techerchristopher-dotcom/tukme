import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.49.1';

type JsonValue = null | boolean | number | string | JsonValue[] | { [k: string]: JsonValue };

const corsHeaders: Record<string, string> = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'GET,POST,PATCH,DELETE,OPTIONS',
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

function requireBodyString(body: Record<string, unknown>, key: string): string {
  const v = body[key];
  if (typeof v !== 'string') {
    throw Object.assign(new Error(`${key} must be a string`), { status: 400 });
  }
  const t = v.trim();
  if (!t) {
    throw Object.assign(new Error(`${key} is required`), { status: 400 });
  }
  return t;
}

function requireBodyDateYmd(body: Record<string, unknown>, key: string): string {
  const v = body[key];
  if (typeof v !== 'string') {
    throw Object.assign(new Error(`${key} must be a string (YYYY-MM-DD)`), { status: 400 });
  }
  const t = v.trim();
  if (!t) {
    throw Object.assign(new Error(`${key} is required`), { status: 400 });
  }
  if (!/^\d{4}-\d{2}-\d{2}$/.test(t)) {
    throw Object.assign(new Error(`${key} must be YYYY-MM-DD`), { status: 400 });
  }
  return t;
}

function asIsoTimestampOrNull(v: unknown): string | null {
  if (typeof v !== 'string') return null;
  const t = v.trim();
  if (!t) return null;
  const d = new Date(t);
  if (!Number.isFinite(d.getTime())) return null;
  return d.toISOString();
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

  // Current vehicle (source of truth: active assignment ends_at is null).
  // We do NOT depend on the "today" read-model here.
  let currentVehicle: {
    id: string;
    kind: string | null;
    plate_number: string | null;
    active: boolean | null;
  } | null = null;

  const { data: activeAssign, error: aErr } = await adminClient
    .from('driver_vehicle_assignments')
    .select('vehicle_id, starts_at')
    .eq('driver_id', driverId)
    .is('ends_at', null)
    .order('starts_at', { ascending: false })
    .limit(1)
    .maybeSingle();
  if (aErr) {
    console.error('[admin-api] current assignment', aErr.message);
    return jsonResponse(500, { data: null, error: { message: 'Internal error' } });
  }
  if (activeAssign?.vehicle_id) {
    const { data: vRow, error: vErr } = await adminClient
      .from('vehicles')
      .select('id, kind, plate_number, active')
      .eq('id', activeAssign.vehicle_id)
      .maybeSingle();
    if (vErr) {
      console.error('[admin-api] current vehicle', vErr.message);
      return jsonResponse(500, { data: null, error: { message: 'Internal error' } });
    }
    if (vRow) {
      currentVehicle = {
        id: String(vRow.id),
        kind: typeof vRow.kind === 'string' ? vRow.kind : null,
        plate_number: typeof vRow.plate_number === 'string' ? vRow.plate_number : null,
        active: typeof vRow.active === 'boolean' ? vRow.active : null,
      };
    }
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
      current_vehicle: currentVehicle,
      rides: { items: rides ?? [], count: ridesCount ?? 0, limit, offset },
      payouts: { items: payouts ?? [], count: payoutsCount ?? 0, limit, offset },
      rents: { items: rents ?? [], count: rentsCount ?? 0, limit, offset },
    },
    error: null,
  });
}

async function handleRetireCurrentVehicle(req: Request, driverIdRaw: string): Promise<Response> {
  const driverId = normalizePathId(driverIdRaw);
  if (!isUuid(driverId)) {
    return jsonResponse(400, { data: null, error: { message: 'Invalid driverId' } });
  }

  const { adminClient } = await requireAdmin(req);

  const { error } = await adminClient.rpc('admin_retire_current_vehicle', {
    p_driver_id: driverId,
  });
  if (error) {
    const msg = String(error.message ?? '');
    console.error('[admin-api] admin_retire_current_vehicle', msg);
    return jsonResponse(500, { data: null, error: { message: 'Internal error' } });
  }

  return jsonResponse(200, { data: { ok: true }, error: null });
}

async function handleSetCurrentVehicle(req: Request, driverIdRaw: string): Promise<Response> {
  const driverId = normalizePathId(driverIdRaw);
  if (!isUuid(driverId)) {
    return jsonResponse(400, { data: null, error: { message: 'Invalid driverId' } });
  }

  const { adminClient } = await requireAdmin(req);
  const body = await readJsonBody(req);

  const kind = requireBodyString(body, 'kind');
  const plate = requireBodyString(body, 'plate_number');

  const { data: vehicleId, error } = await adminClient.rpc('admin_set_current_vehicle', {
    p_driver_id: driverId,
    p_kind: kind,
    p_plate_number: plate,
  });
  if (error) {
    const msg = String(error.message ?? '');
    if (msg.includes('PLATE_INVALID')) {
      return jsonResponse(400, { data: null, error: { message: 'Immatriculation invalide.' } });
    }
    console.error('[admin-api] admin_set_current_vehicle', msg);
    return jsonResponse(500, { data: null, error: { message: 'Internal error' } });
  }

  return jsonResponse(200, { data: { vehicle_id: vehicleId }, error: null });
}

type FleetAssignmentRow = {
  id: string;
  driver_id: string;
  vehicle_id: string;
  starts_at: string;
  ends_at: string | null;
  notes: string | null;
  created_at: string;
};

type FleetDriverProfile = { id: string; full_name: string | null; phone: string | null };

async function getDriverProfilesById(
  adminClient: ReturnType<typeof createClient>,
  ids: string[]
): Promise<Map<string, FleetDriverProfile>> {
  const uniq = Array.from(new Set(ids.filter((x) => isUuid(x))));
  if (!uniq.length) return new Map();
  const { data, error } = await adminClient
    .from('profiles')
    .select('id, full_name, phone')
    .in('id', uniq);
  if (error) {
    console.error('[admin-api] fleet profiles lookup', error.message);
    throw Object.assign(new Error('Internal error'), { status: 500 });
  }
  const m = new Map<string, FleetDriverProfile>();
  for (const r of data ?? []) {
    if (r && typeof (r as { id?: unknown }).id === 'string') {
      const row = r as { id: string; full_name?: unknown; phone?: unknown };
      m.set(String(row.id), {
        id: String(row.id),
        full_name: typeof row.full_name === 'string' ? row.full_name : null,
        phone: typeof row.phone === 'string' ? row.phone : null,
      });
    }
  }
  return m;
}

async function requireFleetVehicleExists(
  adminClient: ReturnType<typeof createClient>,
  vehicleId: string
): Promise<void> {
  const { data, error } = await adminClient
    .from('fleet_vehicles')
    .select('id')
    .eq('id', vehicleId)
    .maybeSingle();
  if (error) {
    console.error('[admin-api] fleet(manual) vehicle exists check', error.message);
    throw Object.assign(new Error('Internal error'), { status: 500 });
  }
  if (!data?.id) {
    throw Object.assign(new Error('Vehicle not found'), { status: 404 });
  }
}

function parseRpcBigintToSafeNumber(v: unknown): number {
  if (typeof v === 'number') {
    if (!Number.isFinite(v)) return 0;
    if (!Number.isSafeInteger(v)) {
      throw Object.assign(new Error('Numeric overflow (unsafe integer) from aggregates'), {
        status: 500,
      });
    }
    return v;
  }
  if (typeof v === 'string' && v.trim()) {
    const n = Number.parseInt(v.trim(), 10);
    if (!Number.isFinite(n) || !Number.isSafeInteger(n)) {
      throw Object.assign(new Error('Numeric overflow (unsafe integer) from aggregates'), {
        status: 500,
      });
    }
    return n;
  }
  return 0;
}

async function computeFleetVehicleEntriesAggregatesFromTable(args: {
  adminClient: ReturnType<typeof createClient>;
  vehicleId: string;
  logPrefix: string;
}): Promise<{ total_income_ariary: number; total_expense_ariary: number }> {
  // Minimal + robust (no SQL RPC dependency):
  // scan all entries for this vehicle and aggregate by entry_type.
  // We page to avoid the max_rows limit truncating results.
  const PAGE_SIZE = 1000;
  let scanOffset = 0;
  let income = 0;
  let expense = 0;
  for (;;) {
    const { data: rows, error: scanErr } = await args.adminClient
      .from('fleet_vehicle_entries')
      .select('entry_type, amount_ariary')
      .eq('vehicle_id', args.vehicleId)
      .order('created_at', { ascending: true })
      .range(scanOffset, scanOffset + PAGE_SIZE - 1);
    if (scanErr) {
      console.error(`${args.logPrefix} entries scan error`, {
        vehicleId: args.vehicleId,
        message: scanErr.message,
        offset: scanOffset,
      });
      throw Object.assign(new Error('Internal error'), { status: 500 });
    }
    const batch = rows ?? [];
    for (const r of batch as any[]) {
      const t = String(r?.entry_type ?? '');
      const a = typeof r?.amount_ariary === 'number' ? r.amount_ariary : Number(r?.amount_ariary ?? 0);
      if (!Number.isFinite(a)) continue;
      if (t === 'income') income += a;
      else if (t === 'expense') expense += a;
    }
    if (batch.length < PAGE_SIZE) break;
    scanOffset += PAGE_SIZE;
    if (scanOffset > 100_000) {
      console.error(`${args.logPrefix} entries scan exceeded guardrail`, {
        vehicleId: args.vehicleId,
        scanOffset,
      });
      throw Object.assign(new Error('Internal error'), { status: 500 });
    }
  }
  return { total_income_ariary: income, total_expense_ariary: expense };
}

function computeFleetManualFinancialSummary(args: {
  vehicle_id: string;
  purchase_price_ariary: number | null;
  purchase_date: string | null;
  amortization_months: number | null;
  target_resale_price_ariary: number | null;
  daily_rent_ariary: number | null;
  total_income_ariary: number;
  total_expense_ariary: number;
}): Record<string, unknown> {
  // Enforce the explicit business separation income vs expense (no ambiguous summing).
  const income = Number.isFinite(args.total_income_ariary) ? args.total_income_ariary : 0;
  const expense = Number.isFinite(args.total_expense_ariary) ? args.total_expense_ariary : 0;
  const net = income - expense;
  const purchase = typeof args.purchase_price_ariary === 'number' ? args.purchase_price_ariary : null;

  const remaining = purchase == null ? null : Math.max(purchase - net, 0);

  const amortizedPercent =
    purchase && purchase > 0
      ? Math.min(Math.max(net / purchase, 0), 1) * 100
      : null;

  return {
    vehicle_id: args.vehicle_id,
    purchase_price_ariary: purchase,
    purchase_date: args.purchase_date,
    amortization_months: args.amortization_months,
    target_resale_price_ariary: args.target_resale_price_ariary,
    daily_rent_ariary: args.daily_rent_ariary,
    total_income_ariary: income,
    total_expense_ariary: expense,
    net_ariary: net,
    remaining_to_amortize_ariary: remaining,
    amortized_percent: amortizedPercent,
    estimated_payoff_date: null,
  };
}

async function handleFleetVehiclesList(req: Request, url: URL): Promise<Response> {
  const { limit, offset } = parseLimitOffset(url);
  const status = (getStringParam(url, 'status') ?? '').trim().toLowerCase();
  if (status) {
    assertOneOf('status', status, ['active', 'inactive', 'sold', 'retired'] as const);
  }
  const driverId = (getStringParam(url, 'driver_id') ?? '').trim();
  if (driverId && !isUuid(driverId)) {
    throw Object.assign(new Error('driver_id must be a UUID'), { status: 400 });
  }
  const q = (getStringParam(url, 'q') ?? '').trim();

  const { adminClient } = await requireAdmin(req);
  console.log('[admin-api] fleet(manual) list vehicles', {
    limit,
    offset,
    status: status || null,
    driver_id: driverId || null,
    q: q || null,
  });

  let vehicleIdsFilter: string[] | null = null;
  if (driverId) {
    const { data: assigns, error: aErr } = await adminClient
      .from('fleet_vehicle_assignments')
      .select('vehicle_id')
      .eq('driver_id', driverId)
      .is('ends_at', null)
      .limit(500);
    if (aErr) {
      console.error('[admin-api] fleet(manual) list driver assignment filter', aErr.message);
      return jsonResponse(500, { data: null, error: { message: 'Internal error' } });
    }
    const ids = (assigns ?? [])
      .map((r) => String((r as { vehicle_id?: unknown })?.vehicle_id ?? ''))
      .filter((x) => isUuid(x));
    vehicleIdsFilter = ids.length ? ids : [];
  }

  let vQ = adminClient
    .from('fleet_vehicles')
    .select(
      'id, plate_number, brand, model, status, purchase_price_ariary, purchase_date, amortization_months, target_resale_price_ariary, daily_rent_ariary, notes, created_at, updated_at',
      { count: 'exact' }
    )
    .order('created_at', { ascending: false })
    .range(offset, offset + limit - 1);

  if (status) vQ = vQ.eq('status', status);
  if (q) vQ = vQ.ilike('plate_number', `%${q}%`);
  if (vehicleIdsFilter) {
    if (!vehicleIdsFilter.length) {
      return jsonResponse(200, { data: { items: [], count: 0, limit, offset }, error: null });
    }
    vQ = vQ.in('id', vehicleIdsFilter);
  }

  const { data: vehicles, count, error: vErr } = await vQ;
  if (vErr) {
    console.error('[admin-api] fleet(manual) vehicles list', vErr.message);
    return jsonResponse(500, { data: null, error: { message: 'Internal error' } });
  }
  console.log(
    '[admin-api] fleet(manual) list vehicles fetched',
    (vehicles ?? []).slice(0, 5).map((v: any) => String(v?.id ?? ''))
  );

  const vehicleIds = (vehicles ?? []).map((v: any) => String(v.id)).filter((x) => isUuid(x));
  const { data: activeAssigns, error: aErr } = await adminClient
    .from('fleet_vehicle_assignments')
    .select('id, driver_id, vehicle_id, starts_at, ends_at, notes, created_at')
    .in('vehicle_id', vehicleIds.length ? vehicleIds : ['00000000-0000-0000-0000-000000000000'])
    .is('ends_at', null)
    .order('starts_at', { ascending: false });
  if (aErr) {
    console.error('[admin-api] fleet(manual) list active assignments', aErr.message);
    return jsonResponse(500, { data: null, error: { message: 'Internal error' } });
  }

  const byVehicle = new Map<string, FleetAssignmentRow>();
  const driverIds: string[] = [];
  for (const r of activeAssigns ?? []) {
    const vid = String((r as any).vehicle_id ?? '');
    if (!isUuid(vid)) continue;
    if (!byVehicle.has(vid)) {
      byVehicle.set(vid, {
        id: String((r as any).id),
        driver_id: String((r as any).driver_id),
        vehicle_id: vid,
        starts_at: String((r as any).starts_at),
        ends_at: (r as any).ends_at == null ? null : String((r as any).ends_at),
        notes: typeof (r as any).notes === 'string' ? (r as any).notes : null,
        created_at: String((r as any).created_at),
      });
      driverIds.push(String((r as any).driver_id ?? ''));
    }
  }

  const profiles = await getDriverProfilesById(adminClient, driverIds);

  const items = (vehicles ?? []).map((v: any) => {
    const vid = String(v.id ?? '');
    const a = byVehicle.get(vid) ?? null;
    const p = a ? profiles.get(a.driver_id) ?? null : null;
    return {
      id: String(v.id ?? ''),
      plate_number: typeof v.plate_number === 'string' ? v.plate_number : null,
      brand: typeof v.brand === 'string' ? v.brand : null,
      model: typeof v.model === 'string' ? v.model : null,
      status: typeof v.status === 'string' ? v.status : null,
      purchase_price_ariary: typeof v.purchase_price_ariary === 'number' ? v.purchase_price_ariary : null,
      purchase_date: typeof v.purchase_date === 'string' ? v.purchase_date : null,
      amortization_months: typeof v.amortization_months === 'number' ? v.amortization_months : null,
      target_resale_price_ariary:
        typeof v.target_resale_price_ariary === 'number' ? v.target_resale_price_ariary : null,
      daily_rent_ariary: typeof v.daily_rent_ariary === 'number' ? v.daily_rent_ariary : null,
      active_assignment: a
        ? {
            driver_id: a.driver_id,
            driver_full_name: p?.full_name ?? null,
            driver_phone: p?.phone ?? null,
            starts_at: a.starts_at,
          }
        : null,
    };
  });

  return jsonResponse(200, { data: { items, count: count ?? 0, limit, offset }, error: null });
}

async function handleFleetVehicleGet(req: Request, url: URL, vehicleIdRaw: string): Promise<Response> {
  const vehicleId = normalizePathId(vehicleIdRaw);
  if (!isUuid(vehicleId)) {
    return jsonResponse(400, { data: null, error: { message: 'Invalid vehicleId' } });
  }
  let stage = 'init';
  try {
    stage = 'requireAdmin';
    const { adminClient, userEmail } = await requireAdmin(req);
    console.log('[admin-api] fleet(manual) vehicle detail start', { vehicleId, userEmail });

    stage = 'read fleet_vehicles';
    const { data: vehicle, error: vErr } = await adminClient
      .from('fleet_vehicles')
      .select(
        'id, plate_number, brand, model, status, purchase_price_ariary, purchase_date, amortization_months, target_resale_price_ariary, daily_rent_ariary, notes, created_at, updated_at'
      )
      .eq('id', vehicleId)
      .maybeSingle();
    if (vErr) {
      console.error('[admin-api] fleet(manual) vehicle detail fleet_vehicles error', {
        vehicleId,
        message: vErr.message,
      });
      return jsonResponse(500, { data: null, error: { message: 'Internal error' } });
    }
    if (!vehicle?.id) {
      console.log('[admin-api] fleet(manual) vehicle detail not found', { vehicleId });
      return jsonResponse(404, { data: null, error: { message: 'Vehicle not found' } });
    }

    stage = 'read active_assignment';
    const { data: activeAssign, error: aErr } = await adminClient
      .from('fleet_vehicle_assignments')
      .select('id, driver_id, vehicle_id, starts_at, ends_at, notes, created_at')
      .eq('vehicle_id', vehicleId)
      .is('ends_at', null)
      .order('starts_at', { ascending: false })
      .limit(1)
      .maybeSingle();
    if (aErr) {
      console.error('[admin-api] fleet(manual) vehicle detail active assignment error', {
        vehicleId,
        message: aErr.message,
      });
      return jsonResponse(500, { data: null, error: { message: 'Internal error' } });
    }
    console.log('[admin-api] fleet(manual) vehicle detail active assignment', {
      vehicleId,
      has_active: !!activeAssign?.id,
    });

    stage = 'read assignment_history';
    const { data: assigns, error: histErr } = await adminClient
      .from('fleet_vehicle_assignments')
      .select('id, driver_id, vehicle_id, starts_at, ends_at, notes, created_at')
      .eq('vehicle_id', vehicleId)
      .order('starts_at', { ascending: false })
      .limit(200);
    if (histErr) {
      console.error('[admin-api] fleet(manual) vehicle detail assignment history error', {
        vehicleId,
        message: histErr.message,
      });
      return jsonResponse(500, { data: null, error: { message: 'Internal error' } });
    }
    console.log('[admin-api] fleet(manual) vehicle detail assignment history', {
      vehicleId,
      count: (assigns ?? []).length,
    });

    stage = 'read driver profiles';
    const driverIds = (assigns ?? [])
      .map((r: any) => String(r.driver_id ?? ''))
      .filter((x) => isUuid(x));
    let profiles: Map<string, FleetDriverProfile>;
    try {
      profiles = await getDriverProfilesById(adminClient, driverIds);
    } catch (e) {
      console.error('[admin-api] fleet(manual) vehicle detail driver profiles error', {
        vehicleId,
        message: e instanceof Error ? e.message : String(e),
      });
      return jsonResponse(500, { data: null, error: { message: 'Internal error' } });
    }
    console.log('[admin-api] fleet(manual) vehicle detail driver profiles', {
      vehicleId,
      requested: driverIds.length,
      returned: profiles.size,
    });

    stage = 'read recent_entries';
    const { data: recentEntries, error: eErr } = await adminClient
      .from('fleet_vehicle_entries')
      .select('id, entry_type, amount_ariary, odometer_km, entry_date, category, label, notes, created_at')
      .eq('vehicle_id', vehicleId)
      .order('entry_date', { ascending: false })
      .order('created_at', { ascending: false })
      .limit(20);
    if (eErr) {
      console.error('[admin-api] fleet(manual) vehicle detail recent entries error', {
        vehicleId,
        message: eErr.message,
      });
      return jsonResponse(500, { data: null, error: { message: 'Internal error' } });
    }
    console.log('[admin-api] fleet(manual) vehicle detail recent entries', {
      vehicleId,
      count: (recentEntries ?? []).length,
    });

    stage = 'compute financial_summary (entries scan)';
    let income = 0;
    let expense = 0;
    try {
      const ag = await computeFleetVehicleEntriesAggregatesFromTable({
        adminClient,
        vehicleId,
        logPrefix: '[admin-api] fleet(manual) vehicle detail',
      });
      income = ag.total_income_ariary;
      expense = ag.total_expense_ariary;
    } catch (e) {
      const status =
        e !== null &&
        typeof e === 'object' &&
        'status' in e &&
        typeof (e as { status: unknown }).status === 'number'
          ? (e as { status: number }).status
          : 500;
      if (status >= 500) return jsonResponse(500, { data: null, error: { message: 'Internal error' } });
      return jsonResponse(status, { data: null, error: { message: 'Internal error' } });
    }
    console.log('[admin-api] fleet(manual) vehicle detail aggregates (from entries)', { vehicleId, income, expense });

    stage = 'compute financial_summary (formula)';
    const summary = computeFleetManualFinancialSummary({
      vehicle_id: vehicleId,
      purchase_price_ariary:
        typeof (vehicle as any).purchase_price_ariary === 'number' ? (vehicle as any).purchase_price_ariary : null,
      purchase_date: typeof (vehicle as any).purchase_date === 'string' ? (vehicle as any).purchase_date : null,
      amortization_months:
        typeof (vehicle as any).amortization_months === 'number' ? (vehicle as any).amortization_months : null,
      target_resale_price_ariary:
        typeof (vehicle as any).target_resale_price_ariary === 'number'
          ? (vehicle as any).target_resale_price_ariary
          : null,
      daily_rent_ariary:
        typeof (vehicle as any).daily_rent_ariary === 'number' ? (vehicle as any).daily_rent_ariary : null,
      total_income_ariary: income,
      total_expense_ariary: expense,
    });

    stage = 'shape response (active_assignment)';
    const active = activeAssign
      ? {
          driver_id: String((activeAssign as any).driver_id ?? ''),
          driver_full_name:
            profiles.get(String((activeAssign as any).driver_id ?? ''))?.full_name ?? null,
          driver_phone: profiles.get(String((activeAssign as any).driver_id ?? ''))?.phone ?? null,
          starts_at: String((activeAssign as any).starts_at),
          notes: typeof (activeAssign as any).notes === 'string' ? (activeAssign as any).notes : null,
        }
      : null;

    stage = 'shape response (assignment_history)';
    const assignmentHistory = (assigns ?? []).map((r: any) => {
      const did = String(r.driver_id ?? '');
      const p = profiles.get(did) ?? null;
      return {
        id: String(r.id ?? ''),
        driver_id: did,
        driver_full_name: p?.full_name ?? null,
        driver_phone: p?.phone ?? null,
        starts_at: String(r.starts_at),
        ends_at: r.ends_at == null ? null : String(r.ends_at),
        notes: typeof r.notes === 'string' ? r.notes : null,
        created_at: String(r.created_at),
      };
    });

    stage = 'response';
    console.log('[admin-api] fleet(manual) vehicle detail ok', {
      vehicleId,
      assignment_history_count: assignmentHistory.length,
      recent_entries_count: (recentEntries ?? []).length,
    });
    return jsonResponse(200, {
      data: {
        vehicle,
        active_assignment: active,
        assignment_history: assignmentHistory,
        recent_entries: recentEntries ?? [],
        financial_summary: summary,
      },
      error: null,
    });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    console.error('[admin-api] fleet(manual) vehicle detail unhandled', {
      vehicleId,
      stage,
      message: msg,
      stack: e instanceof Error ? e.stack : null,
    });
    return jsonResponse(500, { data: null, error: { message: 'Internal error' } });
  }
}

async function handleFleetVehicleCreate(req: Request): Promise<Response> {
  const { adminClient } = await requireAdmin(req);
  const body = await readJsonBody(req);

  const plateNumber = requireBodyString(body, 'plate_number');
  const brand = asNonEmptyString(body.brand);
  const model = asNonEmptyString(body.model);

  const status = (asNonEmptyString(body.status) ?? 'active').toLowerCase();
  assertOneOf('status', status, ['active', 'inactive', 'sold', 'retired'] as const);

  const purchasePrice = asInt(body.purchase_price_ariary);
  if (purchasePrice != null && purchasePrice < 0) {
    throw Object.assign(new Error('purchase_price_ariary must be >= 0'), { status: 400 });
  }
  const amortMonths = asInt(body.amortization_months);
  if (amortMonths != null && amortMonths <= 0) {
    throw Object.assign(new Error('amortization_months must be > 0'), { status: 400 });
  }
  const purchaseDate =
    typeof body.purchase_date === 'string' && body.purchase_date.trim()
      ? requireBodyDateYmd(body, 'purchase_date')
      : null;
  const targetResale = asInt(body.target_resale_price_ariary);
  if (targetResale != null && targetResale < 0) {
    throw Object.assign(new Error('target_resale_price_ariary must be >= 0'), { status: 400 });
  }
  if (purchasePrice != null && targetResale != null && targetResale > purchasePrice) {
    throw Object.assign(new Error('target_resale_price_ariary must be <= purchase_price_ariary'), {
      status: 400,
    });
  }
  const dailyRent = asInt(body.daily_rent_ariary);
  if (dailyRent != null && dailyRent < 0) {
    throw Object.assign(new Error('daily_rent_ariary must be >= 0'), { status: 400 });
  }
  const notes = asNonEmptyString(body.notes);

  const insertRow: Record<string, unknown> = {
    plate_number: plateNumber,
    brand: brand ?? null,
    model: model ?? null,
    status,
    purchase_price_ariary: purchasePrice,
    purchase_date: purchaseDate,
    amortization_months: amortMonths,
    target_resale_price_ariary: targetResale,
    daily_rent_ariary: dailyRent,
    notes: notes ?? null,
  };

  const { data, error } = await adminClient
    .from('fleet_vehicles')
    .insert(insertRow)
    .select('id')
    .maybeSingle();
  if (error) {
    console.error('[admin-api] fleet(manual) create vehicle', error.message);
    return jsonResponse(400, { data: null, error: { message: error.message } });
  }
  return jsonResponse(200, { data: { vehicle_id: data?.id ?? null }, error: null });
}

async function handleFleetVehiclePatch(req: Request, vehicleIdRaw: string): Promise<Response> {
  const vehicleId = normalizePathId(vehicleIdRaw);
  if (!isUuid(vehicleId)) {
    return jsonResponse(400, { data: null, error: { message: 'Invalid vehicleId' } });
  }

  const { adminClient } = await requireAdmin(req);
  await requireFleetVehicleExists(adminClient, vehicleId);

  const body = await readJsonBody(req);

  const updateRow: Record<string, unknown> = {};

  if ('plate_number' in body) {
    const pn = asNonEmptyString(body.plate_number);
    if (!pn) throw Object.assign(new Error('plate_number must be a non-empty string'), { status: 400 });
    updateRow.plate_number = pn;
  }
  if ('brand' in body) updateRow.brand = asNonEmptyString(body.brand);
  if ('model' in body) updateRow.model = asNonEmptyString(body.model);

  if ('status' in body) {
    const st = asNonEmptyString(body.status);
    if (!st) throw Object.assign(new Error('status must be a non-empty string'), { status: 400 });
    const s = st.toLowerCase();
    assertOneOf('status', s, ['active', 'inactive', 'sold', 'retired'] as const);
    updateRow.status = s;
  }

  if ('purchase_price_ariary' in body) {
    const v = body.purchase_price_ariary;
    const n = v == null ? null : asInt(v);
    if (v != null && n == null) throw Object.assign(new Error('purchase_price_ariary must be an integer'), { status: 400 });
    if (n != null && n < 0) throw Object.assign(new Error('purchase_price_ariary must be >= 0'), { status: 400 });
    updateRow.purchase_price_ariary = n;
  }

  if ('purchase_date' in body) {
    const v = body.purchase_date;
    if (v == null || (typeof v === 'string' && !v.trim())) {
      updateRow.purchase_date = null;
    } else {
      updateRow.purchase_date = requireBodyDateYmd(body, 'purchase_date');
    }
  }

  if ('amortization_months' in body) {
    const v = body.amortization_months;
    const n = v == null ? null : asInt(v);
    if (v != null && n == null) throw Object.assign(new Error('amortization_months must be an integer'), { status: 400 });
    if (n != null && n <= 0) throw Object.assign(new Error('amortization_months must be > 0'), { status: 400 });
    updateRow.amortization_months = n;
  }

  if ('target_resale_price_ariary' in body) {
    const v = body.target_resale_price_ariary;
    const n = v == null ? null : asInt(v);
    if (v != null && n == null) {
      throw Object.assign(new Error('target_resale_price_ariary must be an integer'), { status: 400 });
    }
    if (n != null && n < 0) throw Object.assign(new Error('target_resale_price_ariary must be >= 0'), { status: 400 });
    updateRow.target_resale_price_ariary = n;
  }

  if ('daily_rent_ariary' in body) {
    const v = body.daily_rent_ariary;
    const n = v == null ? null : asInt(v);
    if (v != null && n == null) throw Object.assign(new Error('daily_rent_ariary must be an integer'), { status: 400 });
    if (n != null && n < 0) throw Object.assign(new Error('daily_rent_ariary must be >= 0'), { status: 400 });
    updateRow.daily_rent_ariary = n;
  }

  if ('notes' in body) updateRow.notes = asNonEmptyString(body.notes);

  if (Object.keys(updateRow).length === 0) {
    throw Object.assign(new Error('No updatable fields provided'), { status: 400 });
  }

  const { error } = await adminClient.from('fleet_vehicles').update(updateRow).eq('id', vehicleId);
  if (error) {
    console.error('[admin-api] fleet(manual) patch vehicle', error.message);
    return jsonResponse(400, { data: null, error: { message: error.message } });
  }

  return jsonResponse(200, { data: { ok: true }, error: null });
}

async function handleFleetVehicleGetAssignment(req: Request, vehicleIdRaw: string): Promise<Response> {
  const vehicleId = normalizePathId(vehicleIdRaw);
  if (!isUuid(vehicleId)) {
    return jsonResponse(400, { data: null, error: { message: 'Invalid vehicleId' } });
  }
  const { adminClient } = await requireAdmin(req);
  await requireFleetVehicleExists(adminClient, vehicleId);

  const { data: activeAssign, error } = await adminClient
    .from('fleet_vehicle_assignments')
    .select('id, driver_id, vehicle_id, starts_at, ends_at, notes, created_at')
    .eq('vehicle_id', vehicleId)
    .is('ends_at', null)
    .order('starts_at', { ascending: false })
    .limit(1)
    .maybeSingle();
  if (error) {
    console.error('[admin-api] fleet(manual) get assignment', error.message);
    return jsonResponse(500, { data: null, error: { message: 'Internal error' } });
  }
  if (!activeAssign) return jsonResponse(200, { data: null, error: null });

  const profiles = await getDriverProfilesById(adminClient, [String((activeAssign as any).driver_id ?? '')]);
  const p = profiles.get(String((activeAssign as any).driver_id ?? '')) ?? null;
  return jsonResponse(200, {
    data: {
      id: String((activeAssign as any).id),
      vehicle_id: String((activeAssign as any).vehicle_id),
      driver_id: String((activeAssign as any).driver_id),
      driver_full_name: p?.full_name ?? null,
      driver_phone: p?.phone ?? null,
      starts_at: String((activeAssign as any).starts_at),
      notes: typeof (activeAssign as any).notes === 'string' ? (activeAssign as any).notes : null,
      created_at: String((activeAssign as any).created_at),
    },
    error: null,
  });
}

async function handleFleetVehicleAssignmentsList(
  req: Request,
  url: URL,
  vehicleIdRaw: string
): Promise<Response> {
  const vehicleId = normalizePathId(vehicleIdRaw);
  if (!isUuid(vehicleId)) {
    return jsonResponse(400, { data: null, error: { message: 'Invalid vehicleId' } });
  }
  const { limit, offset } = parseLimitOffset(url);
  const { adminClient } = await requireAdmin(req);
  await requireFleetVehicleExists(adminClient, vehicleId);

  const q = adminClient
    .from('fleet_vehicle_assignments')
    .select('id, driver_id, vehicle_id, starts_at, ends_at, notes, created_at', { count: 'exact' })
    .eq('vehicle_id', vehicleId)
    .order('starts_at', { ascending: false })
    .range(offset, offset + limit - 1);

  const { data, count, error } = await q;
  if (error) {
    console.error('[admin-api] fleet(manual) assignments list', error.message);
    return jsonResponse(500, { data: null, error: { message: 'Internal error' } });
  }

  const driverIds = (data ?? []).map((r: any) => String(r.driver_id ?? '')).filter((x) => isUuid(x));
  const profiles = await getDriverProfilesById(adminClient, driverIds);

  const items = (data ?? []).map((r: any) => {
    const did = String(r.driver_id ?? '');
    const p = profiles.get(did) ?? null;
    return {
      id: String(r.id ?? ''),
      driver_id: did,
      driver_full_name: p?.full_name ?? null,
      driver_phone: p?.phone ?? null,
      starts_at: String(r.starts_at),
      ends_at: r.ends_at == null ? null : String(r.ends_at),
      notes: typeof r.notes === 'string' ? r.notes : null,
      created_at: String(r.created_at),
    };
  });

  return jsonResponse(200, { data: { items, count: count ?? 0, limit, offset }, error: null });
}

async function handleFleetVehicleSetAssignment(req: Request, vehicleIdRaw: string): Promise<Response> {
  const vehicleId = normalizePathId(vehicleIdRaw);
  if (!isUuid(vehicleId)) {
    return jsonResponse(400, { data: null, error: { message: 'Invalid vehicleId' } });
  }
  const { adminClient } = await requireAdmin(req);
  await requireFleetVehicleExists(adminClient, vehicleId);

  const body = await readJsonBody(req);
  const driverId = asNonEmptyString(body.driver_id);
  if (!driverId || !isUuid(driverId)) {
    throw Object.assign(new Error('driver_id must be a UUID'), { status: 400 });
  }
  const startsAt = asIsoTimestampOrNull(body.starts_at) ?? new Date().toISOString();
  const notes = asNonEmptyString(body.notes);

  // Prefer the explicit alias RPC, but fall back to the canonical RPC if the alias
  // migration was not applied yet in the target database (schema cache error).
  const rpcArgs = {
    p_vehicle_id: vehicleId,
    p_driver_id: driverId,
    p_starts_at: startsAt,
    p_notes: notes ?? null,
  };

  let assignmentId: string | null = null;
  let rpcError: { message?: string } | null = null;

  {
    const { data, error } = await adminClient.rpc('admin_assign_fleet_vehicle_to_driver', rpcArgs);
    assignmentId = (data as unknown as string | null) ?? null;
    rpcError = error as unknown as { message?: string } | null;
  }

  if (rpcError && String(rpcError.message ?? '').includes('admin_assign_fleet_vehicle_to_driver')) {
    const { data, error } = await adminClient.rpc('admin_fleet_set_vehicle_assignment', rpcArgs);
    assignmentId = (data as unknown as string | null) ?? null;
    rpcError = error as unknown as { message?: string } | null;
  }

  if (rpcError) {
    const msg = String(rpcError.message ?? 'RPC error');
    return jsonResponse(400, { data: null, error: { message: msg } });
  }

  return jsonResponse(200, { data: { assignment_id: assignmentId }, error: null });
}

async function handleFleetVehicleEntriesList(req: Request, url: URL, vehicleIdRaw: string): Promise<Response> {
  const vehicleId = normalizePathId(vehicleIdRaw);
  if (!isUuid(vehicleId)) {
    return jsonResponse(400, { data: null, error: { message: 'Invalid vehicleId' } });
  }
  const { limit, offset } = parseLimitOffset(url);
  const { adminClient } = await requireAdmin(req);
  await requireFleetVehicleExists(adminClient, vehicleId);

  const entryType = (getStringParam(url, 'entry_type') ?? '').trim().toLowerCase();
  if (entryType) assertOneOf('entry_type', entryType, ['income', 'expense'] as const);

  const dateFrom = (getStringParam(url, 'date_from') ?? '').trim();
  const dateTo = (getStringParam(url, 'date_to') ?? '').trim();
  if (dateFrom && !/^\d{4}-\d{2}-\d{2}$/.test(dateFrom)) {
    throw Object.assign(new Error('date_from must be YYYY-MM-DD'), { status: 400 });
  }
  if (dateTo && !/^\d{4}-\d{2}-\d{2}$/.test(dateTo)) {
    throw Object.assign(new Error('date_to must be YYYY-MM-DD'), { status: 400 });
  }

  const q = adminClient
    .from('fleet_vehicle_entries')
    .select('id, entry_type, amount_ariary, odometer_km, entry_date, category, label, notes, created_at', {
      count: 'exact',
    })
    .eq('vehicle_id', vehicleId)
    .order('entry_date', { ascending: false })
    .order('created_at', { ascending: false })
    .range(offset, offset + limit - 1);

  let q2 = q;
  if (entryType) q2 = q2.eq('entry_type', entryType);
  if (dateFrom) q2 = q2.gte('entry_date', dateFrom);
  if (dateTo) q2 = q2.lte('entry_date', dateTo);

  const { data, count, error } = await q2;
  if (error) {
    console.error('[admin-api] fleet(manual) entries list', error.message);
    return jsonResponse(500, { data: null, error: { message: 'Internal error' } });
  }
  return jsonResponse(200, { data: { items: data ?? [], count: count ?? 0, limit, offset }, error: null });
}

async function handleFleetVehicleEntriesCreate(req: Request, vehicleIdRaw: string): Promise<Response> {
  const vehicleId = normalizePathId(vehicleIdRaw);
  if (!isUuid(vehicleId)) {
    return jsonResponse(400, { data: null, error: { message: 'Invalid vehicleId' } });
  }
  const { adminClient } = await requireAdmin(req);
  await requireFleetVehicleExists(adminClient, vehicleId);
  const body = await readJsonBody(req);

  const entryType = asNonEmptyString(body.entry_type)?.toLowerCase() ?? null;
  if (entryType !== 'income' && entryType !== 'expense') {
    throw Object.assign(new Error("entry_type must be one of: income, expense"), { status: 400 });
  }
  const amount = asInt(body.amount_ariary);
  if (amount == null || amount <= 0) {
    throw Object.assign(new Error('amount_ariary must be an integer > 0'), { status: 400 });
  }
  const odometerKmRaw = (body as Record<string, unknown>).odometer_km;
  const odometerKm = odometerKmRaw == null ? null : asInt(odometerKmRaw);
  if (odometerKmRaw != null && odometerKm == null) {
    throw Object.assign(new Error('odometer_km must be an integer'), { status: 400 });
  }
  if (odometerKm != null && odometerKm < 0) {
    throw Object.assign(new Error('odometer_km must be >= 0'), { status: 400 });
  }
  const entryDate = requireBodyDateYmd(body, 'entry_date');
  const category = requireBodyString(body, 'category');
  const label = requireBodyString(body, 'label');
  const notes = asNonEmptyString(body.notes);

  const { data, error } = await adminClient
    .from('fleet_vehicle_entries')
    .insert({
      vehicle_id: vehicleId,
      entry_type: entryType,
      amount_ariary: amount,
      odometer_km: odometerKm,
      category,
      label,
      entry_date: entryDate,
      notes: notes ?? null,
    })
    .select('id')
    .maybeSingle();
  if (error) {
    console.error('[admin-api] fleet(manual) entry create', error.message);
    return jsonResponse(400, { data: null, error: { message: error.message } });
  }
  return jsonResponse(200, { data: { entry_id: data?.id ?? null }, error: null });
}

async function handleFleetVehicleFinancialSummary(req: Request, _url: URL, vehicleIdRaw: string): Promise<Response> {
  const vehicleId = normalizePathId(vehicleIdRaw);
  if (!isUuid(vehicleId)) {
    return jsonResponse(400, { data: null, error: { message: 'Invalid vehicleId' } });
  }
  const { adminClient } = await requireAdmin(req);

  const { data: vehicle, error: vErr } = await adminClient
    .from('fleet_vehicles')
    .select(
      'id, purchase_price_ariary, purchase_date, amortization_months, target_resale_price_ariary, daily_rent_ariary'
    )
    .eq('id', vehicleId)
    .maybeSingle();
  if (vErr) {
    console.error('[admin-api] fleet(manual) summary vehicle', vErr.message);
    return jsonResponse(500, { data: null, error: { message: 'Internal error' } });
  }
  if (!vehicle?.id) return jsonResponse(404, { data: null, error: { message: 'Vehicle not found' } });

  let income = 0;
  let expense = 0;
  try {
    const ag = await computeFleetVehicleEntriesAggregatesFromTable({
      adminClient,
      vehicleId,
      logPrefix: '[admin-api] fleet(manual) financial-summary',
    });
    income = ag.total_income_ariary;
    expense = ag.total_expense_ariary;
  } catch (e) {
    return jsonResponse(500, { data: null, error: { message: 'Internal error' } });
  }

  const summary = computeFleetManualFinancialSummary({
    vehicle_id: vehicleId,
    purchase_price_ariary: typeof (vehicle as any).purchase_price_ariary === 'number' ? (vehicle as any).purchase_price_ariary : null,
    purchase_date: typeof (vehicle as any).purchase_date === 'string' ? (vehicle as any).purchase_date : null,
    amortization_months: typeof (vehicle as any).amortization_months === 'number' ? (vehicle as any).amortization_months : null,
    target_resale_price_ariary: typeof (vehicle as any).target_resale_price_ariary === 'number' ? (vehicle as any).target_resale_price_ariary : null,
    daily_rent_ariary: typeof (vehicle as any).daily_rent_ariary === 'number' ? (vehicle as any).daily_rent_ariary : null,
    total_income_ariary: income,
    total_expense_ariary: expense,
  });

  return jsonResponse(200, { data: summary, error: null });
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

  if (req.method !== 'GET' && req.method !== 'POST' && req.method !== 'PATCH' && req.method !== 'DELETE') {
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
      if (rest.length === 2 && rest[1] === 'vehicle' && req.method === 'DELETE') {
        const driverId = normalizePathId(rest[0] ?? '');
        return await handleRetireCurrentVehicle(req, driverId);
      }
      if (rest.length === 2 && rest[1] === 'vehicle' && req.method === 'POST') {
        const driverId = normalizePathId(rest[0] ?? '');
        return await handleSetCurrentVehicle(req, driverId);
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

    if (scope === 'fleet') {
      if (rest.length === 1 && rest[0] === 'vehicles') {
        if (req.method === 'GET') return await handleFleetVehiclesList(req, url);
        if (req.method === 'POST') return await handleFleetVehicleCreate(req);
      }
      if (rest.length >= 2 && rest[0] === 'vehicles') {
        const vehicleId = normalizePathId(rest[1] ?? '');
        if (rest.length === 2 && req.method === 'GET') return await handleFleetVehicleGet(req, url, vehicleId);
        if (rest.length === 2 && req.method === 'PATCH') return await handleFleetVehiclePatch(req, vehicleId);
        if (rest.length === 3 && rest[2] === 'assignment' && req.method === 'GET') {
          return await handleFleetVehicleGetAssignment(req, vehicleId);
        }
        if (rest.length === 3 && rest[2] === 'assignment' && req.method === 'POST') {
          return await handleFleetVehicleSetAssignment(req, vehicleId);
        }
        if (rest.length === 3 && rest[2] === 'assignments' && req.method === 'GET') {
          return await handleFleetVehicleAssignmentsList(req, url, vehicleId);
        }
        if (rest.length === 3 && rest[2] === 'entries' && req.method === 'GET') {
          return await handleFleetVehicleEntriesList(req, url, vehicleId);
        }
        if (rest.length === 3 && rest[2] === 'entries' && req.method === 'POST') {
          return await handleFleetVehicleEntriesCreate(req, vehicleId);
        }
        if (rest.length === 3 && rest[2] === 'financial-summary' && req.method === 'GET') {
          return await handleFleetVehicleFinancialSummary(req, url, vehicleId);
        }
      }
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

