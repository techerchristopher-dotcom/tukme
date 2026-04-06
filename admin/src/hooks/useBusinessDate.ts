import { useEffect, useMemo, useState } from 'react';

export function toMadagascarBusinessDate(d: Date): string {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Indian/Antananarivo',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(d);
  const y = parts.find((p) => p.type === 'year')?.value ?? '';
  const m = parts.find((p) => p.type === 'month')?.value ?? '';
  const day = parts.find((p) => p.type === 'day')?.value ?? '';
  return `${y}-${m}-${day}`;
}

export function useBusinessDate() {
  const [date, setDate] = useState<string>(() => toMadagascarBusinessDate(new Date()));

  useEffect(() => {
    // Keep it fresh if tab stays open across midnight (Madagascar time).
    const id = setInterval(() => {
      const next = toMadagascarBusinessDate(new Date());
      setDate((prev) => (prev === next ? prev : next));
    }, 60_000);
    return () => clearInterval(id);
  }, []);

  return useMemo(() => ({ businessDate: date, setBusinessDate: setDate }), [date]);
}

