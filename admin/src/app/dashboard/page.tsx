'use client';

import { useEffect, useMemo, useState } from 'react';
import { AdminShell } from '@/components/layout/AdminShell';
import { RequireAuth } from '@/components/auth/RequireAuth';
import { getPlatformDailySummary } from '@/lib/adminApi';
import { useBusinessDate } from '@/hooks/useBusinessDate';
import { formatAriary } from '@/lib/money';
import type { PlatformDailySummary } from '@/lib/types';

export default function DashboardPage() {
  const { businessDate, setBusinessDate } = useBusinessDate();
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [data, setData] = useState<PlatformDailySummary | null>(null);
  const [refreshSeq, setRefreshSeq] = useState(0);

  useEffect(() => {
    let cancelled = false;
    setError(null);
    setLoading(true);
    void (async () => {
      const res = await getPlatformDailySummary(businessDate);
      if (cancelled) return;
      if (res.error) {
        setError(res.error.message);
      } else {
        setData(res.data);
      }
      setLoading(false);
    })();
    return () => {
      cancelled = true;
    };
  }, [businessDate, refreshSeq]);

  const kpis = useMemo(() => {
    const d = data;
    return [
      { label: 'Courses (completed)', value: formatAriary(d?.total_rides) },
      { label: 'CA brut (Ar)', value: formatAriary(d?.gross_fares_ariary) },
      {
        label: 'Commission plateforme (Ar)',
        value: formatAriary(d?.total_platform_commission_ariary),
      },
      { label: 'Dû chauffeurs brut (Ar)', value: formatAriary(d?.total_driver_gross_ariary) },
      { label: 'Locations dues (Ar)', value: formatAriary(d?.total_daily_rents_due_ariary) },
      { label: 'Payouts (Ar)', value: formatAriary(d?.total_payouts_ariary) },
      { label: 'Courses non finalisées', value: formatAriary(d?.non_finalized_completed_rides_count) },
      { label: 'Locations manquantes', value: formatAriary(d?.drivers_with_rent_missing_count) },
    ];
  }, [data]);

  return (
    <RequireAuth>
      <AdminShell title="Dashboard">
        <div className="flex items-end justify-between gap-4">
          <div className="flex flex-wrap items-end gap-4">
            <label className="flex flex-col gap-1 text-sm">
              <span className="text-zinc-700">Jour (Madagascar)</span>
              <input
                className="w-44 rounded-lg border border-zinc-200 px-3 py-2 outline-none focus:border-zinc-400"
                type="date"
                value={businessDate}
                onChange={(e) => setBusinessDate(e.target.value)}
              />
            </label>
            <button
              type="button"
              className="rounded-lg border border-zinc-200 bg-white px-3 py-2 text-sm hover:bg-zinc-100 disabled:opacity-50"
              disabled={loading}
              onClick={() => setRefreshSeq((s) => s + 1)}
            >
              {loading ? 'Rafraîchissement…' : 'Rafraîchir'}
            </button>
          </div>
          <div className="text-sm text-zinc-600">
            {loading ? 'Chargement…' : error ? 'Erreur' : 'OK'}
          </div>
        </div>

        {error ? (
          <div className="mt-4 rounded-lg border border-red-200 bg-red-50 p-3 text-sm text-red-900">
            {error}
          </div>
        ) : null}

        {data ? (
          <div className="mt-4 grid grid-cols-1 gap-3 sm:grid-cols-2">
            {kpis.map((k) => (
              <div key={k.label} className="rounded-lg border border-zinc-200 p-3">
                <div className="text-xs text-zinc-600">{k.label}</div>
                <div className="mt-1 text-lg font-semibold">{k.value}</div>
              </div>
            ))}
          </div>
        ) : !loading && !error ? (
          <div className="mt-4 text-sm text-zinc-600">Aucune donnée.</div>
        ) : null}
      </AdminShell>
    </RequireAuth>
  );
}

