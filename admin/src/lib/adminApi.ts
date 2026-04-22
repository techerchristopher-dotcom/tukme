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
  FleetAssignmentCreateInput,
  FleetVehicleCreateInput,
  FleetVehicleDetailResponse,
  FleetVehicleListItem,
  FleetVehiclePatchInput,
  FleetEntryCreateInput,
  FleetEntryPatchInput,
  FleetEntryPaymentRow,
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

async function callAdminJsonWithMethod<T>(args: {
  path: string;
  method: 'POST' | 'PATCH';
  body: Record<string, unknown>;
}): Promise<ApiResult<T>> {
  if (args.method === 'POST') {
    return callAdminJson<T>({ path: args.path, method: 'POST', body: args.body });
  }

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

async function callAdminDeleteJson<T>(args: {
  path: string;
  body?: Record<string, unknown>;
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
      method: 'DELETE',
      headers: {
        Authorization: `Bearer ${token}`,
        ...(API_KEY ? { apikey: API_KEY } : {}),
        ...(args.body ? { 'Content-Type': 'application/json' } : {}),
      },
      body: args.body ? JSON.stringify(args.body) : undefined,
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

// ---------------------------------------------------------------------------
// Fleet manual module (Suivi du parc)
// ---------------------------------------------------------------------------
export async function getFleetVehicles(params: {
  status?: string | null;
  driver_id?: string | null;
  q?: string | null;
  limit?: number;
  offset?: number;
}): Promise<ApiResult<Paginated<FleetVehicleListItem>>> {
  const query = buildQuery({
    status: params.status ?? undefined,
    driver_id: params.driver_id ?? undefined,
    q: params.q ?? undefined,
    limit: params.limit ?? 50,
    offset: params.offset ?? 0,
  });
  return fetchAdmin(`/fleet/vehicles${query}`);
}

export async function getFleetVehicle(vehicleId: string): Promise<ApiResult<FleetVehicleDetailResponse>> {
  const id = vehicleId.trim();
  if (!isUuidString(id)) {
    return { data: null, error: { message: 'Identifiant véhicule invalide' } };
  }
  return fetchAdmin(`/fleet/vehicles/${encodeURIComponent(id)}`);
}

export async function createFleetVehicle(
  input: FleetVehicleCreateInput
): Promise<ApiResult<{ vehicle_id: string | null }>> {
  const plate = input.plate_number.trim();
  if (!plate) return { data: null, error: { message: 'plate_number obligatoire' } };
  return callAdminJson<{ vehicle_id: string | null }>({
    path: '/fleet/vehicles',
    method: 'POST',
    body: {
      plate_number: plate,
      brand: input.brand ?? null,
      model: input.model ?? null,
      status: input.status ?? 'active',
      purchase_price_ariary: input.purchase_price_ariary ?? null,
      purchase_date: input.purchase_date ?? null,
      amortization_months: input.amortization_months ?? null,
      target_resale_price_ariary: input.target_resale_price_ariary ?? null,
      daily_rent_ariary: input.daily_rent_ariary ?? null,
      notes: input.notes ?? null,
    },
  });
}

export async function patchFleetVehicle(
  vehicleId: string,
  patch: FleetVehiclePatchInput
): Promise<ApiResult<{ ok: boolean }>> {
  const id = vehicleId.trim();
  if (!isUuidString(id)) {
    return { data: null, error: { message: 'Identifiant véhicule invalide' } };
  }
  return callAdminJsonWithMethod<{ ok: boolean }>({
    path: `/fleet/vehicles/${encodeURIComponent(id)}`,
    method: 'PATCH',
    body: patch as Record<string, unknown>,
  });
}

export async function listFleetVehicleEntryPayments(
  vehicleId: string,
  entryId: string
): Promise<ApiResult<{ items: FleetEntryPaymentRow[] }>> {
  const vid = vehicleId.trim();
  if (!isUuidString(vid)) {
    return { data: null, error: { message: 'Identifiant véhicule invalide' } };
  }
  const eid = entryId.trim();
  if (!isUuidString(eid)) {
    return { data: null, error: { message: 'Identifiant écriture invalide' } };
  }
  return fetchAdmin(
    `/fleet/vehicles/${encodeURIComponent(vid)}/entries/${encodeURIComponent(eid)}/payments`
  );
}

export async function createFleetVehicleEntryPayment(
  vehicleId: string,
  entryId: string,
  input: {
    amount_ariary: number;
    paid_at?: string | null;
    notes?: string | null;
  }
): Promise<ApiResult<{ payment_id: string }>> {
  const vid = vehicleId.trim();
  if (!isUuidString(vid)) {
    return { data: null, error: { message: 'Identifiant véhicule invalide' } };
  }
  const eid = entryId.trim();
  if (!isUuidString(eid)) {
    return { data: null, error: { message: 'Identifiant écriture invalide' } };
  }
  const amount = input.amount_ariary;
  if (!Number.isInteger(amount) || amount <= 0) {
    return { data: null, error: { message: 'amount_ariary doit être un entier > 0' } };
  }
  return callAdminJson<{ payment_id: string }>({
    path: `/fleet/vehicles/${encodeURIComponent(vid)}/entries/${encodeURIComponent(eid)}/payments`,
    method: 'POST',
    body: {
      amount_ariary: amount,
      ...(input.paid_at != null && String(input.paid_at).trim()
        ? { paid_at: String(input.paid_at).trim() }
        : {}),
      notes: input.notes ?? null,
    },
  });
}

export async function createFleetVehicleEntry(
  vehicleId: string,
  input: FleetEntryCreateInput
): Promise<ApiResult<{ entry_id: string | null }>> {
  const id = vehicleId.trim();
  if (!isUuidString(id)) {
    return { data: null, error: { message: 'Identifiant véhicule invalide' } };
  }
  return callAdminJson<{ entry_id: string | null }>({
    path: `/fleet/vehicles/${encodeURIComponent(id)}/entries`,
    method: 'POST',
    body: {
      entry_type: input.entry_type,
      amount_ariary: input.amount_ariary,
      odometer_km: input.odometer_km ?? null,
      entry_date: input.entry_date,
      category: input.category,
      label: input.label,
      notes: input.notes ?? null,

      // Fuel snapshot fields (optional; used when category="carburant")
      fuel_km_start: input.fuel_km_start ?? null,
      fuel_km_end: input.fuel_km_end ?? null,
      fuel_km_travelled: input.fuel_km_travelled ?? null,
      fuel_price_per_litre_ariary_used: input.fuel_price_per_litre_ariary_used ?? null,
      fuel_consumption_l_per_km_used: input.fuel_consumption_l_per_km_used ?? null,
      fuel_due_ariary: input.fuel_due_ariary ?? null,

      fuel_recharge_litres_used: input.fuel_recharge_litres_used ?? null,
      fuel_recharge_km_credited_used: input.fuel_recharge_km_credited_used ?? null,
    },
  });
}

export async function patchFleetVehicleEntry(
  vehicleId: string,
  entryId: string,
  patch: FleetEntryPatchInput
): Promise<ApiResult<{ ok: boolean }>> {
  const vid = vehicleId.trim();
  if (!isUuidString(vid)) {
    return { data: null, error: { message: 'Identifiant véhicule invalide' } };
  }
  const eid = entryId.trim();
  if (!isUuidString(eid)) {
    return { data: null, error: { message: 'Identifiant écriture invalide' } };
  }
  return callAdminJsonWithMethod<{ ok: boolean }>({
    path: `/fleet/vehicles/${encodeURIComponent(vid)}/entries/${encodeURIComponent(eid)}`,
    method: 'PATCH',
    body: patch as Record<string, unknown>,
  });
}

export async function softDeleteFleetVehicleEntry(
  vehicleId: string,
  entryId: string,
  input?: { delete_reason?: string | null }
): Promise<ApiResult<{ ok: boolean }>> {
  const vid = vehicleId.trim();
  if (!isUuidString(vid)) {
    return { data: null, error: { message: 'Identifiant véhicule invalide' } };
  }
  const eid = entryId.trim();
  if (!isUuidString(eid)) {
    return { data: null, error: { message: 'Identifiant écriture invalide' } };
  }
  return callAdminDeleteJson<{ ok: boolean }>({
    path: `/fleet/vehicles/${encodeURIComponent(vid)}/entries/${encodeURIComponent(eid)}`,
    body: input?.delete_reason ? { delete_reason: input.delete_reason } : undefined,
  });
}

export async function setFleetVehicleAssignment(
  vehicleId: string,
  input: FleetAssignmentCreateInput
): Promise<ApiResult<{ assignment_id: string | null }>> {
  const id = vehicleId.trim();
  if (!isUuidString(id)) {
    return { data: null, error: { message: 'Identifiant véhicule invalide' } };
  }
  const driverId = input.driver_id.trim();
  if (!isUuidString(driverId)) {
    return { data: null, error: { message: 'driver_id invalide (UUID attendu)' } };
  }
  return callAdminJson<{ assignment_id: string | null }>({
    path: `/fleet/vehicles/${encodeURIComponent(id)}/assignment`,
    method: 'POST',
    body: {
      driver_id: driverId,
      starts_at: input.starts_at ?? null,
      notes: input.notes ?? null,
    },
  });
}

