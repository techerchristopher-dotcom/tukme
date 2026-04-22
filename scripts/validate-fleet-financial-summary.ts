/**
 * Cas de validation pour la règle d’agrégation des recettes (synthèse financière).
 * Exécution : node --experimental-strip-types scripts/validate-fleet-financial-summary.ts
 */
import assert from 'node:assert/strict';
import { incomeAmountForFleetKpi } from '../supabase/functions/admin-api/fleet_financial_aggregates.ts';

function row(
  entry_type: string,
  category: string,
  amount: number
): { entry_type: string; category: string; amount_ariary: number } {
  return { entry_type, category, amount_ariary: amount };
}

// Cas A — recettes simples + carburant entièrement payé via paiements
{
  const totalIncome =
    incomeAmountForFleetKpi(row('income', 'loyer', 50_000), 0) +
    incomeAmountForFleetKpi(row('income', 'carburant', 40_000), 40_000);
  assert.equal(totalIncome, 90_000);
  const totalExpense = 18_050;
  assert.equal(totalIncome - totalExpense, 90_000 - 18_050);
}

// Cas B — carburant partiel + legacy avec paiements (encaissements réels seulement)
{
  const income =
    incomeAmountForFleetKpi(row('income', 'carburant', 32_500), 12_500) +
    incomeAmountForFleetKpi(row('income', 'carburant', 40_000), 20_000);
  assert.equal(income, 32_500);
  const net = income - 160_000;
  assert.equal(net, -127_500);
}

// Cas B bis — legacy sans paiement : le montant de ligne compte
{
  assert.equal(incomeAmountForFleetKpi(row('income', 'carburant', 40_000), 0), 40_000);
}

// Cas C — plusieurs lignes legacy même jour (agrégation = somme des contributions)
{
  const sum =
    incomeAmountForFleetKpi(row('income', 'carburant', 10_000), 3_000) +
    incomeAmountForFleetKpi(row('income', 'carburant', 5_000), 2_000);
  assert.equal(sum, 5_000);
}

// Catégorie modifiée conceptuellement : hors carburant, les paiements passés en paramètre sont ignorés
{
  assert.equal(incomeAmountForFleetKpi(row('income', 'loyer', 25_000), 99_999), 25_000);
}

// Ne pas compter expense dans les recettes
{
  assert.equal(incomeAmountForFleetKpi(row('expense', 'carburant', 160_000), 0), 0);
}

// Cas double paiement (8 500 = 4 500 + 4 000) — contribution recettes = cumul paiements, pas nominal + paiements
{
  const due = 8_500;
  assert.equal(incomeAmountForFleetKpi(row('income', 'carburant', due), 4_500), 4_500);
  assert.equal(incomeAmountForFleetKpi(row('income', 'carburant', due), 8_500), 8_500);
  assert.notEqual(incomeAmountForFleetKpi(row('income', 'carburant', due), 8_500), due + 4_500);
  assert.notEqual(incomeAmountForFleetKpi(row('income', 'carburant', due), 8_500), 12_500);
}

console.log('validate-fleet-financial-summary: OK');
