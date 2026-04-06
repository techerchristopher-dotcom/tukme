'use client';

import { useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import { AdminShell } from '@/components/layout/AdminShell';
import { RequireAuth } from '@/components/auth/RequireAuth';
import { getDriversDailySummary } from '@/lib/adminApi';
import { useBusinessDate } from '@/hooks/useBusinessDate';
import { formatAriary } from '@/lib/money';
import type { DriverDailySummaryRow } from '@/lib/types';

function formatCount(n: unknown): string {
  const v = typeof n === 'number' ? n : Number.NaN;
  if (!Number.isFinite(v)) return '—';
  return new Intl.NumberFormat('fr-FR').format(v);
}

function asFiniteNumber(v: unknown): number | null {
  const n = typeof v === 'number' ? v : Number.NaN;
  return Number.isFinite(n) ? n : null;
}

export default function DriversPage() {
  const { businessDate, setBusinessDate } = useBusinessDate();
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [rows, setRows] = useState<DriverDailySummaryRow[]>([]);
  const [rentMissingOnly, setRentMissingOnly] = useState(false);
  const [activeOnly, setActiveOnly] = useState(false);
  const [payOnly, setPayOnly] = useState(false);
  const [balanceFilter, setBalanceFilter] = useState<'all' | 'positive' | 'negative'>('all');
  const [refreshSeq, setRefreshSeq] = useState(0);

  useEffect(() => {
    let cancelled = false;
    setError(null);
    setLoading(true);
    void (async () => {
      const res = await getDriversDailySummary(businessDate);
      if (cancelled) return;
      if (res.error) {
        setError(res.error.message);
      } else {
        setRows(res.data);
      }
      setLoading(false);
    })();
    return () => {
      cancelled = true;
    };
  }, [businessDate, refreshSeq]);

  const kpis = useMemo(() => {
    const activeCount = rows.filter((r) => (asFiniteNumber(r.rides_count) ?? 0) > 0).length;
    const toPayCount = rows.filter((r) => (asFiniteNumber(r.net_payable_today_ariary) ?? 0) > 0).length;
    const totalNetToPay = rows.reduce((acc, r) => acc + (asFiniteNumber(r.net_payable_today_ariary) ?? 0), 0);
    const anomaliesCount = rows.filter((r) => {
      const bal = asFiniteNumber(r.current_balance_ariary);
      return r.rent_missing || (bal != null && bal < 0);
    }).length;
    return { activeCount, toPayCount, totalNetToPay, anomaliesCount };
  }, [rows]);

  const filteredSorted = useMemo(() => {
    const filtered = rows.filter((r) => {
      if (activeOnly && (asFiniteNumber(r.rides_count) ?? 0) <= 0) return false;
      if (payOnly && (asFiniteNumber(r.net_payable_today_ariary) ?? 0) <= 0) return false;
      if (rentMissingOnly && !r.rent_missing) return false;
      const bal = asFiniteNumber(r.current_balance_ariary);
      if (balanceFilter === 'positive') return bal != null && bal > 0;
      if (balanceFilter === 'negative') return bal != null && bal < 0;
      return true;
    });
    return filtered.sort((a, b) => {
      const anet = asFiniteNumber(a.net_payable_today_ariary) ?? 0;
      const bnet = asFiniteNumber(b.net_payable_today_ariary) ?? 0;
      if (bnet !== anet) return bnet - anet;
      const an = String(a.full_name ?? '');
      const bn = String(b.full_name ?? '');
      return an.localeCompare(bn);
    });
  }, [rows, activeOnly, payOnly, rentMissingOnly, balanceFilter]);

  const isEmpty = !loading && !error && rows.length === 0;

  return (
    <RequireAuth>
      <AdminShell title="Chauffeurs">
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

            <label className="flex items-center gap-2 text-sm">
              <input
                type="checkbox"
                checked={rentMissingOnly}
                onChange={(e) => setRentMissingOnly(e.target.checked)}
              />
              <span className="text-zinc-700">Location manquante uniquement</span>
            </label>

            <label className="flex items-center gap-2 text-sm">
              <input
                type="checkbox"
                checked={activeOnly}
                onChange={(e) => setActiveOnly(e.target.checked)}
              />
              <span className="text-zinc-700">Actifs uniquement</span>
            </label>

            <label className="flex items-center gap-2 text-sm">
              <input type="checkbox" checked={payOnly} onChange={(e) => setPayOnly(e.target.checked)} />
              <span className="text-zinc-700">À payer uniquement</span>
            </label>

            <label className="flex flex-col gap-1 text-sm">
              <span className="text-zinc-700">Balance</span>
              <select
                className="w-44 rounded-lg border border-zinc-200 px-3 py-2 outline-none focus:border-zinc-400"
                value={balanceFilter}
                onChange={(e) => setBalanceFilter(e.target.value as any)}
              >
                <option value="all">Toutes</option>
                <option value="positive">Positive</option>
                <option value="negative">Négative</option>
              </select>
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
            {loading ? 'Chargement…' : error ? 'Erreur' : `${filteredSorted.length} chauffeurs`}
          </div>
        </div>

        {error ? (
          <div className="mt-4 rounded-lg border border-red-200 bg-red-50 p-3 text-sm text-red-900">
            {error}
          </div>
        ) : null}

        <div className="mt-4 grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-4">
          <div className="rounded-lg border border-zinc-200 p-3">
            <div className="text-xs text-zinc-600">Chauffeurs actifs</div>
            <div className="mt-1 text-lg font-semibold">{formatCount(kpis.activeCount)}</div>
          </div>
          <div className="rounded-lg border border-zinc-200 p-3">
            <div className="text-xs text-zinc-600">Chauffeurs à payer</div>
            <div className="mt-1 text-lg font-semibold">{formatCount(kpis.toPayCount)}</div>
          </div>
          <div className="rounded-lg border border-zinc-200 p-3">
            <div className="text-xs text-zinc-600">Total net à payer (Ar)</div>
            <div className="mt-1 text-lg font-semibold">{formatAriary(kpis.totalNetToPay)}</div>
          </div>
          <div className="rounded-lg border border-zinc-200 p-3">
            <div className="text-xs text-zinc-600">Anomalies</div>
            <div className="mt-1 text-lg font-semibold">{formatCount(kpis.anomaliesCount)}</div>
          </div>
        </div>

        <div className="mt-4 overflow-x-auto">
          <table className="min-w-full border-separate border-spacing-0 text-sm">
            <thead>
              <tr className="text-left text-xs text-zinc-600">
                <th className="border-b border-zinc-200 px-3 py-2">Chauffeur</th>
                <th className="border-b border-zinc-200 px-3 py-2">Courses</th>
                <th className="border-b border-zinc-200 px-3 py-2">À payer aujourd’hui (Ar)</th>
                <th className="border-b border-zinc-200 px-3 py-2">Balance (Ar)</th>
                <th className="border-b border-zinc-200 px-3 py-2">Dû chauffeur brut (Ar)</th>
                <th className="border-b border-zinc-200 px-3 py-2">Location (Ar)</th>
                <th className="border-b border-zinc-200 px-3 py-2">Payouts (Ar)</th>
                <th className="border-b border-zinc-200 px-3 py-2">Flags</th>
              </tr>
            </thead>
            <tbody>
              {filteredSorted.map((r) => {
                const flags: string[] = [];
                if ((asFiniteNumber(r.net_payable_today_ariary) ?? 0) > 0) flags.push('À payer');
                if ((asFiniteNumber(r.payouts_done_ariary) ?? 0) > 0) flags.push('Payé aujourd’hui');
                if (r.rent_missing) flags.push('Location manquante');
                if (
                  typeof r.current_balance_ariary === 'number' &&
                  Number.isFinite(r.current_balance_ariary) &&
                  r.current_balance_ariary < 0
                )
                  flags.push('Balance négative');
                return (
                  <tr key={r.driver_id} className="hover:bg-zinc-50">
                    <td className="border-b border-zinc-100 px-3 py-2">
                      <div className="font-medium">
                        {r.driver_id ? (
                          <Link href={`/drivers/${r.driver_id}`}>
                            <span className="cursor-pointer font-medium hover:underline">
                              {r.full_name || 'Chauffeur'}
                            </span>
                          </Link>
                        ) : (
                          <span className="font-medium">{r.full_name || 'Chauffeur'}</span>
                        )}
                      </div>
                      <div className="text-xs text-zinc-500">{r.phone ?? ''}</div>
                    </td>
                    <td className="border-b border-zinc-100 px-3 py-2">{formatCount(r.rides_count)}</td>
                    <td className="border-b border-zinc-100 px-3 py-2 font-semibold">
                      {formatAriary(r.net_payable_today_ariary)}
                    </td>
                    <td className="border-b border-zinc-100 px-3 py-2">{formatAriary(r.current_balance_ariary)}</td>
                    <td className="border-b border-zinc-100 px-3 py-2">{formatAriary(r.driver_gross_ariary)}</td>
                    <td className="border-b border-zinc-100 px-3 py-2">{formatAriary(r.daily_rent_due_ariary)}</td>
                    <td className="border-b border-zinc-100 px-3 py-2">{formatAriary(r.payouts_done_ariary)}</td>
                    <td className="border-b border-zinc-100 px-3 py-2">
                      <div className="flex flex-wrap gap-1">
                        {flags.length ? (
                          flags.map((f) => (
                            <span
                              key={f}
                              className="rounded-full border border-zinc-200 bg-zinc-100 px-2 py-0.5 text-xs text-zinc-700"
                            >
                              {f}
                            </span>
                          ))
                        ) : (
                          <span className="text-xs text-zinc-400">—</span>
                        )}
                      </div>
                    </td>
                  </tr>
                );
              })}
              {!loading && !filteredSorted.length ? (
                <tr>
                  <td className="px-3 py-6 text-sm text-zinc-500" colSpan={8}>
                    {isEmpty ? 'Aucun chauffeur.' : 'Aucun résultat avec ces filtres.'}
                  </td>
                </tr>
              ) : null}
            </tbody>
          </table>
        </div>
      </AdminShell>
    </RequireAuth>
  );
}

