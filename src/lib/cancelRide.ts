import { supabase } from './supabase';

const LOG = '[ride-cancel]';

const USER: Record<string, string> = {
  CANCEL_RIDE_NOT_FOUND: 'Course introuvable.',
  CANCEL_RIDE_FORBIDDEN: 'Vous ne pouvez pas annuler cette course.',
  CANCEL_RIDE_NOT_REQUESTED:
    'Cette course ne peut plus être annulée (déjà prise en charge ou terminée).',
  CANCEL_RIDE_NOT_ALLOWED:
    'Annulation impossible : la course est déjà payée ou en cours.',
};

/** Erreurs métier : débloquer l’UI locale (ride plus annulable / plus la vôtre). */
const CLEAR_PENDING_CODES = new Set([
  'CANCEL_RIDE_NOT_FOUND',
  'CANCEL_RIDE_FORBIDDEN',
  'CANCEL_RIDE_NOT_REQUESTED',
]);

export class CancelRideError extends Error {
  readonly clearPendingRide: boolean;

  constructor(message: string, clearPendingRide: boolean) {
    super(message);
    this.name = 'CancelRideError';
    this.clearPendingRide = clearPendingRide;
  }
}

function parseRpcFailure(error: { message?: string }): CancelRideError {
  const raw = error.message ?? '';
  if (raw.includes('CANCEL_RIDE_NOT_ALLOWED')) {
    return new CancelRideError(USER.CANCEL_RIDE_NOT_ALLOWED, false);
  }
  for (const code of CLEAR_PENDING_CODES) {
    if (raw.includes(code)) {
      return new CancelRideError(USER[code] ?? raw, true);
    }
  }
  return new CancelRideError(
    raw.trim() || 'Impossible d’annuler la course.',
    false
  );
}

export async function cancelRideAsClient(rideId: string): Promise<void> {
  const { error } = await supabase.rpc('cancel_ride', { p_ride_id: rideId });

  if (error) {
    if (__DEV__) {
      console.error(`${LOG} error`, error.message);
    }
    throw parseRpcFailure(error);
  }

  if (__DEV__) {
    console.log(`${LOG} success`, rideId);
  }
}
