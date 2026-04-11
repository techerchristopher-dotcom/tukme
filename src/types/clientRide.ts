/** Colonne `rides.payment_method` (enum PostgreSQL). */
export type RidePaymentMethod = 'card' | 'cash';

/** Statuts `public.ride_status` (aligné schéma Supabase). */
export type ClientRideStatus =
  | 'requested'
  | 'awaiting_payment'
  | 'paid'
  | 'en_route'
  | 'arrived'
  | 'in_progress'
  | 'completed'
  | 'cancelled_by_client'
  | 'cancelled_by_driver'
  | 'expired';

/**
 * Snapshot ride côté client (fetch + Realtime).
 * Inclut la destination persistée en base pour réhydrater l’UI après reload.
 */
export type ClientRideSnapshot = {
  id: string;
  status: ClientRideStatus;
  driver_id: string | null;
  /** Snapshot identité chauffeur (pour UI client). */
  driver_display_name: string | null;
  /** Snapshot avatar chauffeur (Storage path) (pour UI client). */
  driver_avatar_path: string | null;
  /** Snapshot type véhicule (pour UI client). */
  vehicle_type: string | null;
  /** Snapshot plaque véhicule (pour UI client). */
  vehicle_plate: string | null;
  updated_at: string;
  /** Position chauffeur (nullable tant que non envoyée). */
  driver_lat: number | null;
  driver_lng: number | null;
  /** Dernière mise à jour position chauffeur (UTC ISO). */
  driver_location_updated_at: string | null;
  destination_label: string;
  destination_lat: number;
  destination_lng: number;
  destination_place_id: string | null;
  /** Libellé départ persisté en base (peut être null si reverse geocode a échoué). */
  pickup_label: string | null;
  /** Nombre de passagers (MVP 1–4). */
  passenger_count: number;
  /** Estimation EUR persistée (paiement Edge Function). */
  estimated_price_eur: number | null;
  /** Mode de paiement choisi (défaut `card` côté hydrate si absent). */
  payment_method: RidePaymentMethod;
  /** Fin de fenêtre de paiement (UTC, ISO) ; défini une seule fois côté serveur. */
  payment_expires_at: string | null;
  /** Horodatage fin de course (UTC ISO), si complétée. */
  ride_completed_at: string | null;
};
