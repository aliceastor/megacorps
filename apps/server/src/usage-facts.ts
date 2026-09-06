/** Transport accounting facts. Never parse generated answer prose as billing. */
export type UsageStatus = 'actual' | 'estimated' | 'unknown';
export type UsageFacts = {
  costStatus: UsageStatus;
  tokenStatus: UsageStatus;
  source: string;
  costSource?: string;
  tokenSource?: string;
  costUsd: string | null;
  provider: string | null;
  model: string | null;
  inputTokens: number | null;
  outputTokens: number | null;
  cacheReadTokens: number | null;
  cacheWriteTokens: number | null;
  reasoningTokens: number | null;
  totalTokens: number | null;
  providerEventId?: string | null;
  occurredAt?: string | null;
};

export function unknownUsage(source = 'transport_usage_unavailable', estimatedTotalTokens?: number): UsageFacts {
  return { costStatus: 'unknown', tokenStatus: estimatedTotalTokens === undefined ? 'unknown' : 'estimated', source,
    costUsd: null, provider: null, model: null, inputTokens: null, outputTokens: null, cacheReadTokens: null,
    cacheWriteTokens: null, reasoningTokens: null, totalTokens: estimatedTotalTokens ?? null };
}

/** Eight decimal places, represented as integer units throughout arithmetic. */
export function moneyUnits(value: string | number): bigint {
  let text = String(value);
  if (typeof value === 'number' && /e/i.test(text)) {
    if (!Number.isFinite(value) || value < 0) throw new Error('usage_invalid_money');
    const [mantissa, exponent] = text.toLowerCase().split('e');
    const digits = mantissa!.replace('.', '');
    const point = (mantissa!.includes('.') ? mantissa!.indexOf('.') : mantissa!.length) + Number(exponent);
    text = point <= 0 ? `0.${'0'.repeat(-point)}${digits}` : point >= digits.length ? `${digits}${'0'.repeat(point - digits.length)}` : `${digits.slice(0, point)}.${digits.slice(point)}`;
  }
  const match = /^(\d{1,12})(?:\.(\d{1,8}))?$/.exec(text);
  if (!match) throw new Error('usage_invalid_money');
  return BigInt(match[1]!) * 100_000_000n + BigInt((match[2] ?? '').padEnd(8, '0'));
}
export function moneyString(units: bigint): string {
  const sign = units < 0n ? '-' : '';
  const absolute = units < 0n ? -units : units;
  return `${sign}${absolute / 100_000_000n}.${String(absolute % 100_000_000n).padStart(8, '0')}`;
}

/** Explicit opt-in transport extension; unknown/invalid contracts stay unknown.
 * 'actual' means reported by that authenticated transport, not invoice audited.
 */
export function transportUsage(raw: unknown, source: string): UsageFacts | undefined {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return undefined;
  const value = raw as Record<string, unknown>;
  if (value.version !== 1 || !['actual', 'estimated', 'unknown'].includes(String(value.costStatus)) || !['actual', 'estimated', 'unknown'].includes(String(value.tokenStatus))) return undefined;
  const result = unknownUsage(source);
  try {
    if (value.costStatus !== 'unknown') {
      if (typeof value.costUsd !== 'string' && typeof value.costUsd !== 'number') return undefined;
      result.costUsd = moneyString(moneyUnits(value.costUsd));
      result.costStatus = value.costStatus as UsageStatus;
    }
    for (const key of ['inputTokens', 'outputTokens', 'cacheReadTokens', 'cacheWriteTokens', 'reasoningTokens', 'totalTokens'] as const) {
      const token = value[key];
      if (token !== undefined && token !== null) {
        if (!Number.isSafeInteger(token) || Number(token) < 0) return undefined;
        result[key] = Number(token);
      }
    }
    result.tokenStatus = value.tokenStatus as UsageStatus;
    for (const key of ['provider', 'model', 'providerEventId'] as const) {
      if (value[key] !== undefined && value[key] !== null) {
        if (typeof value[key] !== 'string' || !(value[key] as string).trim() || (value[key] as string).length > 200) return undefined;
        result[key] = (value[key] as string).trim();
      }
    }
    if (value.occurredAt !== undefined) {
      if (typeof value.occurredAt !== 'string' || !/^\d{4}-\d\d-\d\dT.*(?:Z|[+-]\d\d:\d\d)$/.test(value.occurredAt) || !Number.isFinite(Date.parse(value.occurredAt))) return undefined;
      result.occurredAt = new Date(value.occurredAt).toISOString();
    }
    return result;
  } catch { return undefined; }
}
