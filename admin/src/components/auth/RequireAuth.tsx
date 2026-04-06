'use client';

import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { getSupabaseBrowser } from '@/lib/supabaseBrowserClient';

export function RequireAuth(props: { children: React.ReactNode }) {
  const { children } = props;
  const router = useRouter();
  const [ready, setReady] = useState(false);

  useEffect(() => {
    const supabase = getSupabaseBrowser();
    if (!supabase) {
      router.replace('/login');
      return;
    }
    let cancelled = false;
    void (async () => {
      const {
        data: { session },
      } = await supabase.auth.getSession();
      if (cancelled) return;
      if (!session?.access_token) {
        router.replace('/login');
        return;
      }
      setReady(true);
    })();
    const { data } = supabase.auth.onAuthStateChange((_evt, session) => {
      if (!session?.access_token) {
        router.replace('/login');
      }
    });
    return () => {
      cancelled = true;
      data.subscription.unsubscribe();
    };
  }, [router]);

  if (!ready) {
    return <div className="text-sm text-zinc-600">Chargement…</div>;
  }

  return <>{children}</>;
}

