import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { messages } from './i18n.ts';

// Grep-style parity: every card comment / card action literal the server can
// write (`action: '...'` in dispatch.ts and routes.ts, including the ternary
// forms) must have a `kanban.event.<action>` label, otherwise the 對話 tab
// would show a raw token for a row the server just started producing.

const here = dirname(fileURLToPath(import.meta.url));
const serverSrc = resolve(here, '../../../server/src');
const serverFiles = ['dispatch.ts', 'routes.ts'];

// Activity-feed and live-event actions are dotted (`card.created`) and are
// not conversation rows; the card vocabulary is snake_case without dots.
const LITERAL_RE = /'([a-z][a-z_]*)'/g;
const NEXT_KEY_RE = /,\s*[A-Za-z_]+\??:/;
const NOT_CARD_ROW_RE = /addActivity\(|activityLog|publishLiveEvent\(|notify\(/;

export function collectActionLiterals(source: string): Set<string> {
  const out = new Set<string>();
  for (const rawLine of source.split(/\r?\n/)) {
    if (!/\baction:/.test(rawLine)) continue;
    // `x === 'final' ? 'a' : 'b'` — comparisons are not action literals.
    const line = rawLine.replace(/[!=]==\s*'[^']*'/g, '');
    const keyRe = /\baction:/g;
    let match: RegExpExecArray | null;
    while ((match = keyRe.exec(line))) {
      const before = line.slice(0, match.index);
      if (NOT_CARD_ROW_RE.test(before)) continue;
      const after = line.slice(match.index + match[0].length);
      const segment = after.split(NEXT_KEY_RE)[0] ?? '';
      for (const literal of segment.matchAll(LITERAL_RE)) {
        if (literal[1]) out.add(literal[1]);
      }
    }
  }
  return out;
}

const transitionActions = ['claim', 'submit_review', 'request_help', 'wait_external', 'external_success', 'external_failure', 'ask_client', 'client_answered', 'open_brainstorm', 'brainstorm_closed', 'approve', 'reject', 'complete', 'block', 'cancel', 'release', 'resume', 'reopen', 'manual_move'];

test('collectActionLiterals reads plain and ternary action literals and skips comparisons', () => {
  const sample = [
    "await addCardMessage({ cardId: card.id, action: 'delegate_report', body: x });",
    "  action: report.reviewerScope === 'final' ? 'final_review_approved' : 'phase_review_approved', body: result.output,",
    "  action: childBlock ? 'review_waiting_on_children' : rejected ? (reviewMode === 'help' ? 'review_guidance' : 'review_rejected') : 'review_note', body: out });",
    "await addActivity({ companyId: c, action: 'peer_question.asked', entityType: 'card' });",
    "publishLiveEvent({ type: 'card.updated', action: 'brainstorm.opened' });",
    "  action: effectiveAction,",
  ].join('\n');
  assert.deepEqual([...collectActionLiterals(sample)].sort(), ['delegate_report', 'final_review_approved', 'phase_review_approved', 'review_guidance', 'review_note', 'review_rejected', 'review_waiting_on_children']);
});

test('every server action literal has a kanban.event.* label in zh-TW', () => {
  const literals = new Set<string>();
  for (const file of serverFiles) {
    const source = readFileSync(resolve(serverSrc, file), 'utf8');
    for (const literal of collectActionLiterals(source)) literals.add(literal);
  }
  assert.ok(literals.size >= 30, `expected a healthy vocabulary, got ${literals.size}`);
  for (const expected of ['delegate_report', 'client_checkpoint_asked', 'brainstorm_opened', 'phase_review_approved', 'review_guidance']) {
    assert.ok(literals.has(expected), `grep should have found ${expected}`);
  }
  const zh = messages['zh-TW'];
  const missing = [...literals].filter((literal) => !zh[`kanban.event.${literal}`]).sort();
  assert.deepEqual(missing, [], `add kanban.event.<action> for: ${missing.join(', ')}`);
});

test('every card transition action and the label list from the design have labels in all locales', () => {
  const designed = ['comment', 'note', 'agent_note', 'agent_question', 'peer_question', 'peer_answer', 'brainstorm_proposal', 'handoff', 'pause_agent', 'continue_run', 'send_to_agent', 'escalate_to_reviewer', 'delegate_request', 'agent_delegated', 'delegate_report', 'delegate_failed', 'delegate_timeout', 'delegate_retry_queued', 'delegate_review_retry_queued', 'delegate_review_rejected', 'delegate_review_failed', 'delegate_review_escalated', 'phase_review_approved', 'final_review_approved', 'review_note', 'review_guidance', 'review_rejected', 'review_escalated', 'review_error', 'review_blocked', 'review_auto_approved', 'review_waiting_on_children', 'review_result', 'split_opened', 'split_child_opened', 'split_rejected', 'split_round_complete', 'brainstorm_opened', 'brainstorm_closed', 'brainstorm_rejected', 'client_checkpoint_asked', 'client_checkpoint_answered', 'client_checkpoint_rejected', 'agent_error', 'peer_question_failed', 'create_card', 'update_card', 'claim', 'cancel', 'block', 'wait_external', 'stage_changed', 'work_product', 'dispatch_failed', 'integration_conflict', 'lock_expired', 'budget', 'budget_override_required', 'card_blocked', 'mention_question', 'mention_unresolved', 'agent_comment'];
  for (const locale of ['zh-TW', 'en', 'ja'] as const) {
    const table = messages[locale];
    const missing = [...transitionActions, ...designed].filter((action) => !table[`kanban.event.${action}`]);
    assert.deepEqual(missing, [], `${locale} lacks: ${missing.join(', ')}`);
  }
});
