'use client';

import { useEffect, useMemo, useState, type FormEvent } from 'react';
import Link from 'next/link';
import { AdminShell } from '@/components/layout/AdminShell';
import { RequireAuth } from '@/components/auth/RequireAuth';
import { createDriver, getDriverDebtsSummary, getDriversDailySummary } from '@/lib/adminApi';
import { useBusinessDate } from '@/hooks/useBusinessDate';
import { formatAriary } from '@/lib/money';
import type { DriverAccountListFilter, DriverDailySummaryRow, DriverDebtSummaryItem } from '@/lib/types';
import { isUuidString } from '@/lib/uuid';

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
  const [driverAccountFilter, setDriverAccountFilter] = useState<DriverAccountListFilter>('active');
  const [refreshSeq, setRefreshSeq] = useState(0);
  const [addOpen, setAddOpen] = useState(false);
  const [addFirst, setAddFirst] = useState('');
  const [addLast, setAddLast] = useState('');
  const [addPhone, setAddPhone] = useState('');
  const [addPlate, setAddPlate] = useState('');
  const [addSubmitting, setAddSubmitting] = useState(false);
  const [addError, setAddError] = useState<string | null>(null);

  const [debtLoading, setDebtLoading] = useState(false);
  const [debtError, setDebtError] = useState<string | null>(null);
  const [debtItems, setDebtItems] = useState<DriverDebtSummaryItem[]>([]);

  useEffect(() => {
    let cancelled = false;
    setError(null);
    setLoading(true);
    void (async () => {
      const res = await getDriversDailySummary(businessDate, driverAccountFilter);
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
  }, [businessDate, driverAccountFilter, refreshSeq]);

  useEffect(() => {
    let cancelled = false;
    setDebtLoading(true);
    setDebtError(null);
    void (async () => {
      const res = await getDriverDebtsSummary();
      if (cancelled) return;
      if (res.error) {
        setDebtError(res.error.message);
        setDebtItems([]);
      } else {
        setDebtItems(res.data.items ?? []);
      }
      setDebtLoading(false);
    })();
    return () => {
      cancelled = true;
    };
  }, [refreshSeq]);

  useEffect(() => {
    if (!addOpen) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setAddOpen(false);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [addOpen]);

  function openAddModal() {
    setAddError(null);
    setAddFirst('');
    setAddLast('');
    setAddPhone('');
    setAddPlate('');
    setAddOpen(true);
  }

  async function submitAddDriver(e: FormEvent) {
    e.preventDefault();
    setAddError(null);
    setAddSubmitting(true);
    const res = await createDriver({
      first_name: addFirst,
      last_name: addLast,
      phone: addPhone,
      vehicle_plate: addPlate,
    });
    setAddSubmitting(false);
    if (res.error) {
      setAddError(res.error.message);
      return;
    }
    setAddOpen(false);
    setRefreshSeq((s) => s + 1);
  }

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

  const debtKpis = useMemo(() => {
    const driversWithDebt = debtItems.length;
    let totalDebt = 0;
    let fuel = 0;
    let rent = 0;
    for (const it of debtItems) {
      totalDebt += Math.trunc(Number(it.total_debt_ariary ?? 0) || 0);
      fuel += Math.trunc(Number(it.fuel_debt_ariary ?? 0) || 0);
      rent += Math.trunc(Number(it.rent_debt_ariary ?? 0) || 0);
    }
    return { driversWithDebt, totalDebt, fuel, rent };
  }, [debtItems]);

  const debtSorted = useMemo(() => {
    return [...debtItems].sort((a, b) => (b.total_debt_ariary ?? 0) - (a.total_debt_ariary ?? 0));
  }, [debtItems]);

  function daysSince(dateYmd: string | null | undefined): number | null {
    if (!dateYmd || !String(dateYmd).trim()) return null;
    const s = String(dateYmd).trim();
    if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) return null;
    if (!/^\d{4}-\d{2}-\d{2}$/.test(businessDate)) return null;
    const a = new Date(`${businessDate}T00:00:00.000Z`);
    const b = new Date(`${s}T00:00:00.000Z`);
    const ms = a.getTime() - b.getTime();
    if (!Number.isFinite(ms)) return null;
    return Math.max(0, Math.floor(ms / 86_400_000));
  }

  function debtStatus(totalDebtAriary: number): 'critique' | 'à surveiller' | 'ok' {
    if (totalDebtAriary > 50_000) return 'critique';
    if (totalDebtAriary > 10_000) return 'à surveiller';
    return 'ok';
  }

  return (
    <RequireAuth>
      <AdminShell title="Chauffeurs">
        <div className="flex flex-col gap-3 md:flex-row md:items-end md:justify-between md:gap-4">
          <div className="flex flex-col gap-3 md:flex-row md:flex-wrap md:items-end md:gap-4">
            <label className="flex flex-col gap-1 text-sm">
              <span className="text-zinc-700">Jour (Madagascar)</span>
              <input
                className="w-full md:w-44 rounded-lg border border-zinc-200 px-3 py-2 outline-none focus:border-zinc-400"
                type="date"
                value={businessDate}
                onChange={(e) => setBusinessDate(e.target.value)}
              />
            </label>

            <label className="flex flex-col gap-1 text-sm">
              <span className="text-zinc-700">Statut compte</span>
              <select
                className="w-full md:w-44 rounded-lg border border-zinc-200 px-3 py-2 outline-none focus:border-zinc-400"
                value={driverAccountFilter}
                onChange={(e) => setDriverAccountFilter(e.target.value as DriverAccountListFilter)}
              >
                <option value="active">Actifs</option>
                <option value="inactive">Désactivés</option>
                <option value="all">Tous</option>
              </select>
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
                className="w-full md:w-44 rounded-lg border border-zinc-200 px-3 py-2 outline-none focus:border-zinc-400"
                value={balanceFilter}
                onChange={(e) =>
                  setBalanceFilter(e.target.value as 'all' | 'positive' | 'negative')
                }
              >
                <option value="all">Toutes</option>
                <option value="positive">Positive</option>
                <option value="negative">Négative</option>
              </select>
            </label>

            <div className="flex flex-col gap-2 md:flex-row md:items-center">
              <button
                type="button"
                className="w-full md:w-auto rounded-lg border border-zinc-200 bg-white px-3 py-2 text-sm hover:bg-zinc-100 disabled:opacity-50"
                disabled={loading}
                onClick={() => setRefreshSeq((s) => s + 1)}
              >
                {loading ? 'Rafraîchissement…' : 'Rafraîchir'}
              </button>

              <button
                type="button"
                className="w-full md:w-auto rounded-lg border border-zinc-800 bg-zinc-900 px-3 py-2 text-sm font-medium text-white hover:bg-zinc-800 disabled:opacity-50"
                disabled={loading || addSubmitting}
                onClick={openAddModal}
              >
                Ajouter un chauffeur
              </button>
            </div>
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

        {driverAccountFilter === 'active' ? (
          <div className="mt-4 grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-4">
            <div className="rounded-lg border border-zinc-200 p-3">
              <div className="text-xs text-zinc-600">Chauffeurs actifs (ce jour)</div>
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
        ) : null}

        <div className="mt-6 flex items-end justify-between gap-4">
          <div>
            <div className="text-sm font-semibold text-zinc-900">Dettes chauffeurs</div>
            <div className="mt-1 text-xs text-zinc-600">
              Source: RPC dettes chauffeurs (carburant/loyer), paiements partiels inclus.
            </div>
          </div>
          <Link
            className="rounded-lg border border-zinc-200 bg-white px-3 py-2 text-sm hover:bg-zinc-100"
            href="/drivers/debts"
          >
            Ouvrir la page dettes →
          </Link>
        </div>

        <div className="mt-3 grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-4">
          <div className="rounded-lg border border-zinc-200 p-3">
            <div className="text-xs text-zinc-600">Total dette chauffeurs</div>
            <div className="mt-1 text-lg font-semibold">{formatAriary(debtKpis.totalDebt)} Ar</div>
          </div>
          <div className="rounded-lg border border-zinc-200 p-3">
            <div className="text-xs text-zinc-600">Chauffeurs avec dette</div>
            <div className="mt-1 text-lg font-semibold">{formatCount(debtKpis.driversWithDebt)}</div>
          </div>
          <div className="rounded-lg border border-zinc-200 p-3">
            <div className="text-xs text-zinc-600">Total carburant</div>
            <div className="mt-1 text-lg font-semibold">{formatAriary(debtKpis.fuel)} Ar</div>
          </div>
          <div className="rounded-lg border border-zinc-200 p-3">
            <div className="text-xs text-zinc-600">Total loyer</div>
            <div className="mt-1 text-lg font-semibold">{formatAriary(debtKpis.rent)} Ar</div>
          </div>
        </div>

        {debtError ? (
          <div className="mt-4 rounded-lg border border-red-200 bg-red-50 p-3 text-sm text-red-900">
            {debtError}
          </div>
        ) : null}

        <div className="mt-3 hidden overflow-x-auto rounded-lg border border-zinc-200 md:block">
          <table className="min-w-full text-sm">
            <thead className="bg-zinc-50 text-left text-xs text-zinc-600">
              <tr>
                <th className="px-3 py-2">Chauffeur</th>
                <th className="px-3 py-2">Téléphone</th>
                <th className="px-3 py-2">Véhicule actuel</th>
                <th className="px-3 py-2 text-right">Dette totale</th>
                <th className="px-3 py-2 text-right">Carburant</th>
                <th className="px-3 py-2 text-right">Loyer</th>
                <th className="px-3 py-2 text-right">Écritures</th>
                <th className="px-3 py-2">Dernier paiement</th>
                <th className="px-3 py-2">Ancienneté</th>
                <th className="px-3 py-2">Statut</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-zinc-200 bg-white">
              {debtLoading ? (
                <tr>
                  <td className="px-3 py-4 text-sm text-zinc-600" colSpan={10}>
                    Chargement…
                  </td>
                </tr>
              ) : debtSorted.length === 0 ? (
                <tr>
                  <td className="px-3 py-4 text-sm text-zinc-600" colSpan={10}>
                    Aucune dette chauffeur ouverte.
                  </td>
                </tr>
              ) : (
                debtSorted.map((d) => {
                  const total = Math.trunc(Number(d.total_debt_ariary ?? 0) || 0);
                  const st = debtStatus(total);
                  const ageDays = daysSince(d.oldest_entry_date);
                  const ageTone =
                    ageDays != null && ageDays > 7 ? 'text-red-800' : ageDays != null && ageDays > 3 ? 'text-amber-800' : 'text-zinc-700';
                  const lastPay = d.last_payment_at ? new Date(d.last_payment_at).toLocaleString('fr-FR') : '—';
                  return (
                    <tr key={d.driver_id} className="hover:bg-zinc-50">
                      <td className="px-3 py-2 font-medium text-zinc-900">{d.driver_name ?? '—'}</td>
                      <td className="px-3 py-2 text-zinc-700">{d.driver_phone ?? '—'}</td>
                      <td className="px-3 py-2 text-zinc-700">
                        {d.current_vehicle_id ? (
                          <Link className="underline hover:text-zinc-900" href={`/fleet/${d.current_vehicle_id}`}>
                            {d.current_vehicle_label ?? 'Véhicule'}
                          </Link>
                        ) : (
                          <span className="text-zinc-500">—</span>
                        )}
                      </td>
                      <td className="px-3 py-2 text-right tabular-nums font-semibold">{formatAriary(total)} Ar</td>
                      <td className="px-3 py-2 text-right tabular-nums">{formatAriary(d.fuel_debt_ariary)} Ar</td>
                      <td className="px-3 py-2 text-right tabular-nums">{formatAriary(d.rent_debt_ariary)} Ar</td>
                      <td className="px-3 py-2 text-right tabular-nums">{formatCount(d.open_entries_count)}</td>
                      <td className="px-3 py-2 text-zinc-700">{lastPay}</td>
                      <td className="px-3 py-2">
                        {ageDays == null ? (
                          <span className="text-zinc-500">—</span>
                        ) : (
                          <div className="leading-tight">
                            <div className={`tabular-nums font-medium ${ageTone}`}>{ageDays} j</div>
                            <div className="mt-0.5 tabular-nums text-[11px] text-zinc-500">
                              {d.oldest_entry_date}
                            </div>
                          </div>
                        )}
                      </td>
                      <td className="px-3 py-2">
                        <span
                          className={
                            'inline-flex items-center rounded-full border px-2 py-0.5 text-xs font-medium ' +
                            (st === 'critique'
                              ? 'border-red-200 bg-red-50 text-red-900'
                              : st === 'à surveiller'
                                ? 'border-amber-200 bg-amber-50 text-amber-900'
                                : 'border-emerald-200 bg-emerald-50 text-emerald-900')
                          }
                        >
                          {st}
                        </span>
                      </td>
                    </tr>
                  );
                })
              )}
            </tbody>
          </table>
        </div>

        <div className="mt-3 md:hidden">
          {debtLoading ? (
            <div className="rounded-lg border border-zinc-200 bg-white p-4 text-sm text-zinc-600">
              Chargement…
            </div>
          ) : debtSorted.length === 0 ? (
            <div className="rounded-lg border border-zinc-200 bg-white p-4 text-sm text-zinc-600">
              Aucune dette chauffeur ouverte.
            </div>
          ) : (
            <ul className="flex flex-col gap-3">
              {debtSorted.map((d) => {
                const total = Math.trunc(Number(d.total_debt_ariary ?? 0) || 0);
                const st = debtStatus(total);
                const ageDays = daysSince(d.oldest_entry_date);
                const ageTone =
                  ageDays != null && ageDays > 7
                    ? 'text-red-800'
                    : ageDays != null && ageDays > 3
                      ? 'text-amber-800'
                      : 'text-zinc-700';
                const lastPay = d.last_payment_at
                  ? new Date(d.last_payment_at).toLocaleString('fr-FR')
                  : '—';
                return (
                  <li
                    key={d.driver_id}
                    className="rounded-xl border border-zinc-200 bg-white p-4 shadow-sm"
                  >
                    <div className="flex items-start justify-between gap-3">
                      <div className="min-w-0">
                        <div className="truncate text-base font-semibold text-zinc-900">
                          {d.driver_name ?? '—'}
                        </div>
                        <div className="mt-0.5 truncate text-sm text-zinc-600">
                          {d.driver_phone ?? '—'}
                        </div>
                      </div>
                      <span
                        className={
                          'shrink-0 inline-flex items-center rounded-full border px-2 py-0.5 text-xs font-medium ' +
                          (st === 'critique'
                            ? 'border-red-200 bg-red-50 text-red-900'
                            : st === 'à surveiller'
                              ? 'border-amber-200 bg-amber-50 text-amber-900'
                              : 'border-emerald-200 bg-emerald-50 text-emerald-900')
                        }
                      >
                        {st}
                      </span>
                    </div>

                    <div className="mt-3 flex items-end justify-between gap-3">
                      <div className="text-sm text-zinc-700">
                        <span className="text-zinc-500">Véhicule : </span>
                        {d.current_vehicle_id ? (
                          <Link
                            className="underline hover:text-zinc-900"
                            href={`/fleet/${d.current_vehicle_id}`}
                          >
                            {d.current_vehicle_label ?? 'Véhicule'}
                          </Link>
                        ) : (
                          <span className="text-zinc-500">—</span>
                        )}
                      </div>
                      <div className="text-right">
                        <div className="text-[11px] uppercase tracking-wide text-zinc-500">Dette</div>
                        <div className="mt-0.5 text-lg font-bold tabular-nums text-zinc-900">
                          {formatAriary(total)} Ar
                        </div>
                      </div>
                    </div>

                    <dl className="mt-3 grid grid-cols-2 gap-x-3 gap-y-2 text-sm">
                      <div>
                        <dt className="text-xs text-zinc-500">Carburant</dt>
                        <dd className="mt-0.5 font-medium tabular-nums">
                          {formatAriary(d.fuel_debt_ariary)} Ar
                        </dd>
                      </div>
                      <div>
                        <dt className="text-xs text-zinc-500">Loyer</dt>
                        <dd className="mt-0.5 font-medium tabular-nums">
                          {formatAriary(d.rent_debt_ariary)} Ar
                        </dd>
                      </div>
                      <div>
                        <dt className="text-xs text-zinc-500">Écritures ouvertes</dt>
                        <dd className="mt-0.5 font-medium tabular-nums">
                          {formatCount(d.open_entries_count)}
                        </dd>
                      </div>
                      <div>
                        <dt className="text-xs text-zinc-500">Ancienneté</dt>
                        <dd className={`mt-0.5 font-medium tabular-nums ${ageTone}`}>
                          {ageDays == null ? '—' : `${ageDays} j`}
                        </dd>
                      </div>
                      <div className="col-span-2">
                        <dt className="text-xs text-zinc-500">Dernier paiement</dt>
                        <dd className="mt-0.5 break-words text-zinc-700">{lastPay}</dd>
                      </div>
                    </dl>
                  </li>
                );
              })}
            </ul>
          )}
        </div>

        {addOpen ? (
          <div
            className="fixed inset-0 z-50 flex items-start justify-center overflow-y-auto bg-black/40 p-2 sm:items-center sm:p-4"
            role="presentation"
            onClick={() => !addSubmitting && setAddOpen(false)}
          >
            <div
              role="dialog"
              aria-modal="true"
              aria-labelledby="add-driver-title"
              className="my-6 w-full max-w-md rounded-xl border border-zinc-200 bg-white p-4 shadow-lg sm:my-0 sm:p-5 max-h-[90vh] overflow-hidden"
              onClick={(ev) => ev.stopPropagation()}
            >
              <div className="flex flex-col max-h-[90vh]">
                <div className="sticky top-0 z-10 -mx-4 border-b border-zinc-200 bg-white px-4 pb-3 sm:-mx-5 sm:px-5">
                  <div className="flex items-start justify-between gap-3">
                    <div>
                      <h2 id="add-driver-title" className="text-lg font-semibold text-zinc-900">
                        Nouveau chauffeur
                      </h2>
                      <p className="mt-1 text-sm text-zinc-600">
                        Téléphone au format E.164 (ex. +261341234567).
                      </p>
                    </div>
                    <button
                      type="button"
                      className="shrink-0 rounded-lg border border-zinc-200 bg-white px-3 py-2 text-sm hover:bg-zinc-100 disabled:opacity-50"
                      disabled={addSubmitting}
                      onClick={() => setAddOpen(false)}
                    >
                      Fermer
                    </button>
                  </div>
                </div>

                <form className="flex-1 min-h-0 overflow-y-auto overflow-x-hidden pt-4 flex flex-col gap-3" onSubmit={submitAddDriver}>
                <label className="flex flex-col gap-1 text-sm">
                  <span className="text-zinc-700">Prénom</span>
                  <input
                    className="rounded-lg border border-zinc-200 px-3 py-2 outline-none focus:border-zinc-400"
                    value={addFirst}
                    onChange={(e) => setAddFirst(e.target.value)}
                    autoComplete="given-name"
                    required
                    disabled={addSubmitting}
                  />
                </label>
                <label className="flex flex-col gap-1 text-sm">
                  <span className="text-zinc-700">Nom</span>
                  <input
                    className="rounded-lg border border-zinc-200 px-3 py-2 outline-none focus:border-zinc-400"
                    value={addLast}
                    onChange={(e) => setAddLast(e.target.value)}
                    autoComplete="family-name"
                    required
                    disabled={addSubmitting}
                  />
                </label>
                <label className="flex flex-col gap-1 text-sm">
                  <span className="text-zinc-700">Téléphone (E.164)</span>
                  <input
                    className="rounded-lg border border-zinc-200 px-3 py-2 outline-none focus:border-zinc-400"
                    value={addPhone}
                    onChange={(e) => setAddPhone(e.target.value)}
                    inputMode="tel"
                    autoComplete="tel"
                    placeholder="+261…"
                    required
                    disabled={addSubmitting}
                  />
                </label>
                <label className="flex flex-col gap-1 text-sm">
                  <span className="text-zinc-700">Immatriculation</span>
                  <input
                    className="rounded-lg border border-zinc-200 px-3 py-2 outline-none focus:border-zinc-400"
                    value={addPlate}
                    onChange={(e) => setAddPlate(e.target.value)}
                    autoComplete="off"
                    required
                    disabled={addSubmitting}
                  />
                </label>
                {addError ? (
                  <div className="rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-900">
                    {addError}
                  </div>
                ) : null}
                <div className="mt-2 flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
                  <button
                    type="button"
                    className="w-full sm:w-auto rounded-lg border border-zinc-200 bg-white px-3 py-2 text-sm hover:bg-zinc-100 disabled:opacity-50"
                    disabled={addSubmitting}
                    onClick={() => setAddOpen(false)}
                  >
                    Annuler
                  </button>
                  <button
                    type="submit"
                    className="w-full sm:w-auto rounded-lg border border-zinc-800 bg-zinc-900 px-3 py-2 text-sm font-medium text-white hover:bg-zinc-800 disabled:opacity-50"
                    disabled={addSubmitting}
                  >
                    {addSubmitting ? 'Création…' : 'Créer'}
                  </button>
                </div>
              </form>
              </div>
            </div>
          </div>
        ) : null}

        <div className="mt-4 overflow-x-auto">
          <table className="min-w-full border-separate border-spacing-0 text-sm">
            <thead>
              <tr className="text-left text-xs text-zinc-600">
                <th className="border-b border-zinc-200 px-3 py-2">Chauffeur</th>
                <th className="border-b border-zinc-200 px-3 py-2">Statut</th>
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
                const rowDeactivated = Boolean(r.deleted_at);
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
                        {isUuidString(String(r.driver_id ?? '')) ? (
                          <Link href={`/drivers/${String(r.driver_id).trim()}`}>
                            <span className="cursor-pointer font-medium hover:underline">
                              {r.full_name || 'Chauffeur'}
                            </span>
                          </Link>
                        ) : (
                          <span className="font-medium text-zinc-800">
                            {r.full_name || 'Chauffeur'}
                            <span className="ml-1 text-xs font-normal text-amber-700">
                              (ID manquant)
                            </span>
                          </span>
                        )}
                      </div>
                      <div className="text-xs text-zinc-500">{r.phone ?? ''}</div>
                    </td>
                    <td className="border-b border-zinc-100 px-3 py-2">
                      <span
                        className={`inline-block rounded-full border px-2 py-0.5 text-xs ${
                          rowDeactivated
                            ? 'border-zinc-300 bg-zinc-100 text-zinc-700'
                            : 'border-emerald-200 bg-emerald-50 text-emerald-900'
                        }`}
                      >
                        {rowDeactivated ? 'Désactivé' : 'Actif'}
                      </span>
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
                  <td className="px-3 py-6 text-sm text-zinc-500" colSpan={9}>
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

