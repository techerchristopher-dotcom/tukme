'use client';

import { useEffect, useMemo, useState, type FormEvent } from 'react';

import { createFleetVehicleEntryPayment, getFleetVehicleEntry, listFleetVehicleEntryPayments } from '@/lib/adminApi';
import { formatAriary } from '@/lib/money';
import type { FleetEntryPaymentRow, FleetEntryRow } from '@/lib/types';
import { isUuidString } from '@/lib/uuid';

function digitsOnly(s: string): string {
  return String(s ?? '').replace(/[^\d]/g, '');
}

function formatDigitsFr(v: string): string {
  const d = digitsOnly(v);
  if (!d) return '';
  const n = Number.parseInt(d, 10);
  if (!Number.isFinite(n)) return '';
  return new Intl.NumberFormat('fr-FR').format(n);
}

function sumPayments(payments: FleetEntryPaymentRow[]): number {
  let s = 0;
  for (const p of payments) {
    const v = typeof p.amount_ariary === 'number' ? p.amount_ariary : Number((p as any).amount_ariary ?? 0);
    if (Number.isFinite(v)) s += Math.max(0, Math.trunc(v));
  }
  return s;
}

export function FleetEntryPaymentModal(props: {
  open: boolean;
  vehicleId: string | null;
  entryId: string | null;
  onClose: () => void;
  onChanged?: (args: { vehicleId: string; entryId: string; wasSettled: boolean }) => void;
}) {
  const open = props.open;
  const vehicleId = (props.vehicleId ?? '').trim();
  const entryId = (props.entryId ?? '').trim();

  const canRun = open && isUuidString(vehicleId) && isUuidString(entryId);

  const [loading, setLoading] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const [entry, setEntry] = useState<FleetEntryRow | null>(null);
  const [payments, setPayments] = useState<FleetEntryPaymentRow[]>([]);
  const [paymentsLoading, setPaymentsLoading] = useState(false);
  const [paymentsError, setPaymentsError] = useState<string | null>(null);

  const [paymentAmountText, setPaymentAmountText] = useState('');
  const [paymentDate, setPaymentDate] = useState('');
  const [paymentNotes, setPaymentNotes] = useState('');

  const isPayableIncomeDebt = useMemo(() => {
    if (!entry) return false;
    const entryType = String(entry.entry_type ?? '').trim().toLowerCase();
    const cat = String(entry.category ?? '').trim().toLowerCase();
    return entryType === 'income' && (cat === 'carburant' || cat === 'loyer');
  }, [entry]);

  const due = entry?.amount_ariary ?? 0;
  const paidFromEntry =
    typeof entry?.total_paid_ariary === 'number' && Number.isFinite(entry.total_paid_ariary)
      ? entry.total_paid_ariary
      : null;
  const paidFromPayments = payments.length ? sumPayments(payments) : null;
  const paid = paidFromPayments ?? paidFromEntry ?? 0;
  const remaining =
    typeof entry?.remaining_amount_ariary === 'number' && Number.isFinite(entry.remaining_amount_ariary)
      ? entry.remaining_amount_ariary
      : Math.max(0, Math.trunc(due) - Math.max(0, Math.trunc(paid)));
  const settled = remaining <= 0 || entry?.payment_status === 'paid';

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') props.onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open, props]);

  useEffect(() => {
    let cancelled = false;
    async function run() {
      if (!canRun) return;
      setLoading(true);
      setError(null);
      setEntry(null);
      setPayments([]);
      setPaymentsError(null);
      setPaymentAmountText('');
      setPaymentDate('');
      setPaymentNotes('');

      const res = await getFleetVehicleEntry(vehicleId, entryId);
      if (cancelled) return;
      if (res.error || !res.data?.entry?.id) {
        setError(res.error?.message ?? 'Impossible de charger l’écriture.');
        setLoading(false);
        return;
      }
      setEntry(res.data.entry);
      setLoading(false);
    }
    void run();
    return () => {
      cancelled = true;
    };
  }, [canRun, vehicleId, entryId, open]);

  useEffect(() => {
    let cancelled = false;
    async function run() {
      if (!canRun) return;
      if (!entry) return;
      if (!isPayableIncomeDebt) return;
      setPaymentsLoading(true);
      setPaymentsError(null);
      const res = await listFleetVehicleEntryPayments(vehicleId, entryId);
      if (cancelled) return;
      setPaymentsLoading(false);
      if (res.error) {
        setPaymentsError(res.error.message);
        setPayments([]);
        return;
      }
      const items = res.data.items ?? [];
      setPayments(items);

      if (!paymentDate) setPaymentDate(entry.entry_date);
      if (!paymentAmountText.trim() && remaining > 0) setPaymentAmountText(String(remaining));
    }
    void run();
    return () => {
      cancelled = true;
    };
  }, [canRun, entry, isPayableIncomeDebt, vehicleId, entryId, paymentAmountText, paymentDate, remaining]);

  async function submitPayment(e: FormEvent) {
    e.preventDefault();
    if (!canRun) return;
    if (!entry) return;
    if (!isPayableIncomeDebt) return;
    setPaymentsError(null);

    if (settled) {
      setPaymentsError('Dette soldée.');
      return;
    }

    const amount = Number.parseInt(digitsOnly(paymentAmountText), 10);
    if (!Number.isInteger(amount) || amount <= 0) {
      setPaymentsError('Montant payé invalide (entier > 0).');
      return;
    }
    if (amount > remaining) {
      setPaymentsError('Montant trop élevé (dépasse le reste).');
      return;
    }

    const paidAt = paymentDate.trim() ? paymentDate.trim() : null;
    setSubmitting(true);
    const res = await createFleetVehicleEntryPayment(vehicleId, entryId, {
      amount_ariary: amount,
      paid_at: paidAt,
      notes: paymentNotes.trim() ? paymentNotes.trim() : null,
    });
    setSubmitting(false);
    if (res.error) {
      setPaymentsError(res.error.message);
      return;
    }

    // Re-fetch entry + payments to avoid any front-side debt computation.
    const [entryRes, payRes] = await Promise.all([
      getFleetVehicleEntry(vehicleId, entryId),
      listFleetVehicleEntryPayments(vehicleId, entryId),
    ]);
    if (entryRes.error || !entryRes.data?.entry?.id) {
      setPaymentsError(entryRes.error?.message ?? 'Paiement OK, mais impossible de rafraîchir l’écriture.');
      return;
    }
    setEntry(entryRes.data.entry);

    if (payRes.error) {
      setPaymentsError(payRes.error.message);
      return;
    }
    const items = payRes.data.items ?? [];
    setPayments(items);

    const nextPaid = items.length ? sumPayments(items) : 0;
    const nextRemaining = Math.max(0, Math.trunc(entryRes.data.entry.amount_ariary) - Math.max(0, Math.trunc(nextPaid)));
    setPaymentAmountText(nextRemaining > 0 ? String(nextRemaining) : '');

    const wasSettled = nextRemaining <= 0 || entryRes.data.entry.payment_status === 'paid';
    props.onChanged?.({ vehicleId, entryId, wasSettled });
  }

  if (!open) return null;

  return (
    <div
      className="fixed inset-0 z-[60] flex items-center justify-center bg-black/50 p-4"
      role="presentation"
      onClick={() => !submitting && props.onClose()}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="fleet-entry-payment-title"
        className="w-full max-w-2xl rounded-xl border border-zinc-200 bg-white p-5 shadow-lg max-h-[calc(100vh-3rem)] overflow-y-auto"
        onClick={(ev) => ev.stopPropagation()}
      >
        <div className="flex items-start justify-between gap-4">
          <div>
            <h2 id="fleet-entry-payment-title" className="text-lg font-semibold">
              Gérer dette
            </h2>
            <div className="mt-1 text-xs text-zinc-500 font-mono">{entryId || '—'}</div>
          </div>
          <button
            type="button"
            className="rounded-lg border border-zinc-200 bg-white px-3 py-2 text-sm hover:bg-zinc-100 disabled:opacity-50"
            disabled={submitting}
            onClick={props.onClose}
          >
            Fermer
          </button>
        </div>

        {!canRun ? (
          <div className="mt-4 rounded-lg border border-red-200 bg-red-50 p-3 text-sm text-red-900">
            Identifiant invalide.
          </div>
        ) : loading ? (
          <div className="mt-4 text-sm text-zinc-600">Chargement…</div>
        ) : error ? (
          <div className="mt-4 rounded-lg border border-red-200 bg-red-50 p-3 text-sm text-red-900">{error}</div>
        ) : !entry ? (
          <div className="mt-4 text-sm text-zinc-600">Écriture introuvable.</div>
        ) : !isPayableIncomeDebt ? (
          <div className="mt-4 rounded-lg border border-amber-200 bg-amber-50 p-3 text-sm text-amber-900">
            Cette écriture n’est pas une dette payable (attendu: income carburant/loyer).
          </div>
        ) : (
          <>
            <div className="mt-4 grid grid-cols-1 gap-3 sm:grid-cols-2">
              <div className="rounded-lg border border-zinc-200 p-3">
                <div className="text-xs text-zinc-600">Date</div>
                <div className="mt-1 font-medium tabular-nums">{entry.entry_date}</div>
              </div>
              <div className="rounded-lg border border-zinc-200 p-3">
                <div className="text-xs text-zinc-600">Catégorie</div>
                <div className="mt-1 font-medium">{entry.category}</div>
              </div>
              <div className="rounded-lg border border-indigo-200 bg-indigo-50 p-3 sm:col-span-2">
                <div className="text-xs font-medium text-indigo-900">Montants</div>
                <div className="mt-2 grid grid-cols-1 gap-3 sm:grid-cols-3">
                  <div className="rounded-lg border border-indigo-200 bg-white p-3">
                    <div className="text-xs text-indigo-900">Dû</div>
                    <div className="mt-1 font-semibold tabular-nums text-indigo-950">{formatAriary(due)} Ar</div>
                  </div>
                  <div className="rounded-lg border border-indigo-200 bg-white p-3">
                    <div className="text-xs text-indigo-900">Payé</div>
                    <div className="mt-1 font-semibold tabular-nums text-indigo-950">{formatAriary(paid)} Ar</div>
                  </div>
                  <div className="rounded-lg border border-indigo-200 bg-white p-3">
                    <div className="text-xs text-indigo-900">Reste</div>
                    <div className="mt-1 font-semibold tabular-nums text-indigo-950">{formatAriary(remaining)} Ar</div>
                  </div>
                </div>
              </div>
            </div>

            <div className="mt-4 rounded-lg border border-zinc-200 p-3">
              <div className="text-xs font-medium text-zinc-900">Historique des paiements</div>
              {paymentsLoading ? (
                <div className="mt-2 text-sm text-zinc-600">Chargement…</div>
              ) : paymentsError ? (
                <div className="mt-2 text-sm text-red-900">{paymentsError}</div>
              ) : payments.length ? (
                <div className="mt-2 space-y-2">
                  {payments.map((p) => (
                    <div
                      key={p.id}
                      className="flex items-start justify-between gap-3 rounded-lg border border-zinc-200 bg-white px-3 py-2"
                    >
                      <div>
                        <div className="text-sm font-medium tabular-nums text-zinc-900">
                          {formatAriary(p.amount_ariary)} Ar
                        </div>
                        <div className="text-xs text-zinc-600">{new Date(p.paid_at).toLocaleString('fr-FR')}</div>
                        {p.notes?.trim() ? <div className="mt-1 text-xs text-zinc-700">{p.notes}</div> : null}
                      </div>
                    </div>
                  ))}
                </div>
              ) : (
                <div className="mt-2 text-sm text-zinc-600">Aucun paiement enregistré.</div>
              )}
            </div>

            {settled ? (
              <div className="mt-4 rounded-lg border border-emerald-200 bg-emerald-50 p-3 text-sm text-emerald-900">
                Dette soldée.
              </div>
            ) : (
              <form className="mt-4 grid grid-cols-1 gap-3 sm:grid-cols-2" onSubmit={submitPayment}>
                <label className="flex flex-col gap-1 text-sm">
                  <span className="text-zinc-700">Montant payé (Ar)</span>
                  <input
                    className="rounded-lg border border-zinc-200 bg-white px-3 py-2 outline-none focus:border-zinc-400"
                    inputMode="numeric"
                    value={paymentAmountText}
                    onChange={(e) => setPaymentAmountText(e.target.value)}
                    onBlur={() => setPaymentAmountText((v) => formatDigitsFr(v))}
                    disabled={submitting}
                  />
                </label>
                <label className="flex flex-col gap-1 text-sm">
                  <span className="text-zinc-700">Date (optionnel)</span>
                  <input
                    className="rounded-lg border border-zinc-200 bg-white px-3 py-2 outline-none focus:border-zinc-400"
                    type="date"
                    value={paymentDate}
                    onChange={(e) => setPaymentDate(e.target.value)}
                    disabled={submitting}
                  />
                </label>
                <label className="flex flex-col gap-1 text-sm sm:col-span-2">
                  <span className="text-zinc-700">Note (optionnel)</span>
                  <input
                    className="rounded-lg border border-zinc-200 bg-white px-3 py-2 outline-none focus:border-zinc-400"
                    value={paymentNotes}
                    onChange={(e) => setPaymentNotes(e.target.value)}
                    disabled={submitting}
                  />
                </label>
                <div className="sm:col-span-2 flex items-center justify-between gap-3">
                  <div className="text-xs text-zinc-500">
                    Conseil: mets le <strong>reste</strong> pour solder.
                  </div>
                  <button
                    type="submit"
                    className="rounded-lg border border-indigo-800 bg-indigo-900 px-3 py-2 text-sm font-medium text-white hover:bg-indigo-800 disabled:opacity-50"
                    disabled={submitting}
                  >
                    {submitting ? 'Paiement…' : 'Ajouter un paiement'}
                  </button>
                </div>
              </form>
            )}
          </>
        )}
      </div>
    </div>
  );
}

