export function formatAriary(value: unknown): string {
  const n = typeof value === 'number' ? value : Number.NaN;
  if (!Number.isFinite(n)) return '—';
  return new Intl.NumberFormat('fr-FR').format(n);
}

