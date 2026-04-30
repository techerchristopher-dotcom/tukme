'use client';

import Link from 'next/link';
import { useEffect, useMemo, useState, type FormEvent } from 'react';

import { AdminShell } from '@/components/layout/AdminShell';
import { RequireAuth } from '@/components/auth/RequireAuth';
import { createFleetVehicle, getFleetVehicles } from '@/lib/adminApi';
import { formatAriary } from '@/lib/money';
import type { FleetVehicleCreateInput, FleetVehicleListItem, FleetVehicleStatus } from '@/lib/types';

function normalizeStatus(v: string): FleetVehicleStatus | 'all' {
  const t = v.trim().toLowerCase();
  if (t === 'all') return 'all';
  if (t === 'active' || t === 'inactive' || t === 'sold' || t === 'retired') return t;
  return 'all';
}

export default function FleetVehiclesPage() {
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [items, setItems] = useState<FleetVehicleListItem[]>([]);
  const [count, setCount] = useState(0);
  const [refreshSeq, setRefreshSeq] = useState(0);

  const [q, setQ] = useState('');
  const [status, setStatus] = useState<'all' | FleetVehicleStatus>('all');

  const [createOpen, setCreateOpen] = useState(false);
  const [createSubmitting, setCreateSubmitting] = useState(false);
  const [createError, setCreateError] = useState<string | null>(null);
  const [form, setForm] = useState<FleetVehicleCreateInput>({
    plate_number: '',
    brand: '',
    model: '',
    status: 'active',
    purchase_price_ariary: null,
    purchase_date: null,
    amortization_months: null,
    target_resale_price_ariary: null,
    daily_rent_ariary: null,
    notes: '',
  });

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      setLoading(true);
      setError(null);
      const res = await getFleetVehicles({
        q: q.trim() ? q.trim() : null,
        status: status === 'all' ? null : status,
        limit: 50,
        offset: 0,
      });
      if (cancelled) return;
      if (res.error) {
        setError(res.error.message);
        setItems([]);
        setCount(0);
      } else {
        setItems(res.data.items);
        setCount(res.data.count);
      }
      setLoading(false);
    })();
    return () => {
      cancelled = true;
    };
  }, [q, status, refreshSeq]);

  useEffect(() => {
    if (!createOpen) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && !createSubmitting) setCreateOpen(false);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [createOpen, createSubmitting]);

  const visible = useMemo(() => items, [items]);

  function openCreate() {
    setCreateError(null);
    setForm({
      plate_number: '',
      brand: '',
      model: '',
      status: 'active',
      purchase_price_ariary: null,
      purchase_date: null,
      amortization_months: null,
      target_resale_price_ariary: null,
      daily_rent_ariary: null,
      notes: '',
    });
    setCreateOpen(true);
  }

  function parseIntOrNull(s: string): number | null {
    const t = s.trim();
    if (!t) return null;
    const n = Number.parseInt(t, 10);
    return Number.isInteger(n) ? n : null;
  }

  async function submitCreate(e: FormEvent) {
    e.preventDefault();
    setCreateError(null);
    const plate = form.plate_number.trim();
    if (!plate) {
      setCreateError('Plaque obligatoire.');
      return;
    }
    setCreateSubmitting(true);
    const res = await createFleetVehicle({
      ...form,
      plate_number: plate,
      brand: form.brand?.trim() ? form.brand.trim() : null,
      model: form.model?.trim() ? form.model.trim() : null,
      notes: form.notes?.trim() ? form.notes.trim() : null,
    });
    setCreateSubmitting(false);
    if (res.error) {
      setCreateError(res.error.message);
      return;
    }
    setCreateOpen(false);
    setRefreshSeq((s) => s + 1);
  }

  const isEmpty = !loading && !error && visible.length === 0;

  return (
    <RequireAuth>
      <AdminShell title="Suivi du parc">
        <div className="flex flex-col gap-3 md:flex-row md:items-end md:justify-between md:gap-4">
          <div className="flex flex-col gap-3 md:flex-row md:flex-wrap md:items-end md:gap-3">
            <label className="flex flex-col gap-1 text-sm">
              <span className="text-zinc-700">Recherche plaque</span>
              <input
                className="w-full md:w-56 rounded-lg border border-zinc-200 px-3 py-2 outline-none focus:border-zinc-400"
                placeholder="ex: 1234TAA"
                value={q}
                onChange={(e) => setQ(e.target.value)}
              />
            </label>
            <label className="flex flex-col gap-1 text-sm">
              <span className="text-zinc-700">Statut</span>
              <select
                className="w-full md:w-48 rounded-lg border border-zinc-200 px-3 py-2 outline-none focus:border-zinc-400"
                value={status}
                onChange={(e) => setStatus(normalizeStatus(e.target.value))}
              >
                <option value="all">Tous</option>
                <option value="active">Actif</option>
                <option value="inactive">Inactif</option>
                <option value="sold">Vendu</option>
                <option value="retired">Retiré</option>
              </select>
            </label>
            <div className="flex flex-col gap-2 md:flex-row md:items-center">
              <button
                type="button"
                className="w-full md:w-auto rounded-lg border border-zinc-200 bg-white px-3 py-2 text-sm hover:bg-zinc-100 disabled:opacity-50"
                disabled={loading}
                onClick={() => setRefreshSeq((s) => s + 1)}
              >
                {loading ? 'Chargement…' : 'Rafraîchir'}
              </button>
              <button
                type="button"
                className="w-full md:w-auto rounded-lg border border-zinc-800 bg-zinc-900 px-3 py-2 text-sm font-medium text-white hover:bg-zinc-800 disabled:opacity-50"
                disabled={loading || createSubmitting}
                onClick={openCreate}
              >
                Créer un véhicule
              </button>
            </div>
          </div>

          <div className="text-sm text-zinc-600">
            {loading ? 'Chargement…' : error ? 'Erreur' : `${visible.length} véhicules (sur ${count})`}
          </div>
        </div>

        {error ? (
          <div className="mt-4 rounded-lg border border-red-200 bg-red-50 p-3 text-sm text-red-900">
            {error}
          </div>
        ) : null}

        <div className="mt-4 overflow-x-auto">
          <table className="min-w-full border-separate border-spacing-0 text-sm">
            <thead>
              <tr className="text-left text-xs text-zinc-600">
                <th className="border-b border-zinc-200 px-3 py-2">Plaque</th>
                <th className="border-b border-zinc-200 px-3 py-2">Marque / modèle</th>
                <th className="border-b border-zinc-200 px-3 py-2">Statut</th>
                <th className="border-b border-zinc-200 px-3 py-2">Chauffeur actuel</th>
                <th className="border-b border-zinc-200 px-3 py-2">Achat (Ar)</th>
                <th className="border-b border-zinc-200 px-3 py-2">Loyer/j (Ar)</th>
                <th className="border-b border-zinc-200 px-3 py-2">Net</th>
                <th className="border-b border-zinc-200 px-3 py-2">Reste amort.</th>
                <th className="border-b border-zinc-200 px-3 py-2">Actions</th>
              </tr>
            </thead>
            <tbody>
              {visible.map((v) => (
                <tr key={v.id} className="hover:bg-zinc-50">
                  <td className="border-b border-zinc-100 px-3 py-2">
                    <div className="font-mono font-semibold">
                      <Link href={`/fleet/${encodeURIComponent(v.id)}`} className="hover:underline">
                        {v.plate_number ?? '—'}
                      </Link>
                    </div>
                    <div className="text-xs text-zinc-500">{v.id}</div>
                  </td>
                  <td className="border-b border-zinc-100 px-3 py-2">
                    <div className="font-medium text-zinc-900">
                      {[v.brand, v.model].filter(Boolean).join(' ') || '—'}
                    </div>
                  </td>
                  <td className="border-b border-zinc-100 px-3 py-2">
                    <span className="inline-block rounded-full border border-zinc-200 bg-zinc-100 px-2 py-0.5 text-xs text-zinc-700">
                      {v.status ?? '—'}
                    </span>
                  </td>
                  <td className="border-b border-zinc-100 px-3 py-2">
                    {v.active_assignment ? (
                      <div>
                        <div className="font-medium text-zinc-900">
                          {v.active_assignment.driver_full_name ?? 'Chauffeur'}
                        </div>
                        <div className="text-xs text-zinc-500">
                          {v.active_assignment.driver_phone ?? '—'} · depuis{' '}
                          {new Date(v.active_assignment.starts_at).toLocaleDateString('fr-FR')}
                        </div>
                      </div>
                    ) : (
                      <span className="text-zinc-500">—</span>
                    )}
                  </td>
                  <td className="border-b border-zinc-100 px-3 py-2 tabular-nums">
                    {formatAriary(v.purchase_price_ariary)}
                  </td>
                  <td className="border-b border-zinc-100 px-3 py-2 tabular-nums">
                    {formatAriary(v.daily_rent_ariary)}
                  </td>
                  <td className="border-b border-zinc-100 px-3 py-2 text-zinc-500">—</td>
                  <td className="border-b border-zinc-100 px-3 py-2 text-zinc-500">—</td>
                  <td className="border-b border-zinc-100 px-3 py-2 whitespace-nowrap">
                    <Link
                      href={`/fleet/${encodeURIComponent(v.id)}`}
                      className="rounded-lg border border-zinc-200 bg-white px-2 py-1 text-xs hover:bg-zinc-100"
                    >
                      Ouvrir
                    </Link>
                  </td>
                </tr>
              ))}
              {!loading && !visible.length ? (
                <tr>
                  <td className="px-3 py-6 text-sm text-zinc-500" colSpan={9}>
                    {isEmpty ? 'Aucun véhicule.' : 'Aucun résultat.'}
                  </td>
                </tr>
              ) : null}
            </tbody>
          </table>
        </div>

        {createOpen ? (
          <div
            className="fixed inset-0 z-50 flex items-start justify-center overflow-y-auto bg-black/40 p-2 sm:items-center sm:p-4"
            role="presentation"
            onClick={() => !createSubmitting && setCreateOpen(false)}
          >
            <div
              role="dialog"
              aria-modal="true"
              aria-labelledby="create-vehicle-title"
              className="my-6 w-full max-w-lg rounded-xl border border-zinc-200 bg-white p-4 shadow-lg sm:my-0 sm:p-5 max-h-[90vh] overflow-hidden"
              onClick={(e) => e.stopPropagation()}
              onKeyDown={(e) => e.stopPropagation()}
            >
              <div className="flex max-h-[90vh] flex-col">
                <div className="sticky top-0 z-10 -mx-4 border-b border-zinc-200 bg-white px-4 pb-3 sm:-mx-5 sm:px-5">
                  <div className="flex items-start justify-between gap-3">
                    <h2 id="create-vehicle-title" className="text-lg font-semibold text-zinc-900">
                      Nouveau véhicule
                    </h2>
                    <button
                      type="button"
                      className="shrink-0 rounded-lg border border-zinc-200 bg-white px-3 py-2 text-sm hover:bg-zinc-100 disabled:opacity-50"
                      disabled={createSubmitting}
                      onClick={() => setCreateOpen(false)}
                    >
                      Fermer
                    </button>
                  </div>
                </div>

                <form className="flex-1 min-h-0 overflow-y-auto overflow-x-hidden pt-4 grid grid-cols-1 gap-3 sm:grid-cols-2" onSubmit={submitCreate}>
                <label className="flex flex-col gap-1 text-sm sm:col-span-1">
                  <span className="text-zinc-700">Plaque</span>
                  <input
                    className="rounded-lg border border-zinc-200 px-3 py-2 font-mono outline-none focus:border-zinc-400"
                    value={form.plate_number}
                    onChange={(e) => setForm((p) => ({ ...p, plate_number: e.target.value }))}
                    required
                    disabled={createSubmitting}
                  />
                </label>
                <label className="flex flex-col gap-1 text-sm sm:col-span-1">
                  <span className="text-zinc-700">Statut</span>
                  <select
                    className="rounded-lg border border-zinc-200 px-3 py-2 outline-none focus:border-zinc-400"
                    value={form.status ?? 'active'}
                    onChange={(e) =>
                      setForm((p) => ({ ...p, status: normalizeStatus(e.target.value) === 'all' ? 'active' : (normalizeStatus(e.target.value) as FleetVehicleStatus) }))
                    }
                    disabled={createSubmitting}
                  >
                    <option value="active">Actif</option>
                    <option value="inactive">Inactif</option>
                    <option value="sold">Vendu</option>
                    <option value="retired">Retiré</option>
                  </select>
                </label>
                <label className="flex flex-col gap-1 text-sm sm:col-span-1">
                  <span className="text-zinc-700">Marque</span>
                  <input
                    className="rounded-lg border border-zinc-200 px-3 py-2 outline-none focus:border-zinc-400"
                    value={String(form.brand ?? '')}
                    onChange={(e) => setForm((p) => ({ ...p, brand: e.target.value }))}
                    disabled={createSubmitting}
                  />
                </label>
                <label className="flex flex-col gap-1 text-sm sm:col-span-1">
                  <span className="text-zinc-700">Modèle</span>
                  <input
                    className="rounded-lg border border-zinc-200 px-3 py-2 outline-none focus:border-zinc-400"
                    value={String(form.model ?? '')}
                    onChange={(e) => setForm((p) => ({ ...p, model: e.target.value }))}
                    disabled={createSubmitting}
                  />
                </label>
                <label className="flex flex-col gap-1 text-sm sm:col-span-1">
                  <span className="text-zinc-700">Prix d’achat (Ar)</span>
                  <input
                    className="rounded-lg border border-zinc-200 px-3 py-2 outline-none focus:border-zinc-400"
                    inputMode="numeric"
                    value={form.purchase_price_ariary == null ? '' : String(form.purchase_price_ariary)}
                    onChange={(e) =>
                      setForm((p) => ({ ...p, purchase_price_ariary: parseIntOrNull(e.target.value) }))
                    }
                    disabled={createSubmitting}
                  />
                </label>
                <label className="flex flex-col gap-1 text-sm sm:col-span-1">
                  <span className="text-zinc-700">Date d’achat</span>
                  <input
                    className="rounded-lg border border-zinc-200 px-3 py-2 outline-none focus:border-zinc-400"
                    type="date"
                    value={form.purchase_date ?? ''}
                    onChange={(e) => setForm((p) => ({ ...p, purchase_date: e.target.value || null }))}
                    disabled={createSubmitting}
                  />
                </label>
                <label className="flex flex-col gap-1 text-sm sm:col-span-1">
                  <span className="text-zinc-700">Durée amort. (mois)</span>
                  <input
                    className="rounded-lg border border-zinc-200 px-3 py-2 outline-none focus:border-zinc-400"
                    inputMode="numeric"
                    value={form.amortization_months == null ? '' : String(form.amortization_months)}
                    onChange={(e) =>
                      setForm((p) => ({ ...p, amortization_months: parseIntOrNull(e.target.value) }))
                    }
                    disabled={createSubmitting}
                  />
                </label>
                <label className="flex flex-col gap-1 text-sm sm:col-span-1">
                  <span className="text-zinc-700">Revente cible (Ar)</span>
                  <input
                    className="rounded-lg border border-zinc-200 px-3 py-2 outline-none focus:border-zinc-400"
                    inputMode="numeric"
                    value={form.target_resale_price_ariary == null ? '' : String(form.target_resale_price_ariary)}
                    onChange={(e) =>
                      setForm((p) => ({ ...p, target_resale_price_ariary: parseIntOrNull(e.target.value) }))
                    }
                    disabled={createSubmitting}
                  />
                </label>
                <label className="flex flex-col gap-1 text-sm sm:col-span-1">
                  <span className="text-zinc-700">Loyer journalier (Ar)</span>
                  <input
                    className="rounded-lg border border-zinc-200 px-3 py-2 outline-none focus:border-zinc-400"
                    inputMode="numeric"
                    value={form.daily_rent_ariary == null ? '' : String(form.daily_rent_ariary)}
                    onChange={(e) =>
                      setForm((p) => ({ ...p, daily_rent_ariary: parseIntOrNull(e.target.value) }))
                    }
                    disabled={createSubmitting}
                  />
                </label>
                <label className="flex flex-col gap-1 text-sm sm:col-span-2">
                  <span className="text-zinc-700">Notes</span>
                  <input
                    className="rounded-lg border border-zinc-200 px-3 py-2 outline-none focus:border-zinc-400"
                    value={String(form.notes ?? '')}
                    onChange={(e) => setForm((p) => ({ ...p, notes: e.target.value }))}
                    disabled={createSubmitting}
                  />
                </label>

                {createError ? (
                  <div className="sm:col-span-2 rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-900">
                    {createError}
                  </div>
                ) : null}

                <div className="sm:col-span-2 mt-1 flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
                  <button
                    type="button"
                    className="w-full sm:w-auto rounded-lg border border-zinc-200 bg-white px-3 py-2 text-sm hover:bg-zinc-100 disabled:opacity-50"
                    disabled={createSubmitting}
                    onClick={() => setCreateOpen(false)}
                  >
                    Annuler
                  </button>
                  <button
                    type="submit"
                    className="w-full sm:w-auto rounded-lg border border-zinc-800 bg-zinc-900 px-3 py-2 text-sm font-medium text-white hover:bg-zinc-800 disabled:opacity-50"
                    disabled={createSubmitting}
                  >
                    {createSubmitting ? 'Création…' : 'Créer'}
                  </button>
                </div>
              </form>
              </div>
            </div>
          </div>
        ) : null}
      </AdminShell>
    </RequireAuth>
  );
}

