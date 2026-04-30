'use client';

import { useEffect, useMemo, useState } from 'react';
import { AdminShell } from '@/components/layout/AdminShell';
import { RequireAuth } from '@/components/auth/RequireAuth';
import { useBusinessDate } from '@/hooks/useBusinessDate';
import { getRents } from '@/lib/adminApi';
import { formatAriary } from '@/lib/money';
import type { DailyRentRow, RentStatus } from '@/lib/types';

export default function RentsPage() {
  const { businessDate, setBusinessDate } = useBusinessDate();
  const [status, setStatus] = useState<RentStatus | ''>('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [data, setData] = useState<{ items: DailyRentRow[]; count: number; limit: number; offset: number } | null>(
    null
  );
  const [offset, setOffset] = useState(0);
  const limit = 50;

  useEffect(() => {
    let cancelled = false;
    setError(null);
    setLoading(true);
    void (async () => {
      const res = await getRents({
        date: businessDate,
        status: status || null,
        limit,
        offset,
      });
      if (cancelled) return;
      if (res.error) setError(res.error.message);
      else setData(res.data);
      setLoading(false);
    })();
    return () => {
      cancelled = true;
    };
  }, [businessDate, status, offset]);

  const items = data?.items ?? [];
  const count = data?.count ?? 0;
  const canPrev = offset > 0;
  const canNext = offset + limit < count;
  const titleSuffix = useMemo(() => (data ? `(${count})` : ''), [count, data]);

  return (
    <RequireAuth>
      <AdminShell title={`Locations ${titleSuffix}`.trim()}>
        <div className="flex flex-col gap-3 md:flex-row md:items-end md:justify-between md:gap-4">
          <div className="flex flex-col gap-3 md:flex-row md:flex-wrap md:items-end md:gap-4">
            <label className="flex flex-col gap-1 text-sm">
              <span className="text-zinc-700">Jour (Madagascar)</span>
              <input
                className="w-full md:w-44 rounded-lg border border-zinc-200 px-3 py-2 outline-none focus:border-zinc-400"
                type="date"
                value={businessDate}
                onChange={(e) => {
                  setBusinessDate(e.target.value);
                  setOffset(0);
                }}
              />
            </label>
            <label className="flex flex-col gap-1 text-sm">
              <span className="text-zinc-700">Statut</span>
              <select
                className="w-full md:w-44 rounded-lg border border-zinc-200 px-3 py-2 outline-none focus:border-zinc-400"
                value={status}
                onChange={(e) => {
                  setStatus(e.target.value as any);
                  setOffset(0);
                }}
              >
                <option value="">Tous</option>
                <option value="due">Due</option>
                <option value="paid">Paid</option>
                <option value="waived">Waived</option>
              </select>
            </label>
          </div>
          <div className="text-sm text-zinc-600">{loading ? 'Chargement…' : error ? 'Erreur' : 'OK'}</div>
        </div>

        {error ? (
          <div className="mt-4 rounded-lg border border-red-200 bg-red-50 p-3 text-sm text-red-900">
            {error}
          </div>
        ) : null}

        {!loading && !error && items.length === 0 ? (
          <div className="mt-4 text-sm text-zinc-600">Aucune location.</div>
        ) : null}

        {items.length ? (
          <div className="mt-4 overflow-x-auto">
            <table className="min-w-full border-separate border-spacing-0 text-sm">
              <thead>
                <tr className="text-left text-xs text-zinc-600">
                  <th className="border-b border-zinc-200 px-3 py-2">Jour</th>
                  <th className="border-b border-zinc-200 px-3 py-2">Chauffeur</th>
                  <th className="border-b border-zinc-200 px-3 py-2">Montant (Ar)</th>
                  <th className="border-b border-zinc-200 px-3 py-2">Statut</th>
                  <th className="border-b border-zinc-200 px-3 py-2">Véhicule</th>
                </tr>
              </thead>
              <tbody>
                {items.map((r) => (
                  <tr key={r.daily_rent_id} className="hover:bg-zinc-50">
                    <td className="border-b border-zinc-100 px-3 py-2 font-mono text-xs">
                      {r.business_date}
                    </td>
                    <td className="border-b border-zinc-100 px-3 py-2">
                      <div className="font-medium">{r.driver_full_name ?? '—'}</div>
                      <div className="text-xs text-zinc-500">{r.driver_phone ?? ''}</div>
                    </td>
                    <td className="border-b border-zinc-100 px-3 py-2">{formatAriary(r.rent_ariary)}</td>
                    <td className="border-b border-zinc-100 px-3 py-2">{r.status}</td>
                    <td className="border-b border-zinc-100 px-3 py-2">
                      <div className="text-xs text-zinc-700">
                        {r.vehicle_plate_number ?? '—'} {r.vehicle_kind ? `(${r.vehicle_kind})` : ''}
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : null}

        {data ? (
          <div className="mt-4 flex items-center justify-between gap-3 text-sm">
            <button
              className="rounded-lg border border-zinc-200 bg-white px-3 py-2 hover:bg-zinc-100 disabled:opacity-50"
              disabled={!canPrev || loading}
              onClick={() => setOffset((o) => Math.max(0, o - limit))}
            >
              Précédent
            </button>
            <div className="text-zinc-600">
              {count ? `${offset + 1}-${Math.min(offset + limit, count)} / ${count}` : '0'}
            </div>
            <button
              className="rounded-lg border border-zinc-200 bg-white px-3 py-2 hover:bg-zinc-100 disabled:opacity-50"
              disabled={!canNext || loading}
              onClick={() => setOffset((o) => o + limit)}
            >
              Suivant
            </button>
          </div>
        ) : null}
      </AdminShell>
    </RequireAuth>
  );
}

