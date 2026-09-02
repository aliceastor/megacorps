import assert from 'node:assert/strict';
import test from 'node:test';
import { messages, type Locale } from './i18n.ts';

const locales: Locale[] = ['zh-TW', 'en', 'ja'];

test('every locale table exposes the same key set', () => {
  const [base, ...others] = locales;
  const baseKeys = new Set(Object.keys(messages[base!]));
  for (const locale of others) {
    const keys = new Set(Object.keys(messages[locale]));
    const missing = [...baseKeys].filter((key) => !keys.has(key));
    const extra = [...keys].filter((key) => !baseKeys.has(key));
    assert.deepEqual(missing, [], `${locale} is missing keys present in ${base}`);
    assert.deepEqual(extra, [], `${locale} has keys absent from ${base}`);
  }
});

test('no locale ships an empty string', () => {
  for (const locale of locales) {
    const empty = Object.entries(messages[locale]).filter(([, value]) => value.trim().length === 0).map(([key]) => key);
    assert.deepEqual(empty, [], `${locale} has empty translations`);
  }
});

test('the keys this phase introduced exist in every locale', () => {
  const required = [
    'kanban.situation.client', 'kanban.situation.brainstorm', 'kanban.situation.children', 'kanban.situation.integrating', 'kanban.situation.review',
    'kanban.situation.helpReview', 'kanban.situation.external', 'kanban.situation.blocked', 'kanban.situation.delegation', 'kanban.situation.running',
    'kanban.situation.queued', 'kanban.situation.done', 'kanban.situation.cancelled', 'kanban.waitedFor', 'kanban.childrenWaitingClient', 'kanban.childrenBlocked',
    'kanban.roundN', 'kanban.event.mention_question', 'kanban.event.mention_unresolved', 'kanban.event.agent_comment', 'kanban.event.comment',
    // PR-2: overview zone, needs-you strip, close guard, layout toggle.
    'kanban.overviewEdit', 'kanban.overviewDone', 'kanban.overviewLastEvent', 'kanban.overviewUpdatedAt', 'kanban.bodyExpand', 'kanban.bodyCollapse',
    'kanban.chipRetryLimit', 'kanban.chipChildren', 'kanban.chipUnmet', 'kanban.chipForceBrainstorm', 'kanban.parentCard', 'kanban.noneAssigned',
    'kanban.youApprover', 'kanban.reviewFeedback', 'kanban.answerCheckpoint', 'kanban.noPendingCheckpoint', 'kanban.approveTask', 'kanban.rejectTask',
    'kanban.decisionNote', 'kanban.reviewEnqueuesAgent', 'kanban.continueWithCommentCta', 'kanban.closeDiscard', 'kanban.closeBlocked',
    'kanban.phaseActive', 'kanban.phaseHistorical', 'kanban.layoutLegacy', 'kanban.layoutV2', 'kanban.approvalBlockedByChildren',
    // PR-3: the merged 對話 tab, its composer and the @mention rows.
    'kanban.tabConversation', 'kanban.tabOutputs', 'kanban.tabHistory', 'kanban.convFilter.all', 'kanban.convFilter.talk', 'kanban.convFilter.milestones',
    'kanban.convFilter.delegationReview', 'kanban.convFilter.system', 'kanban.convSystemFold', 'kanban.convShowOlder', 'kanban.convOlderLogsMissing',
    'kanban.convLoaded', 'kanban.convNewestFirst', 'kanban.convOldestFirst', 'kanban.convComposerHint', 'kanban.convToday', 'kanban.convYesterday',
    'kanban.convAnswerAbove', 'kanban.convAnswered', 'kanban.convWithdrawn', 'kanban.convReminded', 'kanban.convLastActivity', 'kanban.convShowProcess',
    'kanban.convRetries', 'kanban.convConsequence', 'kanban.convQueuedForAgent', 'kanban.convEscalatedTo', 'kanban.convNoIndependentReviewer',
    'kanban.convOpenChild', 'kanban.convOpenParent', 'kanban.convEmpty', 'kanban.convEmptyFilter', 'kanban.convNewEvents', 'kanban.convUnreadAbove',
    'kanban.convSendShortcut', 'kanban.convPauseHint', 'kanban.convSend.comment', 'kanban.convSend.agent_note', 'kanban.convSend.send_to_agent',
    'kanban.convSend.continue_run', 'kanban.convSend.pause_agent', 'kanban.convSend.escalate_to_reviewer', 'kanban.convSend.delegate_to_agent',
    'kanban.convVerdict.approve', 'kanban.convVerdict.reject', 'kanban.convVerdict.request_help', 'kanban.convVerdict.block',
    'kanban.convBrainstormRound', 'kanban.convSplitRound', 'kanban.convRoundClosed', 'kanban.convRoundOpen', 'kanban.convStage', 'kanban.convDelegatedTo',
    'kanban.convMentionWaiting', 'kanban.convMentionAnswered', 'kanban.convMentionFailed', 'kanban.convMentionClient', 'kanban.convMentionButton', 'kanban.convMentionHint',
  ];
  for (const locale of locales) {
    for (const key of required) assert.ok(messages[locale][key], `${locale} lacks ${key}`);
  }
});
