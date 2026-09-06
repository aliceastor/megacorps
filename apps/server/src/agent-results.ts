import { agentReportSchema, reportedWorkProductSchema, type AgentReport, type ReportedWorkProduct } from '@megacorps/shared';
import { and, eq, sql } from 'drizzle-orm';
import { extractAgentReport } from './agent-report.ts';
import { db } from './db/client.ts';
import { agents, approvals, cardComments, heartbeatRuns, kanbanCards, taskLogs, taskRuns, workProducts } from './db/schema.ts';
import { publishLiveEvent } from './live.ts';
import { sanitizeCompanyOutput } from './output-secrets.ts';
import { lockResultAuthority } from './completion-guard.ts';

type Verdict = 'approved' | 'revision_requested' | 'escalate';
/** Retain canonical evidence when the report arrived separately from prose. */
export function agentResultExecutionLog(output: string, result: AgentResult): string {
  return result.report ? `${output}\n\n${JSON.stringify(result.report)}`.trim() : output;
}
export type AgentResult = {
  source: 'report' | 'prose' | 'invalid';
  outcome: 'completed' | 'progress' | 'input_required' | 'permission' | 'failed' | 'rejected' | 'invalid';
  report: AgentReport | null;
  reason: string | null;
  question: string | null;
  verdict: Verdict | null;
  verdictExplicit: boolean;
  verdictError: string | null;
  workProducts: ReportedWorkProduct[];
};

function permissionBlocker(text: string): boolean {
  return /\bpermission(?:s)?\s+(?:denied|required|needed)|\b(?:approval|authorization)\s+(?:required|pending|needed)|\b(?:pending|awaiting|waiting\s+for|requires?)\s+(?:tool\s+|command\s+|execution\s+)?(?:approval|permission|authorization)\b|\b(?:sandbox|security policy)\b[^\n]{0,80}\b(?:blocked|denied)\b/i.test(text);
}

function legacyVerdict(text: string): { verdict: Verdict | null; error: string | null; explicit: boolean } {
  const lines = [...text.matchAll(/^\s*(?:[-*#]+\s*)?(final\s+)?(?:review\s+)?verdict\s*[:=]\s*(approved?|pass|done|reject(?:ed)?|revision[_ -]?requested|escalate)\b/gim)];
  const finals = lines.filter((line) => line[1]);
  const current = finals.length ? finals : lines;
  const decisions = new Set(current.map((line): Verdict => /^(?:approve|pass|done)/i.test(line[2]!) ? 'approved' : /^escalate/i.test(line[2]!) ? 'escalate' : 'revision_requested'));
  if (decisions.size > 1) return { verdict: null, error: 'review_verdict_conflicting: return one current final verdict', explicit: true };
  if (decisions.size === 1) return { verdict: [...decisions][0]!, error: null, explicit: true };
  // Explicitness controls whether a valid legacy review can survive a nonzero
  // adapter exit; it must never select a different verdict from this parser.
  const explicit = /\breject(?:ed)?\W{0,30}revision[_ -]?requested\b|\bnot\s+approved\b|\bcannot\s+approve\b|\bescalate\b(?:\s*[:=]|\W{1,16}(?:manager|boss|higher|review|decision)\b)|\bapproved?\W{0,16}(?:done|complete(?:d)?|resolved)\b|["']status["']\s*:\s*["']done["']/i.test(text);
  if (/\b(escalate|needs[_ -]?higher|needs[_ -]?boss|needs[_ -]?manager|cannot[_ -]?resolve|unable[_ -]?to[_ -]?resolve)\b/i.test(text)) return { verdict: 'escalate', error: null, explicit };
  if (/\b(revision[_ -]?requested|request[_ -]?revision|needs[_ -]?rework|redo|retry|reject|rejected|fail|failed|blocked|not\s+approved|not\s+acceptable|cannot\s+approve)\b/i.test(text)) return { verdict: 'revision_requested', error: null, explicit };
  if (/\b(pass|approve|approved|done|complete|completed|resolved)\b/i.test(text) || /["']status["']\s*:\s*["']done["']/i.test(text)) return { verdict: 'approved', error: null, explicit };
  return { verdict: null, error: null, explicit: false };
}

function productKey(product: ReportedWorkProduct): string {
  // Content identity ignores payload ownership, optional nulls and metadata order.
  return JSON.stringify([product.type, product.title, product.url ?? product.pullRequestUrl ?? null, product.commitSha ?? null, product.branch ?? null, product.repoUrl ?? null]);
}

/** Classify report validity and meaning before consumers perform any side effects. */
export function normalizeAgentResult(input: { output?: string | null; report?: unknown; workProducts?: unknown[]; needsInput?: { question: string } | null }): AgentResult {
  const text = input.output ?? '';
  const embedded = extractAgentReport(text);
  const explicit = input.report === undefined ? null : agentReportSchema.safeParse(input.report);
  const error = embedded && 'error' in embedded ? embedded.error : explicit && !explicit.success ? `report_schema_invalid: ${explicit.error.message.slice(0, 500)}` : null;
  const report = explicit?.success ? explicit.data : embedded && 'report' in embedded ? embedded.report : null;
  const base: AgentResult = { source: report ? 'report' : 'prose', outcome: 'completed', report, reason: null, question: null, verdict: null, verdictExplicit: false, verdictError: null, workProducts: [] };
  if (error) return { ...base, source: 'invalid', outcome: 'invalid', reason: `agent_report_invalid: ${error}. Return one corrected megacorps-report.` };
  if (explicit?.success && embedded && 'report' in embedded && (explicit.data.status !== embedded.report.status || (explicit.data.verdict && embedded.report.verdict && explicit.data.verdict !== embedded.report.verdict))) {
    return { ...base, source: 'invalid', outcome: 'invalid', reason: 'agent_report_invalid: conflicting current reports. Return one consistent status and verdict.' };
  }
  const products = [...(report?.workProducts ?? []), ...(input.workProducts ?? [])].map((product) => reportedWorkProductSchema.safeParse(product));
  if (products.some((product) => !product.success)) return { ...base, source: 'invalid', outcome: 'invalid', reason: 'agent_report_invalid: workProducts failed validation. Return corrected work products.' };
  base.workProducts = [...new Map(products.filter((p) => p.success).map((p) => [productKey(p.data), p.data])).values()];
  if (report?.request?.kind === 'checkpoint' && !report.checkpoint) {
    const { kind: _kind, checkpointKind, ...checkpoint } = report.request;
    report.checkpoint = { ...checkpoint, kind: checkpointKind };
  }
  if (report?.status === 'failed' || report?.status === 'rejected') {
    return { ...base, outcome: report.status, reason: `agent_report_${report.status}: ${report.summary}`, verdict: 'revision_requested', verdictExplicit: true };
  }
  if (report?.request?.kind === 'permission' || ((!report || report.status === 'input_required') && permissionBlocker(report?.summary ?? text))) {
    return { ...base, outcome: 'permission', reason: `agent_permission_blocked: ${report?.request?.question ?? report?.summary ?? text.trim().slice(0, 2000)}` };
  }
  if (report?.status === 'input_required' || report?.request || report?.checkpoint || input.needsInput) {
    return { ...base, outcome: 'input_required', question: report?.request?.question ?? report?.checkpoint?.question ?? input.needsInput?.question ?? report?.questions?.join('\n') ?? report?.summary ?? text, reason: report?.summary ?? null };
  }
  if (report?.status === 'progress') return { ...base, outcome: 'progress' };
  if (report) return { ...base, verdict: report.verdict ?? null, verdictExplicit: Boolean(report.verdict) };
  const parsedVerdict = legacyVerdict(text);
  return { ...base, verdict: parsedVerdict.verdict, verdictExplicit: parsedVerdict.explicit, verdictError: parsedVerdict.error };
}

/** Persist validated content using only the current server-resolved ownership. */
export async function persistAgentWorkProducts(
  card: typeof kanbanCards.$inferSelect, agentId: string | null, taskRunId: string | null,
  products: ReportedWorkProduct[], project?: { repoProvider?: string | null; repoUrl?: string | null } | null,
  report?: AgentReport | null,
): Promise<boolean> {
  if (report?.artifactRefs?.length) products = [...products, { type: 'report', title: 'Agent report evidence references', metadata: { evidenceReport: report } }];
  products = await sanitizeCompanyOutput(card.companyId, products);
  const inserted = await db.transaction(async tx => {
  if (!(await lockResultAuthority(card, taskRunId, tx, agentId))) return null;
  const prior = taskRunId ? await tx.select().from(workProducts).where(and(eq(workProducts.cardId, card.id), eq(workProducts.taskRunId, taskRunId))) : [];
  const keys = new Set(prior.map((product) => productKey(product as ReportedWorkProduct)));
  const rows = products.filter((product) => { const key = productKey(product); if (keys.has(key)) return false; keys.add(key); return true; }).map((product) => ({
    ...product, companyId: card.companyId, cardId: card.id, projectId: card.projectId ?? null, agentId, taskRunId,
    repoProvider: product.repoProvider ?? project?.repoProvider ?? null, repoUrl: product.repoUrl ?? project?.repoUrl ?? null,
  }));
  if (!rows.length) return [];
  return tx.insert(workProducts).values(rows).returning();
  });
  if (!inserted) return false;
  for (const product of inserted) publishLiveEvent({ type: 'work_product.created', companyId: card.companyId, entityType: 'work_product', entityId: product.id, cardId: card.id, projectId: card.projectId });
  return true;
}

export async function parkPermissionBlockedResult(original: typeof kanbanCards.$inferSelect, agentId: string | null, heartbeatRunId: string | null, reason: string, output: string, taskRunId?: string | null) {
  const cardId = original.id;
  let preservedHumanGate = false;
  const updated = await db.transaction(async (tx) => {
    if (!(await lockResultAuthority(original, taskRunId, tx, agentId))) {
      preservedHumanGate = true;
      return (await tx.select().from(kanbanCards).where(eq(kanbanCards.id, cardId)).limit(1))[0];
    }
    const [card] = await tx.update(kanbanCards).set({ columnStatus: 'blocked', lastError: reason, executionLog: output, completedAt: null, nextRunAt: null,
      executionLockId: null, executionLockedByAgentId: null, executionLockedAt: null, executionLockExpiresAt: null, activeHeartbeatRunId: null, updatedAt: new Date(),
    }).where(and(eq(kanbanCards.id, cardId), sql`NOT EXISTS (SELECT 1 FROM ${approvals} WHERE ${approvals.cardId} = ${cardId} AND ${approvals.status} = 'pending' AND ${approvals.type} = 'task_review' AND ${approvals.payload}->>'humanGate' = 'true')`)).returning();
    if (heartbeatRunId) await tx.update(heartbeatRuns).set({ status: 'failed', completedAt: new Date(), error: reason }).where(and(eq(heartbeatRuns.id, heartbeatRunId), eq(heartbeatRuns.status, 'running')));
    if (agentId) {
      const active = await tx.select().from(heartbeatRuns).where(and(eq(heartbeatRuns.agentId, agentId), eq(heartbeatRuns.status, 'running')));
      if (!active.some(run => run.id !== heartbeatRunId)) await tx.update(agents).set({ isBusy: false }).where(eq(agents.id, agentId));
    }
    if (!card) {
      preservedHumanGate = true;
      const [parked] = await tx.select().from(kanbanCards).where(eq(kanbanCards.id, cardId)).limit(1);
      return parked;
    }
    return card;
  });
  if (!preservedHumanGate) await db.insert(cardComments).values({ cardId, agentId, authorType: 'agent', action: 'agent_blocked', body: reason });
  await db.insert(taskLogs).values({ cardId, agentId, type: 'dispatch', status: 'failed', message: reason, output });
  if (!updated) throw new Error('card_update_failed');
  if (!preservedHumanGate) publishLiveEvent({ type: 'card.updated', companyId: updated.companyId, entityType: 'card', entityId: cardId, cardId, projectId: updated.projectId, action: 'agent.permission_blocked' });
  return { card: updated, preservedHumanGate };
}

/** A late attempt may settle its heartbeat, never another attempt's capacity. */
export async function settleOriginalHeartbeat(card: typeof kanbanCards.$inferSelect, agentId: string, heartbeatRunId: string | null | undefined, taskRunId?: string | null, status = 'success') {
  await db.transaction(async tx => {
    const [current] = await tx.select().from(kanbanCards).where(eq(kanbanCards.id, card.id)).for('update').limit(1);
    if (heartbeatRunId) await tx.update(heartbeatRuns).set({ status, completedAt: new Date() }).where(and(eq(heartbeatRuns.id, heartbeatRunId), eq(heartbeatRuns.cardId, card.id), eq(heartbeatRuns.agentId, agentId), eq(heartbeatRuns.status, 'running')));
    const heartbeats = await tx.select().from(heartbeatRuns).where(and(eq(heartbeatRuns.agentId, agentId), eq(heartbeatRuns.status, 'running')));
    const runs = await tx.select().from(taskRuns).where(and(eq(taskRuns.agentId, agentId), eq(taskRuns.status, 'running')));
    const anotherLock = current?.executionLockId && ![card.executionLockId, heartbeatRunId, taskRunId].includes(current.executionLockId);
    if (!anotherLock && !heartbeats.some(run => run.id !== heartbeatRunId) && !runs.some(run => run.id !== taskRunId)) await tx.update(agents).set({ isBusy: false }).where(eq(agents.id, agentId));
  });
}
