/** Utilitaires d’affichage des montants (tarifs pilotés par Supabase : voir `useRideZonePricing`). */

export function formatAriary(value: number): string {
  return value.toLocaleString('fr-FR');
}
