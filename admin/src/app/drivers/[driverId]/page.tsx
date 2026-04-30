'use client';

import Link from 'next/link';
import { useParams, useRouter } from 'next/navigation';
import { useEffect, useMemo, useState, type FormEvent } from 'react';

import { AdminShell } from '@/components/layout/AdminShell';
import { RequireAuth } from '@/components/auth/RequireAuth';
import { useBusinessDate } from '@/hooks/useBusinessDate';
import {
  createDriverPayout,
  deactivateDriver,
  getDriverDetail,
  getDriverDebtsDetail,
  reactivateDriver,
  retireDriverCurrentVehicle,
  setDriverCurrentVehicle,
} from '@/lib/adminApi';
import { FleetEntryPaymentModal } from '@/components/fleet/FleetEntryPaymentModal';
import { formatAriary } from '@/lib/money';
import type { CreateDriverPayoutInput, DriverDebtDetailItem, DriverDetailResponse } from '@/lib/types';
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

  const [debtsLoading, setDebtsLoading] = useState(false);
  const [debtsError, setDebtsError] = useState<string | null>(null);
  const [debts, setDebts] = useState<DriverDebtDetailItem[]>([]);

  const [payOpen, setPayOpen] = useState(false);
  const [payVehicleId, setPayVehicleId] = useState<string | null>(null);
  const [payEntryId, setPayEntryId] = useState<string | null>(null);

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

  const [vehicleRetireOpen, setVehicleRetireOpen] = useState(false);
  const [vehicleRetireSubmitting, setVehicleRetireSubmitting] = useState(false);
  const [vehicleRetireError, setVehicleRetireError] = useState<string | null>(null);

  const [vehicleSetOpen, setVehicleSetOpen] = useState(false);
  const [vehicleSetSubmitting, setVehicleSetSubmitting] = useState(false);
  const [vehicleSetError, setVehicleSetError] = useState<string | null>(null);
  const [vehicleKind, setVehicleKind] = useState('');
  const [vehiclePlate, setVehiclePlate] = useState('');

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
    let cancelled = false;
    async function run() {
      if (!driverId || !isUuidString(driverId)) return;
      setDebtsLoading(true);
      setDebtsError(null);
      const res = await getDriverDebtsDetail(driverId);
      if (cancelled) return;
      if (res.error) {
        setDebtsError(res.error.message);
        setDebts([]);
      } else {
        setDebts(res.data.items ?? []);
      }
      setDebtsLoading(false);
    }
    void run();
    return () => {
      cancelled = true;
    };
  }, [driverId, refreshSeq]);

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

  useEffect(() => {
    if (!vehicleRetireOpen) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && !vehicleRetireSubmitting) setVehicleRetireOpen(false);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [vehicleRetireOpen, vehicleRetireSubmitting]);

  useEffect(() => {
    if (!vehicleSetOpen) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && !vehicleSetSubmitting) setVehicleSetOpen(false);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [vehicleSetOpen, vehicleSetSubmitting]);

  const displayName = data?.driver.full_name?.trim() || 'Chauffeur';
  const isDeactivated = Boolean(data?.driver.deleted_at);
  const profilePhone = data?.driver.phone;
  const todayPhone = data?.today?.phone;
  const displayPhone = formatPhone(
    profilePhone?.trim() ? profilePhone : todayPhone ?? null
  );

  const sortedDebts = useMemo(() => {
    return [...debts].sort((a, b) => (b.remaining_amount_ariary ?? 0) - (a.remaining_amount_ariary ?? 0));
  }, [debts]);

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

  function openPayment(it: DriverDebtDetailItem) {
    setPayVehicleId(it.vehicle_id);
    setPayEntryId(it.entry_id);
    setPayOpen(true);
  }

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

  async function confirmRetireVehicle() {
    if (!driverId || !isUuidString(driverId) || isDeactivated) return;
    setVehicleRetireError(null);
    setVehicleRetireSubmitting(true);
    const res = await retireDriverCurrentVehicle(driverId);
    setVehicleRetireSubmitting(false);
    if (res.error) {
      setVehicleRetireError(res.error.message);
      return;
    }
    setVehicleRetireOpen(false);
    setRefreshSeq((s) => s + 1);
  }

  function openVehicleSetModal() {
    setVehicleSetError(null);
    setVehicleKind(data?.current_vehicle?.kind?.trim() ? String(data.current_vehicle.kind) : '');
    setVehiclePlate(data?.current_vehicle?.plate_number?.trim() ? String(data.current_vehicle.plate_number) : '');
    setVehicleSetOpen(true);
  }

  async function submitSetVehicle(e: FormEvent) {
    e.preventDefault();
    if (!driverId || !isUuidString(driverId) || isDeactivated) return;
    setVehicleSetError(null);
    setVehicleSetSubmitting(true);
    const res = await setDriverCurrentVehicle({
      driverId,
      kind: vehicleKind,
      plate_number: vehiclePlate,
    });
    setVehicleSetSubmitting(false);
    if (res.error) {
      setVehicleSetError(res.error.message);
      return;
    }
    setVehicleSetOpen(false);
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
                <div className="flex items-start justify-between gap-4">
                  <div>
                    <h2 className="text-sm font-semibold text-zinc-900">Dettes (carburant / loyer)</h2>
                    <div className="mt-1 text-xs text-zinc-600">
                      Triées par <strong>reste</strong> décroissant.
                    </div>
                  </div>
                </div>

                {debtsError ? (
                  <div className="mt-3 rounded-lg border border-red-200 bg-red-50 p-3 text-sm text-red-900">
                    {debtsError}
                  </div>
                ) : null}

                <div className="mt-3 overflow-x-auto">
                  <table className="min-w-full border-separate border-spacing-0 text-sm">
                    <thead>
                      <tr className="text-left text-xs text-zinc-600">
                        <th className="border-b border-zinc-200 px-2 py-2">Date</th>
                        <th className="border-b border-zinc-200 px-2 py-2">Véhicule</th>
                        <th className="border-b border-zinc-200 px-2 py-2">Catégorie</th>
                        <th className="border-b border-zinc-200 px-2 py-2 text-right">Dû</th>
                        <th className="border-b border-zinc-200 px-2 py-2 text-right">Payé</th>
                        <th className="border-b border-zinc-200 px-2 py-2 text-right">Reste</th>
                        <th className="border-b border-zinc-200 px-2 py-2">Dernier paiement</th>
                        <th className="border-b border-zinc-200 px-2 py-2">Ancienneté</th>
                        <th className="border-b border-zinc-200 px-2 py-2"></th>
                      </tr>
                    </thead>
                    <tbody>
                      {debtsLoading ? (
                        <tr>
                          <td className="px-2 py-4 text-zinc-500" colSpan={9}>
                            Chargement…
                          </td>
                        </tr>
                      ) : sortedDebts.length === 0 ? (
                        <tr>
                          <td className="px-2 py-4 text-zinc-500" colSpan={9}>
                            Aucune dette ouverte.
                          </td>
                        </tr>
                      ) : (
                        sortedDebts.map((d) => {
                          const lastPay = d.last_payment_at ? new Date(d.last_payment_at).toLocaleString('fr-FR') : '—';
                          const ageDays = daysSince(d.entry_date);
                          return (
                            <tr key={d.entry_id} className="hover:bg-zinc-50">
                              <td className="border-b border-zinc-100 px-2 py-2 tabular-nums">{d.entry_date}</td>
                              <td className="border-b border-zinc-100 px-2 py-2">{d.vehicle_label ?? '—'}</td>
                              <td className="border-b border-zinc-100 px-2 py-2">{d.category}</td>
                              <td className="border-b border-zinc-100 px-2 py-2 text-right tabular-nums">
                                {formatAriary(d.amount_ariary)} Ar
                              </td>
                              <td className="border-b border-zinc-100 px-2 py-2 text-right tabular-nums">
                                {formatAriary(d.total_paid_ariary)} Ar
                              </td>
                              <td className="border-b border-zinc-100 px-2 py-2 text-right tabular-nums font-semibold">
                                {formatAriary(d.remaining_amount_ariary)} Ar
                              </td>
                              <td className="border-b border-zinc-100 px-2 py-2 text-zinc-700">{lastPay}</td>
                              <td className="border-b border-zinc-100 px-2 py-2 tabular-nums text-zinc-700">
                                {ageDays == null ? '—' : `${ageDays} j`}
                              </td>
                              <td className="border-b border-zinc-100 px-2 py-2 text-right">
                                <button
                                  type="button"
                                  className="rounded-lg border border-zinc-200 bg-white px-3 py-2 text-sm hover:bg-zinc-100"
                                  onClick={() => openPayment(d)}
                                >
                                  Gérer dette
                                </button>
                              </td>
                            </tr>
                          );
                        })
                      )}
                    </tbody>
                  </table>
                </div>
              </section>

              <section className="rounded-xl border border-zinc-200 bg-white p-4">
                <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
                  <div>
                    <h2 className="text-sm font-semibold text-zinc-900">Véhicule actuel</h2>
                    {data.current_vehicle ? (
                      <div className="mt-2">
                        <div className="text-base font-semibold text-zinc-900">
                          {data.current_vehicle.kind?.trim() ? data.current_vehicle.kind : '—'}
                        </div>
                        <div className="mt-0.5 font-mono text-sm text-zinc-700">
                          {data.current_vehicle.plate_number?.trim() ? data.current_vehicle.plate_number : '—'}
                        </div>
                        {typeof data.current_vehicle.active === 'boolean' ? (
                          <div className="mt-2 text-xs text-zinc-600">
                            État véhicule: {data.current_vehicle.active ? 'actif' : 'inactif'}
                          </div>
                        ) : null}
                      </div>
                    ) : (
                      <div className="mt-2 text-sm text-zinc-600">Aucun véhicule actif.</div>
                    )}
                  </div>

                  <div className={`flex flex-wrap gap-2 ${isDeactivated ? 'pointer-events-none opacity-50' : ''}`}>
                    {data.current_vehicle ? (
                      <>
                        <button
                          type="button"
                          className="rounded-lg border border-zinc-200 bg-white px-3 py-2 text-sm hover:bg-zinc-100 disabled:opacity-50"
                          disabled={vehicleSetSubmitting || vehicleRetireSubmitting}
                          onClick={openVehicleSetModal}
                        >
                          Remplacer le véhicule
                        </button>
                        <button
                          type="button"
                          className="rounded-lg border border-red-200 bg-white px-3 py-2 text-sm font-medium text-red-800 hover:bg-red-50 disabled:opacity-50"
                          disabled={vehicleSetSubmitting || vehicleRetireSubmitting}
                          onClick={() => {
                            setVehicleRetireError(null);
                            setVehicleRetireOpen(true);
                          }}
                        >
                          Retirer le véhicule…
                        </button>
                      </>
                    ) : (
                      <button
                        type="button"
                        className="rounded-lg border border-zinc-800 bg-zinc-900 px-3 py-2 text-sm font-medium text-white hover:bg-zinc-800 disabled:opacity-50"
                        disabled={vehicleSetSubmitting || vehicleRetireSubmitting}
                        onClick={openVehicleSetModal}
                      >
                        Ajouter un véhicule
                      </button>
                    )}
                  </div>
                </div>
              </section>

              <section className="rounded-xl border border-zinc-200 bg-white p-4">
                <h2 className="mb-3 text-sm font-semibold text-zinc-900">Courses récentes</h2>
                <div className="overflow-x-auto">
                  <table className="min-w-full border-separate border-spacing-0 text-sm">
                    <thead>
                      <tr className="text-left text-xs text-zinc-600">
                        <th className="border-b border-zinc-200 px-2 py-2">Terminée</th>
                        <th className="border-b border-zinc-200 px-2 py-2">Brut course</th>
                        <th className="border-b border-zinc-200 px-2 py-2">Net chauffeur</th>
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
                            {formatAriary(r.fare_total_ariary)} Ar
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
                          <td className="px-2 py-4 text-zinc-500" colSpan={6}>
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
                className="fixed inset-0 z-50 flex items-start justify-center overflow-y-auto bg-black/40 p-2 sm:items-center sm:p-4"
                role="presentation"
                onClick={() => !deleteSubmitting && setDeleteOpen(false)}
              >
                <div
                  role="dialog"
                  aria-modal="true"
                  aria-labelledby="delete-driver-title"
                  className="my-6 w-full max-w-md rounded-xl border border-zinc-200 bg-white p-4 shadow-lg sm:my-0 sm:p-5 max-h-[90vh] overflow-y-auto overflow-x-hidden"
                  onClick={(e) => e.stopPropagation()}
                  onKeyDown={(e) => e.stopPropagation()}
                >
                  <div className="flex items-start justify-between gap-3">
                    <h2 id="delete-driver-title" className="text-lg font-semibold text-zinc-900">
                      Désactiver ce chauffeur ?
                    </h2>
                    <button
                      type="button"
                      className="shrink-0 rounded-lg border border-zinc-200 bg-white px-3 py-2 text-sm hover:bg-zinc-100 disabled:opacity-50"
                      disabled={deleteSubmitting}
                      onClick={() => setDeleteOpen(false)}
                    >
                      Fermer
                    </button>
                  </div>
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

            {vehicleRetireOpen ? (
              <div
                className="fixed inset-0 z-50 flex items-start justify-center overflow-y-auto bg-black/40 p-2 sm:items-center sm:p-4"
                role="presentation"
                onClick={() => !vehicleRetireSubmitting && setVehicleRetireOpen(false)}
              >
                <div
                  role="dialog"
                  aria-modal="true"
                  aria-labelledby="retire-vehicle-title"
                  className="my-6 w-full max-w-md rounded-xl border border-zinc-200 bg-white p-4 shadow-lg sm:my-0 sm:p-5 max-h-[90vh] overflow-y-auto overflow-x-hidden"
                  onClick={(e) => e.stopPropagation()}
                  onKeyDown={(e) => e.stopPropagation()}
                >
                  <div className="flex items-start justify-between gap-3">
                    <h2 id="retire-vehicle-title" className="text-lg font-semibold text-zinc-900">
                      Retirer le véhicule actuel ?
                    </h2>
                    <button
                      type="button"
                      className="shrink-0 rounded-lg border border-zinc-200 bg-white px-3 py-2 text-sm hover:bg-zinc-100 disabled:opacity-50"
                      disabled={vehicleRetireSubmitting}
                      onClick={() => setVehicleRetireOpen(false)}
                    >
                      Fermer
                    </button>
                  </div>
                  <p className="mt-2 text-sm text-zinc-600">
                    Cette action clôture l’assignation active (historique conservé). Aucun véhicule n’est supprimé.
                  </p>
                  <p className="mt-2 text-sm font-medium text-zinc-800">
                    {data.current_vehicle?.kind ?? '—'} ·{' '}
                    <span className="font-mono">{data.current_vehicle?.plate_number ?? '—'}</span>
                  </p>
                  {vehicleRetireError ? (
                    <div className="mt-3 rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-900">
                      {vehicleRetireError}
                    </div>
                  ) : null}
                  <form
                    className="mt-4 flex justify-end gap-2"
                    onSubmit={(e: FormEvent) => {
                      e.preventDefault();
                      void confirmRetireVehicle();
                    }}
                  >
                    <button
                      type="button"
                      className="rounded-lg border border-zinc-200 bg-white px-3 py-2 text-sm hover:bg-zinc-100 disabled:opacity-50"
                      disabled={vehicleRetireSubmitting}
                      onClick={() => setVehicleRetireOpen(false)}
                    >
                      Annuler
                    </button>
                    <button
                      type="submit"
                      className="rounded-lg border border-red-700 bg-red-700 px-3 py-2 text-sm font-medium text-white hover:bg-red-800 disabled:opacity-50"
                      disabled={vehicleRetireSubmitting}
                    >
                      {vehicleRetireSubmitting ? 'Retrait…' : 'Confirmer le retrait'}
                    </button>
                  </form>
                </div>
              </div>
            ) : null}

            {vehicleSetOpen ? (
              <div
                className="fixed inset-0 z-50 flex items-start justify-center overflow-y-auto bg-black/40 p-2 sm:items-center sm:p-4"
                role="presentation"
                onClick={() => !vehicleSetSubmitting && setVehicleSetOpen(false)}
              >
                <div
                  role="dialog"
                  aria-modal="true"
                  aria-labelledby="set-vehicle-title"
                  className="my-6 w-full max-w-md rounded-xl border border-zinc-200 bg-white p-4 shadow-lg sm:my-0 sm:p-5 max-h-[90vh] overflow-y-auto overflow-x-hidden"
                  onClick={(e) => e.stopPropagation()}
                  onKeyDown={(e) => e.stopPropagation()}
                >
                  <div className="flex items-start justify-between gap-3">
                    <h2 id="set-vehicle-title" className="text-lg font-semibold text-zinc-900">
                      {data.current_vehicle ? 'Remplacer le véhicule' : 'Ajouter un véhicule'}
                    </h2>
                    <button
                      type="button"
                      className="shrink-0 rounded-lg border border-zinc-200 bg-white px-3 py-2 text-sm hover:bg-zinc-100 disabled:opacity-50"
                      disabled={vehicleSetSubmitting}
                      onClick={() => setVehicleSetOpen(false)}
                    >
                      Fermer
                    </button>
                  </div>
                  <p className="mt-2 text-sm text-zinc-600">
                    Cette action clôture l’assignation active si elle existe, crée un nouveau véhicule, puis assigne ce véhicule au chauffeur.
                  </p>

                  <form className="mt-4 flex flex-col gap-3" onSubmit={submitSetVehicle}>
                    <label className="flex flex-col gap-1 text-sm">
                      <span className="text-zinc-700">Type véhicule</span>
                      <input
                        className="rounded-lg border border-zinc-200 px-3 py-2 outline-none focus:border-zinc-400"
                        value={vehicleKind}
                        onChange={(e) => setVehicleKind(e.target.value)}
                        required
                        disabled={vehicleSetSubmitting}
                      />
                    </label>
                    <label className="flex flex-col gap-1 text-sm">
                      <span className="text-zinc-700">Immatriculation</span>
                      <input
                        className="rounded-lg border border-zinc-200 px-3 py-2 font-mono outline-none focus:border-zinc-400"
                        value={vehiclePlate}
                        onChange={(e) => setVehiclePlate(e.target.value)}
                        required
                        disabled={vehicleSetSubmitting}
                      />
                    </label>
                    {vehicleSetError ? (
                      <div className="rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-900">
                        {vehicleSetError}
                      </div>
                    ) : null}
                    <div className="mt-2 flex justify-end gap-2">
                      <button
                        type="button"
                        className="rounded-lg border border-zinc-200 bg-white px-3 py-2 text-sm hover:bg-zinc-100 disabled:opacity-50"
                        disabled={vehicleSetSubmitting}
                        onClick={() => setVehicleSetOpen(false)}
                      >
                        Annuler
                      </button>
                      <button
                        type="submit"
                        className="rounded-lg border border-zinc-800 bg-zinc-900 px-3 py-2 text-sm font-medium text-white hover:bg-zinc-800 disabled:opacity-50"
                        disabled={vehicleSetSubmitting}
                      >
                        {vehicleSetSubmitting ? 'Enregistrement…' : 'Enregistrer'}
                      </button>
                    </div>
                  </form>
                </div>
              </div>
            ) : null}

            {reactivateOpen ? (
              <div
                className="fixed inset-0 z-50 flex items-start justify-center overflow-y-auto bg-black/40 p-2 sm:items-center sm:p-4"
                role="presentation"
                onClick={() => !reactivateSubmitting && setReactivateOpen(false)}
              >
                <div
                  role="dialog"
                  aria-modal="true"
                  aria-labelledby="reactivate-driver-title"
                  className="my-6 w-full max-w-md rounded-xl border border-zinc-200 bg-white p-4 shadow-lg sm:my-0 sm:p-5 max-h-[90vh] overflow-y-auto overflow-x-hidden"
                  onClick={(e) => e.stopPropagation()}
                  onKeyDown={(e) => e.stopPropagation()}
                >
                  <div className="flex items-start justify-between gap-3">
                    <h2 id="reactivate-driver-title" className="text-lg font-semibold text-zinc-900">
                      Réactiver ce chauffeur ?
                    </h2>
                    <button
                      type="button"
                      className="shrink-0 rounded-lg border border-zinc-200 bg-white px-3 py-2 text-sm hover:bg-zinc-100 disabled:opacity-50"
                      disabled={reactivateSubmitting}
                      onClick={() => setReactivateOpen(false)}
                    >
                      Fermer
                    </button>
                  </div>
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

        <FleetEntryPaymentModal
          open={payOpen}
          vehicleId={payVehicleId}
          entryId={payEntryId}
          onClose={() => setPayOpen(false)}
          onChanged={() => setRefreshSeq((s) => s + 1)}
        />
      </AdminShell>
    </RequireAuth>
  );
}

function formatCount(n: unknown): string {
  const v = typeof n === 'number' ? n : Number.NaN;
  if (!Number.isFinite(v)) return '—';
  return new Intl.NumberFormat('fr-FR').format(v);
}
