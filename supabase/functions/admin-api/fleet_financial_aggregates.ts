/**
 * Fleet manual — KPI "Total recettes" (agrégation synthèse financière)
 *
 * Règle unique (cash / encaissements réels, sans double comptage) :
 *
 * - Recettes hors carburant-chauffeur : `amount_ariary` de la ligne (encaissement tel que saisi).
 * - Recettes `income` + catégorie `carburant` : `amount_ariary` représente la dette / poste nominal
 *   (kilométrage × conso × prix en structuré, ou montant déclaré en legacy). Les encaissements réels
 *   sont dans `fleet_vehicle_entry_payments`.
 *   - Si la somme des paiements actifs pour cette écriture est **> 0**, la recette KPI est **uniquement**
 *     cette somme (on n’ajoute pas le nominal : évite double comptage montant + paiements).
 *   - Si **aucun** paiement n’existe encore pour cette écriture, on retombe sur `amount_ariary`
 *     (données historiques avant journal des paiements, ou legacy saisi comme encaissement direct).
 *
 * Les badges UI (legacy, partiel, payé) ne sont pas utilisés ici : seuls montant nominal, paiements
 * agrégés et type/catégorie comptent.
 *
 * Dépenses : inchangé — toujours `amount_ariary` pour `entry_type === 'expense'`.
 */

export type FleetEntryLikeForKpi = {
  entry_type: unknown;
  category: unknown;
  amount_ariary: unknown;
};

export function incomeAmountForFleetKpi(row: FleetEntryLikeForKpi, totalPaidFromPayments: number): number {
  const et = String(row.entry_type ?? '').trim().toLowerCase();
  if (et !== 'income') return 0;

  const raw = row.amount_ariary;
  const due = typeof raw === 'number' ? raw : Number(raw ?? 0);
  if (!Number.isFinite(due) || due <= 0) return 0;

  const cat = String(row.category ?? '').trim().toLowerCase();
  if (cat !== 'carburant') {
    return Math.trunc(due);
  }

  const paid = Number.isFinite(totalPaidFromPayments) ? Math.max(0, Math.trunc(totalPaidFromPayments)) : 0;
  if (paid > 0) return paid;
  return Math.trunc(due);
}
