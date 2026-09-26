import assert from 'node:assert/strict';
import test, { type TestContext } from 'node:test';
import { randomUUID } from 'node:crypto';
import Fastify from 'fastify';
import cookie from '@fastify/cookie';
import { approvals, cardComments, companies, companyMemberships, externalWaits, kanbanCards, mergeIntents, projects, reviewRounds, users, workProducts } from './db/schema.ts';
import { memoryDb } from './test-support/memory-db.ts';
import { captureDeliveryAcceptance } from './delivery-acceptance.ts';
import { acceptedReviewerEvidencePacket } from './reviewer-evidence.ts';
import { registerRoutes } from './routes.ts';
import { signSession } from './auth.ts';

const head = 'a'.repeat(40);
const report = (overrides: Record<string, unknown> = {}) => JSON.stringify({
  kind: 'megacorps-report', status: 'completed', verdict: 'approved', score: 8,
  summary: 'Checked 4 references against source records; remaining scope excluded',
  verifications: [{ findingKey: 'R1', status: 'verified', note: 'Reference checked' }],
  ...overrides,
});

async function fixture(t: TestContext, managed = false) {
  const parent: any = { id: randomUUID(), companyId: randomUUID(), projectId: managed ? randomUUID() : null };
  const child: any = { id: randomUUID(), companyId: parent.companyId, projectId: parent.projectId, parentCardId: parent.id,
    columnStatus: 'done', assigneeId: randomUUID(), reviewerId: randomUUID(), title: 'Report', reviewFeedback: report() };
  const product: any = { id: randomUUID(), companyId: parent.companyId, projectId: parent.projectId,
    cardId: child.id, agentId: child.assigneeId, taskRunId: randomUUID(), title: 'Original report' };
  const state = memoryDb(t, [[kanbanCards, [parent, child]], [workProducts, [product]]]);
  if (managed) {
    child.reviewIdentity = { id: randomUUID(), headSha: head, projectId: parent.projectId, repoUrl: 'https://example.test/repo', externalId: '17' };
    state.rows(projects).push({ id: parent.projectId, companyId: parent.companyId, completionRequiresMerge: true, autoMergeAfterApproval: true });
    state.rows(externalWaits).push({ id: 'wait', companyId: parent.companyId, cardId: child.id, provider: 'gitea', status: 'success', authorizedHeadSha: head });
    state.rows(mergeIntents).push({ id: 'intent', cardId: child.id, projectId: parent.projectId, waitId: 'wait', state: 'verified', headSha: head });
  }
  child.deliveryAcceptance = await captureDeliveryAcceptance(child);
  assert.ok(child.deliveryAcceptance);
  return { parent, child, product, state };
}

test('packet exposes current accepted reviewer checks and original provenance, not raw CLI histories', async t => {
  const { parent, child, product } = await fixture(t);
  const packet = await acceptedReviewerEvidencePacket(parent);
  assert.ok(packet.includes(`reviewer=${child.reviewerId}`));
  assert.ok(packet.includes(`author=${child.assigneeId}`));
  assert.ok(packet.includes(product.id));
  assert.ok(packet.includes(product.taskRunId));
  assert.match(packet, /Checked 4 references/);
  assert.match(packet, /score=8/);
  assert.match(packet, /remaining scope excluded/);
  product.title = 'Changed';
  assert.doesNotMatch(await acceptedReviewerEvidencePacket(parent), /Checked 4 references/);
});

test('unstructured reviewer output stays a pointer and cannot claim checks', async t => {
  const { parent, child } = await fixture(t);
  child.reviewFeedback = 'SECRET_RAW_CLI historical tools';
  const packet = await acceptedReviewerEvidencePacket(parent);
  assert.doesNotMatch(packet, /SECRET_RAW_CLI/);
  assert.match(packet, /structured reviewer checks unavailable/);
});

test('long accepted reviews keep exact identity, prioritized unresolved limitations and bounded excerpts', async t => {
  const { parent, child } = await fixture(t, true);
  child.reviewFeedback = 'SECRET_RAW_CLI history\n'.repeat(5000) + report({
    summary: `Checked source records. ${'Repeated detail. '.repeat(210)} LIMITATION: device testing excluded.`,
    verifications: [
      ...Array.from({ length: 58 }, (_, i) => ({ findingKey: `R${i}`, status: 'verified', note: 'Test passed. '.repeat(150) })),
      { findingKey: 'OPEN', status: 'still_open', note: 'Physical device result unavailable' },
    ],
    findings: [
      ...Array.from({ length: 29 }, (_, i) => ({ id: `F${i}`, severity: 'P2', title: `Small caveat ${i}`, evidence: 'Evidence detail. '.repeat(100), requiredFix: 'Follow-up detail. '.repeat(100) })),
      { id: 'LIMIT', severity: 'P0', title: 'Production boundary', evidence: 'Production migration untested', requiredFix: 'Verify before production deployment' },
    ],
  });
  const packet = await acceptedReviewerEvidencePacket(parent);
  t.diagnostic(`long accepted review: ${child.reviewFeedback.length} source characters -> ${packet.length} packet characters`);
  assert.ok(packet.length <= 3000, `packet was ${packet.length} characters`);
  assert.ok(packet.includes(`acceptedHead=${head}`));
  assert.ok(packet.includes(`reviewIdentity=${child.reviewIdentity.id}`));
  assert.ok(packet.includes(child.deliveryAcceptance.acceptedAt));
  assert.ok(!packet.includes(child.deliveryAcceptance.assignment));
  assert.ok(!packet.includes(child.deliveryAcceptance.evidence));
  assert.match(packet, /device testing excluded/);
  assert.match(packet, /OPEN.*still_open.*Physical device result unavailable/);
  assert.match(packet, /P0.*Production boundary.*Production migration untested/);
  assert.match(packet, /omitted|shortened/);
  assert.doesNotMatch(packet, /SECRET_RAW_CLI/);
});

test('packet explicitly scopes reuse to manager assessment of the same accepted artifact', async t => {
  const { parent } = await fixture(t, true);
  const packet = await acceptedReviewerEvidencePacket(parent);
  assert.match(packet, /manager goal assessment/i);
  assert.match(packet, /same (?:accepted )?artifact/i);
  assert.match(packet, /same head/i);
  assert.match(packet, /not a new independent (?:verification|QA)/i);
  assert.match(packet, /changed head.*new review/i);
});

for (const mutation of ['product content', 'product head', 'reviewer', 'assignee', 'body', 'reopened', 'pending approval', 'open panel', 'merge head', 'merge intent'] as const) {
  test(`packet rejects stale acceptance after ${mutation} changes`, async t => {
    const { parent, child, product, state } = await fixture(t, true);
    if (mutation === 'product content') product.summary = 'Replaced evidence';
    if (mutation === 'product head') product.commitSha = 'b'.repeat(40);
    if (mutation === 'reviewer') child.reviewerId = 'replacement';
    if (mutation === 'assignee') child.assigneeId = 'replacement';
    if (mutation === 'body') child.body = 'Revised assignment';
    if (mutation === 'reopened') child.columnStatus = 'in_progress';
    if (mutation === 'pending approval') state.rows(approvals).push({ id: 'pending', cardId: child.id, status: 'pending' });
    if (mutation === 'open panel') state.rows(reviewRounds).push({ id: 'panel', cardId: child.id, status: 'open' });
    if (mutation === 'merge head') state.rows(externalWaits)[0]!.authorizedHeadSha = 'b'.repeat(40);
    if (mutation === 'merge intent') state.rows(mergeIntents)[0]!.state = 'pending';
    const packet = await acceptedReviewerEvidencePacket(parent);
    assert.match(packet, /acceptance is no longer current/);
    assert.doesNotMatch(packet, /Checked 4 references|verdict=approved/);
  });
}

test('a recorded review of a different head cannot become reusable accepted checks', async t => {
  const { parent, child } = await fixture(t, true);
  child.reviewIdentity.headSha = 'b'.repeat(40);
  const packet = await acceptedReviewerEvidencePacket(parent);
  assert.match(packet, /review head.*(?:differs|mismatch).*accepted head/i);
  assert.doesNotMatch(packet, /Checked 4 references|verdict=approved/);
});

test('author-only accepted evidence is clearly distinguished from reviewer approval', async t => {
  const { parent, child } = await fixture(t);
  child.reviewerId = null;
  child.executionLog = report({ verdict: 'approved', score: 10, summary: 'Author completion statement' });
  child.deliveryAcceptance = await captureDeliveryAcceptance(child);
  const packet = await acceptedReviewerEvidencePacket(parent);
  assert.match(packet, /author statement only/);
  assert.match(packet, /verdict=author completed/);
  assert.match(packet, /score=not applicable/);
  assert.doesNotMatch(packet, /verdict=approved/);
});

test('packet bounds a large accepted tree and exposes how to discover omitted cards', async t => {
  const { parent, child, product, state } = await fixture(t);
  for (let index = 0; index < 30; index++) {
    const sibling = { ...child, id: randomUUID(), reviewFeedback: report({ summary: 'Detailed result. '.repeat(230) }) };
    state.rows(kanbanCards).push(sibling);
    state.rows(workProducts).push({ ...product, id: randomUUID(), cardId: sibling.id });
    sibling.deliveryAcceptance = await captureDeliveryAcceptance(sibling);
  }
  const packet = await acceptedReviewerEvidencePacket(parent);
  t.diagnostic(`31 accepted cards: ${packet.length} packet characters`);
  assert.ok(packet.length <= 8000, `packet was ${packet.length} characters`);
  assert.match(packet, /omitted|limited/i);
  assert.ok(packet.includes(`/api/cards/${parent.id}/context`));
});

test('full-evidence GET pointers are usable with authorized company access and reject unauthenticated reads', async t => {
  const { parent, child, product, state } = await fixture(t, true);
  const user = { id: randomUUID(), email: 'evidence@example.test', role: 'viewer', status: 'active' };
  state.rows(users).push(user);
  state.rows(companies).push({ id: parent.companyId, name: 'Evidence company', slug: 'evidence-company' });
  state.rows(companyMemberships).push({ userId: user.id, companyId: parent.companyId, role: 'viewer', status: 'active' });
  state.rows(cardComments).push({ id: randomUUID(), cardId: child.id, authorType: 'agent', authorId: child.reviewerId, body: child.reviewFeedback, createdAt: new Date() });
  const app = Fastify();
  t.after(() => app.close());
  await app.register(cookie);
  await registerRoutes(app);
  const headers = { cookie: `session=${await signSession(user)}` };
  const packet = await acceptedReviewerEvidencePacket(parent);
  assert.match(packet, /authenticated.*(?:session|API token)/i);
  assert.match(packet, /company access/i);
  assert.match(packet, /request\.kind=help/);
  for (const kind of ['context', 'comments', 'work-products']) {
    const url = `/api/cards/${child.id}/${kind}`;
    assert.ok(packet.includes(`GET ${url}`), `missing actual pointer ${url}`);
    assert.equal((await app.inject({ url })).statusCode, 401);
    const response = await app.inject({ url, headers });
    assert.equal(response.statusCode, 200, response.body);
    if (kind === 'context') {
      assert.equal(response.json().currentCard.reviewFeedback, child.reviewFeedback);
      assert.deepEqual(response.json().currentCard.deliveryAcceptance, child.deliveryAcceptance);
    }
    if (kind === 'comments') assert.equal(response.json()[0].body, child.reviewFeedback);
    if (kind === 'work-products') assert.equal(response.json()[0].id, product.id);
  }
  state.rows(companyMemberships)[0]!.status = 'inactive';
  assert.equal((await app.inject({ url: `/api/cards/${child.id}/context`, headers })).statusCode, 403);
});
