'use client';

import { AdminShell } from '@/components/layout/AdminShell';
import { RequireAuth } from '@/components/auth/RequireAuth';

export default function DriverDetailPage(props: { params: { driverId: string } }) {
  const driverId = props.params.driverId;
  return (
    <RequireAuth>
      <AdminShell title="Détail chauffeur">
        <div className="text-sm text-zinc-700">
          Détail chauffeur (placeholder). Driver ID: <span className="font-mono">{driverId}</span>
        </div>
      </AdminShell>
    </RequireAuth>
  );
}

