import { useCallback, useEffect, useState } from 'react';

import { supabase } from '../lib/supabase';
import type { Profile } from '../types/profile';

type ProfileState = {
  profile: Profile | null;
  loading: boolean;
  error: string | null;
  refresh: () => Promise<void>;
};

export function useProfile(userId: string | undefined): ProfileState {
  const [profile, setProfile] = useState<Profile | null>(null);
  const [loading, setLoading] = useState(!!userId);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    if (!userId) {
      setProfile(null);
      setLoading(false);
      setError(null);
      return;
    }
    setLoading(true);
    setError(null);
    const { data, error: queryError } = await supabase
      .from('profiles')
      .select('id, role, full_name, phone')
      .eq('id', userId)
      .maybeSingle();

    if (queryError) {
      setError(queryError.message);
      setProfile(null);
    } else {
      setProfile(data as Profile | null);
    }
    setLoading(false);
  }, [userId]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  return { profile, loading, error, refresh };
}
