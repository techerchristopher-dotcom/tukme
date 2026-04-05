import { supabase } from './supabase';

const LOG = '[driver-release]';

export class DriverReleaseRideError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'DriverReleaseRideError';
  }
}

export async function driverReleaseRideBeforePayment(
  rideId: string
): Promise<void> {
  const { error } = await supabase.rpc('driver_release_ride_before_payment', {
    p_ride_id: rideId,
  });
  if (error) {
    if (__DEV__) {
      console.error(`${LOG}`, error.message);
    }
    const raw = error.message ?? '';
    if (raw.includes('DRIVER_RELEASE_NOT_ALLOWED')) {
      throw new DriverReleaseRideError(
        'Impossible de libérer cette course (déjà payée, expirée ou non assignée).'
      );
    }
    if (raw.includes('DRIVER_RELEASE_NOT_DRIVER')) {
      throw new DriverReleaseRideError('Compte non autorisé.');
    }
    throw new DriverReleaseRideError(
      raw.trim() || 'Impossible de libérer la course.'
    );
  }
}
