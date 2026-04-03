import { useEffect, useMemo, useState } from 'react';

import { supabase } from '../lib/supabase';
import {
  getZoneFromAddress,
  getZoneFromCoords,
  type ZoneRow,
} from '../lib/zoneGeo';
import type { ClientDestination } from '../types/clientDestination';
import type { RidePricingEstimate } from '../types/ridePricing';

/** Forfait app si zones non détectées ou couple absent de `zone_pricing`. */
const FALLBACK_PRICE_ARIARY = 10_000;
const FALLBACK_PRICE_EUR = 2;

type ZonePricingRow = {
  price_eur: number;
  price_ariary: number;
};

async function fetchZones(): Promise<{ rows: ZoneRow[]; error: Error | null }> {
  const { data, error } = await supabase
    .from('zones')
    .select('id,name,min_lat,max_lat,min_lng,max_lng,match_priority')
    .order('match_priority', { ascending: true });

  if (error) {
    return { rows: [], error: new Error(error.message) };
  }
  return { rows: (data ?? []) as ZoneRow[], error: null };
}

export function useRideZonePricing(params: {
  pickupLat: number | null;
  pickupLng: number | null;
  destination: ClientDestination | null;
}): RidePricingEstimate | null {
  const { pickupLat, pickupLng, destination } = params;

  const [zoneRows, setZoneRows] = useState<ZoneRow[]>([]);
  const [zonesReady, setZonesReady] = useState(false);

  const [priceRow, setPriceRow] = useState<ZonePricingRow | null>(null);
  const [priceLoading, setPriceLoading] = useState(false);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      const { rows, error } = await fetchZones();
      if (cancelled) {
        return;
      }
      setZonesReady(true);
      if (error) {
        setZoneRows([]);
        if (__DEV__) {
          console.warn('[zones] Erreur chargement zones Supabase:', error.message);
        }
        return;
      }
      setZoneRows(rows);
      if (__DEV__) {
        console.log('[zones] Zones chargées:', rows.length);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  const pickupZone = useMemo(() => {
    if (
      pickupLat == null ||
      pickupLng == null ||
      zoneRows.length === 0 ||
      !zonesReady
    ) {
      return null;
    }
    if (__DEV__) {
      console.log('[zones] GPS utilisateur (départ):', pickupLat, pickupLng);
    }
    const z = getZoneFromCoords(pickupLat, pickupLng, zoneRows);
    if (__DEV__) {
      console.log('[zones] Zone départ détectée:', z);
    }
    return z;
  }, [pickupLat, pickupLng, zoneRows, zonesReady]);

  const destinationZone = useMemo(() => {
    if (!destination || zoneRows.length === 0 || !zonesReady) {
      return null;
    }
    const destinationAddress = destination.label;
    const fromAddress = getZoneFromAddress(destinationAddress, zoneRows);
    const fromCoords = getZoneFromCoords(
      destination.latitude,
      destination.longitude,
      zoneRows
    );
    const z = fromAddress ?? fromCoords;

    if (__DEV__) {
      console.log('[zones] destinationAddress reçu:', destinationAddress);
      console.log('[zones] getZoneFromAddress →', fromAddress);
      console.log(
        '[zones] Coords destination (Places):',
        destination.latitude,
        destination.longitude
      );
      console.log('[zones] getZoneFromCoords →', fromCoords);
      console.log('[zones] Zone destination finale:', z);
    }
    return z;
  }, [destination, zoneRows, zonesReady]);

  useEffect(() => {
    if (!pickupZone || !destinationZone) {
      setPriceRow(null);
      setPriceLoading(false);
      return;
    }

    let cancelled = false;
    setPriceLoading(true);

    void (async () => {
      const { data, error } = await supabase
        .from('zone_pricing')
        .select('price_eur,price_ariary')
        .eq('from_zone', pickupZone)
        .eq('to_zone', destinationZone)
        .maybeSingle();

      if (cancelled) {
        return;
      }
      setPriceLoading(false);

      if (error) {
        if (__DEV__) {
          console.warn('[zones] Erreur tarif Supabase:', error.message);
        }
        setPriceRow(null);
        return;
      }

      if (data) {
        setPriceRow({
          price_eur: Number(data.price_eur),
          price_ariary: data.price_ariary,
        });
        if (__DEV__) {
          console.log(
            '[zones] Tarif trouvé:',
            pickupZone,
            '→',
            destinationZone,
            data
          );
        }
      } else {
        setPriceRow(null);
        if (__DEV__) {
          console.log(
            '[zones] Aucune ligne zone_pricing pour',
            pickupZone,
            '→',
            destinationZone
          );
        }
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [pickupZone, destinationZone]);

  return useMemo((): RidePricingEstimate | null => {
    if (!destination) {
      return null;
    }

    if (!zonesReady) {
      return {
        pickupZone: null,
        destinationZone: null,
        estimatedPriceAriary: 0,
        estimatedPriceEuro: 0,
        pricingMode: 'loading',
      };
    }

    if (zoneRows.length === 0) {
      return {
        pickupZone: null,
        destinationZone: null,
        estimatedPriceAriary: FALLBACK_PRICE_ARIARY,
        estimatedPriceEuro: FALLBACK_PRICE_EUR,
        pricingMode: 'fallback',
      };
    }

    if (pickupZone === null || destinationZone === null) {
      return {
        pickupZone,
        destinationZone,
        estimatedPriceAriary: FALLBACK_PRICE_ARIARY,
        estimatedPriceEuro: FALLBACK_PRICE_EUR,
        pricingMode: 'fallback',
      };
    }

    if (priceLoading) {
      return {
        pickupZone,
        destinationZone,
        estimatedPriceAriary: 0,
        estimatedPriceEuro: 0,
        pricingMode: 'loading',
      };
    }

    if (priceRow) {
      return {
        pickupZone,
        destinationZone,
        estimatedPriceAriary: priceRow.price_ariary,
        estimatedPriceEuro: priceRow.price_eur,
        pricingMode: 'normal',
      };
    }

    return {
      pickupZone,
      destinationZone,
      estimatedPriceAriary: FALLBACK_PRICE_ARIARY,
      estimatedPriceEuro: FALLBACK_PRICE_EUR,
      pricingMode: 'fallback',
    };
  }, [
    destination,
    zonesReady,
    zoneRows.length,
    pickupZone,
    destinationZone,
    priceLoading,
    priceRow,
  ]);
}
