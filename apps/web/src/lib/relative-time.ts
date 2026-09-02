// Locale-aware relative time shared by the board list view, the checkpoint
// inbox and the card panel. Intl.RelativeTimeFormat with numeric: 'auto' gives
// "now" / "yesterday" style phrases for free in every locale we ship.

type Unit = 'second' | 'minute' | 'hour' | 'day' | 'week' | 'month' | 'year';

const UNIT_MS: Array<{ unit: Unit; ms: number; max: number }> = [
  { unit: 'second', ms: 1_000, max: 45_000 },
  { unit: 'minute', ms: 60_000, max: 60 * 60_000 },
  { unit: 'hour', ms: 3_600_000, max: 24 * 3_600_000 },
  { unit: 'day', ms: 86_400_000, max: 7 * 86_400_000 },
  { unit: 'week', ms: 7 * 86_400_000, max: 30 * 86_400_000 },
  { unit: 'month', ms: 30 * 86_400_000, max: 365 * 86_400_000 },
  { unit: 'year', ms: 365 * 86_400_000, max: Number.POSITIVE_INFINITY },
];

function toTime(value: string | Date | null | undefined): number | null {
  if (value === null || value === undefined || value === '') return null;
  const time = value instanceof Date ? value.getTime() : Date.parse(value);
  return Number.isFinite(time) ? time : null;
}

function relativeFormatter(locale: string): Intl.RelativeTimeFormat {
  try {
    return new Intl.RelativeTimeFormat(locale, { numeric: 'auto' });
  } catch {
    return new Intl.RelativeTimeFormat('en', { numeric: 'auto' });
  }
}

/** "5 minutes ago" / "5 分鐘前" / "yesterday". Empty string when the value is missing or unparsable. */
export function formatRelative(value: string | Date | null | undefined, now: number, locale: string): string {
  const time = toTime(value);
  if (time === null) return '';
  const diff = time - now;
  const magnitude = Math.abs(diff);
  const formatter = relativeFormatter(locale);
  if (magnitude < UNIT_MS[0]!.max) return formatter.format(0, 'second');
  for (const { unit, ms, max } of UNIT_MS) {
    if (magnitude < max) return formatter.format(Math.round(diff / ms), unit);
  }
  const last = UNIT_MS[UNIT_MS.length - 1]!;
  return formatter.format(Math.round(diff / last.ms), last.unit);
}

/** "4 hours" / "4 小時" for a waiting duration; never negative. */
export function formatDuration(ms: number, locale: string): string {
  const magnitude = Math.max(0, ms);
  let unit: Unit = 'minute';
  let value = Math.round(magnitude / 60_000);
  if (magnitude >= 24 * 3_600_000) {
    unit = 'day';
    value = Math.round(magnitude / 86_400_000);
  } else if (magnitude >= 3_600_000) {
    unit = 'hour';
    value = Math.round(magnitude / 3_600_000);
  } else if (magnitude < 60_000) {
    unit = 'second';
    value = Math.round(magnitude / 1_000);
  }
  try {
    return new Intl.NumberFormat(locale, { style: 'unit', unit, unitDisplay: 'long' }).format(value);
  } catch {
    return `${value} ${unit}${value === 1 ? '' : 's'}`;
  }
}
