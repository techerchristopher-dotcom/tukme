export type RidePricingMode = 'normal' | 'fallback' | 'loading';

export type RidePricingEstimate = {
  pickupZone: string | null;
  destinationZone: string | null;
  estimatedPriceAriary: number;
  estimatedPriceEuro: number;
  pricingMode: RidePricingMode;
};
