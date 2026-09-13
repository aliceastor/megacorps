import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import { eq } from 'drizzle-orm';
import { isolatedPostgres } from './test-support/postgres-db.ts';

test('collaboration review and accepted return preserve requested agents and gates', { skip: !process.env.TEST_DATABASE_URL && !process.env.CI ? 'TEST_DATABASE_URL absent; isolated PostgreSQL checks run in CI' : false, timeout: 60_000 }, async (t) => {
  const { db } = await isolatedPostgres(t);
  const { agents, approvals, cardComments, companies, departments, kanbanCards, reviewRounds, taskRuns, workProducts } = await import('./db/schema.ts');
  const { openPanelRound, tryCloseRound } = await import('./review-rounds.ts');
  const { buildTaskPrompt, cascadeParentStatus } = await import('./dispatch.ts');
  const { sealDeliveryAcceptance } = await import('./delivery-acceptance.ts');
  const [company] = await db.insert(companies).values({ name: 'Collaboration review', slug: `collaboration-review-${randomUUID()}` }).returning();
  const [sourceDepartment, targetDepartment] = await db.insert(departments).values([
    { companyId: company!.id, name: 'Source', slug: 'source' },
    { companyId: company!.id, name: 'Target', slug: 'target' },
  ]).returning();
  const [sourceHead, requester, targetHead] = await db.insert(agents).values([
    { companyId: company!.id, departmentId: sourceDepartment!.id, name: 'Source Head', slug: 'source-head', role: 'manager', adapterType: 'webhook', isBusy: true },
    { companyId: company!.id, departmentId: sourceDepartment!.id, name: 'Requester', slug: 'requester', role: 'worker', adapterType: 'webhook' },
    { companyId: company!.id, departmentId: targetDepartment!.id, name: 'Target Head', slug: 'target-head', role: 'manager', adapterType: 'webhook' },
  ]).returning();
  const [card] = await db.insert(kanbanCards).values({
    companyId: company!.id,
    departmentId: targetDepartment!.id,
    title: 'Collaboration child',
    body: 'Return independently reviewed evidence.',
    assigneeId: targetHead!.id,
    reviewerId: sourceHead!.id,
    reviewerIds: [sourceHead!.id, requester!.id],
    reviewMode: 'panel',
    columnStatus: 'in_review',
    splitRequestKey: `collaboration:${randomUUID()}`,
  }).returning();

  const opened = await openPanelRound(card!, { kind: 'panel' });
  assert.equal(opened.outcome, 'opened');
  assert.deepEqual(opened.reviewerIds, [sourceHead!.id, requester!.id]);
  const [round] = await db.select().from(reviewRounds).where(eq(reviewRounds.cardId, card!.id));
  assert.deepEqual(round!.reviewerIds, [sourceHead!.id, requester!.id]);
  const queued = await db.select().from(taskRuns).where(eq(taskRuns.cardId, card!.id));
  assert.deepEqual(queued.map((run) => run.agentId).sort(), [requester!.id, sourceHead!.id].sort());

  const requesterSlot = (await db.select().from(cardComments).where(eq(cardComments.cardId, card!.id)))
    .find((slot) => (slot.metadata as { reviewerId?: string }).reviewerId === requester!.id)!;
  await db.update(cardComments).set({ metadata: { ...(requesterSlot.metadata as object), done: true } }).where(eq(cardComments.id, requesterSlot.id));
  await db.update(reviewRounds).set({ timeoutAt: new Date(0), metadata: { ...(round!.metadata as object), verdicts: { [requester!.id]: 'approved' } } }).where(eq(reviewRounds.id, round!.id));
  assert.equal(await tryCloseRound(round!.id, { force: true, closedBy: 'timeout' }), false, 'busy eligible collaboration reviewer must keep panel open');
  const [waitingRound] = await db.select().from(reviewRounds).where(eq(reviewRounds.id, round!.id));
  assert.equal(waitingRound!.status, 'open');
  const sourceRun = queued.find((run) => run.agentId === sourceHead!.id)!;
  assert.equal((await db.select().from(taskRuns).where(eq(taskRuns.id, sourceRun.id)))[0]!.status, 'queued');

  const [verifyRound] = await db.insert(reviewRounds).values({
    companyId: company!.id, cardId: card!.id, round: 2, kind: 'verify', authorAgentId: targetHead!.id,
    reviewerIds: [sourceHead!.id, requester!.id], status: 'open', timeoutAt: new Date(0),
    metadata: { panelRoundId: round!.id, findingKeys: [], verifications: { [requester!.id]: [] } },
  }).returning();
  const [sourceVerifySlot, requesterVerifySlot] = await db.insert(cardComments).values([
    { cardId: card!.id, authorType: 'system', action: 'review_slot', body: 'Source verify', metadata: { roundId: verifyRound!.id, reviewerId: sourceHead!.id, done: false } },
    { cardId: card!.id, authorType: 'system', action: 'review_slot', body: 'Requester verify', metadata: { roundId: verifyRound!.id, reviewerId: requester!.id, done: true } },
  ]).returning();
  const [sourceVerifyRun] = await db.insert(taskRuns).values({ companyId: company!.id, cardId: card!.id, agentId: sourceHead!.id, kind: 'panel_review', status: 'queued', messageCommentId: sourceVerifySlot!.id }).returning();
  assert.equal(await tryCloseRound(verifyRound!.id, { force: true, closedBy: 'timeout' }), false, 'busy eligible collaboration reviewer must keep verification open');
  assert.equal((await db.select().from(reviewRounds).where(eq(reviewRounds.id, verifyRound!.id)))[0]!.status, 'open');
  await db.update(taskRuns).set({ status: 'failed' }).where(eq(taskRuns.id, sourceVerifyRun!.id));
  await db.update(cardComments).set({ metadata: { ...(sourceVerifySlot!.metadata as object), done: true, failed: true } }).where(eq(cardComments.id, sourceVerifySlot!.id));
  assert.equal(await tryCloseRound(verifyRound!.id, { force: true, closedBy: 'timeout' }), true, 'exhausted reviewer run routes unavailable instead of waiting forever');
  const [unavailableVerify] = await db.select().from(reviewRounds).where(eq(reviewRounds.id, verifyRound!.id));
  assert.equal(unavailableVerify!.decision, 'unavailable');
  assert.match(String((unavailableVerify!.metadata as { collaborationUnavailableReason?: string }).collaborationUnavailableReason), /no viable review run/);

  await db.update(agents).set({ isActive: false }).where(eq(agents.id, sourceHead!.id));
  // Deliver a stale initial SELECT to the closer while another connection-level
  // operation has already committed the final verdict. This must survive claim.
  let interleaved = false;
  const originalSelect = db.select.bind(db);
  const selectMock = t.mock.method(db, 'select', ((...args: any[]) => {
    const query: any = originalSelect(...args as []);
    const originalFrom = query.from.bind(query);
    query.from = (table: unknown) => {
      const chain = originalFrom(table);
      if (table === reviewRounds) {
        const originalThen = chain.then.bind(chain);
        chain.then = (resolve: (value: unknown) => unknown, reject: (error: unknown) => unknown) => originalThen(async (rows: any[]) => {
          if (!interleaved && rows.some(row => row.id === round!.id)) {
            interleaved = true;
            await db.update(reviewRounds).set({ metadata: { ...(waitingRound!.metadata as object), verdicts: { [requester!.id]: 'revision_requested' }, verifications: { [requester!.id]: [{ findingKey: 'late-entry', status: 'still_open' }] } } }).where(eq(reviewRounds.id, round!.id));
          }
          return resolve(rows);
        }, reject);
      }
      return chain;
    };
    return query;
  }) as typeof db.select);
  assert.equal(await tryCloseRound(round!.id, { force: true, closedBy: 'timeout' }), true, 'a real eligibility shortage may downgrade');
  selectMock.mock.restore();
  assert.equal(interleaved, true);
  const [shortageRound] = await db.select().from(reviewRounds).where(eq(reviewRounds.id, round!.id));
  assert.equal(shortageRound!.decision, 'revision_requested');
  assert.equal((shortageRound!.metadata as { panel_degraded?: boolean }).panel_degraded, true);
  assert.match(String((shortageRound!.metadata as { collaborationShortageReason?: string }).collaborationShortageReason), /inactive/);
  assert.equal((shortageRound!.metadata as any).verdicts[requester!.id], 'revision_requested', 'close metadata patch must preserve a late reviewer verdict');
  assert.equal((shortageRound!.metadata as any).verifications[requester!.id][0].status, 'still_open', 'close metadata patch must preserve late verification entries');
  await db.update(agents).set({ isActive: true }).where(eq(agents.id, sourceHead!.id));

  const [inactiveReviewer] = await db.insert(agents).values({ companyId: company!.id, departmentId: sourceDepartment!.id, name: 'Inactive requester', slug: 'inactive-requester', role: 'worker', adapterType: 'webhook', isActive: false }).returning();
  const [degradedCard, unavailableCard] = await db.insert(kanbanCards).values([
    { companyId: company!.id, departmentId: targetDepartment!.id, title: 'Degraded collaboration review', body: 'One requested seat is unavailable.', assigneeId: targetHead!.id, reviewerId: sourceHead!.id, reviewerIds: [sourceHead!.id, inactiveReviewer!.id], reviewMode: 'panel', columnStatus: 'in_review', splitRequestKey: `collaboration:${randomUUID()}` },
    { companyId: company!.id, departmentId: targetDepartment!.id, title: 'Unavailable collaboration review', body: 'No requested seat is available.', assigneeId: targetHead!.id, reviewerId: inactiveReviewer!.id, reviewerIds: [inactiveReviewer!.id], reviewMode: 'panel', columnStatus: 'in_review', splitRequestKey: `collaboration:${randomUUID()}` },
  ]).returning();
  const degraded = await openPanelRound(degradedCard!, { kind: 'panel' });
  assert.equal(degraded.outcome, 'degraded');
  assert.deepEqual(degraded.reviewerIds, [sourceHead!.id]);
  const [degradedRound] = await db.select().from(reviewRounds).where(eq(reviewRounds.cardId, degradedCard!.id));
  assert.equal((degradedRound!.metadata as { panel_degraded?: boolean }).panel_degraded, true);
  assert.match(String((degradedRound!.metadata as { composition?: string }).composition), /explicit:/);
  const unavailable = await openPanelRound(unavailableCard!, { kind: 'panel' });
  assert.equal(unavailable.outcome, 'human_gate');
  assert.equal(unavailable.roundId, null);
  const [gate] = await db.select().from(approvals).where(eq(approvals.cardId, unavailableCard!.id));
  assert.equal(gate!.status, 'pending');
  assert.equal((gate!.payload as { humanGate?: boolean }).humanGate, true);
  const [parent] = await db.insert(kanbanCards).values({
    companyId: company!.id,
    departmentId: sourceDepartment!.id,
    title: 'Original Staff task',
    body: 'Integrate collaboration evidence.',
    assigneeId: requester!.id,
    columnStatus: 'in_progress',
    rollupStatus: 'waiting_on_children',
    requiredChildPolicy: 'all_required_accepted',
  }).returning();
  const [child] = await db.insert(kanbanCards).values({
    companyId: company!.id,
    departmentId: targetDepartment!.id,
    parentCardId: parent!.id,
    title: 'Collaboration child',
    body: 'Supply evidence.',
    assigneeId: targetHead!.id,
    columnStatus: 'done',
    childRequirementLevel: 'required',
    splitRequestKey: `collaboration:${randomUUID()}`,
  }).returning();
  await db.insert(cardComments).values({
    cardId: child!.id,
    authorType: 'system',
    action: 'collaboration_requested',
    body: 'Trusted provenance',
    metadata: { sourceCardId: parent!.id, requesterAgentId: requester!.id, sourceDepartmentId: sourceDepartment!.id, targetDepartmentId: targetDepartment!.id, requestedReviewerIds: [requester!.id], sourceTaskRunId: null },
  });

  await cascadeParentStatus(parent!.id);
  let [freshParent] = await db.select().from(kanbanCards).where(eq(kanbanCards.id, parent!.id));
  assert.equal(freshParent!.rollupStatus, 'waiting_on_children');
  assert.equal((await db.select().from(taskRuns).where(eq(taskRuns.cardId, parent!.id))).length, 0);

  await db.insert(workProducts).values({ companyId: company!.id, cardId: child!.id, agentId: targetHead!.id, type: 'report', title: 'Accepted collaboration evidence', summary: 'Reviewed evidence for integration.' });
  await sealDeliveryAcceptance(child!.id);
  await cascadeParentStatus(parent!.id);
  await cascadeParentStatus(parent!.id);
  [freshParent] = await db.select().from(kanbanCards).where(eq(kanbanCards.id, parent!.id));
  assert.equal(freshParent!.assigneeId, requester!.id);
  assert.equal(freshParent!.columnStatus, 'in_progress');
  assert.equal(freshParent!.rollupStatus, 'integrating');
  const integrationPrompt = await buildTaskPrompt(freshParent!, { continuation: true });
  assert.match(integrationPrompt, /INTEGRATION TURN: continue the original Staff-owned work/);
  assert.doesNotMatch(integrationPrompt, /Remain strategy-only/);
  const parentRuns = await db.select().from(taskRuns).where(eq(taskRuns.cardId, parent!.id));
  assert.equal(parentRuns.filter((run) => run.kind === 'dispatch' && ['queued', 'running'].includes(run.status)).length, 1);
});
