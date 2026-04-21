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
  patchFleetVehicleEntry,
  patchFleetVehicle,
  setFleetVehicleAssignment,
  softDeleteFleetVehicleEntry,
} from '@/lib/adminApi';
import { useBusinessDate } from '@/hooks/useBusinessDate';
import { formatAriary } from '@/lib/money';
import type {
  DriverDailySummaryRow,
  FleetEntryPatchInput,
  FleetEntryCreateInput,
  FleetFinancialSummary,
  FleetVehicleCreateInput,
  FleetVehicleDetailResponse,
  FleetEntryRow,
  FleetVehicleStatus,
} from '@/lib/types';
import { isUuidString, normalizeUuidParam } from '@/lib/uuid';

function asNonEmpty(v: unknown): string | null {
  return typeof v === 'string' && v.trim() ? v.trim() : null;
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
  const financial_summary =
    (r.financial_summary as FleetVehicleDetailResponse['financial_summary']) ?? null;

  return {
    vehicle,
    active_assignment,
    assignment_history,
    recent_entries,
    financial_summary,
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

  const [entryOpen, setEntryOpen] = useState(false);
  const [entrySubmitting, setEntrySubmitting] = useState(false);
  const [entryError, setEntryError] = useState<string | null>(null);
  const [entryAmountText, setEntryAmountText] = useState<string>('');
  const [entryOdometerText, setEntryOdometerText] = useState<string>('');
  const [fuelKmStartText, setFuelKmStartText] = useState<string>('');
  const [fuelKmEndText, setFuelKmEndText] = useState<string>('');
  const [fuelPriceText, setFuelPriceText] = useState<string>('');
  const [fuelConsumptionText, setFuelConsumptionText] = useState<string>('');
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

  const [editAmountText, setEditAmountText] = useState<string>('');
  const [editOdometerText, setEditOdometerText] = useState<string>('');
  const [editFuelKmStartText, setEditFuelKmStartText] = useState<string>('');
  const [editFuelKmEndText, setEditFuelKmEndText] = useState<string>('');
  const [editFuelPriceText, setEditFuelPriceText] = useState<string>('');
  const [editFuelConsumptionText, setEditFuelConsumptionText] = useState<string>('');
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
    });
    setEditOpen(true);
  }

  async function submitEdit(e: FormEvent) {
    e.preventDefault();
    if (!data || !editForm) return;
    setEditError(null);
    setEditSubmitting(true);
    const res = await patchFleetVehicle(data.vehicle.id, {
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
    });
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
    setEntryAmountText('');
    setEntryOdometerText('');
    setFuelKmStartText('');
    setFuelKmEndText('');
    setFuelPriceText('');
    setFuelConsumptionText('');
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

  const fuelInlineError = useMemo(() => {
    if (!isFuelEntry) return null;
    return computeFuelDerived({
      kmStartText: fuelKmStartText,
      kmEndText: fuelKmEndText,
      priceText: fuelPriceText,
      consumptionText: fuelConsumptionText,
    }).error;
  }, [isFuelEntry, fuelKmStartText, fuelKmEndText]);

  const fuelKmDay = useMemo(() => {
    if (!isFuelEntry) return null;
    return computeFuelDerived({
      kmStartText: fuelKmStartText,
      kmEndText: fuelKmEndText,
      priceText: fuelPriceText,
      consumptionText: fuelConsumptionText,
    }).kmDay;
  }, [isFuelEntry, fuelKmStartText, fuelKmEndText]);

  const fuelDueAriary = useMemo(() => {
    if (!isFuelEntry) return null;
    return computeFuelDerived({
      kmStartText: fuelKmStartText,
      kmEndText: fuelKmEndText,
      priceText: fuelPriceText,
      consumptionText: fuelConsumptionText,
    }).dueAriary;
  }, [isFuelEntry, fuelKmStartText, fuelKmEndText, fuelPriceText, fuelConsumptionText]);

  const fuelCanSubmit = isFuelEntry ? fuelDueAriary != null && !fuelInlineError : true;

  async function submitEntry(e: FormEvent) {
    e.preventDefault();
    if (!data) return;
    setEntryError(null);

    if (isFuelEntry) {
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

      setEntrySubmitting(true);
      const res = await createFleetVehicleEntry(data.vehicle.id, {
        entry_type: entryForm.entry_type,
        amount_ariary: due,
        odometer_km: null,
        entry_date: entryForm.entry_date,
        category: 'carburant',
        label: 'Carburant',
        notes: entryForm.notes?.trim() ? entryForm.notes.trim() : null,

        fuel_km_start: start,
        fuel_km_end: end,
        fuel_km_travelled: kmDay,
        fuel_price_per_litre_ariary_used: price,
        fuel_consumption_l_per_km_used: conso,
        fuel_due_ariary: due,
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
    setDetailOpen(true);
  }

  function beginEditEntry() {
    if (!selectedEntry) return;
    setDetailError(null);
    setDetailMode('edit');

    const isFuel = selectedEntry.category?.trim().toLowerCase() === 'carburant';
    setEntryEditForm({
      entry_type: selectedEntry.entry_type,
      entry_date: selectedEntry.entry_date,
      category: selectedEntry.category,
      label: selectedEntry.label,
      notes: selectedEntry.notes ?? null,
      ...(isFuel
        ? {
            fuel_km_start: selectedEntry.fuel_km_start ?? 0,
            fuel_km_end: selectedEntry.fuel_km_end ?? 0,
            fuel_price_per_litre_ariary_used: selectedEntry.fuel_price_per_litre_ariary_used ?? 0,
            fuel_consumption_l_per_km_used: selectedEntry.fuel_consumption_l_per_km_used ?? 0,
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
    } else {
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
    }
  }

  const editIsFuel = selectedEntry?.category?.trim().toLowerCase() === 'carburant';

  const editFuelKmDay = useMemo(() => {
    if (!detailOpen || detailMode !== 'edit' || !editIsFuel) return null;
    return computeFuelDerived({
      kmStartText: editFuelKmStartText,
      kmEndText: editFuelKmEndText,
      priceText: editFuelPriceText,
      consumptionText: editFuelConsumptionText,
    }).kmDay;
  }, [detailOpen, detailMode, editIsFuel, editFuelKmStartText, editFuelKmEndText]);

  const editFuelDueAriary = useMemo(() => {
    if (!detailOpen || detailMode !== 'edit' || !editIsFuel) return null;
    return computeFuelDerived({
      kmStartText: editFuelKmStartText,
      kmEndText: editFuelKmEndText,
      priceText: editFuelPriceText,
      consumptionText: editFuelConsumptionText,
    }).dueAriary;
  }, [detailOpen, detailMode, editIsFuel, editFuelKmStartText, editFuelKmEndText, editFuelPriceText, editFuelConsumptionText]);

  const editFuelInlineError = useMemo(() => {
    if (!detailOpen || detailMode !== 'edit' || !editIsFuel) return null;
    return computeFuelDerived({
      kmStartText: editFuelKmStartText,
      kmEndText: editFuelKmEndText,
      priceText: editFuelPriceText,
      consumptionText: editFuelConsumptionText,
    }).error;
  }, [detailOpen, detailMode, editIsFuel, editFuelKmStartText, editFuelKmEndText, editFuelPriceText, editFuelConsumptionText]);

  async function submitEditEntry(e: FormEvent) {
    e.preventDefault();
    if (!data || !selectedEntry || !entryEditForm) return;
    setDetailError(null);

    const patch: FleetEntryPatchInput = {
      entry_type: entryEditForm.entry_type,
      entry_date: entryEditForm.entry_date,
      category: (entryEditForm.category ?? selectedEntry.category).trim(),
      label: entryEditForm.label ?? selectedEntry.label,
      notes: entryEditForm.notes ?? null,
    };

    if (editIsFuel) {
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
                            : typeof e.odometer_km === 'number' && Number.isFinite(e.odometer_km)
                              ? new Intl.NumberFormat('fr-FR').format(e.odometer_km)
                              : '—'}
                        </td>
                        <td className="border-b border-zinc-100 px-2 py-2">{e.category}</td>
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
                className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4"
                role="presentation"
                onClick={() => !editSubmitting && setEditOpen(false)}
              >
                <div
                  role="dialog"
                  aria-modal="true"
                  aria-labelledby="edit-vehicle-title"
                  className="w-full max-w-lg rounded-xl border border-zinc-200 bg-white p-5 shadow-lg"
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
                className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4"
                role="presentation"
                onClick={() => !entrySubmitting && setEntryOpen(false)}
              >
                <div
                  role="dialog"
                  aria-modal="true"
                  aria-labelledby="add-entry-title"
                  className="w-full max-w-lg rounded-xl border border-zinc-200 bg-white p-5 shadow-lg"
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
                        onChange={(e) =>
                          setEntryForm((p) => ({ ...p, entry_type: e.target.value as 'income' | 'expense' }))
                        }
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

                    {/* Fuel but not income: keep a minimal, non-ambiguous summary (no manual amount). */}
                    {isFuelEntry && entryForm.entry_type !== 'income' ? (
                      <>
                        <div className="rounded-lg border border-zinc-200 px-3 py-2 text-sm">
                          <div className="text-xs text-zinc-600">Carburant dû (Ar)</div>
                          <div className="mt-1 font-semibold tabular-nums">
                            {fuelDueAriary == null ? '—' : `${formatAriary(fuelDueAriary)} Ar`}
                          </div>
                        </div>
                        <div className="rounded-lg border border-zinc-200 px-3 py-2 text-sm">
                          <div className="text-xs text-zinc-600">Km du jour</div>
                          <div className="mt-1 font-semibold tabular-nums">
                            {fuelKmDay == null ? '—' : new Intl.NumberFormat('fr-FR').format(fuelKmDay)}
                          </div>
                        </div>
                      </>
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

                    {isFuelEntry ? (
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
                    {isFuelEntry && fuelInlineError ? (
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
                className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4"
                role="presentation"
                onClick={() => !detailSubmitting && setDetailOpen(false)}
              >
                <div
                  role="dialog"
                  aria-modal="true"
                  aria-labelledby="entry-detail-title"
                  className="w-full max-w-lg rounded-xl border border-zinc-200 bg-white p-5 shadow-lg"
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
                        <div className="mt-1 font-medium">{selectedEntry.category}</div>
                      </div>
                      <div className="rounded-lg border border-zinc-200 p-3">
                        <div className="text-xs text-zinc-600">Montant (Ar)</div>
                        <div className="mt-1 font-semibold tabular-nums">{formatAriary(selectedEntry.amount_ariary)} Ar</div>
                      </div>
                      {selectedEntry.category?.trim().toLowerCase() === 'carburant' ? (
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

                      {editIsFuel ? (
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

                      {editIsFuel ? (
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
                            <input
                              className="rounded-lg border border-zinc-200 px-3 py-2 outline-none focus:border-zinc-400"
                              value={String(entryEditForm.category ?? selectedEntry.category)}
                              onChange={(e) =>
                                setEntryEditForm((p) => (p ? { ...p, category: e.target.value } : p))
                              }
                              disabled={detailSubmitting}
                            />
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
                      {editIsFuel && editFuelInlineError ? (
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
                          disabled={detailSubmitting || (editIsFuel && (editFuelDueAriary == null || editFuelInlineError != null))}
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
                className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4"
                role="presentation"
                onClick={() => !assignSubmitting && setAssignOpen(false)}
              >
                <div
                  role="dialog"
                  aria-modal="true"
                  aria-labelledby="assign-title"
                  className="w-full max-w-lg rounded-xl border border-zinc-200 bg-white p-5 shadow-lg"
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

