/** UUID v1–v5 shape (case-insensitive), aligned with backend admin-api validation. */
const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export function isUuidString(v: string): boolean {
  return UUID_RE.test(v.trim());
}

export function normalizeUuidParam(raw: unknown): string {
  if (typeof raw === 'string') return raw.trim();
  if (Array.isArray(raw) && typeof raw[0] === 'string') return raw[0].trim();
  return '';
}
