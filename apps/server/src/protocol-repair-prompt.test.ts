import assert from 'node:assert/strict';
import test from 'node:test';
import { companies, agents, kanbanCards } from './db/schema.ts';
import { memoryDb } from './test-support/memory-db.ts';
import * as protocolRepair from './protocol-repair.ts';

const correctionReason = 'report_schema_invalid: review.score: expected number; received string. Correct review.score to satisfy the stated constraint.';
const rejectedReport = '{"kind":"megacorps-report","status":"completed","summary":"Reviewed the delivered APK and its recorded checks.","review":{"verdict":"approved","score":"91"},"workProducts":[{"type":"pull_request","url":"https://gitea.example/project/pulls/7","headSha":"abc123"}]}';

for (const kind of ['dispatch', 'review'] as const) {
  for (const actorId of ['boss', 'head', 'staff']) {
    for (const mode of ['same_session', 'fresh_context', 'helped'] as const) {
      test(`${kind} ${mode} repair supplies the precise correction for ${actorId}`, () => {
        assert.equal(typeof protocolRepair.protocolRepairPrompt, 'function');
        const card: any = { lastError: 'Unrelated older error', protocolRepairState: { [kind]: { failures: 1, mode, actorId, reason: correctionReason, rejectedReport } } };
        const prompt = protocolRepair.protocolRepairPrompt(card, kind, actorId);
        assert.ok(prompt.includes(correctionReason));
        assert.ok(prompt.includes(rejectedReport));
        assert.doesNotMatch(prompt, /Unrelated older error/);
        assert.match(prompt, /Do not redo (?:the )?work or rescore/i);
        assert.match(prompt, /Preserve the intended status, verdict, score, summary, evidence, artifact, PR and head/i);
        assert.match(prompt, /(?:missing evidence|missing information).*?(?:work|help)/i);
      });
    }
  }
}

test('repair context is absent for unrelated actors, stages, cleared and inactive state', () => {
  assert.equal(typeof protocolRepair.protocolRepairPrompt, 'function');
  const repair = { failures: 1, mode: 'fresh_context', actorId: 'reviewer', reason: correctionReason, rejectedReport };
  const card: any = { lastError: correctionReason, protocolRepairState: { review: repair } };
  assert.equal(protocolRepair.protocolRepairPrompt(card, 'review', 'other'), '');
  assert.equal(protocolRepair.protocolRepairPrompt(card, 'dispatch', 'reviewer'), '');
  assert.equal(protocolRepair.protocolRepairPrompt({ lastError: correctionReason }, 'review', 'reviewer'), '');
  for (const mode of ['clear', 'blocked', 'escalated']) {
    assert.equal(protocolRepair.protocolRepairPrompt({ ...card, protocolRepairState: { review: { ...repair, mode } } } as any, 'review', 'reviewer'), '');
  }
  assert.equal(protocolRepair.protocolRepairPrompt({ ...card, protocolRepairState: { review: { ...repair, failures: 0 } } } as any, 'review', 'reviewer'), '');
});

test('legacy active repair state uses its persisted lastError without needing a prior report', () => {
  assert.equal(typeof protocolRepair.protocolRepairPrompt, 'function');
  const card: any = { lastError: `Correction needed: ${correctionReason}`, protocolRepairState: { review: { failures: 2, mode: 'fresh_context', actorId: 'reviewer' } } };
  assert.ok(protocolRepair.protocolRepairPrompt(card, 'review', 'reviewer').includes(correctionReason));
});

test('repair persistence retains only the current terminal report across restart and duplicate delivery', async (t) => {
  const card: any = { id: 'card', companyId: 'company', columnStatus: 'in_review', reviewerId: 'reviewer' };
  const actor: any = { id: 'reviewer', companyId: 'company', isActive: true, adapterType: 'webhook' };
  memoryDb(t, [[companies, [{ id: card.companyId }]], [kanbanCards, [card]], [agents, [actor]]]);
  const input = { card, actor, kind: 'review' as const, runKey: 'run-1', reason: correctionReason, output: `┌─ Reasoning ───┐\nprivate CLI/tool transcript\n\n\`\`\`megacorps-report\n${rejectedReport}\n\`\`\`` };
  await protocolRepair.recordProtocolFailure(input);
  assert.equal(card.protocolRepairState.review.reason, correctionReason);
  assert.equal(card.protocolRepairState.review.rejectedReport, rejectedReport);
  assert.doesNotMatch(JSON.stringify(card.protocolRepairState), /private CLI\/tool transcript/);
  await protocolRepair.recordProtocolFailure({ ...input, card: structuredClone(card), reason: 'Duplicate error', output: 'Duplicate transcript' });
  assert.equal(card.protocolRepairState.review.reason, correctionReason);
  assert.equal(card.protocolRepairState.review.rejectedReport, rejectedReport);
  await protocolRepair.recordProtocolFailure({ ...input, card: structuredClone(card), runKey: 'run-2', reason: 'Current terminal report missing', output: 'Ambiguous text without a report' });
  assert.equal(card.protocolRepairState.review.reason, 'Current terminal report missing');
  assert.equal(card.protocolRepairState.review.rejectedReport, undefined, 'a new failure never reuses an older rejected report');
});

for (const [label, output] of [
  ['historical example followed by ambiguous prose', `┌─ Reasoning ───┐\n${rejectedReport}\nThis is still just tool output.`],
  ['oversized terminal report', JSON.stringify({ kind: 'megacorps-report', summary: 'private detail '.repeat(2000) })],
] as const) {
  test(`repair omits unsafe report data: ${label}`, async (t) => {
    const card: any = { id: 'card', companyId: 'company', columnStatus: 'in_review', reviewerId: 'reviewer' };
    const actor: any = { id: 'reviewer', companyId: 'company', isActive: true, adapterType: 'webhook' };
    memoryDb(t, [[companies, [{ id: card.companyId }]], [kanbanCards, [card]], [agents, [actor]]]);
    await protocolRepair.recordProtocolFailure({ card, actor, kind: 'review', runKey: 'run-1', reason: correctionReason, output });
    assert.equal(card.protocolRepairState.review.rejectedReport, undefined);
  });
}

test('repair prompt bounds legacy error and report fields before injection', () => {
  assert.equal(typeof protocolRepair.protocolRepairPrompt, 'function');
  const card: any = { lastError: 'Last error '.repeat(5000), protocolRepairState: { review: { failures: 1, mode: 'same_session', actorId: 'reviewer', rejectedReport: 'private CLI transcript '.repeat(2000) } } };
  const prompt = protocolRepair.protocolRepairPrompt(card, 'review', 'reviewer');
  assert.ok(prompt.length < 12_000);
  assert.doesNotMatch(prompt, /private CLI transcript/);
});

test('a multiline rejected terminal report survives persistence and prompt reconstruction', async (t) => {
  const card: any = { id: 'card', companyId: 'company', columnStatus: 'in_review', reviewerId: 'reviewer' };
  const actor: any = { id: 'reviewer', companyId: 'company', isActive: true, adapterType: 'webhook' };
  memoryDb(t, [[companies, [{ id: card.companyId }]], [kanbanCards, [card]], [agents, [actor]]]);
  const report = JSON.stringify(JSON.parse(rejectedReport), null, 2);
  await protocolRepair.recordProtocolFailure({ card, actor, kind: 'review', runKey: 'run-1', reason: correctionReason, output: `private tool log\n\n\`\`\`megacorps-report\n${report}\n\`\`\`` });
  assert.equal(card.protocolRepairState.review.rejectedReport, report);
  const prompt = protocolRepair.protocolRepairPrompt(structuredClone(card), 'review', actor.id);
  assert.ok(prompt.includes(report));
  assert.doesNotMatch(prompt, /private tool log/);
});
