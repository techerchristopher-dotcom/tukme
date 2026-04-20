'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { getSupabaseBrowser } from '@/lib/supabaseBrowserClient';

const nav = [
  { href: '/dashboard', label: 'Dashboard' },
  { href: '/drivers', label: 'Chauffeurs' },
  { href: '/rides', label: 'Courses' },
  { href: '/payouts', label: 'Payouts' },
  { href: '/rents', label: 'Locations' },
  { href: '/fleet', label: 'Suivi du parc' },
];

export function AdminShell(props: { title: string; children: React.ReactNode }) {
  const { title, children } = props;
  const pathname = usePathname();

  return (
    <div className="min-h-screen bg-zinc-50 text-zinc-900">
      <div className="mx-auto max-w-7xl px-4 py-6">
        <div className="grid grid-cols-12 gap-6">
          <aside className="col-span-12 md:col-span-3">
            <div className="rounded-xl border border-zinc-200 bg-white p-4">
              <div className="mb-4 text-sm font-semibold">Tukme Admin</div>
              <nav className="flex flex-col gap-1">
                {nav.map((item) => {
                  const active = pathname === item.href;
                  return (
                    <Link
                      key={item.href}
                      href={item.href}
                      className={`rounded-lg px-3 py-2 text-sm ${
                        active ? 'bg-zinc-900 text-white' : 'text-zinc-700 hover:bg-zinc-100'
                      }`}
                    >
                      {item.label}
                    </Link>
                  );
                })}
              </nav>
            </div>
          </aside>

          <main className="col-span-12 md:col-span-9">
            <div className="mb-4 flex items-center justify-between">
              <h1 className="text-xl font-semibold">{title}</h1>
              <button
                className="rounded-lg border border-zinc-200 bg-white px-3 py-2 text-sm hover:bg-zinc-100"
                onClick={() => void getSupabaseBrowser()?.auth.signOut()}
              >
                Déconnexion
              </button>
            </div>
            <div className="rounded-xl border border-zinc-200 bg-white p-4">{children}</div>
          </main>
        </div>
      </div>
    </div>
  );
}

