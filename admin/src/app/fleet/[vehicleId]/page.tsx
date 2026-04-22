'use client';

import Link from 'next/link';
import { useParams } from 'next/navigation';
import { useEffect, useMemo, useState, type FormEvent } from 'react';

import { AdminShell } from '@/components/layout/AdminShell';
import { RequireAuth } from '@/components/auth/RequireAuth';
import {
  createFleetVehicleEntry,
  getDriversDailySummary,
  getFleetVehicle,
  listFleetVehicleEntryPayments,
  patchFleetVehicleEntry,
  patchFleetVehicle,
  createFleetVehicleEntryPayment,
  setFleetVehicleAssignment,
  softDeleteFleetVehicleEntry,
} from '@/lib/adminApi';
import { useBusinessDate } from '@/hooks/useBusinessDate';
import { formatAriary } from '@/lib/money';
import type {
  DriverDailySummaryRow,
  FleetEntryPatchInput,
  FleetEntryCreateInput,
  FleetEntryPaymentRow,
  FleetFinancialSummary,
  FleetVehicleCreateInput,
  FleetVehicleDetailResponse,
  FleetEntryRow,
  FleetVehicleStatus,
} from '@/lib/types';
import { isUuidString, normalizeUuidParam } from '@/lib/uuid';

function formatNumberFr(n: number, args?: { maxFrac?: number }): string {
  const maxFrac = args?.maxFrac ?? 0;
  return new Intl.NumberFormat('fr-FR', { maximumFractionDigits: maxFrac }).format(n);
}

function asNonEmpty(v: unknown): string | null {
  return typeof v === 'string' && v.trim() ? v.trim() : null;
}

/** Nombre fini depuis la réponse API (int / float / string entier). */
function financeNumberFromUnknown(v: unknown): number | null {
  if (typeof v === 'number' && Number.isFinite(v)) return v;
  if (typeof v === 'string' && v.trim()) {
    const n = Number.parseInt(v.trim(), 10);
    return Number.isFinite(n) ? n : null;
  }
  return null;
}

/**
 * Compatibilité `financial_summary` : ancienne forme (`total_income_ariary`) ou déploiement encore sur
 * la forme étendue (`total_income_received_ariary` / `total_income_theoretical_ariary` sans `total_income_ariary`).
 * Total recettes affiché : reçu en priorité, sinon théorique, sinon champ legacy.
 */
function normalizeFleetFinancialSummary(
  raw: unknown,
  vehicleIdFallback: string
): FleetFinancialSummary | null {
  if (raw == null || typeof raw !== 'object') return null;
  const s = raw as Record<string, unknown>;

  let total_income_ariary: number | null = null;
  for (const key of ['total_income_ariary', 'total_income_received_ariary', 'total_income_theoretical_ariary'] as const) {
    if (!Object.prototype.hasOwnProperty.call(s, key)) continue;
    const n = financeNumberFromUnknown(s[key]);
    if (n !== null) {
      total_income_ariary = n;
      break;
    }
  }
  if (total_income_ariary === null) total_income_ariary = 0;

  const total_expense_ariary = financeNumberFromUnknown(s.total_expense_ariary) ?? 0;

  let net_ariary = financeNumberFromUnknown(s.net_ariary);
  if (net_ariary === null) {
    net_ariary = total_income_ariary - total_expense_ariary;
  }

  const purchase_price_ariary = financeNumberFromUnknown(s.purchase_price_ariary);
  let remaining_to_amortize_ariary = financeNumberFromUnknown(s.remaining_to_amortize_ariary);
  if (remaining_to_amortize_ariary === null && purchase_price_ariary !== null) {
    remaining_to_amortize_ariary = Math.max(purchase_price_ariary - net_ariary, 0);
  }

  let amortized_percent = financeNumberFromUnknown(s.amortized_percent);
  if (amortized_percent === null && purchase_price_ariary !== null && purchase_price_ariary > 0) {
    amortized_percent = Math.min(Math.max(net_ariary / purchase_price_ariary, 0), 1) * 100;
  }

  const vehicle_id = typeof s.vehicle_id === 'string' && s.vehicle_id.trim() ? s.vehicle_id.trim() : vehicleIdFallback;

  return {
    vehicle_id,
    purchase_price_ariary: purchase_price_ariary ?? null,
    purchase_date: typeof s.purchase_date === 'string' ? s.purchase_date : null,
    amortization_months: financeNumberFromUnknown(s.amortization_months),
    target_resale_price_ariary: financeNumberFromUnknown(s.target_resale_price_ariary),
    daily_rent_ariary: financeNumberFromUnknown(s.daily_rent_ariary),
    total_income_ariary,
    total_expense_ariary,
    net_ariary,
    remaining_to_amortize_ariary: remaining_to_amortize_ariary ?? null,
    amortized_percent: amortized_percent ?? null,
    estimated_payoff_date: typeof s.estimated_payoff_date === 'string' ? s.estimated_payoff_date : null,
  };
}

function normalizeFleetVehicleDetailResponse(raw: FleetVehicleDetailResponse): FleetVehicleDetailResponse {
  const r = raw as unknown as Record<string, unknown>;
  const vehicle = (r.vehicle ?? null) as FleetVehicleDetailResponse['vehicle'] | null;
  if (!vehicle || typeof (vehicle as { id?: unknown }).id !== 'string') {
    // Caller should treat as an invalid response.
    return raw;
  }

  const assignment_history = Array.isArray(r.assignment_history)
    ? (r.assignment_history as FleetVehicleDetailResponse['assignment_history'])
    : [];
  const recent_entries = Array.isArray(r.recent_entries)
    ? (r.recent_entries as FleetVehicleDetailResponse['recent_entries'])
    : [];

  const active_assignment =
    (r.active_assignment as FleetVehicleDetailResponse['active_assignment']) ?? null;
  const financial_summary = normalizeFleetFinancialSummary(r.financial_summary, vehicle.id);
  const fuel_summary = (r.fuel_summary as FleetVehicleDetailResponse['fuel_summary']) ?? null;

  return {
    vehicle,
    active_assignment,
    assignment_history,
    recent_entries,
    financial_summary,
    fuel_summary: fuel_summary ?? undefined,
  } as FleetVehicleDetailResponse;
}

function parseIntOrNull(s: string): number | null {
  const t = s.trim();
  if (!t) return null;
  const n = Number.parseInt(t, 10);
  return Number.isInteger(n) ? n : null;
}

function parseFloatOrNull(s: string): number | null {
  const t = s.trim().replace(',', '.');
  if (!t) return null;
  const n = Number.parseFloat(t);
  return Number.isFinite(n) ? n : null;
}

function digitsOnly(s: string): string {
  return s.replace(/[^\d]/g, '');
}

/** Somme des montants des lignes de paiement (aligné sur la RPC `admin_fleet_entry_payments_aggregates`). */
function sumFleetEntryPaymentAmounts(items: FleetEntryPaymentRow[]): number {
  let s = 0;
  for (const p of items) {
    const a = typeof p.amount_ariary === 'number' ? p.amount_ariary : Number(p.amount_ariary ?? 0);
    if (Number.isFinite(a)) s += Math.trunc(a);
  }
  return s;
}

/**
 * Statut / payé / restant pour une dette carburant chauffeur (même règle que l’enrichissement admin-api).
 * Utilisé après ajout de paiement pour mettre à jour la fiche sans attendre uniquement le re-fetch véhicule.
 */
function fuelIncomeDriverPaymentSummary(
  dueAriary: number,
  totalPaidFromLines: number
): {
  total_paid_ariary: number;
  remaining_amount_ariary: number;
  payment_status: 'unpaid' | 'partial' | 'paid';
} {
  const due = Math.trunc(Number.isFinite(dueAriary) ? dueAriary : 0);
  const paid = Math.max(0, Math.trunc(Number.isFinite(totalPaidFromLines) ? totalPaidFromLines : 0));
  const remaining = Math.max(0, due - paid);
  const payment_status: 'unpaid' | 'partial' | 'paid' =
    paid <= 0 ? 'unpaid' : paid < due ? 'partial' : 'paid';
  return { total_paid_ariary: paid, remaining_amount_ariary: remaining, payment_status };
}

function computeFuelDerived(args: {
  kmStartText: string;
  kmEndText: string;
  priceText: string;
  consumptionText: string;
}): {
  kmDay: number | null;
  dueAriary: number | null;
  error: string | null;
} {
  const a = digitsOnly(args.kmStartText);
  const b = digitsOnly(args.kmEndText);
  const p = digitsOnly(args.priceText);
  const c = args.consumptionText;

  // Incomplete input → neutral state (no error yet).
  if (!a || !b) {
    return { kmDay: null, dueAriary: null, error: null };
  }

  const start = Number.parseInt(a, 10);
  const end = Number.parseInt(b, 10);
  if (!Number.isInteger(start) || !Number.isInteger(end)) {
    return { kmDay: null, dueAriary: null, error: null };
  }
  if (start < 0 || end < 0) {
    return { kmDay: null, dueAriary: null, error: 'Km doit être ≥ 0.' };
  }
  if (end < start) {
    return { kmDay: null, dueAriary: null, error: 'Km retour doit être ≥ km départ.' };
  }
  const kmDay = end - start;
  if (kmDay <= 0) {
    return { kmDay: null, dueAriary: null, error: 'Km du jour doit être > 0.' };
  }

  // Still incomplete → keep kmDay visible but no due until price+consumption are valid.
  if (!p) {
    return { kmDay, dueAriary: null, error: null };
  }
  const price = Number.parseInt(p, 10);
  if (!Number.isInteger(price) || price <= 0) {
    return { kmDay, dueAriary: null, error: null };
  }

  const conso = parseFloatOrNull(c);
  if (conso == null || conso <= 0) {
    return { kmDay, dueAriary: null, error: null };
  }

  const raw = kmDay * conso * price;
  if (!Number.isFinite(raw)) return { kmDay, dueAriary: null, error: null };
  const due = Math.round(raw);
  return { kmDay, dueAriary: due > 0 ? due : null, error: null };
}

function formatIntFr(n: number): string {
  return new Intl.NumberFormat('fr-FR').format(n);
}

function formatDigitsFr(s: string): string {
  const d = digitsOnly(s);
  if (!d) return '';
  const n = Number.parseInt(d, 10);
  if (!Number.isFinite(n)) return '';
  return formatIntFr(n);
}

function lastKnownKmFromEntries(entries: FleetEntryRow[] | undefined): number | null {
  if (!entries?.length) return null;
  const endRow = entries.find((e) => typeof e.fuel_km_end === 'number' && Number.isFinite(e.fuel_km_end));
  if (typeof endRow?.fuel_km_end === 'number') return endRow.fuel_km_end;
  const odoRow = entries.find((e) => typeof e.odometer_km === 'number' && Number.isFinite(e.odometer_km));
  return typeof odoRow?.odometer_km === 'number' ? odoRow.odometer_km : null;
}

function vehicleFuelRefsUsable(vehicle: FleetVehicleDetailResponse['vehicle'] | undefined | null): boolean {
  if (!vehicle) return false;
  const L = vehicle.fuel_ref_litres;
  const K = vehicle.fuel_ref_km;
  return typeof L === 'number' && Number.isFinite(L) && L > 0 && typeof K === 'number' && Number.isFinite(K) && K > 0;
}

/** km crédités = litres × (refKm / refLitres), arrondi entier (Math.round). */
function kmCreditedFromLitresRounded(litres: number, refLitres: number, refKm: number): number {
  return Math.round(litres * (refKm / refLitres));
}

type FleetFuelSummaryRow = NonNullable<FleetVehicleDetailResponse['fuel_summary']>;

function fuelSummaryKmRemainingBase(fs: FleetFuelSummaryRow): number | null {
  if (typeof fs.km_remaining === 'number' && Number.isFinite(fs.km_remaining)) {
    return fs.km_remaining;
  }
  const tr = fs.total_recharge_km_credited;
  const tk = fs.total_km_consumed;
  if (typeof tr === 'number' && Number.isFinite(tr) && typeof tk === 'number' && Number.isFinite(tk)) {
    return tr - tk;
  }
  return null;
}

function fuelSummaryLitresRemainingBase(fs: FleetFuelSummaryRow): number | null {
  if (typeof fs.litres_remaining === 'number' && Number.isFinite(fs.litres_remaining)) {
    return fs.litres_remaining;
  }
  if (fs.total_litres_consumed == null) return null;
  const tr = fs.total_recharge_litres;
  const tc = fs.total_litres_consumed;
  if (typeof tr === 'number' && Number.isFinite(tr) && typeof tc === 'number' && Number.isFinite(tc)) {
    return tr - tc;
  }
  return null;
}

/** Aligné sur la règle serveur `computeFleetFuelSummaryFromEntriesTable` (seuils sur km restants projetés). */
function fuelAutonomyStatusProjected(
  kmRemainingProj: number,
  avgKmPerDay7d: number | null | undefined
): FleetFuelSummaryRow['autonomy_status'] {
  const avg = typeof avgKmPerDay7d === 'number' && Number.isFinite(avgKmPerDay7d) ? avgKmPerDay7d : null;
  if (avg == null || avg <= 0) return 'limite';
  if (kmRemainingProj > avg * 2) return 'confortable';
  if (kmRemainingProj >= avg) return 'limite';
  return 'insuffisante';
}

function fmtPct(v: number | null | undefined): string {
  if (typeof v !== 'number' || !Number.isFinite(v)) return '—';
  return `${v.toFixed(1)}%`;
}

function kpiCard(label: string, value: string, hint?: string) {
  return (
    <div className="rounded-lg border border-zinc-200 p-3">
      <div className="text-xs text-zinc-600">{label}</div>
      <div className="mt-1 text-lg font-semibold tabular-nums">{value}</div>
      {hint ? <div className="mt-1 text-xs text-zinc-500">{hint}</div> : null}
    </div>
  );
}

export default function FleetVehicleDetailPage() {
  const params = useParams();
  const { businessDate } = useBusinessDate();

  const vehicleId = useMemo(() => normalizeUuidParam(params?.vehicleId), [params?.vehicleId]);

  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [data, setData] = useState<FleetVehicleDetailResponse | null>(null);
  const [refreshSeq, setRefreshSeq] = useState(0);

  const [editOpen, setEditOpen] = useState(false);
  const [editSubmitting, setEditSubmitting] = useState(false);
  const [editError, setEditError] = useState<string | null>(null);
  const [editForm, setEditForm] = useState<FleetVehicleCreateInput | null>(null);
  const [editFuelRefLitresText, setEditFuelRefLitresText] = useState<string>('');
  const [editFuelRefKmText, setEditFuelRefKmText] = useState<string>('');

  const [entryOpen, setEntryOpen] = useState(false);
  const [entrySubmitting, setEntrySubmitting] = useState(false);
  const [entryError, setEntryError] = useState<string | null>(null);
  const [entryPaymentPostError, setEntryPaymentPostError] = useState<string | null>(null);
  const [entryAmountText, setEntryAmountText] = useState<string>('');
  const [entryOdometerText, setEntryOdometerText] = useState<string>('');
  const [fuelKmStartText, setFuelKmStartText] = useState<string>('');
  const [fuelKmEndText, setFuelKmEndText] = useState<string>('');
  const [fuelPriceText, setFuelPriceText] = useState<string>('');
  const [fuelConsumptionText, setFuelConsumptionText] = useState<string>('');
  const [entryImmediatePaymentAmountText, setEntryImmediatePaymentAmountText] = useState<string>('');
  const [entryImmediatePaymentNotes, setEntryImmediatePaymentNotes] = useState<string>('');
  const [fuelRechargeLitresText, setFuelRechargeLitresText] = useState<string>('');
  const [fuelRechargeKmCreditedText, setFuelRechargeKmCreditedText] = useState<string>('');
  const [fuelRechargeOdometerText, setFuelRechargeOdometerText] = useState<string>('');
  const [entryForm, setEntryForm] = useState<FleetEntryCreateInput>({
    entry_type: 'expense',
    amount_ariary: 0,
    odometer_km: null,
    entry_date: businessDate,
    category: 'autre',
    label: '',
    notes: '',
  });

  const [detailOpen, setDetailOpen] = useState(false);
  const [detailMode, setDetailMode] = useState<'read' | 'edit'>('read');
  const [detailSubmitting, setDetailSubmitting] = useState(false);
  const [detailError, setDetailError] = useState<string | null>(null);
  const [selectedEntry, setSelectedEntry] = useState<FleetEntryRow | null>(null);
  const [paymentsLoading, setPaymentsLoading] = useState(false);
  const [paymentsError, setPaymentsError] = useState<string | null>(null);
  const [payments, setPayments] = useState<FleetEntryPaymentRow[]>([]);
  const [paymentAmountText, setPaymentAmountText] = useState<string>('');
  const [paymentDate, setPaymentDate] = useState<string>(''); // YYYY-MM-DD optional
  const [paymentNotes, setPaymentNotes] = useState<string>('');

  const [editAmountText, setEditAmountText] = useState<string>('');
  const [editOdometerText, setEditOdometerText] = useState<string>('');
  const [editFuelKmStartText, setEditFuelKmStartText] = useState<string>('');
  const [editFuelKmEndText, setEditFuelKmEndText] = useState<string>('');
  const [editFuelPriceText, setEditFuelPriceText] = useState<string>('');
  const [editFuelConsumptionText, setEditFuelConsumptionText] = useState<string>('');
  const [editFuelRechargeLitresText, setEditFuelRechargeLitresText] = useState<string>('');
  const [editFuelRechargeKmCreditedText, setEditFuelRechargeKmCreditedText] = useState<string>('');
  const [entryEditForm, setEntryEditForm] = useState<FleetEntryPatchInput | null>(null);

  const [assignOpen, setAssignOpen] = useState(false);
  const [assignSubmitting, setAssignSubmitting] = useState(false);
  const [assignError, setAssignError] = useState<string | null>(null);
  const [driversLoading, setDriversLoading] = useState(false);
  const [drivers, setDrivers] = useState<DriverDailySummaryRow[]>([]);
  const [driverId, setDriverId] = useState<string>('');
  const [startsAt, setStartsAt] = useState<string>('');
  const [assignNotes, setAssignNotes] = useState<string>('');

  useEffect(() => {
    let cancelled = false;
    async function run() {
      if (!vehicleId) {
        setLoading(false);
        setError('Identifiant manquant dans l’URL.');
        setData(null);
        return;
      }
      if (!isUuidString(vehicleId)) {
        setLoading(false);
        setError('Identifiant véhicule invalide (attendu : UUID).');
        setData(null);
        return;
      }
      setLoading(true);
      setError(null);
      const res = await getFleetVehicle(vehicleId);
      if (cancelled) return;
      if (res.error) {
        setError(res.error.message);
        setData(null);
      } else {
        const normalized = normalizeFleetVehicleDetailResponse(res.data);
        if (!normalized?.vehicle?.id) {
          setError('Réponse API invalide (vehicle manquant).');
          setData(null);
        } else {
          setData(normalized);
        }
      }
      setLoading(false);
    }
    void run();
    return () => {
      cancelled = true;
    };
  }, [vehicleId, refreshSeq]);

  useEffect(() => {
    if (!editOpen && !entryOpen && !assignOpen && !detailOpen) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      if (!editSubmitting && editOpen) setEditOpen(false);
      if (!entrySubmitting && entryOpen) setEntryOpen(false);
      if (!assignSubmitting && assignOpen) setAssignOpen(false);
      if (!detailSubmitting && detailOpen) setDetailOpen(false);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [editOpen, entryOpen, assignOpen, detailOpen, editSubmitting, entrySubmitting, assignSubmitting, detailSubmitting]);

  function openEdit() {
    if (!data) return;
    setEditError(null);
    setEditForm({
      plate_number: data.vehicle.plate_number ?? '',
      brand: data.vehicle.brand ?? '',
      model: data.vehicle.model ?? '',
      status: (data.vehicle.status as FleetVehicleStatus) ?? 'active',
      purchase_price_ariary: data.vehicle.purchase_price_ariary,
      purchase_date: data.vehicle.purchase_date,
      amortization_months: data.vehicle.amortization_months,
      target_resale_price_ariary: data.vehicle.target_resale_price_ariary,
      daily_rent_ariary: data.vehicle.daily_rent_ariary,
      notes: data.vehicle.notes ?? '',
      fuel_ref_litres: data.vehicle.fuel_ref_litres ?? null,
      fuel_ref_km: data.vehicle.fuel_ref_km ?? null,
    });
    setEditFuelRefLitresText(
      typeof data.vehicle.fuel_ref_litres === 'number' && Number.isFinite(data.vehicle.fuel_ref_litres)
        ? String(data.vehicle.fuel_ref_litres)
        : ''
    );
    setEditFuelRefKmText(
      typeof data.vehicle.fuel_ref_km === 'number' && Number.isFinite(data.vehicle.fuel_ref_km)
        ? formatIntFr(data.vehicle.fuel_ref_km)
        : ''
    );
    setEditOpen(true);
  }

  async function submitEdit(e: FormEvent) {
    e.preventDefault();
    if (!data || !editForm) return;
    setEditError(null);

    const litresDigits = editFuelRefLitresText.trim();
    const kmDigits = digitsOnly(editFuelRefKmText);

    const prevLitres =
      typeof data.vehicle.fuel_ref_litres === 'number' && Number.isFinite(data.vehicle.fuel_ref_litres)
        ? data.vehicle.fuel_ref_litres
        : null;
    const prevKm =
      typeof data.vehicle.fuel_ref_km === 'number' && Number.isFinite(data.vehicle.fuel_ref_km)
        ? data.vehicle.fuel_ref_km
        : null;

    const hasLitresInput = Boolean(litresDigits);
    const hasKmInput = Boolean(kmDigits);

    if (hasLitresInput !== hasKmInput) {
      setEditError('Renseignez les deux références carburant (litres et km), ou laissez les deux vides.');
      return;
    }

    let nextFuelRefLitres: number | null = null;
    let nextFuelRefKm: number | null = null;

    if (hasLitresInput && hasKmInput) {
      const litres = parseFloatOrNull(litresDigits);
      if (litres == null || !Number.isFinite(litres) || litres <= 0) {
        setEditError('Litres de référence invalides (nombre > 0).');
        return;
      }
      const km = Number.parseInt(kmDigits, 10);
      if (!Number.isInteger(km) || km <= 0) {
        setEditError('Km de référence invalides (entier > 0).');
        return;
      }
      nextFuelRefLitres = litres;
      nextFuelRefKm = km;
    }

    const litresChanged =
      (prevLitres == null) !== (nextFuelRefLitres == null) ||
      (prevLitres != null &&
        nextFuelRefLitres != null &&
        Math.abs(prevLitres - nextFuelRefLitres) > 1e-6);
    const kmChanged =
      (prevKm == null) !== (nextFuelRefKm == null) ||
      (prevKm != null && nextFuelRefKm != null && prevKm !== nextFuelRefKm);

    const patch: Parameters<typeof patchFleetVehicle>[1] = {
      plate_number: editForm.plate_number,
      brand: asNonEmpty(editForm.brand) ?? null,
      model: asNonEmpty(editForm.model) ?? null,
      status: (editForm.status as FleetVehicleStatus) ?? 'active',
      purchase_price_ariary: editForm.purchase_price_ariary ?? null,
      purchase_date: editForm.purchase_date ?? null,
      amortization_months: editForm.amortization_months ?? null,
      target_resale_price_ariary: editForm.target_resale_price_ariary ?? null,
      daily_rent_ariary: editForm.daily_rent_ariary ?? null,
      notes: asNonEmpty(editForm.notes) ?? null,
    };

    if (litresChanged || kmChanged) {
      patch.fuel_ref_litres = nextFuelRefLitres;
      patch.fuel_ref_km = nextFuelRefKm;
    }

    setEditSubmitting(true);
    const res = await patchFleetVehicle(data.vehicle.id, patch);
    setEditSubmitting(false);
    if (res.error) {
      setEditError(res.error.message);
      return;
    }
    setEditOpen(false);
    setRefreshSeq((s) => s + 1);
  }

  function openEntry() {
    setEntryError(null);
    setEntryPaymentPostError(null);
    setEntryAmountText('');
    setEntryOdometerText('');
    setFuelKmStartText('');
    setFuelKmEndText('');
    setFuelPriceText('');
    setFuelConsumptionText('');
    setEntryImmediatePaymentAmountText('');
    setEntryImmediatePaymentNotes('');
    setFuelRechargeLitresText('');
    setFuelRechargeKmCreditedText('');
    setFuelRechargeOdometerText('');
    // Prefill fuel km start from last known (if any).
    const lastKm =
      data?.recent_entries?.find((e) => typeof e.fuel_km_end === 'number' && Number.isFinite(e.fuel_km_end))
        ?.fuel_km_end ??
      data?.recent_entries?.find((e) => typeof e.odometer_km === 'number' && Number.isFinite(e.odometer_km))
        ?.odometer_km ??
      null;
    if (lastKm != null) {
      setFuelKmStartText(formatIntFr(lastKm));
    }
    setEntryForm({
      entry_type: 'expense',
      amount_ariary: 0,
      odometer_km: null,
      entry_date: businessDate,
      category: 'autre',
      label: '',
      notes: '',
    });
    setEntryOpen(true);
  }

  const isFuelEntry = entryForm.category === 'carburant';
  const isFuelIncome = isFuelEntry && entryForm.entry_type === 'income';
  const isFuelRecharge = isFuelEntry && entryForm.entry_type === 'expense';

  const fuelInlineError = useMemo(() => {
    if (!isFuelIncome) return null;
    return computeFuelDerived({
      kmStartText: fuelKmStartText,
      kmEndText: fuelKmEndText,
      priceText: fuelPriceText,
      consumptionText: fuelConsumptionText,
    }).error;
  }, [isFuelIncome, fuelKmStartText, fuelKmEndText, fuelPriceText, fuelConsumptionText]);

  const fuelKmDay = useMemo(() => {
    if (!isFuelIncome) return null;
    return computeFuelDerived({
      kmStartText: fuelKmStartText,
      kmEndText: fuelKmEndText,
      priceText: fuelPriceText,
      consumptionText: fuelConsumptionText,
    }).kmDay;
  }, [isFuelIncome, fuelKmStartText, fuelKmEndText, fuelPriceText, fuelConsumptionText]);

  const fuelDueAriary = useMemo(() => {
    if (!isFuelIncome) return null;
    return computeFuelDerived({
      kmStartText: fuelKmStartText,
      kmEndText: fuelKmEndText,
      priceText: fuelPriceText,
      consumptionText: fuelConsumptionText,
    }).dueAriary;
  }, [isFuelIncome, fuelKmStartText, fuelKmEndText, fuelPriceText, fuelConsumptionText]);

  const fuelCanSubmit = useMemo(() => {
    if (!isFuelEntry) return true;
    if (isFuelIncome) return fuelDueAriary != null && !fuelInlineError;
    if (isFuelRecharge) {
      const litres = parseFloatOrNull(fuelRechargeLitresText);
      const kmCred = parseFloatOrNull(fuelRechargeKmCreditedText);
      const amount = Number.parseInt(digitsOnly(entryAmountText), 10) || 0;
      const priceDigits = digitsOnly(fuelPriceText);
      const price = priceDigits ? Number.parseInt(priceDigits, 10) : null;
      const conso = parseFloatOrNull(fuelConsumptionText);
      const odoDigits = digitsOnly(fuelRechargeOdometerText);
      const odo = odoDigits ? Number.parseInt(odoDigits, 10) : null;
      if (litres == null || !Number.isFinite(litres) || litres <= 0) return false;
      if (kmCred == null || !Number.isFinite(kmCred) || kmCred <= 0) return false;
      if (!Number.isInteger(amount) || amount <= 0) return false;
      if (price == null || !Number.isInteger(price) || price <= 0) return false;
      if (conso == null || !Number.isFinite(conso) || conso <= 0) return false;
      if (odo == null || !Number.isInteger(odo) || odo < 0) return false;
      return true;
    }
    return true;
  }, [
    isFuelEntry,
    isFuelIncome,
    isFuelRecharge,
    fuelDueAriary,
    fuelInlineError,
    fuelRechargeLitresText,
    fuelRechargeKmCreditedText,
    fuelRechargeOdometerText,
    entryAmountText,
    fuelPriceText,
    fuelConsumptionText,
  ]);

  /** Projection locale (brouillon) du stock théorique dans la modale carburant + income — sans appel API. */
  const addEntryIncomeFuelStockPreview = useMemo(() => {
    if (!entryOpen || !isFuelIncome) return null;
    const fs = data?.fuel_summary ?? null;
    if (!fs) {
      return {
        hasSummary: false as const,
        hasRecharge: false,
        pctGauge: 0,
        autonomy: null as FleetFuelSummaryRow['autonomy_status'] | null,
        kmRemaining: null as number | null,
        litresRemaining: null as number | null,
        avg: null as number | null,
        isNegative: false,
        isProjected: false,
        litresProjectedActive: false,
        kmDayDraft: null as number | null,
        litresConsumedDraft: null as number | null,
      };
    }
    const consumption = parseFloatOrNull(fuelConsumptionText);
    const kmBase = fuelSummaryKmRemainingBase(fs);
    const litresBase = fuelSummaryLitresRemainingBase(fs);
    const totalRechargeKm =
      typeof fs.total_recharge_km_credited === 'number' && Number.isFinite(fs.total_recharge_km_credited)
        ? fs.total_recharge_km_credited
        : 0;

    const draftKmDayOk =
      fuelInlineError == null &&
      fuelKmDay != null &&
      Number.isFinite(fuelKmDay) &&
      fuelKmDay > 0 &&
      consumption != null &&
      Number.isFinite(consumption) &&
      consumption > 0 &&
      kmBase != null;

    const kmDayDraft = draftKmDayOk ? fuelKmDay! : null;
    const litresConsumedDraft =
      draftKmDayOk && kmDayDraft != null && consumption != null ? kmDayDraft * consumption : null;
    const kmProj = draftKmDayOk && kmBase != null && kmDayDraft != null ? kmBase - kmDayDraft : null;
    const litresProj =
      draftKmDayOk && litresBase != null && litresConsumedDraft != null ? litresBase - litresConsumedDraft : null;

    const useProjection = kmProj != null;

    let pctGauge: number;
    if (useProjection && totalRechargeKm > 0) {
      pctGauge = Math.min(100, Math.max(0, (kmProj / totalRechargeKm) * 100));
    } else {
      const p0 =
        typeof fs.percent_remaining === 'number' && Number.isFinite(fs.percent_remaining)
          ? fs.percent_remaining
          : 0;
      pctGauge = Math.min(100, Math.max(0, p0));
    }

    const kmRemaining = useProjection ? kmProj! : kmBase;
    const litresRemaining = useProjection && litresProj != null ? litresProj : litresBase;

    const autonomy = useProjection
      ? fuelAutonomyStatusProjected(kmProj!, fs.avg_km_per_day_7d)
      : fs.autonomy_status;

    const avg =
      typeof fs.avg_km_per_day_7d === 'number' && Number.isFinite(fs.avg_km_per_day_7d) ? fs.avg_km_per_day_7d : null;
    const isNegative =
      (typeof kmRemaining === 'number' && kmRemaining < 0) ||
      (typeof litresRemaining === 'number' && litresRemaining < 0);

    return {
      hasSummary: true as const,
      hasRecharge: totalRechargeKm > 0,
      pctGauge,
      autonomy,
      kmRemaining,
      litresRemaining,
      avg,
      isNegative,
      isProjected: useProjection,
      litresProjectedActive: litresProj != null,
      kmDayDraft,
      litresConsumedDraft,
    };
  }, [
    entryOpen,
    isFuelIncome,
    data?.fuel_summary,
    fuelInlineError,
    fuelKmDay,
    fuelConsumptionText,
  ]);

  async function submitEntry(e: FormEvent) {
    e.preventDefault();
    if (!data) return;
    setEntryError(null);

    if (isFuelIncome) {
      const startDigits = digitsOnly(fuelKmStartText);
      const endDigits = digitsOnly(fuelKmEndText);
      const start = startDigits ? Number.parseInt(startDigits, 10) : null;
      const end = endDigits ? Number.parseInt(endDigits, 10) : null;
      if (start == null || !Number.isInteger(start) || start < 0) {
        setEntryError('Km départ invalide (entier >= 0).');
        return;
      }
      if (end == null || !Number.isInteger(end) || end < 0) {
        setEntryError('Km retour invalide (entier >= 0).');
        return;
      }
      if (end < start) {
        setEntryError('Km retour doit être ≥ km départ.');
        return;
      }
      const kmDay = end - start;
      if (kmDay <= 0) {
        setEntryError('Km du jour doit être > 0.');
        return;
      }
      const priceDigits = digitsOnly(fuelPriceText);
      const price = priceDigits ? Number.parseInt(priceDigits, 10) : null;
      if (price == null || !Number.isInteger(price) || price <= 0) {
        setEntryError('Prix litre invalide (entier > 0).');
        return;
      }
      const conso = parseFloatOrNull(fuelConsumptionText);
      if (conso == null || !Number.isFinite(conso) || conso <= 0) {
        setEntryError('Consommation invalide (nombre > 0).');
        return;
      }
      const rawDue = kmDay * conso * price;
      const due = Number.isFinite(rawDue) ? Math.round(rawDue) : 0;
      if (!Number.isInteger(due) || due <= 0) {
        setEntryError('Carburant dû invalide.');
        return;
      }

      const paymentDigits = digitsOnly(entryImmediatePaymentAmountText);
      const paymentAmount = paymentDigits ? Number.parseInt(paymentDigits, 10) : null;
      const shouldCreatePayment = !!paymentDigits;
      if (shouldCreatePayment) {
        if (paymentAmount == null || !Number.isInteger(paymentAmount) || paymentAmount <= 0) {
          setEntryError('Paiement reçu invalide (entier > 0).');
          return;
        }
        if (paymentAmount > due) {
          setEntryError('Paiement reçu ne peut pas dépasser le montant dû.');
          return;
        }
      }

      setEntrySubmitting(true);
      const res = await createFleetVehicleEntry(data.vehicle.id, {
        entry_type: entryForm.entry_type,
        amount_ariary: due,
        odometer_km: null,
        entry_date: entryForm.entry_date,
        category: 'carburant',
        fuel_mode: 'structured',
        label: 'Carburant',
        notes: entryForm.notes?.trim() ? entryForm.notes.trim() : null,

        fuel_km_start: start,
        fuel_km_end: end,
        fuel_km_travelled: kmDay,
        fuel_price_per_litre_ariary_used: price,
        fuel_consumption_l_per_km_used: conso,
        fuel_due_ariary: due,
      });
      if (res.error) {
        setEntrySubmitting(false);
        setEntryError(res.error.message);
        return;
      }
      const entryId = res.data?.entry_id ?? null;
      if (shouldCreatePayment && paymentAmount != null && entryId) {
        const payRes = await createFleetVehicleEntryPayment(data.vehicle.id, entryId, {
          amount_ariary: paymentAmount,
          paid_at: entryForm.entry_date,
          notes: entryImmediatePaymentNotes.trim() ? entryImmediatePaymentNotes.trim() : null,
        });
        if (payRes.error) {
          setEntryPaymentPostError(
            'Paiement non enregistré. L’écriture a bien été créée — vous pouvez compléter via le détail.'
          );
        }
      }
      setEntrySubmitting(false);
      setEntryOpen(false);
      setRefreshSeq((s) => s + 1);
      return;
    }

    if (isFuelRecharge) {
      const litres = parseFloatOrNull(fuelRechargeLitresText);
      if (litres == null || !Number.isFinite(litres) || litres <= 0) {
        setEntryError('Litres ajoutés invalide (nombre > 0).');
        return;
      }
      const kmCredited = parseFloatOrNull(fuelRechargeKmCreditedText);
      if (kmCredited == null || !Number.isFinite(kmCredited) || kmCredited <= 0) {
        setEntryError('Km crédités invalide (nombre > 0).');
        return;
      }
      const priceDigits = digitsOnly(fuelPriceText);
      const price = priceDigits ? Number.parseInt(priceDigits, 10) : null;
      if (price == null || !Number.isInteger(price) || price <= 0) {
        setEntryError('Prix litre invalide (entier > 0).');
        return;
      }
      const conso = parseFloatOrNull(fuelConsumptionText);
      if (conso == null || !Number.isFinite(conso) || conso <= 0) {
        setEntryError('Consommation invalide (nombre > 0).');
        return;
      }
      const odoDigits = digitsOnly(fuelRechargeOdometerText);
      const odometerKm = odoDigits ? Number.parseInt(odoDigits, 10) : null;
      if (odometerKm == null || !Number.isInteger(odometerKm) || odometerKm < 0) {
        setEntryError('Relevé kilométrique invalide (entier ≥ 0).');
        return;
      }
      const amount = Number.parseInt(digitsOnly(entryAmountText || String(entryForm.amount_ariary || '')), 10) || 0;
      if (!Number.isInteger(amount) || amount <= 0) {
        setEntryError('Montant invalide (entier > 0).');
        return;
      }

      setEntrySubmitting(true);
      const res = await createFleetVehicleEntry(data.vehicle.id, {
        entry_type: 'expense',
        amount_ariary: amount,
        odometer_km: odometerKm,
        entry_date: entryForm.entry_date,
        category: 'carburant',
        fuel_mode: 'structured',
        label: 'Recharge carburant',
        notes: entryForm.notes?.trim() ? entryForm.notes.trim() : null,

        fuel_recharge_litres_used: litres,
        fuel_recharge_km_credited_used: kmCredited,
        fuel_price_per_litre_ariary_used: price,
        fuel_consumption_l_per_km_used: conso,
      });
      setEntrySubmitting(false);
      if (res.error) {
        setEntryError(res.error.message);
        return;
      }
      setEntryOpen(false);
      setRefreshSeq((s) => s + 1);
      return;
    }

    const amount = Number.parseInt(digitsOnly(entryAmountText || String(entryForm.amount_ariary || '')), 10) || 0;
    if (!Number.isInteger(amount) || amount <= 0) {
      setEntryError('Montant invalide (entier > 0).');
      return;
    }
    const odometerDigits = digitsOnly(entryOdometerText);
    const odometerKm = odometerDigits ? Number.parseInt(odometerDigits, 10) : null;
    if (odometerKm != null && (!Number.isInteger(odometerKm) || odometerKm < 0)) {
      setEntryError('Kilométrage invalide (entier >= 0).');
      return;
    }
    if (!entryForm.category.trim() || !entryForm.label.trim()) {
      setEntryError('Catégorie et libellé sont obligatoires.');
      return;
    }
    setEntrySubmitting(true);
    const res = await createFleetVehicleEntry(data.vehicle.id, {
      entry_type: entryForm.entry_type,
      amount_ariary: amount,
      entry_date: entryForm.entry_date,
      category: entryForm.category.trim(),
      label: entryForm.label.trim(),
      odometer_km: odometerKm,
      notes: entryForm.notes?.trim() ? entryForm.notes.trim() : null,
    });
    setEntrySubmitting(false);
    if (res.error) {
      setEntryError(res.error.message);
      return;
    }
    setEntryOpen(false);
    setRefreshSeq((s) => s + 1);
  }

  async function openAssign() {
    setAssignError(null);
    setDriverId('');
    setStartsAt('');
    setAssignNotes('');
    setAssignOpen(true);

    setDriversLoading(true);
    const res = await getDriversDailySummary(businessDate, 'active');
    setDriversLoading(false);
    if (res.error) {
      setDrivers([]);
      setAssignError(`Impossible de charger les chauffeurs: ${res.error.message}`);
      return;
    }
    setDrivers(res.data);
  }

  async function submitAssign(e: FormEvent) {
    e.preventDefault();
    if (!data) return;
    setAssignError(null);
    const did = driverId.trim();
    if (!isUuidString(did)) {
      setAssignError('Chauffeur invalide (UUID attendu).');
      return;
    }
    const startsIso = startsAt.trim() ? new Date(startsAt.trim()).toISOString() : null;
    if (startsAt.trim() && !startsIso) {
      setAssignError('starts_at invalide.');
      return;
    }
    setAssignSubmitting(true);
    const res = await setFleetVehicleAssignment(data.vehicle.id, {
      driver_id: did,
      starts_at: startsIso,
      notes: assignNotes.trim() ? assignNotes.trim() : null,
    });
    setAssignSubmitting(false);
    if (res.error) {
      setAssignError(res.error.message);
      return;
    }
    setAssignOpen(false);
    setRefreshSeq((s) => s + 1);
  }

  const summary: FleetFinancialSummary | null = data?.financial_summary ?? null;
  const assignmentHistory = data?.assignment_history ?? [];
  const recentEntries = data?.recent_entries ?? [];
  const activeAssignment = data?.active_assignment ?? null;

  function openEntryDetail(e: FleetEntryRow) {
    setSelectedEntry(e);
    setDetailError(null);
    setDetailMode('read');
    setEntryEditForm(null);
    setEditAmountText('');
    setEditOdometerText('');
    setEditFuelKmStartText('');
    setEditFuelKmEndText('');
    setEditFuelPriceText('');
    setEditFuelConsumptionText('');
    setEditFuelRechargeLitresText('');
    setEditFuelRechargeKmCreditedText('');
    setPayments([]);
    setPaymentsError(null);
    setPaymentsLoading(false);
    setPaymentAmountText('');
    setPaymentDate('');
    setPaymentNotes('');
    setDetailOpen(true);
  }

  function beginEditEntry() {
    if (!selectedEntry) return;
    setDetailError(null);
    setDetailMode('edit');

    const isFuel = selectedEntry.category?.trim().toLowerCase() === 'carburant';
    const isFuelExpense = isFuel && selectedEntry.entry_type === 'expense';
    setEntryEditForm({
      entry_type: selectedEntry.entry_type,
      entry_date: selectedEntry.entry_date,
      category: selectedEntry.category,
      label: selectedEntry.label,
      notes: selectedEntry.notes ?? null,
      ...(isFuel && !isFuelExpense
        ? {
            fuel_km_start: selectedEntry.fuel_km_start ?? 0,
            fuel_km_end: selectedEntry.fuel_km_end ?? 0,
            fuel_price_per_litre_ariary_used: selectedEntry.fuel_price_per_litre_ariary_used ?? 0,
            fuel_consumption_l_per_km_used: selectedEntry.fuel_consumption_l_per_km_used ?? 0,
          }
        : isFuelExpense
          ? {
              amount_ariary: selectedEntry.amount_ariary,
              fuel_recharge_litres_used: selectedEntry.fuel_recharge_litres_used ?? 0,
              fuel_recharge_km_credited_used: selectedEntry.fuel_recharge_km_credited_used ?? 0,
            }
        : {
            amount_ariary: selectedEntry.amount_ariary,
            odometer_km: selectedEntry.odometer_km ?? null,
          }),
    });

    if (!isFuel) {
      setEditAmountText(formatIntFr(selectedEntry.amount_ariary));
      setEditOdometerText(
        selectedEntry.odometer_km == null ? '' : formatIntFr(selectedEntry.odometer_km)
      );
    } else if (!isFuelExpense) {
      setEditFuelKmStartText(
        selectedEntry.fuel_km_start == null ? '' : formatIntFr(selectedEntry.fuel_km_start)
      );
      setEditFuelKmEndText(
        selectedEntry.fuel_km_end == null ? '' : formatIntFr(selectedEntry.fuel_km_end)
      );
      setEditFuelPriceText(
        selectedEntry.fuel_price_per_litre_ariary_used == null
          ? ''
          : formatIntFr(selectedEntry.fuel_price_per_litre_ariary_used)
      );
      setEditFuelConsumptionText(
        selectedEntry.fuel_consumption_l_per_km_used == null
          ? ''
          : String(selectedEntry.fuel_consumption_l_per_km_used)
      );
    } else {
      setEditAmountText(formatIntFr(selectedEntry.amount_ariary));
      setEditOdometerText(
        selectedEntry.odometer_km == null ? '' : formatIntFr(selectedEntry.odometer_km)
      );
      setEditFuelPriceText(
        selectedEntry.fuel_price_per_litre_ariary_used == null
          ? '10 000'
          : formatIntFr(selectedEntry.fuel_price_per_litre_ariary_used)
      );
      setEditFuelConsumptionText(
        selectedEntry.fuel_consumption_l_per_km_used == null
          ? '0.05'
          : String(selectedEntry.fuel_consumption_l_per_km_used)
      );
      setEditFuelRechargeLitresText(
        selectedEntry.fuel_recharge_litres_used == null ? '' : String(selectedEntry.fuel_recharge_litres_used)
      );
      setEditFuelRechargeKmCreditedText(
        selectedEntry.fuel_recharge_km_credited_used == null ? '' : String(selectedEntry.fuel_recharge_km_credited_used)
      );
    }
  }

  const editIsFuel = selectedEntry?.category?.trim().toLowerCase() === 'carburant';
  const editIsFuelStructured = editIsFuel && (selectedEntry?.fuel_mode ?? 'structured') !== 'legacy';
  const editIsFuelRecharge =
    editIsFuelStructured && ((entryEditForm?.entry_type ?? selectedEntry?.entry_type) === 'expense');
  const editIsFuelIncome =
    editIsFuelStructured && ((entryEditForm?.entry_type ?? selectedEntry?.entry_type) === 'income');

  const isFuelIncomeDebt =
    selectedEntry?.category?.trim().toLowerCase() === 'carburant' && selectedEntry?.entry_type === 'income';

  useEffect(() => {
    let cancelled = false;
    async function run() {
      if (!detailOpen || detailMode !== 'read' || !data || !selectedEntry) return;
      if (!isFuelIncomeDebt) return;
      setPaymentsLoading(true);
      setPaymentsError(null);
      const res = await listFleetVehicleEntryPayments(data.vehicle.id, selectedEntry.id);
      if (cancelled) return;
      setPaymentsLoading(false);
      if (res.error) {
        setPaymentsError(res.error.message);
        setPayments([]);
        return;
      }
      setPayments(res.data.items ?? []);

      const due = selectedEntry.amount_ariary;
      const paid = typeof selectedEntry.total_paid_ariary === 'number' ? selectedEntry.total_paid_ariary : 0;
      const remaining = Math.max(0, due - paid);
      // Prefill amount only when there is an actual remaining balance.
      if (!paymentAmountText.trim() && remaining > 0) {
        setPaymentAmountText(String(remaining));
      }
      if (!paymentDate) {
        setPaymentDate(selectedEntry.entry_date);
      }
    }
    void run();
    return () => {
      cancelled = true;
    };
  }, [detailOpen, detailMode, data, selectedEntry, isFuelIncomeDebt]);

  // Après re-fetch véhicule (`refreshSeq`), réaligner l’écriture ouverte avec l’entrée enrichie serveur
  // (total payé, reste, statut) — évite état stale sur la carte « Paiement chauffeur » et la validation du 2e paiement.
  useEffect(() => {
    if (!detailOpen || detailMode !== 'read' || !selectedEntry?.id || !data?.recent_entries?.length) return;
    const fresh = data.recent_entries.find((e) => e.id === selectedEntry.id);
    if (!fresh) return;
    setSelectedEntry((prev) => (prev && prev.id === fresh.id ? fresh : prev));
  }, [data, detailOpen, detailMode, selectedEntry?.id]);

  async function submitNewPayment(e: FormEvent) {
    e.preventDefault();
    if (!data || !selectedEntry) return;
    if (!isFuelIncomeDebt) return;
    setPaymentsError(null);

    const due = selectedEntry.amount_ariary;
    const paid = typeof selectedEntry.total_paid_ariary === 'number' ? selectedEntry.total_paid_ariary : 0;
    const remaining = due - paid;
    if (!Number.isFinite(remaining) || remaining <= 0 || selectedEntry.payment_status === 'paid') {
      setPaymentsError('Dette soldée.');
      return;
    }

    const amount = Number.parseInt(digitsOnly(paymentAmountText), 10);
    if (!Number.isInteger(amount) || amount <= 0) {
      setPaymentsError('Montant payé invalide (entier > 0).');
      return;
    }

    const paidAt = paymentDate.trim() ? paymentDate.trim() : null;
    const res = await createFleetVehicleEntryPayment(data.vehicle.id, selectedEntry.id, {
      amount_ariary: amount,
      paid_at: paidAt,
      notes: paymentNotes.trim() ? paymentNotes.trim() : null,
    });
    if (res.error) {
      setPaymentsError(res.error.message);
      return;
    }

    // Refresh everything: payments history + computed status/remaining on entry list.
    const listRes = await listFleetVehicleEntryPayments(data.vehicle.id, selectedEntry.id);
    if (listRes.error) {
      setPaymentsError(listRes.error.message);
      return;
    }
    const paymentItems = listRes.data.items ?? [];
    setPayments(paymentItems);
    const paidSum = sumFleetEntryPaymentAmounts(paymentItems);
    const dueAriary = selectedEntry.amount_ariary;
    const summary = fuelIncomeDriverPaymentSummary(dueAriary, paidSum);
    const entryId = selectedEntry.id;
    setSelectedEntry((prev) =>
      prev && prev.id === entryId ? { ...prev, ...summary } : prev
    );
    const nextRemaining = summary.remaining_amount_ariary;
    setPaymentAmountText(nextRemaining > 0 ? String(nextRemaining) : '');
    setRefreshSeq((s) => s + 1);
  }

  const editFuelKmDay = useMemo(() => {
    if (!detailOpen || detailMode !== 'edit' || !editIsFuelIncome) return null;
    return computeFuelDerived({
      kmStartText: editFuelKmStartText,
      kmEndText: editFuelKmEndText,
      priceText: editFuelPriceText,
      consumptionText: editFuelConsumptionText,
    }).kmDay;
  }, [
    detailOpen,
    detailMode,
    editIsFuelIncome,
    editFuelKmStartText,
    editFuelKmEndText,
    editFuelPriceText,
    editFuelConsumptionText,
  ]);

  const editFuelDueAriary = useMemo(() => {
    if (!detailOpen || detailMode !== 'edit' || !editIsFuelIncome) return null;
    return computeFuelDerived({
      kmStartText: editFuelKmStartText,
      kmEndText: editFuelKmEndText,
      priceText: editFuelPriceText,
      consumptionText: editFuelConsumptionText,
    }).dueAriary;
  }, [detailOpen, detailMode, editIsFuelIncome, editFuelKmStartText, editFuelKmEndText, editFuelPriceText, editFuelConsumptionText]);

  const editFuelInlineError = useMemo(() => {
    if (!detailOpen || detailMode !== 'edit' || !editIsFuelIncome) return null;
    return computeFuelDerived({
      kmStartText: editFuelKmStartText,
      kmEndText: editFuelKmEndText,
      priceText: editFuelPriceText,
      consumptionText: editFuelConsumptionText,
    }).error;
  }, [detailOpen, detailMode, editIsFuelIncome, editFuelKmStartText, editFuelKmEndText, editFuelPriceText, editFuelConsumptionText]);

  async function submitEditEntry(e: FormEvent) {
    e.preventDefault();
    if (!data || !selectedEntry || !entryEditForm) return;
    setDetailError(null);

    const patch: FleetEntryPatchInput = {
      entry_type: entryEditForm.entry_type,
      entry_date: entryEditForm.entry_date,
      category: (entryEditForm.category ?? selectedEntry.category).trim(),
      fuel_mode: entryEditForm.fuel_mode ?? selectedEntry.fuel_mode ?? null,
      label: entryEditForm.label ?? selectedEntry.label,
      notes: entryEditForm.notes ?? null,
    };

    if (editIsFuelIncome) {
      const startDigits = digitsOnly(editFuelKmStartText);
      const endDigits = digitsOnly(editFuelKmEndText);
      const start = startDigits ? Number.parseInt(startDigits, 10) : null;
      const end = endDigits ? Number.parseInt(endDigits, 10) : null;
      if (start == null || start < 0) return setDetailError('Km départ invalide (entier >= 0).');
      if (end == null || end < 0) return setDetailError('Km retour invalide (entier >= 0).');
      if (end < start) return setDetailError('Km retour doit être ≥ km départ.');
      const priceDigits = digitsOnly(editFuelPriceText);
      const price = priceDigits ? Number.parseInt(priceDigits, 10) : null;
      if (price == null || price <= 0) return setDetailError('Prix litre invalide (entier > 0).');
      const conso = parseFloatOrNull(editFuelConsumptionText);
      if (conso == null || conso <= 0) return setDetailError('Consommation invalide (nombre > 0).');
      if (editFuelDueAriary == null || editFuelKmDay == null) {
        return setDetailError('Calcul carburant incomplet.');
      }
      patch.fuel_km_start = start;
      patch.fuel_km_end = end;
      patch.fuel_price_per_litre_ariary_used = price;
      patch.fuel_consumption_l_per_km_used = conso;
    } else if (editIsFuelRecharge) {
      const litres = parseFloatOrNull(editFuelRechargeLitresText);
      if (litres == null || litres <= 0) return setDetailError('Litres ajoutés invalide (nombre > 0).');
      const kmCredited = parseFloatOrNull(editFuelRechargeKmCreditedText);
      if (kmCredited == null || kmCredited <= 0) return setDetailError('Km crédités invalide (nombre > 0).');
      const amount = Number.parseInt(digitsOnly(editAmountText), 10) || 0;
      if (!Number.isInteger(amount) || amount <= 0) return setDetailError('Montant invalide (entier > 0).');
      const odoDigits = digitsOnly(editOdometerText);
      const odo = odoDigits ? Number.parseInt(odoDigits, 10) : null;
      if (odo == null || !Number.isInteger(odo) || odo < 0) {
        return setDetailError('Relevé kilométrique invalide (entier ≥ 0).');
      }
      const priceDigits = digitsOnly(editFuelPriceText);
      const price = priceDigits ? Number.parseInt(priceDigits, 10) : null;
      if (price == null || price <= 0) return setDetailError('Prix litre invalide (entier > 0).');
      const conso = parseFloatOrNull(editFuelConsumptionText);
      if (conso == null || conso <= 0) return setDetailError('Consommation invalide (nombre > 0).');
      patch.amount_ariary = amount;
      patch.fuel_recharge_litres_used = litres;
      patch.fuel_recharge_km_credited_used = kmCredited;
      patch.odometer_km = odo;
      patch.fuel_price_per_litre_ariary_used = price;
      patch.fuel_consumption_l_per_km_used = conso;
    } else {
      const amount = Number.parseInt(digitsOnly(editAmountText), 10) || 0;
      if (!Number.isInteger(amount) || amount <= 0) return setDetailError('Montant invalide (entier > 0).');
      const odoDigits = digitsOnly(editOdometerText);
      const odo = odoDigits ? Number.parseInt(odoDigits, 10) : null;
      if (odo != null && (!Number.isInteger(odo) || odo < 0)) return setDetailError('Kilométrage invalide (entier >= 0).');
      patch.amount_ariary = amount;
      patch.odometer_km = odo;
    }

    setDetailSubmitting(true);
    const res = await patchFleetVehicleEntry(data.vehicle.id, selectedEntry.id, patch);
    setDetailSubmitting(false);
    if (res.error) {
      setDetailError(res.error.message);
      return;
    }
    setDetailOpen(false);
    setRefreshSeq((s) => s + 1);
  }

  async function confirmAndSoftDeleteEntry() {
    if (!data || !selectedEntry) return;
    if (detailSubmitting) return;
    const ok = window.confirm('Supprimer cette écriture ? (suppression logique)');
    if (!ok) return;
    setDetailSubmitting(true);
    const res = await softDeleteFleetVehicleEntry(data.vehicle.id, selectedEntry.id);
    setDetailSubmitting(false);
    if (res.error) {
      setDetailError(res.error.message);
      return;
    }
    setDetailOpen(false);
    setRefreshSeq((s) => s + 1);
  }

  return (
    <RequireAuth>
      <AdminShell title="Fiche véhicule">
        <div className="mb-4 flex flex-wrap items-end justify-between gap-4">
          <div className="text-sm">
            <Link href="/fleet" className="text-zinc-600 underline hover:text-zinc-900">
              ← Retour Suivi du parc
            </Link>
          </div>
          <div className="flex flex-wrap gap-2">
            <button
              type="button"
              className="rounded-lg border border-zinc-200 bg-white px-3 py-2 text-sm hover:bg-zinc-100 disabled:opacity-50"
              disabled={loading}
              onClick={() => setRefreshSeq((s) => s + 1)}
            >
              {loading ? 'Chargement…' : 'Rafraîchir'}
            </button>
          </div>
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
          <div className="space-y-6">
            {entryPaymentPostError ? (
              <div className="rounded-lg border border-red-200 bg-red-50 p-4 text-sm text-red-900">
                {entryPaymentPostError}
              </div>
            ) : null}
            <section className="rounded-xl border border-zinc-200 bg-white p-4">
              <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
                <div>
                  <div className="text-xs text-zinc-600">Plaque</div>
                  <div className="mt-1 font-mono text-xl font-semibold">{data.vehicle.plate_number}</div>
                  <div className="mt-2 text-sm text-zinc-700">
                    {[data.vehicle.brand, data.vehicle.model].filter(Boolean).join(' ') || '—'}
                  </div>
                  <div className="mt-1 text-xs text-zinc-500">{data.vehicle.id}</div>
                </div>
                <div className="flex flex-wrap gap-2">
                  <button
                    type="button"
                    className="rounded-lg border border-zinc-200 bg-white px-3 py-2 text-sm hover:bg-zinc-100"
                    onClick={openEdit}
                  >
                    Éditer
                  </button>
                  <button
                    type="button"
                    className="rounded-lg border border-zinc-800 bg-zinc-900 px-3 py-2 text-sm font-medium text-white hover:bg-zinc-800"
                    onClick={openEntry}
                  >
                    Ajouter une écriture
                  </button>
                  <button
                    type="button"
                    className="rounded-lg border border-zinc-200 bg-white px-3 py-2 text-sm hover:bg-zinc-100"
                    onClick={() => void openAssign()}
                  >
                    Affecter / réaffecter
                  </button>
                </div>
              </div>

              <div className="mt-4 grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
                <div className="rounded-lg border border-zinc-200 p-3 text-sm">
                  <div className="text-xs text-zinc-600">Statut</div>
                  <div className="mt-1 font-medium">{data.vehicle.status}</div>
                </div>
                <div className="rounded-lg border border-zinc-200 p-3 text-sm">
                  <div className="text-xs text-zinc-600">Prix d’achat</div>
                  <div className="mt-1 font-semibold tabular-nums">{formatAriary(data.vehicle.purchase_price_ariary)} Ar</div>
                </div>
                <div className="rounded-lg border border-zinc-200 p-3 text-sm">
                  <div className="text-xs text-zinc-600">Loyer journalier</div>
                  <div className="mt-1 font-semibold tabular-nums">{formatAriary(data.vehicle.daily_rent_ariary)} Ar</div>
                </div>
                <div className="rounded-lg border border-zinc-200 p-3 text-sm">
                  <div className="text-xs text-zinc-600">Date d’achat</div>
                  <div className="mt-1 font-medium">{data.vehicle.purchase_date ?? '—'}</div>
                </div>
                <div className="rounded-lg border border-zinc-200 p-3 text-sm">
                  <div className="text-xs text-zinc-600">Amortissement (mois)</div>
                  <div className="mt-1 font-medium">{data.vehicle.amortization_months ?? '—'}</div>
                </div>
                <div className="rounded-lg border border-zinc-200 p-3 text-sm">
                  <div className="text-xs text-zinc-600">Revente cible</div>
                  <div className="mt-1 font-medium tabular-nums">{formatAriary(data.vehicle.target_resale_price_ariary)} Ar</div>
                </div>
                <div className="rounded-lg border border-zinc-200 p-3 text-sm sm:col-span-2 lg:col-span-3">
                  <div className="text-xs text-zinc-600">Notes</div>
                  <div className="mt-1 text-zinc-800">{data.vehicle.notes?.trim() ? data.vehicle.notes : '—'}</div>
                </div>
              </div>
            </section>

            {/* Résumé carburant (stock théorique) */}
            <section className="rounded-xl border border-zinc-200 bg-white p-4">
              <div className="flex items-start justify-between gap-3">
                <div>
                  <h2 className="text-sm font-semibold text-zinc-900">Résumé carburant</h2>
                  <div className="mt-1 text-xs text-zinc-600">
                    Stock théorique calculé à partir des écritures (recharges et consommations).
                  </div>
                </div>
                {data.fuel_summary?.autonomy_status ? (
                  <span
                    className={
                      'inline-flex items-center rounded-full border px-2 py-0.5 text-xs font-medium ' +
                      (data.fuel_summary.autonomy_status === 'confortable'
                        ? 'border-emerald-200 bg-emerald-50 text-emerald-900'
                        : data.fuel_summary.autonomy_status === 'limite'
                          ? 'border-amber-200 bg-amber-50 text-amber-900'
                          : 'border-red-200 bg-red-50 text-red-900')
                    }
                  >
                    {data.fuel_summary.autonomy_status === 'confortable'
                      ? 'autonomie confortable'
                      : data.fuel_summary.autonomy_status === 'limite'
                        ? 'autonomie limite'
                        : 'autonomie insuffisante'}
                  </span>
                ) : null}
              </div>

              <div className="mt-4 grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
                <div className="rounded-lg border border-zinc-200 p-3 text-sm">
                  <div className="text-xs text-zinc-600">Litres restants</div>
                  <div className="mt-1 font-semibold tabular-nums">
                    {data.fuel_summary?.litres_remaining == null
                      ? '—'
                      : `${formatNumberFr(data.fuel_summary.litres_remaining, { maxFrac: 2 })} L`}
                  </div>
                </div>
                <div className="rounded-lg border border-zinc-200 p-3 text-sm">
                  <div className="text-xs text-zinc-600">Km restants</div>
                  <div className="mt-1 font-semibold tabular-nums">
                    {data.fuel_summary ? `${formatNumberFr(data.fuel_summary.km_remaining)} km` : '—'}
                  </div>
                </div>
                <div className="rounded-lg border border-zinc-200 p-3 text-sm">
                  <div className="text-xs text-zinc-600">% restant</div>
                  <div className="mt-1 font-semibold tabular-nums">
                    {data.fuel_summary?.percent_remaining == null
                      ? '—'
                      : `${formatNumberFr(data.fuel_summary.percent_remaining, { maxFrac: 0 })} %`}
                  </div>
                </div>

                <div className="rounded-lg border border-zinc-200 p-3 text-sm">
                  <div className="text-xs text-zinc-600">Moyenne km/jour (7 jours)</div>
                  <div className="mt-1 font-medium tabular-nums">
                    {data.fuel_summary?.avg_km_per_day_7d == null
                      ? '—'
                      : `${formatNumberFr(data.fuel_summary.avg_km_per_day_7d, { maxFrac: 1 })} km/j`}
                  </div>
                </div>

                <div className="rounded-lg border border-zinc-200 p-3 text-sm">
                  <div className="text-xs text-zinc-600">Dernière recharge</div>
                  <div className="mt-1 font-medium">
                    {data.fuel_summary?.last_recharge
                      ? `${data.fuel_summary.last_recharge.entry_date} — ${formatNumberFr(
                          data.fuel_summary.last_recharge.litres_added,
                          { maxFrac: 2 }
                        )} L / ${formatNumberFr(data.fuel_summary.last_recharge.km_credited, { maxFrac: 0 })} km`
                      : '—'}
                  </div>
                  {data.fuel_summary?.last_recharge ? (
                    <div className="mt-0.5 text-xs text-zinc-600 tabular-nums">
                      {formatAriary(data.fuel_summary.last_recharge.cost_ariary)} Ar
                    </div>
                  ) : null}
                </div>

                <div className="rounded-lg border border-zinc-200 p-3 text-sm">
                  <div className="text-xs text-zinc-600">Dernier km retour connu</div>
                  <div className="mt-1 font-medium tabular-nums">
                    {data.fuel_summary?.last_km_end
                      ? `${formatNumberFr(data.fuel_summary.last_km_end.km_end)} km`
                      : '—'}
                  </div>
                  {data.fuel_summary?.last_km_end ? (
                    <div className="mt-0.5 text-xs text-zinc-600">
                      {data.fuel_summary.last_km_end.entry_date}
                    </div>
                  ) : null}
                </div>
              </div>
            </section>

            <section className="rounded-xl border border-zinc-200 bg-white p-4">
              <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
                <div>
                  <h2 className="text-sm font-semibold text-zinc-900">Affectation chauffeur</h2>
                  {activeAssignment ? (
                    <div className="mt-2 text-sm">
                      <div className="font-medium text-zinc-900">
                        {activeAssignment.driver_full_name ?? 'Chauffeur'}{' '}
                        <span className="ml-1 text-xs font-normal text-zinc-500">
                          {activeAssignment.driver_phone ?? '—'}
                        </span>
                      </div>
                      <div className="mt-1 text-xs text-zinc-600">
                        Depuis {new Date(activeAssignment.starts_at).toLocaleString('fr-FR')}
                      </div>
                      {activeAssignment.notes ? (
                        <div className="mt-1 text-xs text-zinc-600">Notes: {activeAssignment.notes}</div>
                      ) : null}
                    </div>
                  ) : (
                    <div className="mt-2 text-sm text-zinc-600">Aucune affectation active.</div>
                  )}
                </div>
                <button
                  type="button"
                  className="rounded-lg border border-zinc-200 bg-white px-3 py-2 text-sm hover:bg-zinc-100"
                  onClick={() => void openAssign()}
                >
                  Affecter / réaffecter
                </button>
              </div>

              {assignmentHistory.length ? (
                <div className="mt-4 overflow-x-auto">
                  <table className="min-w-full border-separate border-spacing-0 text-sm">
                    <thead>
                      <tr className="text-left text-xs text-zinc-600">
                        <th className="border-b border-zinc-200 px-2 py-2">Chauffeur</th>
                        <th className="border-b border-zinc-200 px-2 py-2">Début</th>
                        <th className="border-b border-zinc-200 px-2 py-2">Fin</th>
                        <th className="border-b border-zinc-200 px-2 py-2">Notes</th>
                      </tr>
                    </thead>
                    <tbody>
                      {assignmentHistory.slice(0, 10).map((a) => (
                        <tr key={a.id} className="hover:bg-zinc-50">
                          <td className="border-b border-zinc-100 px-2 py-2">
                            <div className="font-medium">{a.driver_full_name ?? 'Chauffeur'}</div>
                            <div className="text-xs text-zinc-500">{a.driver_phone ?? '—'}</div>
                          </td>
                          <td className="border-b border-zinc-100 px-2 py-2">
                            {new Date(a.starts_at).toLocaleString('fr-FR')}
                          </td>
                          <td className="border-b border-zinc-100 px-2 py-2">
                            {a.ends_at ? new Date(a.ends_at).toLocaleString('fr-FR') : '—'}
                          </td>
                          <td className="border-b border-zinc-100 px-2 py-2 text-zinc-700">{a.notes ?? '—'}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              ) : null}
            </section>

            <section className="rounded-xl border border-zinc-200 bg-white p-4">
              <h2 className="text-sm font-semibold text-zinc-900">Synthèse financière</h2>
              {summary ? (
                <div className="mt-3 grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-5">
                  {kpiCard('Total recettes', `${formatAriary(summary.total_income_ariary)} Ar`)}
                  {kpiCard('Total dépenses', `${formatAriary(summary.total_expense_ariary)} Ar`)}
                  {kpiCard('Net', `${formatAriary(summary.net_ariary)} Ar`)}
                  {kpiCard(
                    'Reste à amortir',
                    summary.remaining_to_amortize_ariary == null
                      ? '—'
                      : `${formatAriary(summary.remaining_to_amortize_ariary)} Ar`
                  )}
                  {kpiCard('% amorti', fmtPct(summary.amortized_percent))}
                </div>
              ) : (
                <div className="mt-2 text-sm text-zinc-600">—</div>
              )}
            </section>

            <section className="rounded-xl border border-zinc-200 bg-white p-4">
              <div className="flex items-center justify-between gap-3">
                <h2 className="text-sm font-semibold text-zinc-900">Journal des écritures</h2>
                <button
                  type="button"
                  className="rounded-lg border border-zinc-800 bg-zinc-900 px-3 py-2 text-sm font-medium text-white hover:bg-zinc-800"
                  onClick={openEntry}
                >
                  Ajouter une écriture
                </button>
              </div>

              <div className="mt-3 overflow-x-auto">
                <table className="min-w-full border-separate border-spacing-0 text-sm">
                  <thead>
                    <tr className="text-left text-xs text-zinc-600">
                      <th className="border-b border-zinc-200 px-2 py-2">Date</th>
                      <th className="border-b border-zinc-200 px-2 py-2">Type</th>
                      <th className="border-b border-zinc-200 px-2 py-2">Montant (Ar)</th>
                      <th className="border-b border-zinc-200 px-2 py-2">Km</th>
                      <th className="border-b border-zinc-200 px-2 py-2">Catégorie</th>
                      <th className="border-b border-zinc-200 px-2 py-2">Libellé</th>
                      <th className="border-b border-zinc-200 px-2 py-2">Notes</th>
                    </tr>
                  </thead>
                  <tbody>
                    {recentEntries.map((e) => (
                      <tr
                        key={e.id}
                        className="cursor-pointer hover:bg-zinc-50"
                        role="button"
                        tabIndex={0}
                        onClick={() => openEntryDetail(e)}
                        onKeyDown={(ev) => {
                          if (ev.key === 'Enter' || ev.key === ' ') openEntryDetail(e);
                        }}
                      >
                        <td className="border-b border-zinc-100 px-2 py-2">{e.entry_date}</td>
                        <td className="border-b border-zinc-100 px-2 py-2">
                          <span
                            className={`inline-block rounded-full border px-2 py-0.5 text-xs ${
                              e.entry_type === 'income'
                                ? 'border-emerald-200 bg-emerald-50 text-emerald-900'
                                : 'border-red-200 bg-red-50 text-red-900'
                            }`}
                          >
                            {e.entry_type}
                          </span>
                          {String(e.category ?? '').trim().toLowerCase() === 'carburant' && e.entry_type === 'income' && e.payment_status ? (
                            <span
                              className={
                                'ml-2 inline-block rounded-full border px-2 py-0.5 text-xs ' +
                                (e.payment_status === 'paid'
                                  ? 'border-emerald-200 bg-emerald-50 text-emerald-900'
                                  : e.payment_status === 'partial'
                                    ? 'border-amber-200 bg-amber-50 text-amber-900'
                                    : 'border-zinc-200 bg-white text-zinc-900')
                              }
                            >
                              {e.payment_status === 'paid'
                                ? 'payé'
                                : e.payment_status === 'partial'
                                  ? 'partiel'
                                  : 'non payé'}
                            </span>
                          ) : null}
                        </td>
                        <td className="border-b border-zinc-100 px-2 py-2 tabular-nums font-semibold">
                          {formatAriary(e.amount_ariary)}
                        </td>
                        <td className="border-b border-zinc-100 px-2 py-2 tabular-nums text-zinc-700">
                          {String(e.category ?? '').trim().toLowerCase() === 'carburant' &&
                          e.entry_type === 'income' &&
                          typeof e.fuel_km_end === 'number' &&
                          Number.isFinite(e.fuel_km_end)
                            ? new Intl.NumberFormat('fr-FR').format(e.fuel_km_end)
                            : String(e.category ?? '').trim().toLowerCase() === 'carburant' &&
                                e.entry_type === 'expense' &&
                                typeof e.odometer_km === 'number' &&
                                Number.isFinite(e.odometer_km)
                              ? new Intl.NumberFormat('fr-FR').format(e.odometer_km)
                              : typeof e.odometer_km === 'number' && Number.isFinite(e.odometer_km)
                                ? new Intl.NumberFormat('fr-FR').format(e.odometer_km)
                                : '—'}
                        </td>
                        <td className="border-b border-zinc-100 px-2 py-2">
                          <span className="inline-flex items-center gap-2">
                            <span>{e.category}</span>
                            {String(e.category ?? '').trim().toLowerCase() === 'carburant' &&
                            String(e.fuel_mode ?? '').trim().toLowerCase() === 'legacy' ? (
                              <span className="inline-flex items-center rounded-full border border-amber-200 bg-amber-50 px-2 py-0.5 text-xs font-medium text-amber-900">
                                legacy
                              </span>
                            ) : null}
                          </span>
                        </td>
                        <td className="border-b border-zinc-100 px-2 py-2">{e.label}</td>
                        <td className="border-b border-zinc-100 px-2 py-2 text-zinc-700">{e.notes ?? '—'}</td>
                      </tr>
                    ))}
                    {!recentEntries.length ? (
                      <tr>
                        <td className="px-2 py-4 text-zinc-500" colSpan={7}>
                          Aucune écriture.
                        </td>
                      </tr>
                    ) : null}
                  </tbody>
                </table>
              </div>
            </section>

            {editOpen && editForm ? (
              <div
                className="fixed inset-0 z-50 flex items-start justify-center overflow-y-auto bg-black/40 p-2 sm:items-center sm:p-4"
                role="presentation"
                onClick={() => !editSubmitting && setEditOpen(false)}
              >
                <div
                  role="dialog"
                  aria-modal="true"
                  aria-labelledby="edit-vehicle-title"
                  className="my-6 w-full max-w-lg rounded-xl border border-zinc-200 bg-white p-4 shadow-lg sm:my-0 sm:p-5 max-h-[calc(100vh-3rem)] overflow-y-auto"
                  onClick={(e) => e.stopPropagation()}
                  onKeyDown={(e) => e.stopPropagation()}
                >
                  <h2 id="edit-vehicle-title" className="text-lg font-semibold text-zinc-900">
                    Éditer véhicule
                  </h2>
                  <form className="mt-4 grid grid-cols-1 gap-3 sm:grid-cols-2" onSubmit={submitEdit}>
                    <label className="flex flex-col gap-1 text-sm">
                      <span className="text-zinc-700">Plaque</span>
                      <input
                        className="rounded-lg border border-zinc-200 px-3 py-2 font-mono outline-none focus:border-zinc-400"
                        value={editForm.plate_number}
                        onChange={(e) => setEditForm((p) => (p ? { ...p, plate_number: e.target.value } : p))}
                        required
                        disabled={editSubmitting}
                      />
                    </label>
                    <label className="flex flex-col gap-1 text-sm">
                      <span className="text-zinc-700">Statut</span>
                      <select
                        className="rounded-lg border border-zinc-200 px-3 py-2 outline-none focus:border-zinc-400"
                        value={editForm.status ?? 'active'}
                        onChange={(e) =>
                          setEditForm((p) => (p ? { ...p, status: e.target.value as FleetVehicleStatus } : p))
                        }
                        disabled={editSubmitting}
                      >
                        <option value="active">Actif</option>
                        <option value="inactive">Inactif</option>
                        <option value="sold">Vendu</option>
                        <option value="retired">Retiré</option>
                      </select>
                    </label>
                    <label className="flex flex-col gap-1 text-sm">
                      <span className="text-zinc-700">Marque</span>
                      <input
                        className="rounded-lg border border-zinc-200 px-3 py-2 outline-none focus:border-zinc-400"
                        value={String(editForm.brand ?? '')}
                        onChange={(e) => setEditForm((p) => (p ? { ...p, brand: e.target.value } : p))}
                        disabled={editSubmitting}
                      />
                    </label>
                    <label className="flex flex-col gap-1 text-sm">
                      <span className="text-zinc-700">Modèle</span>
                      <input
                        className="rounded-lg border border-zinc-200 px-3 py-2 outline-none focus:border-zinc-400"
                        value={String(editForm.model ?? '')}
                        onChange={(e) => setEditForm((p) => (p ? { ...p, model: e.target.value } : p))}
                        disabled={editSubmitting}
                      />
                    </label>
                    <label className="flex flex-col gap-1 text-sm">
                      <span className="text-zinc-700">Prix d’achat (Ar)</span>
                      <input
                        className="rounded-lg border border-zinc-200 px-3 py-2 outline-none focus:border-zinc-400"
                        inputMode="numeric"
                        value={editForm.purchase_price_ariary == null ? '' : String(editForm.purchase_price_ariary)}
                        onChange={(e) =>
                          setEditForm((p) =>
                            p ? { ...p, purchase_price_ariary: parseIntOrNull(e.target.value) } : p
                          )
                        }
                        disabled={editSubmitting}
                      />
                    </label>
                    <label className="flex flex-col gap-1 text-sm">
                      <span className="text-zinc-700">Date d’achat</span>
                      <input
                        className="rounded-lg border border-zinc-200 px-3 py-2 outline-none focus:border-zinc-400"
                        type="date"
                        value={editForm.purchase_date ?? ''}
                        onChange={(e) =>
                          setEditForm((p) => (p ? { ...p, purchase_date: e.target.value || null } : p))
                        }
                        disabled={editSubmitting}
                      />
                    </label>
                    <label className="flex flex-col gap-1 text-sm">
                      <span className="text-zinc-700">Amortissement (mois)</span>
                      <input
                        className="rounded-lg border border-zinc-200 px-3 py-2 outline-none focus:border-zinc-400"
                        inputMode="numeric"
                        value={editForm.amortization_months == null ? '' : String(editForm.amortization_months)}
                        onChange={(e) =>
                          setEditForm((p) =>
                            p ? { ...p, amortization_months: parseIntOrNull(e.target.value) } : p
                          )
                        }
                        disabled={editSubmitting}
                      />
                    </label>
                    <label className="flex flex-col gap-1 text-sm">
                      <span className="text-zinc-700">Revente cible (Ar)</span>
                      <input
                        className="rounded-lg border border-zinc-200 px-3 py-2 outline-none focus:border-zinc-400"
                        inputMode="numeric"
                        value={
                          editForm.target_resale_price_ariary == null
                            ? ''
                            : String(editForm.target_resale_price_ariary)
                        }
                        onChange={(e) =>
                          setEditForm((p) =>
                            p ? { ...p, target_resale_price_ariary: parseIntOrNull(e.target.value) } : p
                          )
                        }
                        disabled={editSubmitting}
                      />
                    </label>
                    <label className="flex flex-col gap-1 text-sm">
                      <span className="text-zinc-700">Loyer journalier (Ar)</span>
                      <input
                        className="rounded-lg border border-zinc-200 px-3 py-2 outline-none focus:border-zinc-400"
                        inputMode="numeric"
                        value={editForm.daily_rent_ariary == null ? '' : String(editForm.daily_rent_ariary)}
                        onChange={(e) =>
                          setEditForm((p) =>
                            p ? { ...p, daily_rent_ariary: parseIntOrNull(e.target.value) } : p
                          )
                        }
                        disabled={editSubmitting}
                      />
                    </label>
                    <div className="sm:col-span-2 rounded-lg border border-zinc-200 bg-zinc-50 p-3">
                      <div className="text-sm font-medium text-zinc-900">Références carburant par défaut</div>
                      <p className="mt-1 text-xs text-zinc-600">
                        Utilisées pour préremplir les recharges <span className="font-mono">carburant + expense</span>.
                        Laissez vide si vous ne souhaitez pas de valeurs par défaut.
                      </p>
                      <div className="mt-3 grid grid-cols-1 gap-3 sm:grid-cols-2">
                        <label className="flex flex-col gap-1 text-sm">
                          <span className="text-zinc-700">Litres de référence (L)</span>
                          <input
                            className="rounded-lg border border-zinc-200 bg-white px-3 py-2 outline-none focus:border-zinc-400"
                            inputMode="decimal"
                            placeholder="16"
                            value={editFuelRefLitresText}
                            onChange={(e) => setEditFuelRefLitresText(e.target.value)}
                            disabled={editSubmitting}
                          />
                        </label>
                        <label className="flex flex-col gap-1 text-sm">
                          <span className="text-zinc-700">Km de référence</span>
                          <input
                            className="rounded-lg border border-zinc-200 bg-white px-3 py-2 outline-none focus:border-zinc-400"
                            inputMode="numeric"
                            placeholder="285"
                            value={editFuelRefKmText}
                            onChange={(e) => setEditFuelRefKmText(e.target.value)}
                            disabled={editSubmitting}
                          />
                        </label>
                      </div>
                    </div>
                    <label className="flex flex-col gap-1 text-sm sm:col-span-2">
                      <span className="text-zinc-700">Notes</span>
                      <input
                        className="rounded-lg border border-zinc-200 px-3 py-2 outline-none focus:border-zinc-400"
                        value={String(editForm.notes ?? '')}
                        onChange={(e) => setEditForm((p) => (p ? { ...p, notes: e.target.value } : p))}
                        disabled={editSubmitting}
                      />
                    </label>
                    {editError ? (
                      <div className="sm:col-span-2 rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-900">
                        {editError}
                      </div>
                    ) : null}
                    <div className="sm:col-span-2 mt-1 flex justify-end gap-2">
                      <button
                        type="button"
                        className="rounded-lg border border-zinc-200 bg-white px-3 py-2 text-sm hover:bg-zinc-100 disabled:opacity-50"
                        disabled={editSubmitting}
                        onClick={() => setEditOpen(false)}
                      >
                        Annuler
                      </button>
                      <button
                        type="submit"
                        className="rounded-lg border border-zinc-800 bg-zinc-900 px-3 py-2 text-sm font-medium text-white hover:bg-zinc-800 disabled:opacity-50"
                        disabled={editSubmitting}
                      >
                        {editSubmitting ? 'Enregistrement…' : 'Enregistrer'}
                      </button>
                    </div>
                  </form>
                </div>
              </div>
            ) : null}

            {entryOpen ? (
              <div
                className="fixed inset-0 z-50 flex items-start justify-center overflow-y-auto bg-black/40 p-2 sm:items-center sm:p-4"
                role="presentation"
                onClick={() => !entrySubmitting && setEntryOpen(false)}
              >
                <div
                  role="dialog"
                  aria-modal="true"
                  aria-labelledby="add-entry-title"
                  className="my-6 w-full max-w-lg rounded-xl border border-zinc-200 bg-white p-4 shadow-lg sm:my-0 sm:p-5 max-h-[calc(100vh-3rem)] overflow-y-auto"
                  onClick={(e) => e.stopPropagation()}
                  onKeyDown={(e) => e.stopPropagation()}
                >
                  <h2 id="add-entry-title" className="text-lg font-semibold text-zinc-900">
                    Ajouter une écriture
                  </h2>
                  <form className="mt-4 grid grid-cols-1 gap-3 sm:grid-cols-2" onSubmit={submitEntry}>
                    <label className="flex flex-col gap-1 text-sm">
                      <span className="text-zinc-700">Type</span>
                      <select
                        className="rounded-lg border border-zinc-200 px-3 py-2 outline-none focus:border-zinc-400"
                        value={entryForm.entry_type}
                        onChange={(e) => {
                          const nextType = e.target.value as 'income' | 'expense';
                          setEntryForm((p) => ({ ...p, entry_type: nextType }));
                          if (entryForm.category === 'carburant' && nextType === 'expense') {
                            const v = data?.vehicle;
                            const lastKm = lastKnownKmFromEntries(data?.recent_entries);
                            if (!fuelPriceText.trim()) setFuelPriceText('10 000');
                            if (!fuelConsumptionText.trim()) setFuelConsumptionText('0.05');
                            if (!fuelRechargeOdometerText.trim() && lastKm != null) {
                              setFuelRechargeOdometerText(formatIntFr(lastKm));
                            }
                            const refL = v?.fuel_ref_litres;
                            const refK = v?.fuel_ref_km;
                            let nextLitresStr = fuelRechargeLitresText.trim();
                            if (!nextLitresStr && typeof refL === 'number' && Number.isFinite(refL) && refL > 0) {
                              nextLitresStr = String(refL);
                              setFuelRechargeLitresText(nextLitresStr);
                            }
                            const litresVal = parseFloatOrNull(nextLitresStr);
                            if (vehicleFuelRefsUsable(v) && litresVal != null && litresVal > 0 && v) {
                              setFuelRechargeKmCreditedText(
                                String(kmCreditedFromLitresRounded(litresVal, v.fuel_ref_litres!, v.fuel_ref_km!))
                              );
                            } else if (
                              !fuelRechargeKmCreditedText.trim() &&
                              typeof refK === 'number' &&
                              Number.isFinite(refK) &&
                              refK > 0
                            ) {
                              setFuelRechargeKmCreditedText(String(refK));
                            }
                          }
                        }}
                        disabled={entrySubmitting}
                      >
                        <option value="income">Income</option>
                        <option value="expense">Expense</option>
                      </select>
                    </label>

                    {/* Fuel + income: results-first UX layout */}
                    {isFuelEntry && entryForm.entry_type === 'income' ? (
                      <div className="sm:col-span-2 rounded-xl border border-emerald-200 bg-emerald-50 p-4">
                        <div className="flex items-start justify-between gap-3">
                          <div>
                            <div className="text-xs font-medium text-emerald-900">Résultat (carburant)</div>
                            <div className="mt-1 text-xs text-emerald-800">
                              Km du jour et montant dû sont calculés automatiquement.
                            </div>
                          </div>
                          <span className="inline-flex items-center rounded-full border border-emerald-200 bg-white px-2 py-0.5 text-xs font-medium text-emerald-900">
                            income
                          </span>
                        </div>
                        <div className="mt-4 grid grid-cols-1 gap-3 sm:grid-cols-2">
                          <div className="rounded-lg border border-emerald-200 bg-white p-3">
                            <div className="text-xs text-emerald-900">Carburant dû (Ar)</div>
                            <div className="mt-1 text-2xl font-semibold tabular-nums text-emerald-950">
                              {fuelDueAriary == null ? '—' : `${formatAriary(fuelDueAriary)} Ar`}
                            </div>
                          </div>
                          <div className="rounded-lg border border-emerald-200 bg-white p-3">
                            <div className="text-xs text-emerald-900">Km du jour</div>
                            <div className="mt-1 text-2xl font-semibold tabular-nums text-emerald-950">
                              {fuelKmDay == null ? '—' : new Intl.NumberFormat('fr-FR').format(fuelKmDay)}
                            </div>
                          </div>
                        </div>
                      </div>
                    ) : null}

                    {/* Fuel + income: immediate payment entry (optional) */}
                    {entryForm.entry_type === 'income' && entryForm.category === 'carburant' ? (
                      <div className="sm:col-span-2 rounded-xl border border-zinc-200 bg-white p-4">
                        <div className="text-sm font-semibold text-zinc-900">Paiement reçu maintenant</div>
                        <div className="mt-3 grid grid-cols-1 gap-3 sm:grid-cols-2">
                          <label className="flex flex-col gap-1 text-sm">
                            <span className="text-zinc-700">Montant (Ar)</span>
                            <input
                              className="rounded-lg border border-zinc-200 bg-white px-3 py-2 outline-none focus:border-zinc-400"
                              inputMode="numeric"
                              placeholder="ex: 10 000"
                              value={entryImmediatePaymentAmountText}
                              onChange={(e) => setEntryImmediatePaymentAmountText(e.target.value)}
                              onBlur={() => setEntryImmediatePaymentAmountText((v) => formatDigitsFr(v))}
                              disabled={entrySubmitting}
                            />
                          </label>
                          <div className="rounded-lg border border-zinc-200 bg-zinc-50 p-3 text-sm">
                            <div className="flex items-center justify-between gap-3">
                              <div className="text-xs text-zinc-600">Montant dû</div>
                              <div className="font-semibold tabular-nums text-zinc-900">
                                {fuelDueAriary == null ? '—' : `${formatAriary(fuelDueAriary)} Ar`}
                              </div>
                            </div>
                            <div className="mt-2 flex items-center justify-between gap-3">
                              <div className="text-xs text-zinc-600">Reste à payer</div>
                              <div className="font-semibold tabular-nums text-zinc-900">
                                {fuelDueAriary == null
                                  ? '—'
                                  : (() => {
                                      const due = fuelDueAriary;
                                      const paid = Number.parseInt(digitsOnly(entryImmediatePaymentAmountText), 10) || 0;
                                      return `${formatAriary(Math.max(0, due - paid))} Ar`;
                                    })()}
                              </div>
                            </div>
                          </div>
                          <label className="flex flex-col gap-1 text-sm sm:col-span-2">
                            <span className="text-zinc-700">Note (optionnel)</span>
                            <input
                              className="rounded-lg border border-zinc-200 px-3 py-2 outline-none focus:border-zinc-400"
                              value={entryImmediatePaymentNotes}
                              onChange={(e) => setEntryImmediatePaymentNotes(e.target.value)}
                              disabled={entrySubmitting}
                            />
                          </label>
                        </div>
                      </div>
                    ) : null}

                    {/* Fuel + income: contextual stock summary (projection locale du brouillon) */}
                    {isFuelEntry && entryForm.entry_type === 'income' && addEntryIncomeFuelStockPreview ? (
                      <div className="sm:col-span-2 rounded-xl border border-zinc-200 bg-white p-4">
                        <div className="flex items-start justify-between gap-3">
                          <div>
                            <div className="text-xs font-medium text-zinc-900">Stock carburant (théorique)</div>
                            <div className="mt-1 text-xs text-zinc-600">
                              Indicateur d’aide à la décision (pas d’automatisme).
                              {addEntryIncomeFuelStockPreview.isProjected ? (
                                <span className="mt-1 block text-indigo-700">
                                  Projection locale du brouillon — les valeurs définitives suivent le calcul serveur
                                  après enregistrement.
                                </span>
                              ) : null}
                            </div>
                          </div>
                          {addEntryIncomeFuelStockPreview.autonomy ? (
                            <span
                              className={
                                'inline-flex items-center rounded-full border px-2 py-0.5 text-xs font-medium ' +
                                (addEntryIncomeFuelStockPreview.autonomy === 'confortable'
                                  ? 'border-emerald-200 bg-emerald-50 text-emerald-900'
                                  : addEntryIncomeFuelStockPreview.autonomy === 'limite'
                                    ? 'border-amber-200 bg-amber-50 text-amber-900'
                                    : 'border-red-200 bg-red-50 text-red-900')
                              }
                            >
                              {addEntryIncomeFuelStockPreview.autonomy === 'confortable'
                                ? 'autonomie confortable'
                                : addEntryIncomeFuelStockPreview.autonomy === 'limite'
                                  ? 'autonomie limite'
                                  : 'autonomie insuffisante'}
                            </span>
                          ) : null}
                        </div>

                        {addEntryIncomeFuelStockPreview.hasSummary ? (
                          <>
                            {addEntryIncomeFuelStockPreview.isProjected &&
                            addEntryIncomeFuelStockPreview.kmDayDraft != null &&
                            addEntryIncomeFuelStockPreview.litresConsumedDraft != null ? (
                              <div className="mt-3 grid grid-cols-1 gap-2 rounded-lg border border-indigo-100 bg-indigo-50/60 p-3 text-sm sm:grid-cols-2">
                                <div>
                                  <div className="text-xs text-indigo-800">Km du jour (brouillon)</div>
                                  <div className="mt-0.5 font-semibold tabular-nums text-indigo-950">
                                    {new Intl.NumberFormat('fr-FR').format(addEntryIncomeFuelStockPreview.kmDayDraft)}
                                  </div>
                                </div>
                                <div>
                                  <div className="text-xs text-indigo-800">Litres consommés (brouillon)</div>
                                  <div className="mt-0.5 font-semibold tabular-nums text-indigo-950">
                                    {formatNumberFr(addEntryIncomeFuelStockPreview.litresConsumedDraft, {
                                      maxFrac: 2,
                                    })}{' '}
                                    L
                                  </div>
                                </div>
                              </div>
                            ) : null}

                            <div className="mt-4">
                              <div className="flex items-baseline justify-between gap-3">
                                <div className="text-sm font-semibold tabular-nums text-zinc-900">
                                  {formatNumberFr(addEntryIncomeFuelStockPreview.pctGauge, { maxFrac: 0 })}%
                                </div>
                                {!addEntryIncomeFuelStockPreview.hasRecharge ? (
                                  <div className="text-xs text-zinc-600">Aucune recharge enregistrée.</div>
                                ) : addEntryIncomeFuelStockPreview.isNegative ? (
                                  <div className="text-xs text-red-700">Stock négatif (théorique).</div>
                                ) : null}
                              </div>

                              <div className="mt-2">
                                <div className="relative h-3 overflow-hidden rounded-full border border-zinc-200">
                                  <div className="absolute inset-0 flex">
                                    <div className="w-1/3 bg-red-200" />
                                    <div className="w-1/3 bg-amber-200" />
                                    <div className="w-1/3 bg-emerald-200" />
                                  </div>
                                  <div
                                    className="absolute top-0 h-full w-0.5 bg-zinc-900"
                                    style={{ left: `${addEntryIncomeFuelStockPreview.pctGauge}%` }}
                                    aria-hidden="true"
                                  />
                                </div>
                              </div>
                            </div>

                            <div className="mt-4 grid grid-cols-1 gap-3 sm:grid-cols-2">
                              <div className="rounded-lg border border-zinc-200 p-3 text-sm">
                                <div className="text-xs text-zinc-600">
                                  Km restants
                                  {addEntryIncomeFuelStockPreview.isProjected ? (
                                    <span className="ml-1 font-normal text-indigo-700">(après brouillon)</span>
                                  ) : null}
                                </div>
                                <div className="mt-1 font-semibold tabular-nums text-zinc-900">
                                  {addEntryIncomeFuelStockPreview.kmRemaining == null
                                    ? '—'
                                    : `${formatNumberFr(addEntryIncomeFuelStockPreview.kmRemaining)} km`}
                                </div>
                              </div>
                              <div className="rounded-lg border border-zinc-200 p-3 text-sm">
                                <div className="text-xs text-zinc-600">
                                  Litres restants
                                  {addEntryIncomeFuelStockPreview.litresProjectedActive ? (
                                    <span className="ml-1 font-normal text-indigo-700">(après brouillon)</span>
                                  ) : null}
                                </div>
                                <div className="mt-1 font-semibold tabular-nums text-zinc-900">
                                  {addEntryIncomeFuelStockPreview.litresRemaining == null
                                    ? '—'
                                    : `${formatNumberFr(addEntryIncomeFuelStockPreview.litresRemaining, {
                                        maxFrac: 2,
                                      })} L`}
                                </div>
                              </div>
                              <div className="rounded-lg border border-zinc-200 p-3 text-sm sm:col-span-2">
                                <div className="flex items-baseline justify-between gap-3">
                                  <div className="text-xs text-zinc-600">Moyenne km/jour (7 jours)</div>
                                  <div className="text-xs text-zinc-500">
                                    {addEntryIncomeFuelStockPreview.avg == null
                                      ? 'non fiable (< 2 jours actifs)'
                                      : null}
                                  </div>
                                </div>
                                <div className="mt-1 font-medium tabular-nums text-zinc-900">
                                  {addEntryIncomeFuelStockPreview.avg == null
                                    ? '—'
                                    : `${formatNumberFr(addEntryIncomeFuelStockPreview.avg, { maxFrac: 1 })} km/j`}
                                </div>
                              </div>
                            </div>
                          </>
                        ) : (
                          <div className="mt-4 text-sm text-zinc-600">
                            Résumé carburant indisponible (rafraîchir la fiche ou vérifier les données).
                          </div>
                        )}
                      </div>
                    ) : null}

                    {/* Standard (non-fuel): keep legacy fields */}
                    {!isFuelEntry ? (
                      <>
                        <label className="flex flex-col gap-1 text-sm">
                          <span className="text-zinc-700">Montant (Ar)</span>
                          <input
                            className="rounded-lg border border-zinc-200 px-3 py-2 outline-none focus:border-zinc-400"
                            inputMode="numeric"
                            value={entryAmountText}
                            onChange={(e) => setEntryAmountText(e.target.value)}
                            onBlur={() => setEntryAmountText((v) => formatDigitsFr(v))}
                            disabled={entrySubmitting}
                          />
                        </label>
                        <label className="flex flex-col gap-1 text-sm">
                          <span className="text-zinc-700">Kilométrage (km)</span>
                          <input
                            className="rounded-lg border border-zinc-200 px-3 py-2 outline-none focus:border-zinc-400"
                            inputMode="numeric"
                            placeholder="optionnel"
                            value={entryOdometerText}
                            onChange={(e) => setEntryOdometerText(e.target.value)}
                            onBlur={() => setEntryOdometerText((v) => formatDigitsFr(v))}
                            disabled={entrySubmitting}
                          />
                        </label>
                      </>
                    ) : null}

                    {isFuelRecharge ? (
                      <div className="sm:col-span-2 rounded-xl border border-zinc-200 bg-zinc-50 p-4">
                        <div className="text-xs font-medium text-zinc-900">Recharge carburant</div>
                        <p className="mt-1 text-xs text-zinc-600">
                          Km crédités se recalculent depuis les litres si les références véhicule sont renseignées ; vous
                          pouvez les ajuster manuellement si besoin.
                        </p>
                        <div className="mt-3 grid grid-cols-1 gap-3 sm:grid-cols-2">
                          <label className="flex flex-col gap-1 text-sm sm:col-span-2">
                            <span className="text-zinc-700">Relevé kilométrique (compteur)</span>
                            <input
                              className="rounded-lg border border-zinc-200 bg-white px-3 py-2 outline-none focus:border-zinc-400"
                              inputMode="numeric"
                              placeholder="ex: 45 280"
                              value={fuelRechargeOdometerText}
                              onChange={(e) => setFuelRechargeOdometerText(e.target.value)}
                              onBlur={() => setFuelRechargeOdometerText((v) => formatDigitsFr(v))}
                              disabled={entrySubmitting}
                            />
                          </label>
                          <label className="flex flex-col gap-1 text-sm">
                            <span className="text-zinc-700">Litres ajoutés</span>
                            <input
                              className="rounded-lg border border-zinc-200 bg-white px-3 py-2 outline-none focus:border-zinc-400"
                              inputMode="decimal"
                              placeholder={
                                data?.vehicle?.fuel_ref_litres != null ? String(data.vehicle.fuel_ref_litres) : 'ex: 16'
                              }
                              value={fuelRechargeLitresText}
                              onChange={(e) => {
                                const next = e.target.value;
                                setFuelRechargeLitresText(next);
                                const v = data?.vehicle;
                                if (vehicleFuelRefsUsable(v) && v) {
                                  const parsed = parseFloatOrNull(next);
                                  if (parsed != null && Number.isFinite(parsed) && parsed > 0) {
                                    setFuelRechargeKmCreditedText(
                                      String(
                                        kmCreditedFromLitresRounded(parsed, v.fuel_ref_litres!, v.fuel_ref_km!)
                                      )
                                    );
                                  }
                                }
                              }}
                              disabled={entrySubmitting}
                            />
                          </label>
                          <label className="flex flex-col gap-1 text-sm">
                            <span className="text-zinc-700">Km crédités</span>
                            <input
                              className="rounded-lg border border-zinc-200 bg-white px-3 py-2 outline-none focus:border-zinc-400"
                              inputMode="decimal"
                              placeholder={
                                data?.vehicle?.fuel_ref_litres != null && data?.vehicle?.fuel_ref_km != null
                                  ? String(
                                      kmCreditedFromLitresRounded(
                                        Number(data.vehicle.fuel_ref_litres),
                                        data.vehicle.fuel_ref_litres,
                                        data.vehicle.fuel_ref_km
                                      )
                                    )
                                  : 'ex: 285'
                              }
                              value={fuelRechargeKmCreditedText}
                              onChange={(e) => setFuelRechargeKmCreditedText(e.target.value)}
                              disabled={entrySubmitting}
                            />
                          </label>
                          <label className="flex flex-col gap-1 text-sm">
                            <span className="text-zinc-700">Prix litre (Ar)</span>
                            <input
                              className="rounded-lg border border-zinc-200 bg-white px-3 py-2 outline-none focus:border-zinc-400"
                              inputMode="numeric"
                              value={fuelPriceText}
                              onChange={(e) => setFuelPriceText(e.target.value)}
                              onBlur={() => setFuelPriceText((v) => formatDigitsFr(v))}
                              disabled={entrySubmitting}
                            />
                          </label>
                          <label className="flex flex-col gap-1 text-sm">
                            <span className="text-zinc-700">Consommation (L/km)</span>
                            <input
                              className="rounded-lg border border-zinc-200 bg-white px-3 py-2 outline-none focus:border-zinc-400"
                              inputMode="decimal"
                              placeholder="ex: 0.05"
                              value={fuelConsumptionText}
                              onChange={(e) => setFuelConsumptionText(e.target.value)}
                              disabled={entrySubmitting}
                            />
                          </label>
                          <label className="flex flex-col gap-1 text-sm sm:col-span-2">
                            <span className="text-zinc-700">Coût (Ar)</span>
                            <input
                              className="rounded-lg border border-zinc-200 bg-white px-3 py-2 outline-none focus:border-zinc-400"
                              inputMode="numeric"
                              value={entryAmountText}
                              onChange={(e) => setEntryAmountText(e.target.value)}
                              onBlur={() => setEntryAmountText((v) => formatDigitsFr(v))}
                              disabled={entrySubmitting}
                            />
                          </label>
                        </div>
                      </div>
                    ) : null}

                    <label className="flex flex-col gap-1 text-sm">
                      <span className="text-zinc-700">Date</span>
                      <input
                        className="rounded-lg border border-zinc-200 px-3 py-2 outline-none focus:border-zinc-400"
                        type="date"
                        value={entryForm.entry_date}
                        onChange={(e) => setEntryForm((p) => ({ ...p, entry_date: e.target.value }))}
                        disabled={entrySubmitting}
                      />
                    </label>
                    <label className="flex flex-col gap-1 text-sm">
                      <span className="text-zinc-700">Catégorie</span>
                      <select
                        className="rounded-lg border border-zinc-200 px-3 py-2 outline-none focus:border-zinc-400"
                        value={entryForm.category}
                        onChange={(e) => {
                          const next = e.target.value;
                          setEntryForm((p) => ({
                            ...p,
                            category: next,
                            // For fuel: default to income, but let the user override afterwards.
                            entry_type: next === 'carburant' ? 'income' : p.entry_type,
                            label: next === 'carburant' ? 'Carburant' : p.label,
                            odometer_km: next === 'carburant' ? null : p.odometer_km,
                          }));
                          if (next === 'carburant') {
                            // Defaults for the "income" fuel form (driver payment flow).
                            if (!fuelPriceText.trim()) setFuelPriceText('10 000');
                            if (!fuelConsumptionText.trim()) setFuelConsumptionText('0.05');
                            // Prefill km départ from last known km retour (fuel) if empty.
                            if (!fuelKmStartText.trim()) {
                              const lastKm =
                                data?.recent_entries?.find(
                                  (e) => typeof e.fuel_km_end === 'number' && Number.isFinite(e.fuel_km_end)
                                )?.fuel_km_end ??
                                data?.recent_entries?.find(
                                  (e) => typeof e.odometer_km === 'number' && Number.isFinite(e.odometer_km)
                                )?.odometer_km ??
                                null;
                              if (lastKm != null) setFuelKmStartText(formatIntFr(lastKm));
                            }

                            // Prefill recharge defaults (used if user switches to expense).
                            const v = data?.vehicle;
                            const refLitres = v?.fuel_ref_litres ?? null;
                            const refKm = v?.fuel_ref_km ?? null;
                            let nextLitresStr = fuelRechargeLitresText.trim();
                            if (!nextLitresStr && typeof refLitres === 'number' && Number.isFinite(refLitres) && refLitres > 0) {
                              nextLitresStr = String(refLitres);
                              setFuelRechargeLitresText(nextLitresStr);
                            }
                            const litresVal = parseFloatOrNull(nextLitresStr);
                            if (vehicleFuelRefsUsable(v) && litresVal != null && litresVal > 0 && v) {
                              setFuelRechargeKmCreditedText(
                                String(kmCreditedFromLitresRounded(litresVal, v.fuel_ref_litres!, v.fuel_ref_km!))
                              );
                            } else if (
                              !fuelRechargeKmCreditedText.trim() &&
                              typeof refKm === 'number' &&
                              Number.isFinite(refKm) &&
                              refKm > 0
                            ) {
                              setFuelRechargeKmCreditedText(String(refKm));
                            }
                          }
                        }}
                        disabled={entrySubmitting}
                      >
                        <option value="achat_vehicule">achat_vehicule</option>
                        <option value="loyer">loyer</option>
                        <option value="entretien">entretien</option>
                        <option value="reparation">reparation</option>
                        <option value="carburant">carburant</option>
                        <option value="assurance">assurance</option>
                        <option value="autre">autre</option>
                      </select>
                    </label>
                    {!isFuelEntry ? (
                      <label className="flex flex-col gap-1 text-sm sm:col-span-2">
                        <span className="text-zinc-700">Libellé</span>
                        <input
                          className="rounded-lg border border-zinc-200 px-3 py-2 outline-none focus:border-zinc-400"
                          value={entryForm.label}
                          onChange={(e) => setEntryForm((p) => ({ ...p, label: e.target.value }))}
                          disabled={entrySubmitting}
                        />
                      </label>
                    ) : null}

                    {isFuelIncome ? (
                      <div className="sm:col-span-2 rounded-xl border border-zinc-200 bg-white p-4">
                        <div className="text-xs font-medium text-zinc-900">Saisie métier</div>
                        <div className="mt-3 grid grid-cols-1 gap-3 sm:grid-cols-2">
                          <label className="flex flex-col gap-1 text-sm">
                            <span className="text-zinc-700">Km départ</span>
                            <input
                              className="rounded-lg border border-zinc-200 px-3 py-2 outline-none focus:border-zinc-400"
                              inputMode="numeric"
                              value={fuelKmStartText}
                              onChange={(e) => setFuelKmStartText(e.target.value)}
                              onBlur={() => setFuelKmStartText((v) => formatDigitsFr(v))}
                              disabled={entrySubmitting}
                            />
                          </label>
                          <label className="flex flex-col gap-1 text-sm">
                            <span className="text-zinc-700">Km retour</span>
                            <input
                              className="rounded-lg border border-zinc-200 px-3 py-2 outline-none focus:border-zinc-400"
                              inputMode="numeric"
                              value={fuelKmEndText}
                              onChange={(e) => setFuelKmEndText(e.target.value)}
                              onBlur={() => setFuelKmEndText((v) => formatDigitsFr(v))}
                              disabled={entrySubmitting}
                            />
                          </label>
                          <label className="flex flex-col gap-1 text-sm">
                            <span className="text-zinc-700">Prix litre (Ar)</span>
                            <input
                              className="rounded-lg border border-zinc-200 px-3 py-2 outline-none focus:border-zinc-400"
                              inputMode="numeric"
                              value={fuelPriceText}
                              onChange={(e) => setFuelPriceText(e.target.value)}
                              onBlur={() => setFuelPriceText((v) => formatDigitsFr(v))}
                              disabled={entrySubmitting}
                            />
                          </label>
                          <label className="flex flex-col gap-1 text-sm">
                            <span className="text-zinc-700">Consommation (L/km)</span>
                            <input
                              className="rounded-lg border border-zinc-200 px-3 py-2 outline-none focus:border-zinc-400"
                              inputMode="decimal"
                              placeholder="ex: 0.05"
                              value={fuelConsumptionText}
                              onChange={(e) => setFuelConsumptionText(e.target.value)}
                              disabled={entrySubmitting}
                            />
                          </label>
                        </div>
                      </div>
                    ) : null}
                    <label className="flex flex-col gap-1 text-sm sm:col-span-2">
                      <span className="text-zinc-700">{isFuelEntry ? 'Observation' : 'Notes'}</span>
                      <input
                        className="rounded-lg border border-zinc-200 px-3 py-2 outline-none focus:border-zinc-400"
                        value={String(entryForm.notes ?? '')}
                        onChange={(e) => setEntryForm((p) => ({ ...p, notes: e.target.value }))}
                        disabled={entrySubmitting}
                      />
                    </label>
                    {entryError ? (
                      <div className="sm:col-span-2 rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-900">
                        {entryError}
                      </div>
                    ) : null}
                    {isFuelIncome && fuelInlineError ? (
                      <div className="sm:col-span-2 rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-sm text-amber-900">
                        {fuelInlineError}
                      </div>
                    ) : null}
                    <div className="sm:col-span-2 mt-1 flex justify-end gap-2">
                      <button
                        type="button"
                        className="rounded-lg border border-zinc-200 bg-white px-3 py-2 text-sm hover:bg-zinc-100 disabled:opacity-50"
                        disabled={entrySubmitting}
                        onClick={() => setEntryOpen(false)}
                      >
                        Annuler
                      </button>
                      <button
                        type="submit"
                        className="rounded-lg border border-zinc-800 bg-zinc-900 px-3 py-2 text-sm font-medium text-white hover:bg-zinc-800 disabled:opacity-50"
                        disabled={entrySubmitting || !fuelCanSubmit}
                      >
                        {entrySubmitting ? 'Ajout…' : 'Ajouter'}
                      </button>
                    </div>
                  </form>
                </div>
              </div>
            ) : null}

            {detailOpen && selectedEntry ? (
              <div
                className="fixed inset-0 z-50 flex items-start justify-center overflow-y-auto bg-black/40 p-2 sm:items-center sm:p-4"
                role="presentation"
                onClick={() => !detailSubmitting && setDetailOpen(false)}
              >
                <div
                  role="dialog"
                  aria-modal="true"
                  aria-labelledby="entry-detail-title"
                  className="my-6 w-full max-w-lg rounded-xl border border-zinc-200 bg-white p-4 shadow-lg sm:my-0 sm:p-5 max-h-[calc(100vh-3rem)] overflow-y-auto"
                  onClick={(e) => e.stopPropagation()}
                  onKeyDown={(e) => e.stopPropagation()}
                >
                  <div className="flex items-start justify-between gap-3">
                    <div>
                      <h2 id="entry-detail-title" className="text-lg font-semibold text-zinc-900">
                        Écriture
                      </h2>
                      <div className="mt-1 text-xs text-zinc-500">{selectedEntry.id}</div>
                    </div>
                    <div className="flex gap-2">
                      {detailMode === 'read' ? (
                        <>
                          <button
                            type="button"
                            className="rounded-lg border border-zinc-200 bg-white px-3 py-2 text-sm hover:bg-zinc-100 disabled:opacity-50"
                            disabled={detailSubmitting}
                            onClick={beginEditEntry}
                          >
                            Modifier
                          </button>
                          <button
                            type="button"
                            className="rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-900 hover:bg-red-100 disabled:opacity-50"
                            disabled={detailSubmitting}
                            onClick={() => void confirmAndSoftDeleteEntry()}
                          >
                            Supprimer
                          </button>
                        </>
                      ) : null}
                    </div>
                  </div>

                  {detailMode === 'read' ? (
                    <div className="mt-4 grid grid-cols-1 gap-3 text-sm">
                      <div className="grid grid-cols-2 gap-3">
                        <div className="rounded-lg border border-zinc-200 p-3">
                          <div className="text-xs text-zinc-600">Type</div>
                          <div className="mt-1 font-medium">{selectedEntry.entry_type}</div>
                        </div>
                        <div className="rounded-lg border border-zinc-200 p-3">
                          <div className="text-xs text-zinc-600">Date</div>
                          <div className="mt-1 font-medium">{selectedEntry.entry_date}</div>
                        </div>
                      </div>
                      <div className="rounded-lg border border-zinc-200 p-3">
                        <div className="text-xs text-zinc-600">Catégorie</div>
                        <div className="mt-1 font-medium">
                          <span className="inline-flex items-center gap-2">
                            <span>{selectedEntry.category}</span>
                            {String(selectedEntry.category ?? '').trim().toLowerCase() === 'carburant' &&
                            String(selectedEntry.fuel_mode ?? '').trim().toLowerCase() === 'legacy' ? (
                              <span className="inline-flex items-center rounded-full border border-amber-200 bg-amber-50 px-2 py-0.5 text-xs font-medium text-amber-900">
                                legacy
                              </span>
                            ) : null}
                          </span>
                        </div>
                      </div>
                      <div className="rounded-lg border border-zinc-200 p-3">
                        <div className="text-xs text-zinc-600">Montant (Ar)</div>
                        <div className="mt-1 font-semibold tabular-nums">{formatAriary(selectedEntry.amount_ariary)} Ar</div>
                      </div>
                      {selectedEntry.category?.trim().toLowerCase() === 'carburant' &&
                      selectedEntry.entry_type === 'income' ? (
                        <div className="rounded-lg border border-indigo-200 bg-indigo-50 p-3">
                          <div className="flex items-start justify-between gap-3">
                            <div>
                              <div className="text-xs font-medium text-indigo-900">Paiement chauffeur</div>
                              <div className="mt-1 text-xs text-indigo-800">
                                Suivi d’une dette issue de l’écriture carburant (income).
                              </div>
                            </div>
                            {selectedEntry.payment_status ? (
                              <span
                                className={
                                  'inline-flex items-center rounded-full border px-2 py-0.5 text-xs font-medium ' +
                                  (selectedEntry.payment_status === 'paid'
                                    ? 'border-emerald-200 bg-emerald-50 text-emerald-900'
                                    : selectedEntry.payment_status === 'partial'
                                      ? 'border-amber-200 bg-amber-50 text-amber-900'
                                      : 'border-zinc-200 bg-white text-zinc-900')
                                }
                              >
                                {selectedEntry.payment_status === 'paid'
                                  ? 'payé'
                                  : selectedEntry.payment_status === 'partial'
                                    ? 'partiel'
                                    : 'non payé'}
                              </span>
                            ) : null}
                          </div>

                          {(() => {
                            const due = selectedEntry.amount_ariary;
                            const paid =
                              typeof selectedEntry.total_paid_ariary === 'number' && Number.isFinite(selectedEntry.total_paid_ariary)
                                ? selectedEntry.total_paid_ariary
                                : 0;
                            const remaining =
                              typeof selectedEntry.remaining_amount_ariary === 'number' && Number.isFinite(selectedEntry.remaining_amount_ariary)
                                ? selectedEntry.remaining_amount_ariary
                                : due - paid;
                            const isSettled = selectedEntry.payment_status === 'paid' || remaining <= 0;
                            return (
                              <>
                                <div className="mt-3 grid grid-cols-1 gap-3 sm:grid-cols-3">
                                  <div className="rounded-lg border border-indigo-200 bg-white p-3">
                                    <div className="text-xs text-indigo-900">Dû</div>
                                    <div className="mt-1 font-semibold tabular-nums text-indigo-950">
                                      {formatAriary(due)} Ar
                                    </div>
                                  </div>
                                  <div className="rounded-lg border border-indigo-200 bg-white p-3">
                                    <div className="text-xs text-indigo-900">Payé</div>
                                    <div className="mt-1 font-semibold tabular-nums text-indigo-950">
                                      {formatAriary(paid)} Ar
                                    </div>
                                  </div>
                                  <div className="rounded-lg border border-indigo-200 bg-white p-3">
                                    <div className="text-xs text-indigo-900">Reste</div>
                                    <div className="mt-1 font-semibold tabular-nums text-indigo-950">
                                      {formatAriary(remaining)} Ar
                                    </div>
                                  </div>
                                </div>

                                <div className="mt-3 rounded-lg border border-indigo-200 bg-white p-3">
                                  <div className="text-xs font-medium text-indigo-900">Historique des paiements</div>
                                  {paymentsLoading ? (
                                    <div className="mt-2 text-sm text-indigo-900/80">Chargement…</div>
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
                                            <div className="text-xs text-zinc-600">
                                              {new Date(p.paid_at).toLocaleString('fr-FR')}
                                            </div>
                                            {p.notes?.trim() ? (
                                              <div className="mt-1 text-xs text-zinc-700">{p.notes}</div>
                                            ) : null}
                                          </div>
                                        </div>
                                      ))}
                                    </div>
                                  ) : (
                                    <div className="mt-2 text-sm text-zinc-600">Aucun paiement enregistré.</div>
                                  )}
                                </div>

                                {isSettled ? (
                                  <div className="mt-3 rounded-lg border border-emerald-200 bg-emerald-50 px-3 py-2 text-sm text-emerald-900">
                                    Dette soldée.
                                  </div>
                                ) : (
                                  <form className="mt-3 grid grid-cols-1 gap-3 sm:grid-cols-2" onSubmit={submitNewPayment}>
                                    <label className="flex flex-col gap-1 text-sm">
                                      <span className="text-indigo-900">Montant payé (Ar)</span>
                                      <input
                                        className="rounded-lg border border-indigo-200 bg-white px-3 py-2 outline-none focus:border-indigo-400"
                                        inputMode="numeric"
                                        value={paymentAmountText}
                                        onChange={(e) => setPaymentAmountText(e.target.value)}
                                        onBlur={() => setPaymentAmountText((v) => formatDigitsFr(v))}
                                        disabled={detailSubmitting}
                                      />
                                    </label>
                                    <label className="flex flex-col gap-1 text-sm">
                                      <span className="text-indigo-900">Date (optionnel)</span>
                                      <input
                                        className="rounded-lg border border-indigo-200 bg-white px-3 py-2 outline-none focus:border-indigo-400"
                                        type="date"
                                        value={paymentDate}
                                        onChange={(e) => setPaymentDate(e.target.value)}
                                        disabled={detailSubmitting}
                                      />
                                    </label>
                                    <label className="flex flex-col gap-1 text-sm sm:col-span-2">
                                      <span className="text-indigo-900">Note (optionnel)</span>
                                      <input
                                        className="rounded-lg border border-indigo-200 bg-white px-3 py-2 outline-none focus:border-indigo-400"
                                        value={paymentNotes}
                                        onChange={(e) => setPaymentNotes(e.target.value)}
                                        disabled={detailSubmitting}
                                      />
                                    </label>
                                    <div className="sm:col-span-2 flex justify-end">
                                      <button
                                        type="submit"
                                        className="rounded-lg border border-indigo-800 bg-indigo-900 px-3 py-2 text-sm font-medium text-white hover:bg-indigo-800 disabled:opacity-50"
                                        disabled={detailSubmitting}
                                      >
                                        Ajouter un paiement
                                      </button>
                                    </div>
                                  </form>
                                )}
                              </>
                            );
                          })()}
                        </div>
                      ) : null}
                      {selectedEntry.category?.trim().toLowerCase() === 'carburant' &&
                      selectedEntry.entry_type === 'income' ? (
                        <div className="rounded-lg border border-emerald-200 bg-emerald-50 p-3">
                          <div className="text-xs font-medium text-emerald-900">Carburant (snapshot)</div>
                          <div className="mt-2 grid grid-cols-2 gap-2 text-sm">
                            <div>
                              <div className="text-xs text-emerald-800">Km départ</div>
                              <div className="font-medium tabular-nums">{selectedEntry.fuel_km_start ?? '—'}</div>
                            </div>
                            <div>
                              <div className="text-xs text-emerald-800">Km retour</div>
                              <div className="font-medium tabular-nums">{selectedEntry.fuel_km_end ?? '—'}</div>
                            </div>
                            <div>
                              <div className="text-xs text-emerald-800">Km du jour</div>
                              <div className="font-medium tabular-nums">{selectedEntry.fuel_km_travelled ?? '—'}</div>
                            </div>
                            <div>
                              <div className="text-xs text-emerald-800">Carburant dû</div>
                              <div className="font-semibold tabular-nums">
                                {selectedEntry.fuel_due_ariary == null ? '—' : `${formatAriary(selectedEntry.fuel_due_ariary)} Ar`}
                              </div>
                            </div>
                          </div>
                          <div className="mt-2 grid grid-cols-2 gap-2 text-xs text-emerald-800">
                            <div>Prix litre: {selectedEntry.fuel_price_per_litre_ariary_used ?? '—'} Ar</div>
                            <div>Conso: {selectedEntry.fuel_consumption_l_per_km_used ?? '—'} L/km</div>
                          </div>
                        </div>
                      ) : selectedEntry.category?.trim().toLowerCase() === 'carburant' &&
                        selectedEntry.entry_type === 'expense' ? (
                        <div className="rounded-lg border border-amber-200 bg-amber-50 p-3">
                          <div className="text-xs font-medium text-amber-900">Recharge carburant</div>
                          <div className="mt-2 grid grid-cols-2 gap-2 text-sm">
                            <div>
                              <div className="text-xs text-amber-800">Relevé kilométrique</div>
                              <div className="font-medium tabular-nums">
                                {selectedEntry.odometer_km == null
                                  ? '—'
                                  : new Intl.NumberFormat('fr-FR').format(selectedEntry.odometer_km)}
                              </div>
                            </div>
                            <div>
                              <div className="text-xs text-amber-800">Litres ajoutés</div>
                              <div className="font-medium tabular-nums">{selectedEntry.fuel_recharge_litres_used ?? '—'}</div>
                            </div>
                            <div>
                              <div className="text-xs text-amber-800">Km crédités</div>
                              <div className="font-medium tabular-nums">
                                {selectedEntry.fuel_recharge_km_credited_used ?? '—'}
                              </div>
                            </div>
                            <div>
                              <div className="text-xs text-amber-800">Coût</div>
                              <div className="font-semibold tabular-nums">{formatAriary(selectedEntry.amount_ariary)} Ar</div>
                            </div>
                          </div>
                          <div className="mt-2 grid grid-cols-2 gap-2 text-xs text-amber-800">
                            <div>Prix litre: {selectedEntry.fuel_price_per_litre_ariary_used ?? '—'} Ar</div>
                            <div>Conso: {selectedEntry.fuel_consumption_l_per_km_used ?? '—'} L/km</div>
                          </div>
                        </div>
                      ) : (
                        <div className="grid grid-cols-2 gap-3">
                          <div className="rounded-lg border border-zinc-200 p-3">
                            <div className="text-xs text-zinc-600">Km</div>
                            <div className="mt-1 font-medium tabular-nums">
                              {selectedEntry.odometer_km == null ? '—' : new Intl.NumberFormat('fr-FR').format(selectedEntry.odometer_km)}
                            </div>
                          </div>
                          <div className="rounded-lg border border-zinc-200 p-3">
                            <div className="text-xs text-zinc-600">Libellé</div>
                            <div className="mt-1 font-medium">{selectedEntry.label}</div>
                          </div>
                        </div>
                      )}
                      <div className="rounded-lg border border-zinc-200 p-3">
                        <div className="text-xs text-zinc-600">Notes</div>
                        <div className="mt-1 text-zinc-800">{selectedEntry.notes?.trim() ? selectedEntry.notes : '—'}</div>
                      </div>
                    </div>
                  ) : null}

                  {detailMode === 'edit' && entryEditForm ? (
                    <form className="mt-4 grid grid-cols-1 gap-3 sm:grid-cols-2" onSubmit={submitEditEntry}>
                      <label className="flex flex-col gap-1 text-sm">
                        <span className="text-zinc-700">Type</span>
                        <select
                          className="rounded-lg border border-zinc-200 px-3 py-2 outline-none focus:border-zinc-400"
                          value={entryEditForm.entry_type ?? selectedEntry.entry_type}
                          onChange={(e) =>
                            setEntryEditForm((p) =>
                              p ? { ...p, entry_type: e.target.value as 'income' | 'expense' } : p
                            )
                          }
                          disabled={detailSubmitting}
                        >
                          <option value="income">Income</option>
                          <option value="expense">Expense</option>
                        </select>
                      </label>
                      <label className="flex flex-col gap-1 text-sm">
                        <span className="text-zinc-700">Date</span>
                        <input
                          className="rounded-lg border border-zinc-200 px-3 py-2 outline-none focus:border-zinc-400"
                          type="date"
                          value={entryEditForm.entry_date ?? selectedEntry.entry_date}
                          onChange={(e) =>
                            setEntryEditForm((p) => (p ? { ...p, entry_date: e.target.value } : p))
                          }
                          disabled={detailSubmitting}
                        />
                      </label>

                      {editIsFuelIncome ? (
                        <div className="sm:col-span-2 rounded-xl border border-emerald-200 bg-emerald-50 p-4">
                          <div className="text-xs font-medium text-emerald-900">Résultat (carburant)</div>
                          <div className="mt-3 grid grid-cols-1 gap-3 sm:grid-cols-2">
                            <div className="rounded-lg border border-emerald-200 bg-white p-3">
                              <div className="text-xs text-emerald-900">Carburant dû (Ar)</div>
                              <div className="mt-1 text-2xl font-semibold tabular-nums text-emerald-950">
                                {editFuelDueAriary == null ? '—' : `${formatAriary(editFuelDueAriary)} Ar`}
                              </div>
                            </div>
                            <div className="rounded-lg border border-emerald-200 bg-white p-3">
                              <div className="text-xs text-emerald-900">Km du jour</div>
                              <div className="mt-1 text-2xl font-semibold tabular-nums text-emerald-950">
                                {editFuelKmDay == null ? '—' : new Intl.NumberFormat('fr-FR').format(editFuelKmDay)}
                              </div>
                            </div>
                          </div>
                        </div>
                      ) : null}

                      {editIsFuelIncome ? (
                        <div className="sm:col-span-2 rounded-xl border border-zinc-200 bg-white p-4">
                          <div className="text-xs font-medium text-zinc-900">Saisie métier</div>
                          <div className="mt-3 grid grid-cols-1 gap-3 sm:grid-cols-2">
                            <label className="flex flex-col gap-1 text-sm">
                              <span className="text-zinc-700">Km départ</span>
                              <input
                                className="rounded-lg border border-zinc-200 px-3 py-2 outline-none focus:border-zinc-400"
                                inputMode="numeric"
                                value={editFuelKmStartText}
                                onChange={(e) => setEditFuelKmStartText(e.target.value)}
                                onBlur={() => setEditFuelKmStartText((v) => formatDigitsFr(v))}
                                disabled={detailSubmitting}
                              />
                            </label>
                            <label className="flex flex-col gap-1 text-sm">
                              <span className="text-zinc-700">Km retour</span>
                              <input
                                className="rounded-lg border border-zinc-200 px-3 py-2 outline-none focus:border-zinc-400"
                                inputMode="numeric"
                                value={editFuelKmEndText}
                                onChange={(e) => setEditFuelKmEndText(e.target.value)}
                                onBlur={() => setEditFuelKmEndText((v) => formatDigitsFr(v))}
                                disabled={detailSubmitting}
                              />
                            </label>
                            <label className="flex flex-col gap-1 text-sm">
                              <span className="text-zinc-700">Prix litre (Ar)</span>
                              <input
                                className="rounded-lg border border-zinc-200 px-3 py-2 outline-none focus:border-zinc-400"
                                inputMode="numeric"
                                value={editFuelPriceText}
                                onChange={(e) => setEditFuelPriceText(e.target.value)}
                                onBlur={() => setEditFuelPriceText((v) => formatDigitsFr(v))}
                                disabled={detailSubmitting}
                              />
                            </label>
                            <label className="flex flex-col gap-1 text-sm">
                              <span className="text-zinc-700">Consommation (L/km)</span>
                              <input
                                className="rounded-lg border border-zinc-200 px-3 py-2 outline-none focus:border-zinc-400"
                                inputMode="decimal"
                                value={editFuelConsumptionText}
                                onChange={(e) => setEditFuelConsumptionText(e.target.value)}
                                disabled={detailSubmitting}
                              />
                            </label>
                          </div>
                        </div>
                      ) : editIsFuelRecharge ? (
                        <div className="sm:col-span-2 rounded-xl border border-zinc-200 bg-zinc-50 p-4">
                          <div className="text-xs font-medium text-zinc-900">Recharge carburant</div>
                          <div className="mt-3 grid grid-cols-1 gap-3 sm:grid-cols-2">
                            <label className="flex flex-col gap-1 text-sm sm:col-span-2">
                              <span className="text-zinc-700">Relevé kilométrique (compteur)</span>
                              <input
                                className="rounded-lg border border-zinc-200 bg-white px-3 py-2 outline-none focus:border-zinc-400"
                                inputMode="numeric"
                                value={editOdometerText}
                                onChange={(e) => setEditOdometerText(e.target.value)}
                                onBlur={() => setEditOdometerText((v) => formatDigitsFr(v))}
                                disabled={detailSubmitting}
                              />
                            </label>
                            <label className="flex flex-col gap-1 text-sm">
                              <span className="text-zinc-700">Litres ajoutés</span>
                              <input
                                className="rounded-lg border border-zinc-200 bg-white px-3 py-2 outline-none focus:border-zinc-400"
                                inputMode="decimal"
                                value={editFuelRechargeLitresText}
                                onChange={(e) => {
                                  const next = e.target.value;
                                  setEditFuelRechargeLitresText(next);
                                  const v = data?.vehicle;
                                  if (vehicleFuelRefsUsable(v) && v) {
                                    const parsed = parseFloatOrNull(next);
                                    if (parsed != null && Number.isFinite(parsed) && parsed > 0) {
                                      setEditFuelRechargeKmCreditedText(
                                        String(
                                          kmCreditedFromLitresRounded(parsed, v.fuel_ref_litres!, v.fuel_ref_km!)
                                        )
                                      );
                                    }
                                  }
                                }}
                                disabled={detailSubmitting}
                              />
                            </label>
                            <label className="flex flex-col gap-1 text-sm">
                              <span className="text-zinc-700">Km crédités</span>
                              <input
                                className="rounded-lg border border-zinc-200 bg-white px-3 py-2 outline-none focus:border-zinc-400"
                                inputMode="decimal"
                                value={editFuelRechargeKmCreditedText}
                                onChange={(e) => setEditFuelRechargeKmCreditedText(e.target.value)}
                                disabled={detailSubmitting}
                              />
                            </label>
                            <label className="flex flex-col gap-1 text-sm">
                              <span className="text-zinc-700">Prix litre (Ar)</span>
                              <input
                                className="rounded-lg border border-zinc-200 bg-white px-3 py-2 outline-none focus:border-zinc-400"
                                inputMode="numeric"
                                value={editFuelPriceText}
                                onChange={(e) => setEditFuelPriceText(e.target.value)}
                                onBlur={() => setEditFuelPriceText((v) => formatDigitsFr(v))}
                                disabled={detailSubmitting}
                              />
                            </label>
                            <label className="flex flex-col gap-1 text-sm">
                              <span className="text-zinc-700">Consommation (L/km)</span>
                              <input
                                className="rounded-lg border border-zinc-200 bg-white px-3 py-2 outline-none focus:border-zinc-400"
                                inputMode="decimal"
                                value={editFuelConsumptionText}
                                onChange={(e) => setEditFuelConsumptionText(e.target.value)}
                                disabled={detailSubmitting}
                              />
                            </label>
                            <label className="flex flex-col gap-1 text-sm sm:col-span-2">
                              <span className="text-zinc-700">Coût (Ar)</span>
                              <input
                                className="rounded-lg border border-zinc-200 bg-white px-3 py-2 outline-none focus:border-zinc-400"
                                inputMode="numeric"
                                value={editAmountText}
                                onChange={(e) => setEditAmountText(e.target.value)}
                                onBlur={() => setEditAmountText((v) => formatDigitsFr(v))}
                                disabled={detailSubmitting}
                              />
                            </label>
                          </div>
                        </div>
                      ) : (
                        <>
                          <label className="flex flex-col gap-1 text-sm">
                            <span className="text-zinc-700">Montant (Ar)</span>
                            <input
                              className="rounded-lg border border-zinc-200 px-3 py-2 outline-none focus:border-zinc-400"
                              inputMode="numeric"
                              value={editAmountText}
                              onChange={(e) => setEditAmountText(e.target.value)}
                              onBlur={() => setEditAmountText((v) => formatDigitsFr(v))}
                              disabled={detailSubmitting}
                            />
                          </label>
                          <label className="flex flex-col gap-1 text-sm">
                            <span className="text-zinc-700">Kilométrage (km)</span>
                            <input
                              className="rounded-lg border border-zinc-200 px-3 py-2 outline-none focus:border-zinc-400"
                              inputMode="numeric"
                              placeholder="optionnel"
                              value={editOdometerText}
                              onChange={(e) => setEditOdometerText(e.target.value)}
                              onBlur={() => setEditOdometerText((v) => formatDigitsFr(v))}
                              disabled={detailSubmitting}
                            />
                          </label>
                          <label className="flex flex-col gap-1 text-sm sm:col-span-2">
                            <span className="text-zinc-700">Catégorie</span>
                            <select
                              className="rounded-lg border border-zinc-200 px-3 py-2 outline-none focus:border-zinc-400"
                              value={String(entryEditForm.category ?? selectedEntry.category)}
                              onChange={(e) => {
                                const next = e.target.value;
                                setEntryEditForm((p) =>
                                  p
                                    ? {
                                        ...p,
                                        category: next,
                                        // Keep fuel_mode empty unless user explicitly chooses it later;
                                        // backend will infer legacy vs structured when switching to carburant.
                                        fuel_mode: next === 'carburant' ? (p.fuel_mode ?? null) : null,
                                      }
                                    : p
                                );
                              }}
                              disabled={detailSubmitting}
                            >
                              <option value="achat_vehicule">achat_vehicule</option>
                              <option value="loyer">loyer</option>
                              <option value="entretien">entretien</option>
                              <option value="reparation">reparation</option>
                              <option value="carburant">carburant</option>
                              <option value="assurance">assurance</option>
                              <option value="autre">autre</option>
                            </select>
                          </label>
                          <label className="flex flex-col gap-1 text-sm sm:col-span-2">
                            <span className="text-zinc-700">Libellé</span>
                            <input
                              className="rounded-lg border border-zinc-200 px-3 py-2 outline-none focus:border-zinc-400"
                              value={String(entryEditForm.label ?? selectedEntry.label)}
                              onChange={(e) =>
                                setEntryEditForm((p) => (p ? { ...p, label: e.target.value } : p))
                              }
                              disabled={detailSubmitting}
                            />
                          </label>
                        </>
                      )}

                      <label className="flex flex-col gap-1 text-sm sm:col-span-2">
                        <span className="text-zinc-700">{editIsFuel ? 'Observation' : 'Notes'}</span>
                        <input
                          className="rounded-lg border border-zinc-200 px-3 py-2 outline-none focus:border-zinc-400"
                          value={String(entryEditForm.notes ?? '')}
                          onChange={(e) =>
                            setEntryEditForm((p) => (p ? { ...p, notes: e.target.value } : p))
                          }
                          disabled={detailSubmitting}
                        />
                      </label>

                      {detailError ? (
                        <div className="sm:col-span-2 rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-900">
                          {detailError}
                        </div>
                      ) : null}
                      {editIsFuelIncome && editFuelInlineError ? (
                        <div className="sm:col-span-2 rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-sm text-amber-900">
                          {editFuelInlineError}
                        </div>
                      ) : null}
                      <div className="sm:col-span-2 mt-1 flex justify-end gap-2">
                        <button
                          type="button"
                          className="rounded-lg border border-zinc-200 bg-white px-3 py-2 text-sm hover:bg-zinc-100 disabled:opacity-50"
                          disabled={detailSubmitting}
                          onClick={() => setDetailMode('read')}
                        >
                          Annuler
                        </button>
                        <button
                          type="submit"
                          className="rounded-lg border border-zinc-800 bg-zinc-900 px-3 py-2 text-sm font-medium text-white hover:bg-zinc-800 disabled:opacity-50"
                          disabled={
                            detailSubmitting ||
                            (editIsFuelIncome && (editFuelDueAriary == null || editFuelInlineError != null))
                          }
                        >
                          {detailSubmitting ? 'Enregistrement…' : 'Enregistrer'}
                        </button>
                      </div>
                    </form>
                  ) : null}

                  {detailMode === 'read' && detailError ? (
                    <div className="mt-3 rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-900">
                      {detailError}
                    </div>
                  ) : null}
                </div>
              </div>
            ) : null}

            {assignOpen ? (
              <div
                className="fixed inset-0 z-50 flex items-start justify-center overflow-y-auto bg-black/40 p-2 sm:items-center sm:p-4"
                role="presentation"
                onClick={() => !assignSubmitting && setAssignOpen(false)}
              >
                <div
                  role="dialog"
                  aria-modal="true"
                  aria-labelledby="assign-title"
                  className="my-6 w-full max-w-lg rounded-xl border border-zinc-200 bg-white p-4 shadow-lg sm:my-0 sm:p-5 max-h-[calc(100vh-3rem)] overflow-y-auto"
                  onClick={(e) => e.stopPropagation()}
                  onKeyDown={(e) => e.stopPropagation()}
                >
                  <h2 id="assign-title" className="text-lg font-semibold text-zinc-900">
                    Affecter / réaffecter un chauffeur
                  </h2>
                  <p className="mt-1 text-sm text-zinc-600">
                    L’atomicité et les règles de non-recouvrement sont gérées côté DB/API.
                  </p>
                  <form className="mt-4 flex flex-col gap-3" onSubmit={submitAssign}>
                    <label className="flex flex-col gap-1 text-sm">
                      <span className="text-zinc-700">Chauffeur</span>
                      <select
                        className="rounded-lg border border-zinc-200 px-3 py-2 outline-none focus:border-zinc-400"
                        value={driverId}
                        onChange={(e) => setDriverId(e.target.value)}
                        disabled={assignSubmitting || driversLoading}
                      >
                        <option value="">
                          {driversLoading ? 'Chargement…' : 'Sélectionner…'}
                        </option>
                        {drivers
                          .filter((d) => isUuidString(String(d.driver_id ?? '')))
                          .map((d) => (
                            <option key={d.driver_id} value={d.driver_id}>
                              {(d.full_name ?? 'Chauffeur').trim()} · {d.phone ?? '—'}
                            </option>
                          ))}
                      </select>
                    </label>

                    <label className="flex flex-col gap-1 text-sm">
                      <span className="text-zinc-700">Début (optionnel)</span>
                      <input
                        className="rounded-lg border border-zinc-200 px-3 py-2 outline-none focus:border-zinc-400"
                        type="datetime-local"
                        value={startsAt}
                        onChange={(e) => setStartsAt(e.target.value)}
                        disabled={assignSubmitting}
                      />
                      <span className="text-xs text-zinc-500">
                        Si vide, l’API utilise “maintenant”. Sinon, l’API peut refuser si chevauchement.
                      </span>
                    </label>

                    <label className="flex flex-col gap-1 text-sm">
                      <span className="text-zinc-700">Notes</span>
                      <input
                        className="rounded-lg border border-zinc-200 px-3 py-2 outline-none focus:border-zinc-400"
                        value={assignNotes}
                        onChange={(e) => setAssignNotes(e.target.value)}
                        disabled={assignSubmitting}
                      />
                    </label>

                    {assignError ? (
                      <div className="rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-900">
                        {assignError}
                      </div>
                    ) : null}

                    <div className="mt-2 flex justify-end gap-2">
                      <button
                        type="button"
                        className="rounded-lg border border-zinc-200 bg-white px-3 py-2 text-sm hover:bg-zinc-100 disabled:opacity-50"
                        disabled={assignSubmitting}
                        onClick={() => setAssignOpen(false)}
                      >
                        Annuler
                      </button>
                      <button
                        type="submit"
                        className="rounded-lg border border-zinc-800 bg-zinc-900 px-3 py-2 text-sm font-medium text-white hover:bg-zinc-800 disabled:opacity-50"
                        disabled={assignSubmitting}
                      >
                        {assignSubmitting ? 'Affectation…' : 'Affecter'}
                      </button>
                    </div>
                  </form>
                </div>
              </div>
            ) : null}
          </div>
        ) : null}
      </AdminShell>
    </RequireAuth>
  );
}

