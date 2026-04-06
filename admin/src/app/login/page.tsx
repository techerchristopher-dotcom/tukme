'use client';

import { useMemo, useState } from 'react';
import { useRouter } from 'next/navigation';
import { getSupabaseBrowser } from '@/lib/supabaseBrowserClient';

export default function LoginPage() {
  const router = useRouter();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  const configError = useMemo(() => {
    const url = process.env.NEXT_PUBLIC_SUPABASE_URL ?? '';
    const key = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ?? '';
    if (!url || !key) {
      return 'Config manquante: NEXT_PUBLIC_SUPABASE_URL / NEXT_PUBLIC_SUPABASE_ANON_KEY.';
    }
    return null;
  }, []);

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (configError) return;
    setError(null);
    setLoading(true);
    try {
      const supabase = getSupabaseBrowser();
      if (!supabase) {
        setError('Config Supabase manquante.');
        return;
      }
      const { error } = await supabase.auth.signInWithPassword({
        email: email.trim(),
        password,
      });
      if (error) {
        setError(error.message);
        return;
      }
      router.replace('/dashboard');
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="min-h-screen bg-zinc-50 text-zinc-900">
      <div className="mx-auto flex min-h-screen max-w-md flex-col justify-center px-4">
        <div className="rounded-xl border border-zinc-200 bg-white p-6">
          <h1 className="text-xl font-semibold">Connexion admin</h1>
          <p className="mt-1 text-sm text-zinc-600">
            Utilisez un compte dans la allowlist.
          </p>

          {configError ? (
            <div className="mt-4 rounded-lg border border-amber-200 bg-amber-50 p-3 text-sm text-amber-900">
              {configError}
            </div>
          ) : null}

          {error ? (
            <div className="mt-4 rounded-lg border border-red-200 bg-red-50 p-3 text-sm text-red-900">
              {error}
            </div>
          ) : null}

          <form className="mt-4 flex flex-col gap-3" onSubmit={onSubmit}>
            <label className="flex flex-col gap-1 text-sm">
              <span className="text-zinc-700">Email</span>
              <input
                className="rounded-lg border border-zinc-200 px-3 py-2 outline-none focus:border-zinc-400"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                autoComplete="email"
                inputMode="email"
              />
            </label>

            <label className="flex flex-col gap-1 text-sm">
              <span className="text-zinc-700">Mot de passe</span>
              <input
                className="rounded-lg border border-zinc-200 px-3 py-2 outline-none focus:border-zinc-400"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                autoComplete="current-password"
                type="password"
              />
            </label>

            <button
              className="mt-2 rounded-lg bg-zinc-900 px-3 py-2 text-sm font-medium text-white hover:bg-zinc-800 disabled:opacity-50"
              disabled={loading || !!configError}
              type="submit"
            >
              {loading ? 'Connexion…' : 'Se connecter'}
            </button>
          </form>
        </div>
        <div className="mt-4 text-xs text-zinc-500">
          Accès restreint. Les données admin passent par une Edge Function.
        </div>
      </div>
    </div>
  );
}

