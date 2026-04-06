import { getSupabaseBrowser } from './supabaseBrowserClient';
import type {
  ApiError,
  ApiResult,
  CompletedRideRow,
  DailyRentRow,
  DriverDailySummaryRow,
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

function parseApiError(payload: unknown, fallback: string): ApiError {
  if (payload && typeof payload === 'object') {
    const anyPayload = payload as any;
    const msg =
      (typeof anyPayload?.error?.message === 'string' && anyPayload.error.message) ||
      (typeof anyPayload?.error === 'string' && anyPayload.error) ||
      (typeof anyPayload?.message === 'string' && anyPayload.message) ||
      '';
    if (msg.trim()) return { message: msg.trim() };
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
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), DEFAULT_TIMEOUT_MS);

  let res: Response;
  try {
    res = await fetch(`${BASE_URL}${pathAndQuery}`, {
      method: 'GET',
      headers: { Authorization: `Bearer ${token}` },
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
  const env = payload as any;
  if (env.error) {
    return { data: null, error: parseApiError(env, 'Request failed') };
  }
  return { data: (env.data as T) ?? null, error: null } as ApiResult<T>;
}

export async function getPlatformDailySummary(
  date: string
): Promise<ApiResult<PlatformDailySummary>> {
  return fetchAdmin(`/platform/daily-summary?date=${encodeURIComponent(date)}&tz=Indian/Antananarivo`);
}

export async function getDriversDailySummary(
  date: string
): Promise<ApiResult<DriverDailySummaryRow[]>> {
  return fetchAdmin(`/drivers/daily-summary?date=${encodeURIComponent(date)}&tz=Indian/Antananarivo`);
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

