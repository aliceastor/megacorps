import { randomUUID } from 'node:crypto';
import { and, eq } from 'drizzle-orm';
import { db } from './db/client.ts';
import { retryMergeGateWrite } from './db/merge-gate-write.ts';
import { activityLog, agents, agentRuntimes, budgetPolicies, budgetThresholds, companies, costEvents, heartbeatRuns, kanbanCards, projects, taskRuns, a2aExecutions, a2aExecutionAliases } from './db/schema.ts';
import { moneyString, moneyUnits, tokenFields, unknownUsage, type TokenField, type UsageFacts } from './usage-facts.ts';
import type { TaskResult } from './adapters/hermes.ts';
import { withUsageAttempt } from './usage-context.ts';
import { assertA2aTaskRunOwner } from './a2a-task-recovery.ts';

type Reader = Pick<typeof db, 'select' | 'insert' | 'update'>;
type Entry = typeof costEvents.$inferSelect;
type Agent = typeof agents.$inferSelect;
type Card = typeof kanbanCards.$inferSelect;
export type AttemptScope = {
  companyId: string; agentId: string; cardId?: string | null; projectId?: string | null;
  taskRunId?: string | null; heartbeatRunId?: string | null; runtimeId?: string | null;
  attemptKey: string; source: string; reportingSource?: string | null;
};
export function attemptKey(scope: { taskRunId?: string | null; heartbeatRunId?: string | null }): string {
  return scope.taskRunId ? `task-run:${scope.taskRunId}` : scope.heartbeatRunId ? `heartbeat:${scope.heartbeatRunId}` : `operation:${randomUUID()}`;
}
export function utcPeriod(at = new Date()) {
  const start = new Date(Date.UTC(at.getUTCFullYear(), at.getUTCMonth(), 1));
  const end = new Date(Date.UTC(at.getUTCFullYear(), at.getUTCMonth() + 1, 1));
  return { key: start.toISOString().slice(0, 7), start: start.toISOString(), end: end.toISOString(), timezone: 'UTC' as const };
}
const units = (value: string | null | undefined) => value == null ? 0n : moneyUnits(value);
function fail(code: string): never { throw Object.assign(new Error(code), { statusCode: 409, code }); }
function canonicalScope(scope: AttemptScope): AttemptScope {
  return { ...scope, runtimeId: scope.runtimeId ?? null, reportingSource: scope.reportingSource ?? `${scope.companyId}:runtime:${scope.runtimeId ?? `agent:${scope.agentId}`}` };
}

export function summarizeUsage(rows: Entry[], filter: { agentId?: string; cardId?: string; projectId?: string; period?: ReturnType<typeof utcPeriod> } = {}, now = new Date()) {
  let actual = 0n, estimated = 0n, reserved = 0n, unknown = 0, count = 0;
  for (const row of rows) {
    if (filter.agentId && row.agentId !== filter.agentId || filter.cardId && row.cardId !== filter.cardId || filter.projectId && row.projectId !== filter.projectId) continue;
    // Outstanding exposure survives a UTC month boundary. Reservation totals
    // are always current as of `now`, independently of the cost event period.
    if (!row.settledAt && row.reservationExpiresAt && new Date(row.reservationExpiresAt) > now) reserved += units(row.reservationUsd);
    const occurred = new Date(row.occurredAt ?? row.admittedAt ?? 0).getTime();
    if (filter.period && (occurred < Date.parse(filter.period.start) || occurred >= Date.parse(filter.period.end))) continue;
    count++;
    if (row.costStatus === 'actual') actual += units(row.costUsd);
    else if (row.costStatus === 'unknown' || row.costUsd == null) unknown++;
    else estimated += units(row.costUsd);
  }
  return { actualUsd: moneyString(actual), estimatedUsd: moneyString(estimated), totalUsd: moneyString(actual + estimated), reservedUsd: moneyString(reserved), unknownAttempts: unknown, attempts: count };
}

async function lockScope(tx: Reader, scope: AttemptScope) {
  const [company] = await tx.select().from(companies).where(eq(companies.id, scope.companyId)).for('update').limit(1);
  if (!company) fail('usage_company_not_found');
  const [agent] = await tx.select().from(agents).where(eq(agents.id, scope.agentId)).for('update').limit(1);
  if (!agent || agent.companyId !== scope.companyId) fail('usage_agent_company_mismatch');
  if (scope.runtimeId) {
    const [runtime] = await tx.select().from(agentRuntimes).where(eq(agentRuntimes.id, scope.runtimeId)).limit(1);
    if (!runtime || runtime.companyId !== scope.companyId) fail('usage_runtime_company_mismatch');
  }
  const [card] = scope.cardId ? await tx.select().from(kanbanCards).where(eq(kanbanCards.id, scope.cardId)).for('update').limit(1) : [];
  if (scope.cardId && (!card || card.companyId !== scope.companyId)) fail('usage_card_company_mismatch');
  if (scope.projectId) {
    const [project] = await tx.select().from(projects).where(eq(projects.id, scope.projectId)).limit(1);
    if (!project || project.companyId !== scope.companyId) fail('usage_project_company_mismatch');
  }
  for (const [id, table] of [[scope.taskRunId, taskRuns], [scope.heartbeatRunId, heartbeatRuns]] as const) if (id) {
    const [run] = await tx.select().from(table).where(eq(table.id, id)).limit(1);
    if (!run || run.companyId !== scope.companyId || run.agentId !== scope.agentId || (scope.cardId && run.cardId !== scope.cardId)) fail('usage_run_identity_mismatch');
  }
  return { agent, card };
}
function assertIdentity(entry: Entry, scope: AttemptScope) {
  for (const key of ['companyId', 'agentId', 'cardId', 'projectId', 'taskRunId', 'heartbeatRunId', 'runtimeId', 'reportingSource'] as const) {
    if ((entry[key] ?? null) !== (scope[key] ?? null)) fail('usage_attempt_identity_conflict');
  }
}
type Rule = { key: string; scope: 'company' | 'agent' | 'card'; limit: bigint; hard: boolean; warn: number; monthly: boolean };
async function rulesFor(tx: Reader, agent: Agent, card?: Card): Promise<Rule[]> {
  const rules: Rule[] = [];
  const add = (key: string, scope: Rule['scope'], value: string | null | undefined, hard: boolean, warn: number, monthly: boolean) => {
    if (value != null) rules.push({ key, scope, limit: units(value), hard, warn, monthly });
  };
  add(`agent:${agent.id}:monthly`, 'agent', agent.budgetMonthly, true, 80, true);
  if (card) {
    add(`agent:${agent.id}:card`, 'card', agent.budgetPerTask, true, 80, false);
    add(`card:${card.id}`, 'card', card.taskBudgetLimit, true, 80, false);
  }
  const policies = await tx.select().from(budgetPolicies).where(eq(budgetPolicies.companyId, agent.companyId));
  for (const policy of policies) {
    if (policy.isActive === false || policy.agentId && policy.agentId !== agent.id) continue;
    add(`policy:${policy.id}:monthly`, policy.agentId ? 'agent' : 'company', policy.monthlyLimitUsd, policy.hardStop !== false, policy.warnAtPercent ?? 80, true);
    if (card) add(`policy:${policy.id}:card`, 'card', policy.perTaskLimitUsd, policy.hardStop !== false, policy.warnAtPercent ?? 80, false);
  }
  return rules;
}
function totalsFor(rule: Rule, rows: Entry[], agent: Agent, card: Card | undefined, now: Date) {
  return summarizeUsage(rows, { agentId: rule.scope === 'agent' ? agent.id : undefined, cardId: rule.scope === 'card' ? card?.id : undefined, period: rule.monthly ? utcPeriod(now) : undefined }, now);
}
async function warnThresholds(tx: Reader, rules: Rule[], rows: Entry[], agent: Agent, card: Card | undefined, now: Date) {
  for (const rule of rules) {
    const totals = totalsFor(rule, rows, agent, card, now);
    const used = units(totals.totalUsd);
    const stopped = rule.hard && used >= rule.limit;
    if (used * 100n < rule.limit * BigInt(rule.warn)) continue;
    const thresholdKey = `${rule.key}:${rule.monthly ? utcPeriod(now).key : card?.id}:${stopped ? 'stop' : 'warning'}`;
    const [existing] = await tx.select().from(budgetThresholds).where(eq(budgetThresholds.thresholdKey, thresholdKey)).limit(1);
    if (existing) continue;
    const details = { ...totals, scope: rule.scope, limitUsd: moneyString(rule.limit), period: rule.monthly ? utcPeriod(now) : null, cardId: card?.id ?? null, warnAtPercent: rule.warn, hardStop: stopped, enforcement: 'Recorded usage and reservations; unavailable provider costs are unknown. Direct card execution excludes child cards.' };
    await tx.insert(budgetThresholds).values({ companyId: agent.companyId, thresholdKey, details });
    await tx.insert(activityLog).values({ companyId: agent.companyId, actorType: 'system', actorId: 'budget', agentId: agent.id, action: stopped ? 'budget.hard_stop' : 'budget.warning', entityType: rule.scope, entityId: rule.scope === 'company' ? agent.companyId : rule.scope === 'card' ? card!.id : agent.id, details });
  }
}

/** Company first, then original agent/card. No provider IO occurs in this transaction. */
export async function admitUsage(scope: AttemptScope, options: { now?: Date; timeoutSeconds?: number; boundUsd?: string | null; transaction?: Reader } = {}): Promise<Entry> {
  scope = canonicalScope(scope);
  const now = options.now ?? new Date();
  const work = async (tx: Reader) => {
    const { agent, card } = await lockScope(tx, scope);
    if ((agent.runtimeId ?? null) !== (scope.runtimeId ?? null)) fail('usage_runtime_binding_changed');
    const [existing] = await tx.select().from(costEvents).where(eq(costEvents.attemptKey, scope.attemptKey)).limit(1);
    if (existing) {
      assertIdentity(existing, scope);
      fail('usage_attempt_already_admitted');
    }
    if (agent.isActive === false || agent.deletedAt) fail('usage_agent_inactive');
    if (card && (card.deletedAt || ['cancelled', 'done'].includes(card.columnStatus ?? ''))) fail('usage_card_terminal');
    const rows = await tx.select().from(costEvents).where(eq(costEvents.companyId, scope.companyId));
    const rules = await rulesFor(tx, agent, card);
    let reservation = options.boundUsd == null ? null : units(options.boundUsd);
    for (const rule of rules.filter(rule => rule.hard)) {
      const total = totalsFor(rule, rows, agent, card, now);
      const remaining = rule.limit - units(total.totalUsd) - units(total.reservedUsd);
      if (remaining <= 0n || options.boundUsd != null && reservation !== null && reservation > remaining) fail(`budget_exceeded_${rule.scope}`);
      if (reservation === null) reservation = remaining;
      else if (options.boundUsd == null && remaining < reservation) reservation = remaining;
    }
    const [entry] = await tx.insert(costEvents).values({ ...scope, id: randomUUID(), provider: 'unknown', model: 'unknown', source: scope.source, costStatus: 'unknown', costUsd: null, usage: unknownUsage('awaiting_transport_usage'), occurredAt: now, admittedAt: now, reservationUsd: reservation === null ? null : moneyString(reservation), reservationExpiresAt: new Date(now.getTime() + Math.min(86_400, Math.max(60, (options.timeoutSeconds ?? 300) + 300)) * 1000) }).returning();
    return entry!;
  };
  return options.transaction ? work(options.transaction) : retryMergeGateWrite(() => db.transaction(work));
}

export function resultUsage(result: Pick<TaskResult, 'usage' | 'costUsd' | 'tokensUsed'>): UsageFacts {
  if (result.usage) return result.usage;
  // Backward compatible authenticated legacy adapter results remain estimates;
  // a zero without facts is unknown, never proof of a free provider attempt.
  const usage = unknownUsage('legacy_adapter_estimate', result.tokensUsed > 0 ? result.tokensUsed : undefined);
  if (result.costUsd > 0) {
    usage.costUsd = moneyString(moneyUnits(result.costUsd.toFixed(8)));
    usage.costStatus = 'estimated';
  }
  return usage;
}

const usageRank = { unknown: 0, estimated: 1, actual: 2 };
function reconcileTokens(previous: UsageFacts | null | undefined, incoming: UsageFacts) {
  const tokens = {} as Pick<UsageFacts, TokenField | 'tokenStatus' | 'tokenSource'>;
  const tokenProvenance: NonNullable<UsageFacts['tokenProvenance']> = {};
  for (const field of tokenFields) {
    const old = previous?.[field] == null ? undefined : previous.tokenProvenance?.[field]
      ?? { status: previous.tokenStatus, source: previous.tokenSource ?? previous.source };
    const next = incoming[field] == null ? undefined : incoming.tokenProvenance?.[field]
      ?? { status: incoming.tokenStatus, source: incoming.tokenSource ?? incoming.source };
    const accept = next && (!old || usageRank[next.status] >= usageRank[old.status]);
    tokens[field] = accept ? incoming[field] : previous?.[field] ?? null;
    const provenance = accept ? next : old;
    if (provenance) tokenProvenance[field] = provenance;
  }
  // Existing clients render totalTokens with this pair. A partial actual cache
  // report must not turn an untouched estimated total into an actual total.
  const populated = Object.values(tokenProvenance);
  const summary = tokenProvenance.totalTokens ?? populated.reduce<typeof populated[number] | undefined>(
    (least, fact) => !least || usageRank[fact.status] < usageRank[least.status] ? fact : least, undefined);
  tokens.tokenStatus = summary?.status ?? 'unknown';
  tokens.tokenSource = tokenProvenance.totalTokens?.source ?? (populated.every(fact => fact.source === summary?.source)
    ? summary?.source ?? incoming.tokenSource ?? incoming.source : 'mixed_token_provenance');
  return { ...tokens, tokenProvenance };
}

type UsageReconciliationOptions = { now?: Date; phase?: 'progress' | 'terminal' };
export async function settleUsage(scope: AttemptScope, facts: UsageFacts, options: UsageReconciliationOptions = {}) {
  scope = canonicalScope(scope);
  const now = options.now ?? new Date();
  return retryMergeGateWrite(() => db.transaction(async tx => {
    const { agent, card } = await lockScope(tx, scope);
    let [entry] = await tx.select().from(costEvents).where(eq(costEvents.attemptKey, scope.attemptKey)).limit(1);
    if (entry) assertIdentity(entry, scope);
    const reportingSource = scope.reportingSource!;
    // Once an event is bound, even the unknown-provider namespace is immutable.
    // Corrections may omit the event ID; they must not relocate its dedupe key.
    if (entry?.providerEventId && facts.provider != null && entry.provider !== facts.provider) fail('usage_attempt_identity_conflict');
    if (facts.providerEventId) {
      const [bound] = await tx.select().from(costEvents).where(and(eq(costEvents.reportingSource, reportingSource), eq(costEvents.provider, facts.provider ?? entry?.provider ?? 'unknown'), eq(costEvents.providerEventId, facts.providerEventId))).limit(1);
      if (bound && bound.attemptKey !== scope.attemptKey) fail('usage_provider_event_already_bound');
      if (entry?.providerEventId && entry.providerEventId !== facts.providerEventId) fail('usage_attempt_provider_event_conflict');
    }
    const previous = entry?.usage;
    const cost = previous && usageRank[previous.costStatus] > usageRank[facts.costStatus] ? previous : facts;
    const accepted: UsageFacts = { ...facts, costStatus: cost.costStatus, costUsd: cost.costUsd, costSource: cost.costSource ?? cost.source,
      ...reconcileTokens(previous, facts),
      provider: facts.provider ?? previous?.provider ?? null, model: facts.model ?? previous?.model ?? null,
      providerEventId: facts.providerEventId ?? entry?.providerEventId ?? null,
      occurredAt: facts.occurredAt ?? previous?.occurredAt };
    // A terminal attempt may receive a factual correction. Identity is immutable;
    // neither admission eligibility nor current orchestration ownership is tested.
    const occurredAt = accepted.occurredAt ? new Date(accepted.occurredAt) : entry?.occurredAt ?? now;
    // Progress reports are cumulative facts, not completion of the provider IO.
    // Transfer only the change in booked cost out of the remaining reservation;
    // duplicates transfer zero. Preserve the original expiry and terminal marker.
    const progress = options.phase === 'progress';
    const remaining = entry?.reservationUsd == null ? null
      : units(entry.reservationUsd) + units(entry.costUsd) - units(accepted.costUsd);
    const reservationUsd = progress && !entry?.settledAt && remaining !== null ? moneyString(remaining > 0n ? remaining : 0n) : null;
    const values = { costUsd: accepted.costStatus === 'unknown' ? null : accepted.costUsd, costStatus: accepted.costStatus, usage: accepted,
      provider: accepted.provider ?? 'unknown', model: accepted.model ?? 'unknown', inputTokens: accepted.inputTokens, outputTokens: accepted.outputTokens,
      reportingSource, providerEventId: facts.providerEventId ?? entry?.providerEventId ?? null, reservationUsd,
      reservationExpiresAt: progress && !entry?.settledAt ? entry?.reservationExpiresAt ?? null : null,
      settledAt: progress ? entry?.settledAt ?? null : now, occurredAt };
    if (entry) [entry] = await tx.update(costEvents).set(values).where(eq(costEvents.id, entry.id)).returning();
    else [entry] = await tx.insert(costEvents).values({ ...scope, ...values }).returning();
    const rows = await tx.select().from(costEvents).where(eq(costEvents.companyId, scope.companyId));
    const agentTotals = summarizeUsage(rows, { agentId: agent.id, period: utcPeriod(now) }, now);
    await tx.update(agents).set({ spentThisMonth: agentTotals.totalUsd }).where(eq(agents.id, agent.id));
    if (card) {
      const totalUsd = summarizeUsage(rows, { cardId: card.id }, now).totalUsd;
      if (units(card.costUsd) !== units(totalUsd)) await tx.update(kanbanCards).set({ costUsd: totalUsd }).where(eq(kanbanCards.id, card.id));
    }
    if (scope.taskRunId) await tx.update(taskRuns).set({ costUsd: entry!.costUsd }).where(eq(taskRuns.id, scope.taskRunId));
    if (scope.heartbeatRunId) await tx.update(heartbeatRuns).set({ costUsd: entry!.costUsd }).where(eq(heartbeatRuns.id, scope.heartbeatRunId));
    const rules = await rulesFor(tx, agent, card);
    await warnThresholds(tx, rules, rows, agent, card, now);
    return { entry: entry!, totals: agentTotals, stopped: rules.some(rule => rule.hard && units(totalsFor(rule, rows, agent, card, now).totalUsd) >= rule.limit) };
  }));
}

export async function releaseUsage(scope: AttemptScope) {
  // Cancellation never deletes an attempt or declares it free. Late facts can
  // still settle; expired reservations are excluded by timestamp, even day 2/3.
  return settleUsage(scope, unknownUsage('cancelled_or_abandoned_usage_unknown'));
}

export async function releaseCancelledCardUsage(companyId: string, cardId: string) {
  const [card] = await db.select().from(kanbanCards).where(and(eq(kanbanCards.id, cardId), eq(kanbanCards.companyId, companyId))).limit(1);
  if (!card) return;
  const entries = await db.select().from(costEvents).where(and(eq(costEvents.companyId, companyId), eq(costEvents.cardId, cardId)));
  for (const entry of entries) {
    if (!entry.attemptKey || entry.settledAt) continue;
    const [run] = entry.taskRunId ? await db.select().from(taskRuns).where(eq(taskRuns.id, entry.taskRunId)).limit(1) : [];
    const [heartbeat] = entry.heartbeatRunId ? await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, entry.heartbeatRunId)).limit(1) : [];
    if (card.deletedAt || card.columnStatus === 'cancelled' || run?.status === 'cancelled' || heartbeat?.status === 'cancelled') await releaseUsage(scopeFromEntry(entry));
  }
}

/** Only admission errors raised before provider IO may defer an orchestration
 * attempt. A factual settlement or provider failure must never use this path. */
export async function deferDeniedUsage(scope: AttemptScope, error: unknown): Promise<boolean> {
  const code = (error as { code?: string; statusCode?: number })?.code;
  if ((error as { statusCode?: number })?.statusCode !== 409 || !code || !(/^(budget_exceeded_|usage_runtime_binding_changed$|usage_agent_inactive$)/.test(code))) return false;
  await retryMergeGateWrite(() => db.transaction(async tx => {
    await lockScope(tx, scope);
    const [entry] = await tx.select().from(costEvents).where(eq(costEvents.attemptKey, scope.attemptKey)).limit(1);
    if (entry) fail('usage_admitted_attempt_cannot_defer');
    if (scope.taskRunId) await tx.update(taskRuns).set({ status: 'queued', lockedBy: null, lockedAt: null, startedAt: null, heartbeatRunId: null, error: `Budget admission deferred: ${code}`, updatedAt: new Date() }).where(and(eq(taskRuns.id, scope.taskRunId), eq(taskRuns.status, 'running')));
    if (scope.heartbeatRunId) {
      await tx.update(heartbeatRuns).set({ status: 'cancelled', completedAt: new Date(), error: `No provider call: ${code}` }).where(and(eq(heartbeatRuns.id, scope.heartbeatRunId), eq(heartbeatRuns.status, 'running')));
      if (scope.cardId) await tx.update(kanbanCards).set({ executionLockId: null, executionLockedByAgentId: null, executionLockedAt: null, executionLockExpiresAt: null, activeHeartbeatRunId: null }).where(and(eq(kanbanCards.id, scope.cardId), eq(kanbanCards.executionLockId, scope.heartbeatRunId)));
    }
    await tx.update(agents).set({ isBusy: false }).where(eq(agents.id, scope.agentId));
  }));
  return true;
}

async function a2aUsageAttempt(scope: AttemptScope, executionScope?: string): Promise<Entry | null> {
  const [agent] = await db.select().from(agents).where(eq(agents.id, scope.agentId)).limit(1);
  if (agent?.adapterType !== 'a2a') return null;
  return db.transaction(async tx => {
    await tx.select().from(agents).where(eq(agents.id, scope.agentId)).limit(1).for('update');
    const [alias] = await tx.select().from(a2aExecutionAliases).where(eq(a2aExecutionAliases.key, scope.attemptKey)).limit(1);
    let [execution] = alias ? await tx.select().from(a2aExecutions).where(eq(a2aExecutions.key, alias.executionKey)).limit(1).for('update') : [];
    if (!execution && executionScope) {
      [execution] = await tx.select().from(a2aExecutions).where(and(eq(a2aExecutions.agentId, scope.agentId), eq(a2aExecutions.active, true), eq(a2aExecutions.scope, executionScope))).limit(1).for('update');
    }
    if (execution && executionScope && execution.scope !== executionScope) fail('a2a_usage_identity_mismatch');
    if (!execution) return null;
    const [entry] = await tx.select().from(costEvents).where(eq(costEvents.attemptKey, execution.key)).limit(1);
    if (!entry) fail('a2a_usage_reconciliation_required');
    if (execution.agentId !== scope.agentId || execution.companyId !== scope.companyId ||
        entry.agentId !== scope.agentId || entry.companyId !== scope.companyId || entry.cardId !== (scope.cardId ?? null) ||
        entry.projectId !== (scope.projectId ?? null) || entry.runtimeId !== (scope.runtimeId ?? null) || entry.source !== scope.source) fail('a2a_usage_identity_mismatch');
    // Pin the replay before releasing the row lock. A concurrent completion may
    // acknowledge this scope before adapter.begin, but cannot authorize a new
    // SendMessage against the already admitted predecessor's budget.
    if (!alias) await tx.insert(a2aExecutionAliases).values({ key: scope.attemptKey, executionKey: execution.key });
    return entry;
  });
}
export async function executeUsage(scope: AttemptScope, operation: () => Promise<TaskResult>, options: { timeoutSeconds?: number; boundUsd?: string | null; a2aScope?: string } = {}) {
  await assertA2aTaskRunOwner();
  // Recover accounting before invoking the adapter: journal aliases are created
  // only inside dispatch, which is too late to prevent a second reservation.
  const original = await a2aUsageAttempt(scope, options.a2aScope);
  if (original) scope = scopeFromEntry(original);
  else await admitUsage(scope, options);
  let result: TaskResult;
  try {
    await assertA2aTaskRunOwner();
    result = await withUsageAttempt(scope.attemptKey, operation);
  } catch (error) {
    await assertA2aTaskRunOwner();
    await settleUsage(scope, unknownUsage('operation_threw_usage_unavailable'));
    throw error;
  }
  await assertA2aTaskRunOwner();
  // A DB error after provider return is a pending settlement, not evidence that
  // the provider threw or that its reported cost should become unknown.
  const settled = await settleUsage(scope, resultUsage(result));
  await assertA2aTaskRunOwner();
  return { ...result, usage: settled.entry.usage ?? resultUsage(result), costUsd: Number(settled.entry.costUsd ?? 0) };
}

export async function usageSummary(companyId: string, filter: Parameters<typeof summarizeUsage>[1] = {}, now = new Date()) {
  const rows = await db.select().from(costEvents).where(eq(costEvents.companyId, companyId));
  return { ...summarizeUsage(rows, filter, now), period: filter.period ?? null, accounting: 'runtime-reported actual, estimates, and unknown usage; not invoice reconciliation', taskScope: 'direct card executions; child cards accounted independently' };
}

export async function usageBudgetState(agent: Agent, card?: Card, now = new Date()) {
  const rules = await rulesFor(db, agent, card);
  const rows = await db.select().from(costEvents).where(eq(costEvents.companyId, agent.companyId));
  const scopes = rules.map(rule => ({ ...totalsFor(rule, rows, agent, card, now), scope: rule.scope, limitUsd: moneyString(rule.limit), hardStop: rule.hard, warnAtPercent: rule.warn }));
  return { blocked: agent.isActive === false || scopes.some(scope => scope.hardStop && units(scope.totalUsd) + units(scope.reservedUsd) >= units(scope.limitUsd)), scopes, period: utcPeriod(now) };
}

export function cardUsageScope(card: Card, agent: Agent, heartbeatRunId: string, taskRunId?: string | null, source = 'dispatch'): AttemptScope {
  return { companyId: card.companyId, agentId: agent.id, cardId: card.id, projectId: card.projectId, heartbeatRunId, taskRunId: taskRunId ?? null, runtimeId: agent.runtimeId, attemptKey: attemptKey({ taskRunId, heartbeatRunId }), source };
}

export async function settleTaskRunUsage(run: typeof taskRuns.$inferSelect, facts: UsageFacts, reportingSource?: string, options: UsageReconciliationOptions = {}) {
  if (!run.agentId) fail('usage_run_agent_unknown');
  const [entry] = await db.select().from(costEvents).where(eq(costEvents.attemptKey, attemptKey({ taskRunId: run.id }))).limit(1);
  const [agent] = await db.select().from(agents).where(eq(agents.id, run.agentId)).limit(1);
  if (!agent || agent.companyId !== run.companyId) fail('usage_run_identity_mismatch');
  return settleUsage({ companyId: run.companyId, agentId: run.agentId, cardId: run.cardId,
    // Old unadmitted runs have no durable project snapshot. Do not assign their
    // late cost to whichever project the card happens to belong to today.
    projectId: entry?.projectId ?? null, runtimeId: entry ? entry.runtimeId : null,
    taskRunId: run.id, heartbeatRunId: entry ? entry.heartbeatRunId : run.heartbeatRunId,
    attemptKey: attemptKey({ taskRunId: run.id }), source: entry?.source ?? 'legacy_runner_callback',
    reportingSource: entry?.reportingSource ?? reportingSource ?? `legacy:${run.companyId}:agent:${run.agentId}` }, facts, options);
}

export function scopeFromEntry(entry: Entry): AttemptScope {
  if (!entry.attemptKey) fail('usage_legacy_identity_unknown');
  return { attemptKey: entry.attemptKey, companyId: entry.companyId, agentId: entry.agentId, cardId: entry.cardId, projectId: entry.projectId, taskRunId: entry.taskRunId, heartbeatRunId: entry.heartbeatRunId, runtimeId: entry.runtimeId, source: entry.source, reportingSource: entry.reportingSource };
}

export async function refreshUsageCaches(now = new Date()) {
  const companyRows = await db.select().from(companies);
  let changed = 0;
  for (const company of companyRows) await retryMergeGateWrite(() => db.transaction(async tx => {
    await tx.select().from(companies).where(eq(companies.id, company.id)).for('update').limit(1);
    const agentRows = await tx.select().from(agents).where(eq(agents.companyId, company.id));
    const usage = await tx.select().from(costEvents).where(eq(costEvents.companyId, company.id));
    for (const agent of agentRows.sort((a, b) => a.id.localeCompare(b.id))) {
      const total = summarizeUsage(usage, { agentId: agent.id, period: utcPeriod(now) }, now).totalUsd;
      if (units(agent.spentThisMonth) === units(total)) continue;
      await tx.update(agents).set({ spentThisMonth: total }).where(eq(agents.id, agent.id));
      changed++;
    }
  }));
  return changed;
}
