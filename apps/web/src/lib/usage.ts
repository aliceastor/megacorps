export type UsageStatus = 'actual' | 'estimated' | 'unknown';
export type UsageSummary = {
  actualUsd: string; estimatedUsd: string; totalUsd: string; reservedUsd: string;
  unknownAttempts: number; attempts: number;
  period: { key: string; start: string; end: string; timezone: 'UTC' } | null;
  reservationAsOf?: string; accounting?: string; taskScope?: string;
};
export type CostEvent = {
  id: string; agentId: string; cardId?: string | null; provider?: string | null; model?: string | null;
  costUsd: string | null; costStatus?: UsageStatus; source?: string; occurredAt?: string;
  usage?: { costStatus: UsageStatus; tokenStatus: UsageStatus; totalTokens?: number | null; costSource?: string; tokenSource?: string } | null;
};

/** Keep the server's decimal precision; never pass accounting strings through Number. */
export function formatUsd(value: string | null | undefined): string {
  if (typeof value !== 'string' || !/^\d+(?:\.\d{1,8})?$/.test(value)) return '—';
  const [whole, fraction = ''] = value.split('.');
  return `$${whole}.${fraction.replace(/0+$/, '').padEnd(2, '0')}`;
}

export function currentUtcMonth(): string { return new Date().toISOString().slice(0, 7); }
