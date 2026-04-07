/** Destination côté client (non persistée en base pour l’instant). */
export type ClientDestination = {
  label: string;
  latitude: number;
  longitude: number;
  /** Place ID Google (Places API), utile pour la suite (trajet, cache…). */
  placeId?: string;
  /** Photo principale (Places API New) si disponible. */
  photoName?: string | null;
};
