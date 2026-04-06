import { supabase } from './supabase';

const LOG = '[driver-ride-progress]';

export class DriverRideProgressError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'DriverRideProgressError';
  }
}

function mapRpcError(raw: string): string {
  if (raw.includes('START_EN_ROUTE_NOT_ALLOWED')) {
    return 'Impossible de passer en route (vérifiez le statut de la course).';
  }
  if (raw.includes('MARK_ARRIVED_NOT_ALLOWED')) {
    return 'Impossible de signaler l’arrivée (étape précédente requise).';
  }
  if (raw.includes('START_RIDE_NOT_ALLOWED')) {
    return 'Impossible de démarrer la course (étape précédente requise).';
  }
  if (raw.includes('COMPLETE_RIDE_NOT_ALLOWED')) {
    return 'Impossible de terminer la course (elle doit être en cours).';
  }
  if (
    raw.includes('START_EN_ROUTE_NOT_DRIVER') ||
    raw.includes('MARK_ARRIVED_NOT_DRIVER') ||
    raw.includes('START_RIDE_NOT_DRIVER') ||
    raw.includes('COMPLETE_RIDE_NOT_DRIVER')
  ) {
    return 'Compte non autorisé.';
  }
  return raw.trim() || 'Action impossible pour le moment.';
}

export async function rpcStartEnRoute(rideId: string): Promise<void> {
  const { error } = await supabase.rpc('start_en_route', { p_ride_id: rideId });
  if (error) {
    if (__DEV__) {
      console.error(`${LOG} start_en_route`, error.message);
    }
    throw new DriverRideProgressError(mapRpcError(error.message ?? ''));
  }
}

export async function rpcMarkArrived(rideId: string): Promise<void> {
  const { error } = await supabase.rpc('mark_arrived', { p_ride_id: rideId });
  if (error) {
    if (__DEV__) {
      console.error(`${LOG} mark_arrived`, error.message);
    }
    throw new DriverRideProgressError(mapRpcError(error.message ?? ''));
  }
}

export async function rpcStartRide(rideId: string): Promise<void> {
  const { error } = await supabase.rpc('start_ride', { p_ride_id: rideId });
  if (error) {
    if (__DEV__) {
      console.error(`${LOG} start_ride`, error.message);
    }
    throw new DriverRideProgressError(mapRpcError(error.message ?? ''));
  }
}

export async function rpcCompleteRide(rideId: string): Promise<void> {
  const { error } = await supabase.rpc('complete_ride', { p_ride_id: rideId });
  if (error) {
    if (__DEV__) {
      console.error(`${LOG} complete_ride`, error.message);
    }
    throw new DriverRideProgressError(mapRpcError(error.message ?? ''));
  }
}
