/** Statuts `public.ride_status` (aligné schéma Supabase). */
export type ClientRideStatus =
  | 'requested'
  | 'accepted'
  | 'in_progress'
  | 'completed'
  | 'cancelled_by_client'
  | 'cancelled_by_driver'
  | 'expired';

/** Données minimales pour suivi client + Realtime. */
export type ClientRideSnapshot = {
  id: string;
  status: ClientRideStatus;
  driver_id: string | null;
  updated_at: string;
};
