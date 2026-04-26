'use client';

import Link from 'next/link';
import { useEffect, useMemo, useState } from 'react';

import { AdminShell } from '@/components/layout/AdminShell';
import { RequireAuth } from '@/components/auth/RequireAuth';
import { FleetEntryPaymentModal } from '@/components/fleet/FleetEntryPaymentModal';
import { getDriverDebtsDetail, getDriverDebtsSummary } from '@/lib/adminApi';
import { formatAriary } from '@/lib/money';
import type { DriverDebtDetailItem, DriverDebtSummaryItem } from '@/lib/types';

function formatCount(n: number): string {
  return new Intl.NumberFormat('fr-FR').format(n);
}

function fmtDate(iso: string | null | undefined): string {
  if (!iso || !String(iso).trim()) return '—';
  // entry_date is YYYY-MM-DD already; paid_at is timestamptz → keep simple.
  const s = String(iso).trim();
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return s;
  const d = new Date(s);
  if (!Number.isFinite(d.getTime())) return s;
  return d.toLocaleString('fr-FR');
}

function sumBy(items: DriverDebtSummaryItem[], key: keyof Pick<DriverDebtSummaryItem, 'total_debt_ariary' | 'fuel_debt_ariary' | 'rent_debt_ariary' | 'open_entries_count'>): number {
  let s = 0;
  for (const it of items) {
    const v = it[key] as unknown as number;
    if (Number.isFinite(v)) s += Math.trunc(v);
  }
  return s;
}

function paymentStatusLabel(s: DriverDebtDetailItem['payment_status']): string {
  return s === 'partiel' ? 'Partiel' : 'Non payé';
}

export default function DriversDebtsPage() {
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [items, setItems] = useState<DriverDebtSummaryItem[]>([]);
  const [refreshSeq, setRefreshSeq] = useState(0);

  const [detailOpen, setDetailOpen] = useState(false);
  const [detailDriver, setDetailDriver] = useState<DriverDebtSummaryItem | null>(null);
  const [detailLoading, setDetailLoading] = useState(false);
  const [detailError, setDetailError] = useState<string | null>(null);
  const [detailItems, setDetailItems] = useState<DriverDebtDetailItem[]>([]);

  const [payOpen, setPayOpen] = useState(false);
  const [payVehicleId, setPayVehicleId] = useState<string | null>(null);
  const [payEntryId, setPayEntryId] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    void (async () => {
      const res = await getDriverDebtsSummary();
      if (cancelled) return;
      if (res.error) {
        setError(res.error.message);
        setItems([]);
      } else {
        setItems(res.data.items ?? []);
      }
      setLoading(false);
    })();
    return () => {
      cancelled = true;
    };
  }, [refreshSeq]);

  useEffect(() => {
    if (!detailOpen || !detailDriver) return;
    let cancelled = false;
    setDetailLoading(true);
    setDetailError(null);
    setDetailItems([]);
    void (async () => {
      const res = await getDriverDebtsDetail(detailDriver.driver_id);
      if (cancelled) return;
      if (res.error) {
        setDetailError(res.error.message);
        setDetailItems([]);
      } else {
        setDetailItems(res.data.items ?? []);
      }
      setDetailLoading(false);
    })();
    return () => {
      cancelled = true;
    };
  }, [detailOpen, detailDriver, refreshSeq]);

  useEffect(() => {
    if (!detailOpen) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setDetailOpen(false);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [detailOpen]);

  const kpis = useMemo(() => {
    const driversCount = items.length;
    const totalDebt = sumBy(items, 'total_debt_ariary');
    const fuelDebt = sumBy(items, 'fuel_debt_ariary');
    const rentDebt = sumBy(items, 'rent_debt_ariary');
    const openEntries = sumBy(items, 'open_entries_count');
    return { driversCount, totalDebt, fuelDebt, rentDebt, openEntries };
  }, [items]);

  const sorted = useMemo(() => {
    return [...items].sort((a, b) => (b.total_debt_ariary ?? 0) - (a.total_debt_ariary ?? 0));
  }, [items]);

  const isEmpty = !loading && !error && sorted.length === 0;

  const detailKpis = useMemo(() => {
    let total = 0;
    let fuel = 0;
    let rent = 0;
    for (const r of detailItems) {
      const rem = Number(r.remaining_amount_ariary ?? 0);
      if (!Number.isFinite(rem) || rem <= 0) continue;
      total += Math.trunc(rem);
      const cat = String(r.category ?? '').trim().toLowerCase();
      if (cat === 'carburant') fuel += Math.trunc(rem);
      if (cat === 'loyer') rent += Math.trunc(rem);
    }
    return { total, fuel, rent };
  }, [detailItems]);

  function openDetail(row: DriverDebtSummaryItem) {
    setDetailDriver(row);
    setDetailOpen(true);
  }

  function openPayment(it: DriverDebtDetailItem) {
    setPayVehicleId(it.vehicle_id);
    setPayEntryId(it.entry_id);
    setPayOpen(true);
  }

  return (
    <RequireAuth>
      <AdminShell title="Dettes chauffeurs">
        <div className="flex items-end justify-between gap-4">
          <div className="text-sm text-zinc-600">
            {loading ? 'Chargement…' : error ? 'Erreur' : `${formatCount(sorted.length)} chauffeur(s)`}
          </div>
          <button
            type="button"
            className="rounded-lg border border-zinc-200 bg-white px-3 py-2 text-sm hover:bg-zinc-100 disabled:opacity-50"
            disabled={loading}
            onClick={() => setRefreshSeq((s) => s + 1)}
          >
            Rafraîchir
          </button>
        </div>

        <div className="mt-4 grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-5">
          <div className="rounded-lg border border-zinc-200 p-3">
            <div className="text-xs text-zinc-600">Dette totale chauffeurs</div>
            <div className="mt-1 text-lg font-semibold">{formatAriary(kpis.totalDebt)} Ar</div>
          </div>
          <div className="rounded-lg border border-zinc-200 p-3">
            <div className="text-xs text-zinc-600">Chauffeurs avec dette</div>
            <div className="mt-1 text-lg font-semibold">{formatCount(kpis.driversCount)}</div>
          </div>
          <div className="rounded-lg border border-zinc-200 p-3">
            <div className="text-xs text-zinc-600">Total carburant</div>
            <div className="mt-1 text-lg font-semibold">{formatAriary(kpis.fuelDebt)} Ar</div>
          </div>
          <div className="rounded-lg border border-zinc-200 p-3">
            <div className="text-xs text-zinc-600">Total loyer</div>
            <div className="mt-1 text-lg font-semibold">{formatAriary(kpis.rentDebt)} Ar</div>
          </div>
          <div className="rounded-lg border border-zinc-200 p-3">
            <div className="text-xs text-zinc-600">Écritures ouvertes</div>
            <div className="mt-1 text-lg font-semibold">{formatCount(kpis.openEntries)}</div>
          </div>
        </div>

        {error ? (
          <div className="mt-4 rounded-lg border border-red-200 bg-red-50 p-3 text-sm text-red-900">
            {error}
          </div>
        ) : null}

        {isEmpty ? (
          <div className="mt-4 rounded-lg border border-zinc-200 bg-white p-6 text-sm text-zinc-600">
            Aucune dette chauffeur ouverte.
          </div>
        ) : (
          <div className="mt-4 overflow-x-auto rounded-lg border border-zinc-200">
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
                  <th className="px-3 py-2"></th>
                </tr>
              </thead>
              <tbody className="divide-y divide-zinc-200 bg-white">
                {sorted.map((r) => (
                  <tr key={r.driver_id} className="hover:bg-zinc-50">
                    <td className="px-3 py-2 font-medium text-zinc-900">{r.driver_name ?? '—'}</td>
                    <td className="px-3 py-2 text-zinc-700">{r.driver_phone ?? '—'}</td>
                    <td className="px-3 py-2 text-zinc-700">
                      {r.current_vehicle_id ? (
                        <Link className="underline hover:text-zinc-900" href={`/fleet/${encodeURIComponent(r.current_vehicle_id)}`}>
                          {r.current_vehicle_label ?? 'Véhicule'}
                        </Link>
                      ) : (
                        <span className="text-zinc-500">—</span>
                      )}
                    </td>
                    <td className="px-3 py-2 text-right tabular-nums font-semibold">
                      {formatAriary(r.total_debt_ariary)} Ar
                    </td>
                    <td className="px-3 py-2 text-right tabular-nums">{formatAriary(r.fuel_debt_ariary)} Ar</td>
                    <td className="px-3 py-2 text-right tabular-nums">{formatAriary(r.rent_debt_ariary)} Ar</td>
                    <td className="px-3 py-2 text-right tabular-nums">{formatCount(r.open_entries_count)}</td>
                    <td className="px-3 py-2 text-zinc-700">{fmtDate(r.last_payment_at)}</td>
                    <td className="px-3 py-2 text-right">
                      <button
                        type="button"
                        className="rounded-lg border border-zinc-200 bg-white px-3 py-2 text-sm hover:bg-zinc-100"
                        onClick={() => openDetail(r)}
                      >
                        Voir détail
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}

        {detailOpen && detailDriver ? (
          <div
            className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4"
            role="presentation"
            onClick={() => setDetailOpen(false)}
          >
            <div
              role="dialog"
              aria-modal="true"
              aria-labelledby="driver-debt-detail-title"
              className="w-full max-w-5xl rounded-xl border border-zinc-200 bg-white p-5 shadow-lg"
              onClick={(ev) => ev.stopPropagation()}
            >
              <div className="flex items-start justify-between gap-4">
                <div>
                  <h2 id="driver-debt-detail-title" className="text-lg font-semibold">
                    Dette — {detailDriver.driver_name ?? 'Chauffeur'}
                  </h2>
                  <div className="mt-1 text-sm text-zinc-600">
                    {detailDriver.driver_phone ?? '—'} · {formatCount(detailDriver.open_entries_count)} écriture(s) ouverte(s)
                  </div>
                </div>
                <button
                  type="button"
                  className="rounded-lg border border-zinc-200 bg-white px-3 py-2 text-sm hover:bg-zinc-100"
                  onClick={() => setDetailOpen(false)}
                >
                  Fermer
                </button>
              </div>

              <div className="mt-4 grid grid-cols-1 gap-3 sm:grid-cols-3">
                <div className="rounded-lg border border-zinc-200 p-3">
                  <div className="text-xs text-zinc-600">Dette totale</div>
                  <div className="mt-1 text-lg font-semibold">{formatAriary(detailKpis.total)} Ar</div>
                </div>
                <div className="rounded-lg border border-zinc-200 p-3">
                  <div className="text-xs text-zinc-600">Carburant</div>
                  <div className="mt-1 text-lg font-semibold">{formatAriary(detailKpis.fuel)} Ar</div>
                </div>
                <div className="rounded-lg border border-zinc-200 p-3">
                  <div className="text-xs text-zinc-600">Loyer</div>
                  <div className="mt-1 text-lg font-semibold">{formatAriary(detailKpis.rent)} Ar</div>
                </div>
              </div>

              {detailError ? (
                <div className="mt-4 rounded-lg border border-red-200 bg-red-50 p-3 text-sm text-red-900">
                  {detailError}
                </div>
              ) : null}

              <div className="mt-4 overflow-x-auto rounded-lg border border-zinc-200">
                <table className="min-w-full text-sm">
                  <thead className="bg-zinc-50 text-left text-xs text-zinc-600">
                    <tr>
                      <th className="px-3 py-2">Date</th>
                      <th className="px-3 py-2">Véhicule</th>
                      <th className="px-3 py-2">Catégorie</th>
                      <th className="px-3 py-2">Libellé</th>
                      <th className="px-3 py-2 text-right">Dû</th>
                      <th className="px-3 py-2 text-right">Payé</th>
                      <th className="px-3 py-2 text-right">Reste</th>
                      <th className="px-3 py-2">Statut</th>
                      <th className="px-3 py-2">Période</th>
                      <th className="px-3 py-2"></th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-zinc-200 bg-white">
                    {detailLoading ? (
                      <tr>
                        <td className="px-3 py-4 text-sm text-zinc-600" colSpan={10}>
                          Chargement…
                        </td>
                      </tr>
                    ) : detailItems.length === 0 ? (
                      <tr>
                        <td className="px-3 py-4 text-sm text-zinc-600" colSpan={10}>
                          Aucune écriture ouverte.
                        </td>
                      </tr>
                    ) : (
                      detailItems.map((it) => (
                        <tr key={it.entry_id} className="hover:bg-zinc-50">
                          <td className="px-3 py-2 tabular-nums">{it.entry_date}</td>
                          <td className="px-3 py-2">
                            <Link
                              className="underline hover:text-zinc-900"
                              href={`/fleet/${encodeURIComponent(it.vehicle_id)}`}
                            >
                              {it.vehicle_label ?? 'Véhicule'}
                            </Link>
                          </td>
                          <td className="px-3 py-2">{it.category}</td>
                          <td className="px-3 py-2">{it.label ?? '—'}</td>
                          <td className="px-3 py-2 text-right tabular-nums">{formatAriary(it.amount_ariary)} Ar</td>
                          <td className="px-3 py-2 text-right tabular-nums">{formatAriary(it.total_paid_ariary)} Ar</td>
                          <td className="px-3 py-2 text-right tabular-nums font-semibold">
                            {formatAriary(it.remaining_amount_ariary)} Ar
                          </td>
                          <td className="px-3 py-2">{paymentStatusLabel(it.payment_status)}</td>
                          <td className="px-3 py-2 text-xs text-zinc-600">
                            <div className="tabular-nums">
                              {fmtDate(it.assignment_starts_at)} → {fmtDate(it.assignment_ends_at)}
                            </div>
                            <div className="mt-0.5 font-mono text-[10px] text-zinc-500">{it.assignment_id ?? '—'}</div>
                          </td>
                          <td className="px-3 py-2 text-right">
                            <button
                              type="button"
                              className="rounded-lg border border-zinc-200 bg-white px-3 py-2 text-sm hover:bg-zinc-100"
                              onClick={() => openPayment(it)}
                            >
                              Gérer dette
                            </button>
                          </td>
                        </tr>
                      ))
                    )}
                  </tbody>
                </table>
              </div>

              <div className="mt-3 text-xs text-zinc-500">
                Astuce: clique sur <strong>Gérer dette</strong> pour ouvrir la fenêtre de paiement (historique +
                paiement partiel / solde) sans quitter cette page.
              </div>
            </div>
          </div>
        ) : null}

        <FleetEntryPaymentModal
          open={payOpen}
          vehicleId={payVehicleId}
          entryId={payEntryId}
          onClose={() => setPayOpen(false)}
          onChanged={() => {
            // Triggers re-fetch of summary and (if open) detail list.
            setRefreshSeq((s) => s + 1);
          }}
        />
      </AdminShell>
    </RequireAuth>
  );
}

