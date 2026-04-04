import { useEffect, useMemo, useState } from 'react';

import { supabase } from '../lib/supabase';
import {
  resolveZoneFromLabelAndCoords,
  type ZoneRow,
} from '../lib/zoneGeo';
import type { ClientDestination } from '../types/clientDestination';
import type { RidePricingEstimate } from '../types/ridePricing';

/** Forfait app si zones non détectées ou couple absent de `zone_pricing`. */
const FALLBACK_PRICE_ARIARY = 10_000;
const FALLBACK_PRICE_EUR = 2;

const LOG = '[zone-debug]';

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
  /** Texte optionnel (ex. reverse geocode) pour aligner départ / destination. */
  pickupLabel: string | null;
  destination: ClientDestination | null;
}): RidePricingEstimate | null {
  const { pickupLat, pickupLng, pickupLabel, destination } = params;

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
          console.warn(`${LOG}[zones] Erreur chargement:`, error.message);
        }
        return;
      }
      setZoneRows(rows);
      if (__DEV__) {
        const names = rows.map((z) => z.name);
        console.log(`${LOG}[zones] count=`, rows.length, 'names=', names);
        const amba = rows.find((z) => z.name === 'Ambatoloaka');
        if (amba) {
          console.log(`${LOG}[zones] Ambatoloaka bbox Supabase:`, {
            min_lat: amba.min_lat,
            max_lat: amba.max_lat,
            min_lng: amba.min_lng,
            max_lng: amba.max_lng,
            match_priority: amba.match_priority,
          });
        } else {
          console.log(`${LOG}[zones] Aucune ligne nommée "Ambatoloaka" dans le jeu chargé`);
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  const pickupResolution = useMemo(() => {
    if (!zonesReady || zoneRows.length === 0) {
      return {
        fromText: null as string | null,
        fromCoords: null as string | null,
        zone: null as string | null,
      };
    }
    return resolveZoneFromLabelAndCoords(
      pickupLabel,
      pickupLat,
      pickupLng,
      zoneRows
    );
  }, [zonesReady, zoneRows, pickupLabel, pickupLat, pickupLng]);

  const pickupZone = pickupResolution.zone;

  useEffect(() => {
    if (!__DEV__ || !zonesReady || zoneRows.length === 0) {
      return;
    }
    console.log(`${LOG}[pickup] lat,lng=`, pickupLat, pickupLng);
    console.log(
      `${LOG}[pickup] label (reverse geocode)=`,
      pickupLabel ?? '(absent)'
    );
    console.log(`${LOG}[pickup] zone texte=`, pickupResolution.fromText);
    console.log(`${LOG}[pickup] zone GPS=`, pickupResolution.fromCoords);
    console.log(`${LOG}[pickup] zone finale=`, pickupZone);
    if (pickupZone == null) {
      console.log(
        `${LOG}[pickup] null → raison: texte=${
          pickupLabel?.trim()
            ? pickupResolution.fromText === null
              ? 'aucun name ne matche'
              : 'n/a'
            : 'pas de label'
        }; GPS=${
          pickupLat != null && pickupLng != null
            ? pickupResolution.fromCoords === null
              ? 'point hors de toutes les bbox'
              : 'n/a'
            : 'coords invalides/absentes'
        }`
      );
    }
  }, [
    zonesReady,
    zoneRows.length,
    pickupLat,
    pickupLng,
    pickupLabel,
    pickupResolution.fromText,
    pickupResolution.fromCoords,
    pickupZone,
  ]);

  const destinationResolution = useMemo(() => {
    if (!destination || !zonesReady || zoneRows.length === 0) {
      return {
        fromText: null as string | null,
        fromCoords: null as string | null,
        zone: null as string | null,
      };
    }
    return resolveZoneFromLabelAndCoords(
      destination.label,
      destination.latitude,
      destination.longitude,
      zoneRows
    );
  }, [destination, zonesReady, zoneRows]);

  const destinationZone = destinationResolution.zone;

  useEffect(() => {
    if (!__DEV__ || !destination || !zonesReady || zoneRows.length === 0) {
      return;
    }
    console.log(
      `${LOG}[destination] label (Places)=`,
      JSON.stringify(destination.label)
    );
    console.log(
      `${LOG}[destination] lat,lng=`,
      destination.latitude,
      destination.longitude
    );
    console.log(
      `${LOG}[destination] getZoneFromAddress →`,
      destinationResolution.fromText
    );
    console.log(
      `${LOG}[destination] getZoneFromCoords →`,
      destinationResolution.fromCoords
    );
    console.log(`${LOG}[destination] zone finale=`, destinationZone);
    if (destinationZone == null) {
      console.log(
        `${LOG}[destination] null → raison: texte=${
          destination.label?.trim()
            ? destinationResolution.fromText === null
              ? 'aucun name ne matche'
              : 'n/a'
            : 'label vide'
        }; GPS=${
          destinationResolution.fromCoords === null
            ? 'point hors de toutes les bbox'
            : 'n/a'
        }`
      );
    }
  }, [
    destination,
    zonesReady,
    zoneRows.length,
    destinationResolution.fromText,
    destinationResolution.fromCoords,
    destinationZone,
  ]);

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
          console.warn(`${LOG} Erreur zone_pricing:`, error.message);
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
            `${LOG} Tarif OK:`,
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
            `${LOG} Pas de ligne zone_pricing pour`,
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
