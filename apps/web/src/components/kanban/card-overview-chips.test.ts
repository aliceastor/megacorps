import assert from 'node:assert/strict';
import test from 'node:test';
import { formatTemplate } from '../../lib/format.ts';
import { t } from '../../lib/i18n.ts';
import { childChipTone, needsYouVariant, normalizeDecisionMode, overviewChips } from './card-overview-chips.ts';
import type { Card, CardApproval } from './card-types.ts';

const tf = (key: string, vars?: Record<string, string | number>) => formatTemplate(t('zh-TW', key), vars ?? {});

function card(overrides: Partial<Card> = {}): Card {
  return { id: 'card-1', title: 'Card', body: '', columnStatus: 'todo', tags: [], priority: 0, ...overrides };
}

function approval(overrides: Partial<CardApproval> = {}): CardApproval {
  return { id: 'ap-1', type: 'client_checkpoint', status: 'pending', cardId: 'card-1', ...overrides };
}

test('the four base chips are always present and point at their form fields', () => {
  const chips = overviewChips(card({ priority: 2, decisionMode: 'pair', requiresApproval: true, maxRetries: 5 }), { tf });
  assert.deepEqual(chips.map((chip) => chip.id), ['priority', 'decisionMode', 'requiresApproval', 'maxRetries']);
  assert.deepEqual(chips.map((chip) => chip.field), ['priority', 'decisionMode', 'requiresApproval', 'maxRetries']);
  assert.equal(chips[0]!.text, '高');
  assert.equal(chips[1]!.text, '協作 pair');
  assert.equal(chips[2]!.text, '需要審批 ✓');
  assert.equal(chips[3]!.text, '重試上限 5');
});

test('defaults: normal priority, auto mode, no approval, three retries', () => {
  const chips = overviewChips(card(), { tf });
  assert.deepEqual(chips.map((chip) => chip.text), ['普通', '協作 auto', '需要審批 —', '重試上限 3']);
});

test('normalizeDecisionMode mirrors the edit form select', () => {
  assert.equal(normalizeDecisionMode(null), 'auto');
  assert.equal(normalizeDecisionMode('execute'), 'solo');
  assert.equal(normalizeDecisionMode('swarm'), 'swarm');
  assert.equal(normalizeDecisionMode('delegate'), 'auto');
});

test('dependencies count unmet ones in red; unknown dependencies are not counted as unmet', () => {
  const board = [card({ id: 'd1', columnStatus: 'done' }), card({ id: 'd2', columnStatus: 'in_progress' })];
  const chips = overviewChips(card({ dependencyCardIds: ['d1', 'd2', 'd-missing'] }), { tf, cards: board });
  const dependency = chips.find((chip) => chip.id === 'dependencies');
  assert.ok(dependency);
  assert.equal(dependency.text, '依賴 3 · 1 未完成');
  assert.equal(dependency.tone, 'danger');
  assert.equal(dependency.field, 'dependencyCardIds');
  const allMet = overviewChips(card({ dependencyCardIds: ['d1'] }), { tf, cards: board }).find((chip) => chip.id === 'dependencies');
  assert.equal(allMet?.text, '依賴 1');
  assert.equal(allMet?.tone, 'neutral');
  assert.equal(overviewChips(card({ dependencyCardIds: [] }), { tf }).some((chip) => chip.id === 'dependencies'), false);
});

test('a parent card shows live/total children with the round only when splitRound > 0', () => {
  const children = [{ id: 'k1', columnStatus: 'in_progress' }, { id: 'k2', columnStatus: 'done' }, { id: 'k3', columnStatus: 'waiting_on_client' }];
  const withRound = overviewChips(card({ splitRound: 2 }), { tf, children }).find((chip) => chip.id === 'children');
  assert.equal(withRound?.text, '子卡 2/3 · 第 2 輪');
  assert.equal(withRound?.field, null);
  const noRound = overviewChips(card({ splitRound: 0 }), { tf, children }).find((chip) => chip.id === 'children');
  assert.equal(noRound?.text, '子卡 2/3');
  assert.ok(!noRound?.text.includes('第 0 輪'));
  const unloadedWithRound = overviewChips(card({ splitRound: 1 }), { tf, children: null }).find((chip) => chip.id === 'children');
  assert.equal(unloadedWithRound?.text, '第 1 輪');
  assert.equal(overviewChips(card(), { tf, children: [] }).some((chip) => chip.id === 'children'), false);
});

test('forceBrainstorm adds an informational chip', () => {
  const chip = overviewChips(card({ forceBrainstorm: true }), { tf }).find((item) => item.id === 'forceBrainstorm');
  assert.equal(chip?.text, '強制腦力激盪');
  assert.equal(chip?.field, null);
  assert.equal(overviewChips(card(), { tf }).some((item) => item.id === 'forceBrainstorm'), false);
});

test('child chip tones: waiting_on_client amber, blocked red, finished grey', () => {
  assert.equal(childChipTone('waiting_on_client'), 'warning');
  assert.equal(childChipTone('blocked'), 'danger');
  assert.equal(childChipTone('done'), 'muted');
  assert.equal(childChipTone('cancelled'), 'muted');
  assert.equal(childChipTone('in_progress'), 'neutral');
});

test('waiting_on_client with a pending checkpoint embeds the answer form', () => {
  const pending = approval();
  const variant = needsYouVariant(card({ columnStatus: 'waiting_on_client' }), [pending]);
  assert.equal(variant?.kind, 'checkpoint');
  assert.equal(variant && 'approval' in variant ? variant.approval.id : '', 'ap-1');
});

test('waiting_on_client without a pending approval falls back to the last question once approvals have loaded', () => {
  const comments = [
    { id: 'c1', body: 'older', action: 'client_checkpoint_asked', authorType: 'agent', createdAt: '2026-09-01T10:00:00.000Z' },
    { id: 'c2', body: 'newest question', action: 'client_checkpoint_asked', authorType: 'agent', createdAt: '2026-09-02T10:00:00.000Z' },
  ];
  const withdrawn = needsYouVariant(card({ columnStatus: 'waiting_on_client' }), [approval({ status: 'cancelled' })], comments);
  assert.deepEqual(withdrawn, { kind: 'checkpointMissing', question: 'newest question' });
  assert.equal(needsYouVariant(card({ columnStatus: 'waiting_on_client' }), null, comments), null);
});

test('a human-approved card with a pending task_review gets the approve / reject form; otherwise a review hint', () => {
  const pending = approval({ id: 'ap-r', type: 'task_review' });
  const decide = needsYouVariant(card({ columnStatus: 'in_review', requiresApproval: true }), [pending]);
  assert.equal(decide?.kind, 'approval');
  const hint = needsYouVariant(card({ columnStatus: 'in_review', requiresApproval: true }), []);
  assert.deepEqual(hint, { kind: 'reviewHint' });
  assert.equal(needsYouVariant(card({ columnStatus: 'in_review', requiresApproval: true }), null), null);
  assert.equal(needsYouVariant(card({ columnStatus: 'in_review', requiresApproval: false }), []), null);
  assert.equal(needsYouVariant(card({ columnStatus: 'done', requiresApproval: true }), [pending]), null);
});

test('blocked offers continue-with-comment and todo offers run-now; other statuses show nothing', () => {
  assert.deepEqual(needsYouVariant(card({ columnStatus: 'blocked' }), []), { kind: 'blocked' });
  assert.deepEqual(needsYouVariant(card({ columnStatus: 'todo' }), null), { kind: 'todo' });
  assert.equal(needsYouVariant(card({ columnStatus: 'in_progress' }), []), null);
  assert.equal(needsYouVariant(card({ columnStatus: 'waiting_on_brainstorm' }), []), null);
  assert.equal(needsYouVariant(card({ columnStatus: 'done' }), []), null);
});
