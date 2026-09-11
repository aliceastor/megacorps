import { createHash } from 'node:crypto';
import { and, desc, eq, getTableColumns, gt, inArray, isNull, sql } from 'drizzle-orm';
import { agentReportSchema } from '@megacorps/shared';
import { db } from './db/client.ts';
import { activityLog, agents, a2aExecutions, a2aExecutionAliases, companies, kanbanCards, taskRuns } from './db/schema.ts';
import { acceptedDescendantEvidence, captureDeliveryAcceptance } from './delivery-acceptance.ts';

type Card = typeof kanbanCards.$inferSelect;
type Origin = { rowOrigin: string; originAge: number };
type Snapshot = Card & Origin & { updatedStamp: string | null; completedStamp: string | null; firstEpoch: boolean };
const MAX_ORIGIN_AGE = 1_000_000;
const RECOVERY_WINDOW_MS = 24 * 60 * 60 * 1000;
const validOrigin = (row: Origin) => /^[0-9]+$/.test(row.rowOrigin) && BigInt(row.rowOrigin) > 3n && Number.isInteger(row.originAge) && row.originAge >= 0 && row.originAge <= MAX_ORIGIN_AGE;
const signature = ({ originAge: _age, ...row }: Snapshot) => JSON.stringify(row);
const snapshotColumns = { ...getTableColumns(kanbanCards), rowOrigin: sql<string>`${kanbanCards}.xmin::text`, originAge: sql<number>`age(${kanbanCards}.xmin)`, firstEpoch: sql<boolean>`pg_snapshot_xmax(pg_current_snapshot()) < '4294967296'::xid8`, updatedStamp: sql<string | null>`${kanbanCards.updatedAt}::text`, completedStamp: sql<string | null>`${kanbanCards.completedAt}::text` };
const eligibleRoot = () => and(eq(kanbanCards.columnStatus, 'done'), isNull(kanbanCards.deletedAt), isNull(kanbanCards.parentCardId), isNull(kanbanCards.deliveryAcceptance), sql`${kanbanCards.completedAt} IS NOT NULL AND ${kanbanCards.updatedAt} = ${kanbanCards.completedAt} AND ${kanbanCards.completedAt} >= current_timestamp - interval '24 hours' AND ${kanbanCards.completedAt} <= current_timestamp`);
function unchangedCompletion(card: Snapshot) {
  const elapsed = card.completedAt ? Date.now() - card.completedAt.getTime() : -1;
  return card.firstEpoch === true && validOrigin(card) && elapsed >= 0 && elapsed <= RECOVERY_WINDOW_MS && card.columnStatus === 'done' && !card.deletedAt && !card.parentCardId && !card.deliveryAcceptance && Boolean(card.assigneeId && card.updatedStamp && card.completedStamp && card.updatedStamp === card.completedStamp);
}

/** Only the final standalone JSON payload is authoritative. Never search back
 * for an older valid report when the final payload is malformed or different. */
export function terminalCompletedReport(output: string | null | undefined) {
  if (!output || output.length > 262_144) return null;
  const text = output.trim();
  let candidate = text;
  if (text.endsWith('```')) {
    const match = /(?:^|\n)```(?:json)?[ \t]*\r?\n([^]*?)\r?\n```$/i.exec(text);
    if (!match || match[1]!.includes('```')) return null;
    candidate = match[1]!.trim();
  } else if (!text.startsWith('{') || text.includes('\n')) {
    // A multiline JSON object with no surrounding prose is also standalone.
    try { JSON.parse(text); }
    catch {
      if (/^[{[]/.test(text)) return null;
      const lines = text.split(/\r?\n/);
      let finalStart = -1;
      for (let index = lines.length - 1; index >= 0; index--) if (lines[index]!.trimStart().startsWith('{')) { finalStart = index; break; }
      if (finalStart < 0) return null;
      // Do not promote a line that is nested inside a truncated preceding JSON
      // object/array, even when prose appears before that unfinished container.
      const stack: string[] = [];
      let quoted = false, escaped = false;
      for (const char of lines.slice(0, finalStart).join('\n')) {
        if (quoted) {
          if (escaped) escaped = false;
          else if (char === '\\') escaped = true;
          else if (char === '"') quoted = false;
        } else if (stack.length && char === '"') quoted = true;
        else if (char === '{' || char === '[') stack.push(char);
        else if (char === '}' || char === ']') {
          if (stack.pop() !== (char === '}' ? '{' : '[')) return null;
        }
      }
      if (stack.length || quoted) return null;
      candidate = lines.slice(finalStart).join('\n').trim();
    }
  }
  try {
    const raw = JSON.parse(candidate);
    if (raw?.kind !== 'megacorps-report' || raw.status !== 'completed') return null;
    const parsed = agentReportSchema.safeParse(raw);
    return parsed.success ? parsed.data : null;
  } catch { return null; }
}

function auditId(cardId: string, runId: string) {
  const hex = createHash('sha256').update(`a2a-delivery-receipt-recovered:${cardId}:${runId}`).digest('hex').slice(0, 32);
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

/** Repair only the interrupted A2A management completion boundary. It cannot
 * complete a card, create evidence, approve work, merge, or submit remote work. */
export async function recoverMissingA2aDeliveryReceipt(cardId: string): Promise<boolean> {
  const [snapshot] = await db.select(snapshotColumns).from(kanbanCards).where(and(eq(kanbanCards.id, cardId), eligibleRoot())).limit(1);
  if (!snapshot || !unchangedCompletion(snapshot)) return false;
  return db.transaction(async tx => {
    await tx.execute(sql`SET LOCAL lock_timeout = '1s'`);
    await tx.execute(sql`SET LOCAL statement_timeout = '5s'`);
    const [company] = await tx.select().from(companies).where(eq(companies.id, snapshot.companyId)).for('update').limit(1);
    const [agent] = await tx.select().from(agents).where(eq(agents.id, snapshot.assigneeId!)).for('update').limit(1);
    if (!company || !agent || agent.companyId !== company.id || agent.adapterType !== 'a2a') return false;
    const [card] = await tx.select(snapshotColumns).from(kanbanCards).where(eq(kanbanCards.id, snapshot.id)).for('update').limit(1);
    if (!card || !unchangedCompletion(card) || signature(card) !== signature(snapshot)) return false;
    const [run, predecessor] = await tx.select({ ...getTableColumns(taskRuns), rowOrigin: sql<string>`${taskRuns}.xmin::text`, originAge: sql<number>`age(${taskRuns}.xmin)` }).from(taskRuns).where(eq(taskRuns.cardId, card.id)).orderBy(desc(taskRuns.createdAt), desc(taskRuns.id)).for('update').limit(2);
    if (run && predecessor && run.createdAt?.getTime() === predecessor.createdAt?.getTime()) return false;
    if (!run || run.companyId !== card.companyId || run.agentId !== card.assigneeId || run.kind !== 'dispatch' || run.status !== 'success' || !run.completedAt || !card.completedAt) return false;
    if (!validOrigin(run) || run.rowOrigin !== card.rowOrigin) return false;
    const elapsed = run.completedAt.getTime() - card.completedAt.getTime();
    if (elapsed < 0 || elapsed > 5_000 || !terminalCompletedReport(run.output)) return false;
    const [active] = await tx.select({ id: taskRuns.id }).from(taskRuns).where(and(eq(taskRuns.cardId, card.id), inArray(taskRuns.status, ['queued', 'running']))).limit(1);
    if (active) return false;
    // Check the same five-second window using PostgreSQL's complete timestamp
    // precision rather than trusting the Date mapper's millisecond truncation.
    const [timely] = await tx.select({ id: taskRuns.id }).from(taskRuns).where(and(eq(taskRuns.id, run.id), sql`${taskRuns.completedAt} >= ${card.completedStamp}::timestamptz AND ${taskRuns.completedAt} <= ${card.completedStamp}::timestamptz + interval '5 seconds'`)).limit(1);
    if (!timely) return false;
    const key = `task-run:${run.id}`;
    const [alias] = await tx.select().from(a2aExecutionAliases).where(eq(a2aExecutionAliases.key, key)).limit(1);
    if (!alias || alias.executionKey !== key) return false;
    const [journal] = await tx.select({ ...getTableColumns(a2aExecutions), rowOrigin: sql<string>`${a2aExecutions}.xmin::text`, originAge: sql<number>`age(${a2aExecutions}.xmin)` }).from(a2aExecutions).where(eq(a2aExecutions.key, key)).for('update').limit(1);
    if (!journal || journal.active || journal.companyId !== card.companyId || journal.agentId !== card.assigneeId || journal.record.key !== key || journal.record.phase !== 'terminal' || journal.record.outcome?.state !== 'completed' || journal.record.outcome.text !== run.output) return false;
    // The original completion transaction wrote all three row versions. Gate
    // invalidation changes the root version even when updatedAt stays fixed.
    // xmin is a 32-bit row origin, not a permanent ID: reject old/system IDs,
    // stale completions, and any cluster that has crossed its first XID epoch.
    if (!validOrigin(journal) || journal.rowOrigin !== card.rowOrigin) return false;
    let scope: unknown;
    try { scope = JSON.parse(journal.record.scope); } catch { return false; }
    if (!Array.isArray(scope) || scope.length !== 4 || scope[0] !== card.assigneeId || scope[1] !== 'task' || scope[2] !== card.id || !['management', 'execution'].includes(scope[3])) return false;
    const descendants = await acceptedDescendantEvidence(card, tx, true);
    if (!descendants.ready || descendants.requiredCount < 1 || descendants.issues.length) return false;
    const receipt = await captureDeliveryAcceptance(card, tx);
    if (!receipt?.inherited) return false;
    const id = auditId(card.id, run.id);
    if ((await tx.select({ id: activityLog.id }).from(activityLog).where(eq(activityLog.id, id)).limit(1)).length) return false;
    const [updated] = await tx.update(kanbanCards).set({ deliveryAcceptance: receipt }).where(and(eq(kanbanCards.id, card.id), eligibleRoot(), eq(kanbanCards.mergeGateVersion, card.mergeGateVersion), eq(kanbanCards.assigneeId, card.assigneeId!), sql`${kanbanCards}.xmin::text = ${card.rowOrigin}`, sql`${kanbanCards.updatedAt} IS NOT DISTINCT FROM ${card.updatedStamp}::timestamptz`, sql`${kanbanCards.completedAt} IS NOT DISTINCT FROM ${card.completedStamp}::timestamptz`)).returning({ id: kanbanCards.id });
    if (!updated) return false;
    await tx.insert(activityLog).values({ id, companyId: card.companyId, actorType: 'system', actorId: 'a2a-delivery-recovery', agentId: card.assigneeId, action: 'card.delivery_acceptance_recovered', entityType: 'card', entityId: card.id, details: { taskRunId: run.id, executionKey: key, journalRevision: journal.record.revision, originalTransaction: card.rowOrigin, transactionAge: card.originAge, gateVersion: card.mergeGateVersion, completedAt: card.completedStamp, productIds: receipt.productIds } });
    return true;
  });
}

let sweeping = false;
let afterId: string | null = null;
export async function sweepMissingA2aDeliveryReceipts(onError: (error: unknown) => void = () => {}): Promise<number> {
  if (sweeping) return 0;
  sweeping = true;
  let repaired = 0;
  try {
    // Cursor advances past conservative rejections so an edited/gated record
    // cannot starve another eligible receipt. No output is read by this scan.
    const candidates = await db.select({ id: kanbanCards.id }).from(kanbanCards).where(and(eligibleRoot(), afterId ? gt(kanbanCards.id, afterId) : undefined)).orderBy(kanbanCards.id).limit(8);
    afterId = candidates.length === 8 ? candidates[7]!.id : null;
    for (const candidate of candidates) {
      try { if (await recoverMissingA2aDeliveryReceipt(candidate.id)) repaired++; }
      catch (error) { onError(error); }
    }
    return repaired;
  } finally { sweeping = false; }
}
