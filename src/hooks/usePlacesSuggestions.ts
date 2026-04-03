import { useEffect, useMemo, useState } from 'react';

import {
  fetchPlaceSuggestions,
  isPlacesConfigured,
  type PlaceSuggestionItem,
} from '../lib/googlePlaces';

type Params = {
  query: string;
  sessionToken: string;
  biasLat: number | null;
  biasLng: number | null;
  /** Après choix d’un lieu : ne pas relancer une recherche sur le libellé final. */
  suspended: boolean;
};

export function usePlacesSuggestions({
  query,
  sessionToken,
  biasLat,
  biasLng,
  suspended,
}: Params): {
  suggestions: PlaceSuggestionItem[];
  loading: boolean;
  error: string | null;
} {
  const [suggestions, setSuggestions] = useState<PlaceSuggestionItem[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const biasAround = useMemo(() => {
    if (biasLat == null || biasLng == null) {
      return null;
    }
    return { latitude: biasLat, longitude: biasLng };
  }, [biasLat, biasLng]);

  useEffect(() => {
    if (!isPlacesConfigured() || suspended) {
      setSuggestions([]);
      setLoading(false);
      return;
    }

    const q = query.trim();
    if (q.length < 2) {
      setSuggestions([]);
      setError(null);
      setLoading(false);
      return;
    }

    let cancelled = false;
    setLoading(true);
    setError(null);

    const timer = setTimeout(() => {
      void (async () => {
        try {
          const list = await fetchPlaceSuggestions({
            input: q,
            sessionToken,
            biasAround: biasAround ?? undefined,
            languageCode: 'fr',
            regionCode: 'fr',
          });
          if (!cancelled) {
            setSuggestions(list);
          }
        } catch (e) {
          if (!cancelled) {
            setSuggestions([]);
            setError(
              e instanceof Error
                ? e.message
                : 'Recherche Google Places indisponible.'
            );
          }
        } finally {
          if (!cancelled) {
            setLoading(false);
          }
        }
      })();
    }, 380);

    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [query, sessionToken, biasAround, suspended]);

  return { suggestions, loading, error };
}

export type { PlaceSuggestionItem };
