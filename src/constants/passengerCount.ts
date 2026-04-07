/**
 * MVP Tukme — borne du sélecteur « nombre de passagers » côté client.
 * Aligné sur la contrainte SQL `rides_passenger_count_mvp_check`.
 */
export const PASSENGER_COUNT_MIN_MVP = 1;
/** Inclus : le client peut commander pour au plus ce nombre de passagers. */
export const PASSENGER_COUNT_MAX_MVP = 4;

export function multiplyBasePriceAriary(
  baseAriary: number,
  passengerCount: number
): number {
  return Math.round(baseAriary * passengerCount);
}

/** EUR facturée (2 décimales), pour `rides.estimated_price_eur` et Stripe. */
export function multiplyBasePriceEur(
  baseEur: number,
  passengerCount: number
): number {
  return Math.round(baseEur * passengerCount * 100) / 100;
}
