'use client';
import { useLocale } from '@/lib/locale-context';
import { budgetCopy } from '@/lib/budget-copy';
import { formatUsd, type UsageSummary as Summary } from '@/lib/usage';

export function UsageSummary({ usage, includeTotal = true }: { usage: Summary; includeTotal?: boolean }) {
  const { locale } = useLocale(); const text = budgetCopy[locale];
  const values = [
    ...(includeTotal ? [[text.knownTotal, formatUsd(usage.totalUsd)]] : []),
    [text.actual, formatUsd(usage.actualUsd)], [text.estimated, formatUsd(usage.estimatedUsd)],
    [text.unknown, String(usage.unknownAttempts)], [text.reserved, formatUsd(usage.reservedUsd)],
  ];
  return <section className="usage-summary" aria-label={text.summary}>
    <p>{text.period}: {usage.period?.key ?? text.allTime} · UTC</p>
    <div className="stat-grid">{values.map(([label, value]) => <section className="card stat-card" key={label}><span>{label}</span><b className="usage-money">{value}</b></section>)}</div>
    <p className="usage-note">{text.knownHint}</p>
    <p className="usage-note">{text.reservationHint}</p>
  </section>;
}
