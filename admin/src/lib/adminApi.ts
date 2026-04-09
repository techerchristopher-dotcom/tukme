import { getSupabaseBrowser } from './supabaseBrowserClient';
import { isUuidString } from './uuid';
import type {
  ApiError,
  ApiResult,
  CompletedRideRow,
  CreateDriverInput,
  CreateDriverPayoutInput,
  CreateDriverPayoutResponse,
  CreateDriverResponse,
  DeactivateDriverResponse,
  DailyRentRow,
  DriverAccountListFilter,
  DriverDailySummaryRow,
  DriverDetailResponse,
  Paginated,
  PayoutRow,
  PlatformDailySummary,
  PayoutMethod,
  PayoutStatus,
  RentStatus,
} from './types';

const DEFAULT_TIMEOUT_MS = 10_000;

const BASE_URL = (() => {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL ?? '';
  if (!url) return '';
  return `${url.replace(/\/+$/, '')}/functions/v1/admin-api`;
})();

const API_KEY = (process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ?? '').trim();

function readStringProp(obj: Record<string, unknown>, key: string): string | null {
  const v = obj[key];
  return typeof v === 'string' && v.trim() ? v.trim() : null;
}

function parseApiError(payload: unknown, fallback: string): ApiError {
  if (payload && typeof payload === 'object' && payload !== null && !Array.isArray(payload)) {
    const o = payload as Record<string, unknown>;
    const err = o.error;
    let msg = '';
    if (err && typeof err === 'object' && err !== null && !Array.isArray(err)) {
      const em = readStringProp(err as Record<string, unknown>, 'message');
      if (em) msg = em;
    } else if (typeof err === 'string' && err.trim()) {
      msg = err.trim();
    }
    if (!msg) {
      const top = readStringProp(o, 'message');
      if (top) msg = top;
    }
    if (msg) return { message: msg };
  }
  return { message: fallback };
}

function buildQuery(params: Record<string, string | number | boolean | null | undefined>): string {
  const q = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) {
    if (v == null) continue;
    q.set(k, String(v));
  }
  const s = q.toString();
  return s ? `?${s}` : '';
}

async function fetchAdmin<T>(pathAndQuery: string): Promise<ApiResult<T>> {
  if (!BASE_URL) return { data: null, error: { message: 'Missing NEXT_PUBLIC_SUPABASE_URL' } };

  const supabase = getSupabaseBrowser();
  if (!supabase) {
    return {
      data: null,
      error: { message: 'Missing NEXT_PUBLIC_SUPABASE_URL / NEXT_PUBLIC_SUPABASE_ANON_KEY' },
    };
  }

  const { data, error: sessErr } = await supabase.auth.getSession();
  if (sessErr) return { data: null, error: { message: 'Session error' } };
  const token = data.session?.access_token;
  if (!token) return { data: null, error: { message: 'Not authenticated' } };

  if (process.env.NODE_ENV !== 'production') {
    // eslint-disable-next-line no-console
    console.debug('[adminApi] access_token present:', token.length > 0);
    // eslint-disable-next-line no-console
    console.debug('[adminApi] apikey present:', API_KEY.length > 0);
    // eslint-disable-next-line no-console
    console.debug('[adminApi] session present:', !!data.session);
    // eslint-disable-next-line no-console
    console.debug('[adminApi] session expires_at:', data.session?.expires_at ?? null);
    // eslint-disable-next-line no-console
    console.debug('[adminApi] token prefix:', token.slice(0, 16));
    // eslint-disable-next-line no-console
    console.debug('[adminApi] token suffix:', token.slice(-16));

    // Check what Supabase Auth thinks the current user is (should match JWT sub).
    try {
      const { data: u, error: ue } = await supabase.auth.getUser();
      // eslint-disable-next-line no-console
      console.debug('[adminApi] getUser ok:', !ue);
      // eslint-disable-next-line no-console
      console.debug('[adminApi] getUser error:', ue?.message ?? null);
      // eslint-disable-next-line no-console
      console.debug('[adminApi] user id:', u.user?.id ?? null);
      // eslint-disable-next-line no-console
      console.debug('[adminApi] user email:', u.user?.email ?? null);
    } catch (e) {
      // eslint-disable-next-line no-console
      console.debug('[adminApi] getUser threw:', e instanceof Error ? e.message : String(e));
    }

    // Optional claims helper if available in this SDK version.
    try {
      const anyAuth = supabase.auth as unknown as { getClaims?: () => Promise<unknown> };
      if (typeof anyAuth.getClaims === 'function') {
        const claims = await anyAuth.getClaims();
        // eslint-disable-next-line no-console
        console.debug('[adminApi] getClaims available: true');
        // eslint-disable-next-line no-console
        console.debug('[adminApi] claims (raw):', claims);
      } else {
        // eslint-disable-next-line no-console
        console.debug('[adminApi] getClaims available: false');
      }
    } catch (e) {
      // eslint-disable-next-line no-console
      console.debug('[adminApi] getClaims threw:', e instanceof Error ? e.message : String(e));
    }
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), DEFAULT_TIMEOUT_MS);

  let res: Response;
  try {
    res = await fetch(`${BASE_URL}${pathAndQuery}`, {
      method: 'GET',
      headers: {
        Authorization: `Bearer ${token}`,
        ...(API_KEY ? { apikey: API_KEY } : {}),
      },
      signal: controller.signal,
    });
  } catch (e) {
    clearTimeout(timer);
    if (e instanceof DOMException && e.name === 'AbortError') {
      return { data: null, error: { message: 'Request timeout' } };
    }
    return { data: null, error: { message: 'Request failed' } };
  } finally {
    clearTimeout(timer);
  }

  const payload = await res.json().catch(() => null);

  if (!res.ok) {
    const fallback = `HTTP ${res.status}`;
    return { data: null, error: parseApiError(payload, fallback) };
  }

  if (!payload || typeof payload !== 'object') {
    return { data: null, error: { message: 'Invalid response' } };
  }

  // Expect Edge Function standard envelope: { data, error }
  const env = payload as Record<string, unknown>;
  if (env.error != null && env.error !== false) {
    return { data: null, error: parseApiError(env, 'Request failed') };
  }
  const inner = env.data;
  return { data: (inner as T) ?? null, error: null } as ApiResult<T>;
}

async function callAdminJson<T>(args: {
  path: string;
  method: 'POST';
  body: Record<string, unknown>;
}): Promise<ApiResult<T>> {
  if (!BASE_URL) return { data: null, error: { message: 'Missing NEXT_PUBLIC_SUPABASE_URL' } };

  const supabase = getSupabaseBrowser();
  if (!supabase) {
    return {
      data: null,
      error: { message: 'Missing NEXT_PUBLIC_SUPABASE_URL / NEXT_PUBLIC_SUPABASE_ANON_KEY' },
    };
  }

  const { data, error: sessErr } = await supabase.auth.getSession();
  if (sessErr) return { data: null, error: { message: 'Session error' } };
  const token = data.session?.access_token;
  if (!token) return { data: null, error: { message: 'Not authenticated' } };

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), DEFAULT_TIMEOUT_MS);

  let res: Response;
  try {
    res = await fetch(`${BASE_URL}${args.path}`, {
      method: args.method,
      headers: {
        Authorization: `Bearer ${token}`,
        ...(API_KEY ? { apikey: API_KEY } : {}),
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(args.body),
      signal: controller.signal,
    });
  } catch (e) {
    clearTimeout(timer);
    if (e instanceof DOMException && e.name === 'AbortError') {
      return { data: null, error: { message: 'Request timeout' } };
    }
    return { data: null, error: { message: 'Request failed' } };
  } finally {
    clearTimeout(timer);
  }

  const payload = await res.json().catch(() => null);
  if (!res.ok) {
    const fallback = `HTTP ${res.status}`;
    return { data: null, error: parseApiError(payload, fallback) };
  }

  if (!payload || typeof payload !== 'object') {
    return { data: null, error: { message: 'Invalid response' } };
  }

  const env = payload as Record<string, unknown>;
  if (env.error != null && env.error !== false) {
    return { data: null, error: parseApiError(env, 'Request failed') };
  }
  return { data: (env.data as T) ?? null, error: null } as ApiResult<T>;
}

async function callAdminDelete<T>(path: string): Promise<ApiResult<T>> {
  if (!BASE_URL) return { data: null, error: { message: 'Missing NEXT_PUBLIC_SUPABASE_URL' } };

  const supabase = getSupabaseBrowser();
  if (!supabase) {
    return {
      data: null,
      error: { message: 'Missing NEXT_PUBLIC_SUPABASE_URL / NEXT_PUBLIC_SUPABASE_ANON_KEY' },
    };
  }

  const { data, error: sessErr } = await supabase.auth.getSession();
  if (sessErr) return { data: null, error: { message: 'Session error' } };
  const token = data.session?.access_token;
  if (!token) return { data: null, error: { message: 'Not authenticated' } };

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), DEFAULT_TIMEOUT_MS);

  let res: Response;
  try {
    res = await fetch(`${BASE_URL}${path}`, {
      method: 'DELETE',
      headers: {
        Authorization: `Bearer ${token}`,
        ...(API_KEY ? { apikey: API_KEY } : {}),
      },
      signal: controller.signal,
    });
  } catch (e) {
    clearTimeout(timer);
    if (e instanceof DOMException && e.name === 'AbortError') {
      return { data: null, error: { message: 'Request timeout' } };
    }
    return { data: null, error: { message: 'Request failed' } };
  } finally {
    clearTimeout(timer);
  }

  const payload = await res.json().catch(() => null);
  if (!res.ok) {
    const fallback = `HTTP ${res.status}`;
    return { data: null, error: parseApiError(payload, fallback) };
  }

  if (!payload || typeof payload !== 'object') {
    return { data: null, error: { message: 'Invalid response' } };
  }

  const env = payload as Record<string, unknown>;
  if (env.error != null && env.error !== false) {
    return { data: null, error: parseApiError(env, 'Request failed') };
  }
  return { data: (env.data as T) ?? null, error: null } as ApiResult<T>;
}

export async function deactivateDriver(driverId: string): Promise<ApiResult<DeactivateDriverResponse>> {
  const id = driverId.trim();
  if (!isUuidString(id)) {
    return { data: null, error: { message: 'Identifiant chauffeur invalide' } };
  }
  return callAdminDelete<DeactivateDriverResponse>(`/drivers/${encodeURIComponent(id)}`);
}

export async function reactivateDriver(driverId: string): Promise<ApiResult<DeactivateDriverResponse>> {
  const id = driverId.trim();
  if (!isUuidString(id)) {
    return { data: null, error: { message: 'Identifiant chauffeur invalide' } };
  }
  return callAdminJson<DeactivateDriverResponse>({
    path: `/drivers/${encodeURIComponent(id)}/reactivate`,
    method: 'POST',
    body: {},
  });
}

export async function getPlatformDailySummary(
  date: string
): Promise<ApiResult<PlatformDailySummary>> {
  return fetchAdmin(`/platform/daily-summary?date=${encodeURIComponent(date)}&tz=Indian/Antananarivo`);
}

export async function getDriversDailySummary(
  date: string,
  driverStatus: DriverAccountListFilter = 'active'
): Promise<ApiResult<DriverDailySummaryRow[]>> {
  const q = buildQuery({
    date,
    tz: 'Indian/Antananarivo',
    driver_status: driverStatus,
  });
  return fetchAdmin(`/drivers/daily-summary${q}`);
}

export async function getCompletedRides(params: {
  date?: string;
  finalized?: 'all' | 'true' | 'false';
  limit?: number;
  offset?: number;
}): Promise<ApiResult<Paginated<CompletedRideRow>>> {
  const query = buildQuery({
    date: params.date,
    tz: 'Indian/Antananarivo',
    finalized: params.finalized ?? 'all',
    limit: params.limit ?? 50,
    offset: params.offset ?? 0,
  });
  return fetchAdmin(`/rides/completed${query}`);
}

export async function getPayouts(params: {
  dateFrom?: string;
  dateTo?: string;
  driverId?: string;
  method?: PayoutMethod | null;
  status?: PayoutStatus | null;
  limit?: number;
  offset?: number;
}): Promise<ApiResult<Paginated<PayoutRow>>> {
  const query = buildQuery({
    dateFrom: params.dateFrom,
    dateTo: params.dateTo,
    driverId: params.driverId,
    method: params.method,
    status: params.status,
    tz: 'Indian/Antananarivo',
    limit: params.limit ?? 50,
    offset: params.offset ?? 0,
  });
  return fetchAdmin(`/payouts${query}`);
}

export async function getRents(params: {
  date?: string;
  driverId?: string;
  status?: RentStatus | null;
  limit?: number;
  offset?: number;
}): Promise<ApiResult<Paginated<DailyRentRow>>> {
  const query = buildQuery({
    date: params.date,
    driverId: params.driverId,
    status: params.status,
    limit: params.limit ?? 50,
    offset: params.offset ?? 0,
  });
  return fetchAdmin(`/rents${query}`);
}

export async function getDriverDetail(params: {
  driverId: string;
  date: string;
  limit?: number;
  offset?: number;
}): Promise<ApiResult<DriverDetailResponse>> {
  const id = params.driverId.trim();
  if (!isUuidString(id)) {
    return { data: null, error: { message: 'Identifiant chauffeur invalide' } };
  }
  const query = buildQuery({
    date: params.date,
    tz: 'Indian/Antananarivo',
    limit: params.limit ?? 50,
    offset: params.offset ?? 0,
  });
  return fetchAdmin(`/drivers/${encodeURIComponent(id)}/detail${query}`);
}

export async function retireDriverCurrentVehicle(driverId: string): Promise<ApiResult<{ ok: boolean }>> {
  const id = driverId.trim();
  if (!isUuidString(id)) {
    return { data: null, error: { message: 'Identifiant chauffeur invalide' } };
  }
  return callAdminDelete<{ ok: boolean }>(`/drivers/${encodeURIComponent(id)}/vehicle`);
}

export async function setDriverCurrentVehicle(input: {
  driverId: string;
  kind: string;
  plate_number: string;
}): Promise<ApiResult<{ vehicle_id: string }>> {
  const id = input.driverId.trim();
  if (!isUuidString(id)) {
    return { data: null, error: { message: 'Identifiant chauffeur invalide' } };
  }
  const kind = input.kind.trim();
  const plate = input.plate_number.trim();
  if (!kind) {
    return { data: null, error: { message: 'Type véhicule obligatoire' } };
  }
  if (!plate) {
    return { data: null, error: { message: 'Immatriculation obligatoire' } };
  }
  return callAdminJson<{ vehicle_id: string }>({
    path: `/drivers/${encodeURIComponent(id)}/vehicle`,
    method: 'POST',
    body: { kind, plate_number: plate },
  });
}

export async function createDriver(
  input: CreateDriverInput
): Promise<ApiResult<CreateDriverResponse>> {
  const first = input.first_name.trim();
  const last = input.last_name.trim();
  const phone = input.phone.trim();
  const plate = input.vehicle_plate.trim();
  if (!first || !last) {
    return { data: null, error: { message: 'Prénom et nom obligatoires' } };
  }
  if (!phone) {
    return { data: null, error: { message: 'Téléphone obligatoire' } };
  }
  if (!plate) {
    return { data: null, error: { message: 'Immatriculation obligatoire' } };
  }
  return callAdminJson<CreateDriverResponse>({
    path: '/drivers',
    method: 'POST',
    body: {
      first_name: first,
      last_name: last,
      phone,
      vehicle_plate: plate,
    },
  });
}

export async function createDriverPayout(
  input: CreateDriverPayoutInput
): Promise<ApiResult<CreateDriverPayoutResponse>> {
  const driverId = input.driver_id.trim();
  if (!isUuidString(driverId)) {
    return { data: null, error: { message: 'driver_id invalide' } };
  }
  const amount = input.amount_ariary;
  if (!Number.isInteger(amount) || amount <= 0) {
    return { data: null, error: { message: 'amount_ariary doit être un entier > 0' } };
  }
  if (input.method !== 'cash' && input.method !== 'orange_money') {
    return { data: null, error: { message: 'method invalide' } };
  }

  return callAdminJson<CreateDriverPayoutResponse>({
    path: '/payouts',
    method: 'POST',
    body: {
      driver_id: driverId,
      amount_ariary: amount,
      method: input.method,
      reference: input.reference ?? null,
      notes: input.notes ?? null,
    },
  });
}

