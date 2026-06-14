import assert from 'node:assert/strict';
import test from 'node:test';
import { dispatchInternals } from './dispatch.ts';

test('top-level guidance requests are accepted as done when no reviewer exists', () => {
  const decision = dispatchInternals.dispatchCompletionDecision('needs_review: server callback is unreachable, final answer follows.', null);
  assert.equal(decision.needsHelpReview, true);
  assert.equal(decision.nextStatus, 'done');
  assert.equal(decision.topLevelGuidanceAccepted, true);
});

test('guidance requests still queue review when a reviewer exists', () => {
  const decision = dispatchInternals.dispatchCompletionDecision('needs reviewer guidance on the blocker.', 'reviewer-1');
  assert.equal(decision.nextStatus, 'needs_review');
  assert.equal(decision.topLevelGuidanceAccepted, false);
});

test('normal dispatch completion enters quality review when a reviewer exists', () => {
  const decision = dispatchInternals.dispatchCompletionDecision('Completed the requested implementation.', 'reviewer-1');
  assert.equal(decision.needsHelpReview, false);
  assert.equal(decision.nextStatus, 'in_review');
});

test('explicit approved review verdict wins over infrastructure blocker wording', () => {
  const output = [
    'FINAL REVIEW VERDICT: APPROVED \u2014 DONE',
    'The deliverable is sound.',
    'Infrastructure is broken and the card cannot progress without a human dashboard seal.',
    'status: blocked in the server loop',
  ].join('\n');
  assert.equal(dispatchInternals.explicitReviewDecision(output), 'approved');
  assert.equal(dispatchInternals.reviewDecision(output, 'quality'), 'approved');
});

test('explicit review rejection wins over approval wording', () => {
  const output = 'REJECT - REVISION_REQUESTED: No deliverable artifact. I would approve after the missing artifact is added.';
  assert.equal(dispatchInternals.explicitReviewDecision(output), 'revision_requested');
  assert.equal(dispatchInternals.reviewDecision(output, 'quality'), 'revision_requested');
});

test('review verdict JSON status done is accepted as approval despite loop notes', () => {
  const output = '{"status":"done","summary":"APPROVED \u2014 DONE"}\nServer loop continues; only external human action can move the card.';
  assert.equal(dispatchInternals.explicitReviewDecision(output), 'approved');
});

test('dispatch preserves webhook-updated card status after adapter returns', () => {
  assert.equal(dispatchInternals.cardChangedOutsideCurrentRun(
    { columnStatus: 'waiting_on_external', activeHeartbeatRunId: null, executionLockId: null } as any,
    { columnStatus: 'in_progress' } as any,
    'run-1',
  ), true);
  assert.equal(dispatchInternals.cardChangedOutsideCurrentRun(
    { columnStatus: 'in_progress', activeHeartbeatRunId: 'run-1', executionLockId: 'lock-1' } as any,
    { columnStatus: 'in_progress' } as any,
    'run-1',
  ), false);
  assert.equal(dispatchInternals.cardChangedOutsideCurrentRun(
    { columnStatus: 'done', activeHeartbeatRunId: null, executionLockId: null } as any,
    { columnStatus: 'in_progress' } as any,
    'run-1',
  ), true);
});

test('confirmation-seeking replies are rejected for autonomous kanban work', () => {
  assert.equal(dispatchInternals.asksForConfirmationInsteadOfWorking('我目前其實不確定您要我直接動手做，還是您想先看初稿方向再決定。請問……？'), true);
  assert.equal(dispatchInternals.asksForConfirmationInsteadOfWorking('Should I continue and POST the result?'), true);
  assert.equal(dispatchInternals.asksForConfirmationInsteadOfWorking('Executive Summary\n- Differentiated USP\n- Priority matrix\n- Red flags'), false);
});

test('adapter transport failures are not treated as agent feedback corrections', () => {
  const message = dispatchInternals.adapterFailureMessage(
    'dispatch',
    'kex_exchange_identification: Connection closed by remote host\nConnection closed by 192.168.1.180 port 2222',
  );
  assert.match(message, /^dispatch_adapter_failed:/);
  assert.doesNotMatch(message, /collaboration_mode_requires_delegation|agent_asked_for_confirmation|DELEGATE/);
});

test('external completion reports respect the quality review gate', () => {
  assert.equal(dispatchInternals.completionStatusForQualityGate('done', 'reviewer-1'), 'in_review');
  assert.equal(dispatchInternals.completionStatusForQualityGate('success', 'reviewer-1'), 'in_review');
  assert.equal(dispatchInternals.completionStatusForQualityGate('in_review', null), 'done');
  assert.equal(dispatchInternals.completionStatusForQualityGate('done', null), 'done');
});

test('parent completion policy blocks incomplete required child cards', () => {
  assert.equal(dispatchInternals.childCompletionPolicySatisfied(
    { requiredChildPolicy: 'all_required_accepted' },
    [
      { columnStatus: 'done', childRequirementLevel: 'required', estimatedWeight: null },
      { columnStatus: 'in_progress', childRequirementLevel: 'required', estimatedWeight: null },
    ],
  ), false);
  assert.equal(dispatchInternals.childCompletionPolicySatisfied(
    { requiredChildPolicy: 'all_required_accepted' },
    [
      { columnStatus: 'done', childRequirementLevel: 'required', estimatedWeight: null },
      { columnStatus: 'todo', childRequirementLevel: 'optional', estimatedWeight: null },
    ],
  ), true);
});

test('parent completion policy supports non-cancelled and threshold rules', () => {
  assert.equal(dispatchInternals.childCompletionPolicySatisfied(
    { requiredChildPolicy: 'all_non_cancelled_accepted' },
    [
      { columnStatus: 'done', childRequirementLevel: 'required', estimatedWeight: null },
      { columnStatus: 'cancelled', childRequirementLevel: 'required', estimatedWeight: null },
    ],
  ), true);
  assert.equal(dispatchInternals.childCompletionPolicySatisfied(
    { requiredChildPolicy: 'threshold' },
    [
      { columnStatus: 'done', childRequirementLevel: 'required', estimatedWeight: '8' },
      { columnStatus: 'todo', childRequirementLevel: 'required', estimatedWeight: '2' },
    ],
  ), true);
  assert.equal(dispatchInternals.childCompletionPolicySatisfied(
    { requiredChildPolicy: 'threshold' },
    [
      { columnStatus: 'done', childRequirementLevel: 'required', estimatedWeight: '7' },
      { columnStatus: 'todo', childRequirementLevel: 'required', estimatedWeight: '3' },
    ],
  ), false);
});

test('delegation parser only accepts explicit delegation blocks', () => {
  assert.deepEqual(dispatchInternals.delegationItems('IDEA 1: Build a music app\n- not a company task'), []);
  assert.deepEqual(dispatchInternals.delegationItems('DELEGATE:\n- Build the UI shell\n- Wire the backend API\n\nSTATUS:\nwaiting'), ['Build the UI shell', 'Wire the backend API']);
});

test('delegation parser accepts webhook summary plus output payloads', () => {
  const webhookPayload = [
    'I will split this across direct reports.',
    '',
    'DELEGATE:',
    '- Ribel: Generate 20 raw product ideas',
    '- Score and cluster the strongest concepts',
    '',
    'Do not mark the parent done yet.',
  ].join('\n');
  assert.deepEqual(dispatchInternals.delegationItems(webhookPayload), [
    'Ribel: Generate 20 raw product ideas',
    'Score and cluster the strongest concepts',
  ]);
});

test('delegation parser stops before later markdown status bullets', () => {
  const output = [
    'DELEGATE:',
    '- Ribel: 對上面這 12 個候選功能做技術可行性審查，輸出風險、取捨、MVP 建議。',
    '',
    '---',
    '',
    '## 關於這張卡本身',
    '- **狀態**：in_progress，等待 Ribel 回覆後整合。',
    '- **預計完成**：Ribel report -> Alice final integration。',
    '- **不要做的事**：不要建立 child Kanban card。',
    '- **要你回覆的**：請直接提交 report。',
  ].join('\n');
  assert.deepEqual(dispatchInternals.delegationItems(output), [
    'Ribel: 對上面這 12 個候選功能做技術可行性審查，輸出風險、取捨、MVP 建議。',
  ]);
});

test('delegation source context is only injected on the first message turn', () => {
  const comment = {
    metadata: {
      sourceContext: [
        'Requester full output:',
        '| # | Feature | Notes |',
        '| 12 | Browser extension capture | Needs local archive queue. |',
      ].join('\n'),
    },
  } as any;
  const firstTurn = dispatchInternals.delegationSourceContextForPrompt(comment, {});
  assert.match(firstTurn, /Delegation source context/);
  assert.match(firstTurn, /Browser extension capture/);
  assert.equal(dispatchInternals.delegationSourceContextForPrompt(comment, { continuation: true }), '');
  assert.equal(dispatchInternals.delegationSourceContextForPrompt({ metadata: {} } as any, {}), '');
});

test('submitted final reports can be reviewed after the parent card is done', () => {
  assert.equal(dispatchInternals.terminalMessageTaskCanRun(
    { kind: 'message_review' } as any,
    { columnStatus: 'done' } as any,
    { action: 'delegate_report', delegationStatus: 'submitted' } as any,
  ), true);
  assert.equal(dispatchInternals.terminalMessageTaskCanRun(
    { kind: 'message' } as any,
    { columnStatus: 'done' } as any,
    { action: 'delegate_request', delegationStatus: 'queued' } as any,
  ), false);
  assert.equal(dispatchInternals.terminalMessageTaskCanRun(
    { kind: 'message_review' } as any,
    { columnStatus: 'blocked' } as any,
    { action: 'delegate_report', delegationStatus: 'submitted' } as any,
  ), false);
});

test('collaboration mode remains enabled on legacy parent-linked card rows', () => {
  assert.equal(dispatchInternals.collaborationModeRequiresDelegation({ decisionMode: 'delegate', parentCardId: null } as any), true);
  assert.equal(dispatchInternals.collaborationModeRequiresDelegation({ decisionMode: 'delegate', parentCardId: 'parent-1' } as any), true);
  assert.equal(dispatchInternals.collaborationModeRequiresDelegation({ decisionMode: 'auto', parentCardId: null } as any), false);
});

test('collaboration delegation instructions include required webhook and block format', () => {
  const instructions = dispatchInternals.collaborationDelegationInstructions([
    { name: 'Alice', slug: 'alice', positionName: 'Design Lead', departmentName: 'Product' },
    { name: 'Bob', slug: 'bob', positionName: 'Backend Engineer', departmentName: 'Engineering' },
  ]);
  assert.match(instructions, /MUST split meaningful work/);
  assert.match(instructions, /one-time per agent/);
  assert.match(instructions, /Alice \(slug: alice, position: Design Lead, department: Product\)/);
  assert.match(instructions, /Bob \(slug: bob, position: Backend Engineer, department: Engineering\)/);
  assert.match(instructions, /status="in_progress"/);
  assert.match(instructions, /DELEGATE:/);
  assert.match(instructions, /- Alice: <delegated work item and expected deliverable>/);
  assert.match(instructions, /- Bob: <another delegated work item and expected deliverable>/);
});

test('delegation instructions omit fake second delegate when only one report is active', () => {
  const instructions = dispatchInternals.collaborationDelegationInstructions([
    { name: 'Ribel', slug: 'ribel', positionName: 'Senior Engineer', departmentName: 'Engineering' },
  ]);
  assert.match(instructions, /Active direct reports to consider: Ribel \(slug: ribel, position: Senior Engineer, department: Engineering\)/);
  assert.match(instructions, /DELEGATE:\n- Ribel: <delegated work item and expected deliverable>/);
  assert.doesNotMatch(instructions, /another direct report/);
  assert.doesNotMatch(instructions, /sub-task title/);
});

test('satisfied collaboration instructions allow integration without keepalive delegation', () => {
  const instructions = dispatchInternals.collaborationDelegationSatisfiedInstructions([
    { name: 'Ribel', slug: 'ribel', positionName: 'Senior Engineer', departmentName: 'Engineering' },
  ]);
  assert.match(instructions, /already satisfied the one required/);
  assert.match(instructions, /Do not create keepalive/);
  assert.match(instructions, /Review work is exempt/);
  assert.doesNotMatch(instructions, /MUST split this work/);
});

test('optional delegation instructions include direct reports and block format', () => {
  const instructions = dispatchInternals.optionalDelegationInstructions([
    { name: 'Alice', slug: 'alice', positionName: 'Design Lead', departmentName: 'Product' },
    { name: 'Bob', slug: 'bob', positionName: 'Backend Engineer', departmentName: 'Engineering' },
  ]);
  assert.match(instructions, /Collaboration Mode is OFF/);
  assert.match(instructions, /may split those parts into delegated work items/);
  assert.doesNotMatch(instructions, /MUST split this work/);
  assert.match(instructions, /Active direct reports to consider: Alice \(slug: alice, position: Design Lead, department: Product\), Bob \(slug: bob, position: Backend Engineer, department: Engineering\)/);
  assert.match(instructions, /status="in_progress"/);
  assert.match(instructions, /DELEGATE:/);
  assert.match(instructions, /- Alice: <delegated work item and expected deliverable>/);
  assert.match(instructions, /- Bob: <another delegated work item and expected deliverable>/);
});

test('company structure lines include name slug position department description and direct reports', () => {
  const departmentById = new Map<string, any>([
    ['dept-eng', { id: 'dept-eng', name: 'Engineering', slug: 'engineering' }],
    ['dept-prod', { id: 'dept-prod', name: 'Product', slug: 'product' }],
  ]);
  const positionById = new Map<string, any>([
    ['pos-cto', { id: 'pos-cto', name: 'CTO', slug: 'cto', description: 'Owns technical direction.' }],
    ['pos-eng', { id: 'pos-eng', name: 'Backend Engineer', slug: 'backend-engineer', description: 'Builds backend systems.' }],
  ]);
  const lines = dispatchInternals.companyStructureLines({
    agents: [
      { id: 'agent-1', name: 'Alice', slug: 'alice', bossId: null, role: 'leader', title: null, positionId: 'pos-cto', departmentId: 'dept-eng', isActive: true },
      { id: 'agent-2', name: 'Bob', slug: 'bob', bossId: 'agent-1', role: 'worker', title: null, positionId: 'pos-eng', departmentId: 'dept-prod', isActive: true },
      { id: 'agent-3', name: 'Cyd', slug: 'cyd', bossId: 'agent-1', role: 'worker', title: null, positionId: 'pos-eng', departmentId: 'dept-prod', isActive: false },
    ] as any,
    departmentById,
    positionById,
  });
  assert.deepEqual(lines, [
    '[Alice (alice), CTO | Engineering, Owns technical direction.|[list: bob]]',
    '[Bob (bob), Backend Engineer | Product, Builds backend systems.|[list: none]]',
  ]);
});
