'use client';

import Link from 'next/link';
import { useParams, useRouter } from 'next/navigation';
import { useEffect, useMemo, useState, type FormEvent } from 'react';

import { AdminShell } from '@/components/layout/AdminShell';
import { RequireAuth } from '@/components/auth/RequireAuth';
import { useBusinessDate } from '@/hooks/useBusinessDate';
import { createDriverPayout, deactivateDriver, getDriverDetail, reactivateDriver } from '@/lib/adminApi';
import { formatAriary } from '@/lib/money';
import type { CreateDriverPayoutInput, DriverDetailResponse } from '@/lib/types';
import { isUuidString, normalizeUuidParam } from '@/lib/uuid';

function formatPhone(v: string | null | undefined): string {
  if (!v || !String(v).trim()) return '—';
  return String(v).trim();
}

export default function DriverDetailPage() {
  const router = useRouter();
  const params = useParams();
  const { businessDate, setBusinessDate } = useBusinessDate();
  const driverId = useMemo(
    () => normalizeUuidParam(params?.driverId),
    [params?.driverId]
  );

  const [loading, setLoading] = useState(true);
  const [data, setData] = useState<DriverDetailResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [refreshSeq, setRefreshSeq] = useState(0);

  const [payoutAmount, setPayoutAmount] = useState<string>('');
  const [payoutMethod, setPayoutMethod] = useState<CreateDriverPayoutInput['method']>('cash');
  const [payoutReference, setPayoutReference] = useState<string>('');
  const [payoutNotes, setPayoutNotes] = useState<string>('');
  const [payoutSubmitting, setPayoutSubmitting] = useState(false);
  const [payoutError, setPayoutError] = useState<string | null>(null);
  const [payoutOk, setPayoutOk] = useState<string | null>(null);

  const [deleteOpen, setDeleteOpen] = useState(false);
  const [deleteSubmitting, setDeleteSubmitting] = useState(false);
  const [deleteError, setDeleteError] = useState<string | null>(null);

  const [reactivateOpen, setReactivateOpen] = useState(false);
  const [reactivateSubmitting, setReactivateSubmitting] = useState(false);
  const [reactivateError, setReactivateError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    async function run() {
      if (!driverId) {
        setLoading(false);
        setError('Identifiant manquant dans l’URL.');
        setData(null);
        return;
      }
      if (!isUuidString(driverId)) {
        setLoading(false);
        setError('Identifiant chauffeur invalide (attendu : UUID).');
        setData(null);
        return;
      }
      setLoading(true);
      setError(null);
      const res = await getDriverDetail({ driverId, date: businessDate });
      if (cancelled) return;
      if (res.error) {
        setError(res.error.message);
        setData(null);
      } else {
        setData(res.data);
        setError(null);
      }
      setLoading(false);
    }
    void run();
    return () => {
      cancelled = true;
    };
  }, [driverId, businessDate, refreshSeq]);

  useEffect(() => {
    if (!deleteOpen) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && !deleteSubmitting) setDeleteOpen(false);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [deleteOpen, deleteSubmitting]);

  useEffect(() => {
    if (!reactivateOpen) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && !reactivateSubmitting) setReactivateOpen(false);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [reactivateOpen, reactivateSubmitting]);

  const displayName = data?.driver.full_name?.trim() || 'Chauffeur';
  const isDeactivated = Boolean(data?.driver.deleted_at);
  const profilePhone = data?.driver.phone;
  const todayPhone = data?.today?.phone;
  const displayPhone = formatPhone(
    profilePhone?.trim() ? profilePhone : todayPhone ?? null
  );

  async function submitPayout() {
    setPayoutOk(null);
    setPayoutError(null);

    if (!driverId || !isUuidString(driverId)) {
      setPayoutError('driver_id invalide.');
      return;
    }

    const amount = Number.parseInt(payoutAmount.trim(), 10);
    if (!Number.isInteger(amount) || amount <= 0) {
      setPayoutError('Montant invalide (entier > 0).');
      return;
    }

    setPayoutSubmitting(true);
    const res = await createDriverPayout({
      driver_id: driverId,
      amount_ariary: amount,
      method: payoutMethod,
      reference: payoutReference.trim() ? payoutReference.trim() : null,
      notes: payoutNotes.trim() ? payoutNotes.trim() : null,
    });
    setPayoutSubmitting(false);

    if (res.error) {
      setPayoutError(res.error.message);
      return;
    }

    setPayoutAmount('');
    setPayoutReference('');
    setPayoutNotes('');
    setPayoutOk('Payout enregistré.');
    setRefreshSeq((s) => s + 1);
  }

  async function confirmDeactivate() {
    if (!driverId || !isUuidString(driverId) || isDeactivated) return;
    setDeleteError(null);
    setDeleteSubmitting(true);
    const res = await deactivateDriver(driverId);
    setDeleteSubmitting(false);
    if (res.error) {
      setDeleteError(res.error.message);
      return;
    }
    setDeleteOpen(false);
    router.push('/drivers');
  }

  async function confirmReactivate() {
    if (!driverId || !isUuidString(driverId) || !isDeactivated) return;
    setReactivateError(null);
    setReactivateSubmitting(true);
    const res = await reactivateDriver(driverId);
    setReactivateSubmitting(false);
    if (res.error) {
      setReactivateError(res.error.message);
      return;
    }
    setReactivateOpen(false);
    setRefreshSeq((s) => s + 1);
  }

  return (
    <RequireAuth>
      <AdminShell title="Fiche chauffeur">
        <div className="mb-4 flex flex-wrap items-end justify-between gap-4">
          <div className="text-sm">
            <Link href="/drivers" className="text-zinc-600 underline hover:text-zinc-900">
              ← Retour chauffeurs
            </Link>
          </div>
          <label className="flex flex-col gap-1 text-sm">
            <span className="text-zinc-700">Jour (Madagascar)</span>
            <input
              className="w-44 rounded-lg border border-zinc-200 px-3 py-2 outline-none focus:border-zinc-400"
              type="date"
              value={businessDate}
              onChange={(e) => setBusinessDate(e.target.value)}
            />
          </label>
        </div>

        {loading ? (
          <div className="rounded-lg border border-zinc-200 bg-white p-6 text-sm text-zinc-600">
            Chargement…
          </div>
        ) : error ? (
          <div className="rounded-lg border border-red-200 bg-red-50 p-4 text-sm text-red-900">
            {error}
          </div>
        ) : data ? (
          <>
            {isDeactivated ? (
              <div className="mb-4 flex flex-col gap-3 rounded-lg border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-950 sm:flex-row sm:items-center sm:justify-between">
                <p>
                  Ce chauffeur est <strong>désactivé</strong> : il n’apparaît plus dans la liste opérationnelle
                  (filtre Actifs). L’historique reste consultable. Connexion appli normalement rétablie après
                  réactivation.
                </p>
                <button
                  type="button"
                  className="shrink-0 rounded-lg border border-emerald-700 bg-emerald-700 px-3 py-2 text-sm font-medium text-white hover:bg-emerald-800 disabled:opacity-50"
                  disabled={reactivateSubmitting}
                  onClick={() => {
                    setReactivateError(null);
                    setReactivateOpen(true);
                  }}
                >
                  Réactiver le chauffeur…
                </button>
              </div>
            ) : null}

            <div className="rounded-xl border border-zinc-200 bg-white p-6">
              <div className="flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
                <div>
                  <h1 className="text-xl font-semibold text-zinc-900">{displayName}</h1>
                  <p className="mt-2 text-base font-medium text-zinc-800">
                    Tél. <span className="tabular-nums">{displayPhone}</span>
                  </p>
                  <p className="mt-1 font-mono text-xs text-zinc-500">{driverId}</p>
                </div>
                <div className="flex flex-col gap-3 text-left sm:items-end sm:text-right">
                  {!isDeactivated ? (
                    <button
                      type="button"
                      className="rounded-lg border border-red-200 bg-white px-3 py-2 text-sm font-medium text-red-800 hover:bg-red-50 disabled:opacity-50"
                      disabled={deleteSubmitting}
                      onClick={() => {
                        setDeleteError(null);
                        setDeleteOpen(true);
                      }}
                    >
                      Désactiver le chauffeur…
                    </button>
                  ) : null}
                  <div>
                    <div className="text-xs text-zinc-600">Solde (ledger)</div>
                    <div className="text-2xl font-bold tabular-nums">
                      {formatAriary(data.balance.driver_balance_ariary)} Ar
                    </div>
                  </div>
                  {data.today ? (
                    <div className="mt-2 space-y-0.5 text-xs text-zinc-600">
                      <div>
                        Ce jour : {formatCount(data.today.rides_count)} course(s) · net à payer{' '}
                        <span className="font-semibold text-zinc-800">
                          {formatAriary(data.today.net_payable_today_ariary)} Ar
                        </span>
                      </div>
                    </div>
                  ) : (
                    <div className="mt-2 text-xs text-zinc-500">Pas d’activité ce jour-là.</div>
                  )}
                </div>
              </div>

              <div
                className={`mt-6 rounded-lg border border-zinc-200 bg-zinc-50 p-4 ${isDeactivated ? 'pointer-events-none opacity-50' : ''}`}
              >
                <div className="mb-3 text-sm font-semibold text-zinc-900">Enregistrer un payout manuel</div>
                {isDeactivated ? (
                  <p className="mb-3 text-sm text-zinc-600">
                    Payouts désactivés pour un chauffeur désactivé.
                  </p>
                ) : null}
                <div className="grid grid-cols-1 gap-3 md:grid-cols-5">
                  <label className="flex flex-col gap-1 text-sm md:col-span-1">
                    <span className="text-zinc-700">Montant (Ar)</span>
                    <input
                      className="rounded-lg border border-zinc-200 bg-white px-3 py-2 outline-none focus:border-zinc-400"
                      inputMode="numeric"
                      placeholder="ex: 20000"
                      value={payoutAmount}
                      onChange={(e) => setPayoutAmount(e.target.value)}
                      disabled={payoutSubmitting || isDeactivated}
                    />
                  </label>

                  <label className="flex flex-col gap-1 text-sm md:col-span-1">
                    <span className="text-zinc-700">Méthode</span>
                    <select
                      className="rounded-lg border border-zinc-200 bg-white px-3 py-2 outline-none focus:border-zinc-400"
                      value={payoutMethod}
                      onChange={(e) =>
                        setPayoutMethod(e.target.value as CreateDriverPayoutInput['method'])
                      }
                      disabled={payoutSubmitting || isDeactivated}
                    >
                      <option value="cash">Cash</option>
                      <option value="orange_money">Orange Money</option>
                    </select>
                  </label>

                  <label className="flex flex-col gap-1 text-sm md:col-span-1">
                    <span className="text-zinc-700">Référence (optionnel)</span>
                    <input
                      className="rounded-lg border border-zinc-200 bg-white px-3 py-2 outline-none focus:border-zinc-400"
                      placeholder="ex: TXN123"
                      value={payoutReference}
                      onChange={(e) => setPayoutReference(e.target.value)}
                      disabled={payoutSubmitting || isDeactivated}
                    />
                  </label>

                  <label className="flex flex-col gap-1 text-sm md:col-span-2">
                    <span className="text-zinc-700">Notes (optionnel)</span>
                    <input
                      className="rounded-lg border border-zinc-200 bg-white px-3 py-2 outline-none focus:border-zinc-400"
                      placeholder="ex: payé en fin de journée"
                      value={payoutNotes}
                      onChange={(e) => setPayoutNotes(e.target.value)}
                      disabled={payoutSubmitting || isDeactivated}
                    />
                  </label>
                </div>

                <div className="mt-3 flex flex-wrap items-center gap-3">
                  <button
                    type="button"
                    className="rounded-lg bg-zinc-900 px-3 py-2 text-sm font-medium text-white hover:bg-zinc-800 disabled:opacity-50"
                    onClick={() => void submitPayout()}
                    disabled={payoutSubmitting || isDeactivated}
                  >
                    {payoutSubmitting ? 'Enregistrement…' : 'Enregistrer le payout'}
                  </button>
                  {payoutError ? (
                    <span className="text-sm text-red-800">{payoutError}</span>
                  ) : payoutOk ? (
                    <span className="text-sm text-emerald-800">{payoutOk}</span>
                  ) : null}
                </div>
              </div>
            </div>

            <div className="mt-6 space-y-6">
              <section className="rounded-xl border border-zinc-200 bg-white p-4">
                <h2 className="mb-3 text-sm font-semibold text-zinc-900">Courses récentes</h2>
                <div className="overflow-x-auto">
                  <table className="min-w-full border-separate border-spacing-0 text-sm">
                    <thead>
                      <tr className="text-left text-xs text-zinc-600">
                        <th className="border-b border-zinc-200 px-2 py-2">Terminée</th>
                        <th className="border-b border-zinc-200 px-2 py-2">Brut chauffeur</th>
                        <th className="border-b border-zinc-200 px-2 py-2">Commission</th>
                        <th className="border-b border-zinc-200 px-2 py-2">Finalisé</th>
                        <th className="border-b border-zinc-200 px-2 py-2 font-mono">ride_id</th>
                      </tr>
                    </thead>
                    <tbody>
                      {data.rides.items.map((r) => (
                        <tr key={r.ride_id} className="hover:bg-zinc-50">
                          <td className="border-b border-zinc-100 px-2 py-2 text-zinc-700">
                            {r.ride_completed_at
                              ? new Date(r.ride_completed_at).toLocaleString('fr-FR')
                              : '—'}
                          </td>
                          <td className="border-b border-zinc-100 px-2 py-2 tabular-nums">
                            {formatAriary(r.driver_gross_ariary)} Ar
                          </td>
                          <td className="border-b border-zinc-100 px-2 py-2 tabular-nums">
                            {formatAriary(r.platform_commission_ariary)} Ar
                          </td>
                          <td className="border-b border-zinc-100 px-2 py-2">
                            {r.is_financials_finalized ? 'oui' : 'non'}
                          </td>
                          <td className="border-b border-zinc-100 px-2 py-2 font-mono text-xs text-zinc-600">
                            {r.ride_id}
                          </td>
                        </tr>
                      ))}
                      {!data.rides.items.length ? (
                        <tr>
                          <td className="px-2 py-4 text-zinc-500" colSpan={5}>
                            Aucune course.
                          </td>
                        </tr>
                      ) : null}
                    </tbody>
                  </table>
                </div>
              </section>

              <section className="rounded-xl border border-zinc-200 bg-white p-4">
                <h2 className="mb-3 text-sm font-semibold text-zinc-900">Payouts</h2>
                <div className="overflow-x-auto">
                  <table className="min-w-full border-separate border-spacing-0 text-sm">
                    <thead>
                      <tr className="text-left text-xs text-zinc-600">
                        <th className="border-b border-zinc-200 px-2 py-2">Créé</th>
                        <th className="border-b border-zinc-200 px-2 py-2">Statut</th>
                        <th className="border-b border-zinc-200 px-2 py-2">Méthode</th>
                        <th className="border-b border-zinc-200 px-2 py-2">Montant</th>
                      </tr>
                    </thead>
                    <tbody>
                      {data.payouts.items.map((p) => (
                        <tr key={p.payout_id} className="hover:bg-zinc-50">
                          <td className="border-b border-zinc-100 px-2 py-2">
                            {new Date(p.created_at).toLocaleString('fr-FR')}
                          </td>
                          <td className="border-b border-zinc-100 px-2 py-2">{p.status}</td>
                          <td className="border-b border-zinc-100 px-2 py-2">{p.method}</td>
                          <td className="border-b border-zinc-100 px-2 py-2 tabular-nums">
                            {formatAriary(p.amount_ariary)} Ar
                          </td>
                        </tr>
                      ))}
                      {!data.payouts.items.length ? (
                        <tr>
                          <td className="px-2 py-4 text-zinc-500" colSpan={4}>
                            Aucun payout.
                          </td>
                        </tr>
                      ) : null}
                    </tbody>
                  </table>
                </div>
              </section>

              <section className="rounded-xl border border-zinc-200 bg-white p-4">
                <h2 className="mb-3 text-sm font-semibold text-zinc-900">Locations journalières</h2>
                <div className="overflow-x-auto">
                  <table className="min-w-full border-separate border-spacing-0 text-sm">
                    <thead>
                      <tr className="text-left text-xs text-zinc-600">
                        <th className="border-b border-zinc-200 px-2 py-2">Jour</th>
                        <th className="border-b border-zinc-200 px-2 py-2">Statut</th>
                        <th className="border-b border-zinc-200 px-2 py-2">Montant</th>
                      </tr>
                    </thead>
                    <tbody>
                      {data.rents.items.map((rent) => (
                        <tr key={rent.daily_rent_id} className="hover:bg-zinc-50">
                          <td className="border-b border-zinc-100 px-2 py-2">{rent.business_date}</td>
                          <td className="border-b border-zinc-100 px-2 py-2">{rent.status}</td>
                          <td className="border-b border-zinc-100 px-2 py-2 tabular-nums">
                            {formatAriary(rent.rent_ariary)} Ar
                          </td>
                        </tr>
                      ))}
                      {!data.rents.items.length ? (
                        <tr>
                          <td className="px-2 py-4 text-zinc-500" colSpan={3}>
                            Aucune location enregistrée.
                          </td>
                        </tr>
                      ) : null}
                    </tbody>
                  </table>
                </div>
              </section>
            </div>

            {deleteOpen ? (
              <div
                className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4"
                role="presentation"
                onClick={() => !deleteSubmitting && setDeleteOpen(false)}
              >
                <div
                  role="dialog"
                  aria-modal="true"
                  aria-labelledby="delete-driver-title"
                  className="w-full max-w-md rounded-xl border border-zinc-200 bg-white p-5 shadow-lg"
                  onClick={(e) => e.stopPropagation()}
                  onKeyDown={(e) => e.stopPropagation()}
                >
                  <h2 id="delete-driver-title" className="text-lg font-semibold text-zinc-900">
                    Désactiver ce chauffeur ?
                  </h2>
                  <p className="mt-2 text-sm text-zinc-600">
                    Le compte sera désactivé (plus de connexion appli), retiré de la liste opérationnelle, et
                    les affectations véhicule seront closes. Les courses et l’historique financier restent en
                    base.
                  </p>
                  <p className="mt-2 text-sm font-medium text-zinc-800">
                    {displayName}
                    <span className="ml-1 font-normal text-zinc-500">({displayPhone})</span>
                  </p>
                  {deleteError ? (
                    <div className="mt-3 rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-900">
                      {deleteError}
                    </div>
                  ) : null}
                  <form
                    className="mt-4 flex justify-end gap-2"
                    onSubmit={(e: FormEvent) => {
                      e.preventDefault();
                      void confirmDeactivate();
                    }}
                  >
                    <button
                      type="button"
                      className="rounded-lg border border-zinc-200 bg-white px-3 py-2 text-sm hover:bg-zinc-100 disabled:opacity-50"
                      disabled={deleteSubmitting}
                      onClick={() => setDeleteOpen(false)}
                    >
                      Annuler
                    </button>
                    <button
                      type="submit"
                      className="rounded-lg border border-red-700 bg-red-700 px-3 py-2 text-sm font-medium text-white hover:bg-red-800 disabled:opacity-50"
                      disabled={deleteSubmitting}
                    >
                      {deleteSubmitting ? 'Désactivation…' : 'Confirmer la désactivation'}
                    </button>
                  </form>
                </div>
              </div>
            ) : null}

            {reactivateOpen ? (
              <div
                className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4"
                role="presentation"
                onClick={() => !reactivateSubmitting && setReactivateOpen(false)}
              >
                <div
                  role="dialog"
                  aria-modal="true"
                  aria-labelledby="reactivate-driver-title"
                  className="w-full max-w-md rounded-xl border border-zinc-200 bg-white p-5 shadow-lg"
                  onClick={(e) => e.stopPropagation()}
                  onKeyDown={(e) => e.stopPropagation()}
                >
                  <h2 id="reactivate-driver-title" className="text-lg font-semibold text-zinc-900">
                    Réactiver ce chauffeur ?
                  </h2>
                  <p className="mt-2 text-sm text-zinc-600">
                    Le compte redevient actif dans l’admin (liste Actifs), le soft-delete est annulé et la
                    connexion appli est de nouveau autorisée si le bannissement Auth a été levé.
                  </p>
                  <p className="mt-2 text-sm font-medium text-zinc-800">
                    {displayName}
                    <span className="ml-1 font-normal text-zinc-500">({displayPhone})</span>
                  </p>
                  {reactivateError ? (
                    <div className="mt-3 rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-900">
                      {reactivateError}
                    </div>
                  ) : null}
                  <form
                    className="mt-4 flex justify-end gap-2"
                    onSubmit={(e: FormEvent) => {
                      e.preventDefault();
                      void confirmReactivate();
                    }}
                  >
                    <button
                      type="button"
                      className="rounded-lg border border-zinc-200 bg-white px-3 py-2 text-sm hover:bg-zinc-100 disabled:opacity-50"
                      disabled={reactivateSubmitting}
                      onClick={() => setReactivateOpen(false)}
                    >
                      Annuler
                    </button>
                    <button
                      type="submit"
                      className="rounded-lg border border-emerald-700 bg-emerald-700 px-3 py-2 text-sm font-medium text-white hover:bg-emerald-800 disabled:opacity-50"
                      disabled={reactivateSubmitting}
                    >
                      {reactivateSubmitting ? 'Réactivation…' : 'Confirmer la réactivation'}
                    </button>
                  </form>
                </div>
              </div>
            ) : null}
          </>
        ) : null}
      </AdminShell>
    </RequireAuth>
  );
}

function formatCount(n: unknown): string {
  const v = typeof n === 'number' ? n : Number.NaN;
  if (!Number.isFinite(v)) return '—';
  return new Intl.NumberFormat('fr-FR').format(v);
}
