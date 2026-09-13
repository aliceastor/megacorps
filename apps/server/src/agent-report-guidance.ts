export type ReportingMode = 'execution' | 'management' | 'review' | 'recovery';

/** One role/stage contract, shared by native adapters and API documentation. */
export function agentReportGuidance(mode: ReportingMode): string {
  const example = mode === 'management'
    ? { kind: 'megacorps-report', status: 'progress', summary: 'Replace with current coordination facts.', children: [] }
    : mode === 'review'
      ? { kind: 'megacorps-report', status: 'completed', summary: 'The required verification evidence is missing; supply the stated checks before resubmission.', verdict: 'revision_requested' }
      : mode === 'recovery'
        ? { kind: 'megacorps-report', status: 'completed', summary: 'Return the task with a concrete correction.', recovery: { action: 'rework', reason: 'Reported evidence does not match the assigned project.', instructions: 'Produce the deliverable in the assigned project and report its actual PR and head revision for review.' } }
        : { kind: 'megacorps-report', status: 'completed', summary: 'Describe what was completed and how it was verified.', workProducts: [{ type: 'file', title: 'Verified deliverable', url: 'https://example.com/actual-deliverable' }] };
  const collaboration = { kind: 'megacorps-report', status: 'input_required', summary: 'Product input is required to continue this owned card.', request: { kind: 'collaboration', departmentSlug: 'product', question: 'Provide the approved interface wording needed by this card.', acceptance: ['Cover every visible error state.', 'Return the approved wording with its source.'] } };
  return [
    'Return one flat megacorps-report JSON in your final response. No HTTP request is needed to report progress, delegation, or results. MegaCorps applies review, approval and merge gates; report completed does not itself mark the card Done.',
    'Use only fields relevant to this turn. The notation report.children or report.request means a top-level key beside kind/status/summary, never another report wrapper. Omit unused optional fields instead of filling them with null.',
    mode === 'execution' ? 'Execute the assignment. Report progress, completed work with actual workProducts, or a concrete help/permission request. Review decisions and management actions belong to their assigned stages.' : '',
    mode === 'management' ? 'Coordinate and delegate independent deliverables through children to eligible direct reports supplied in the prompt. Each child needs title (bounded deliverable), body (complete scope and acceptance evidence), and assigneeSlug (an eligible supplied recipient). The empty children array in the non-action example creates no assignments. Use progress while waiting. Assess the goal only after verified child acceptance; never invent evidence or execute work forbidden by your role.' : '',
    mode === 'review' ? 'Inspect the actual artifact against acceptance criteria. Return verdict approved | revision_requested | escalate. Missing evidence requires concrete rework or help. Only evidence-supported approval is valid. Include findings only for actual defects: severity P0 | P1 | P2, title, evidence, requiredFix. Follow any required panel contract supplied in the assignment.' : '',
    mode === 'recovery' ? 'Return one completed recovery decision using recovery.action fix_card | rework | raise_to_human and a concrete reason. Follow the permitted patch fields in this assignment. If you cannot resolve the blocker, use raise_to_human and explain the decision needed. Recovery is guidance, never artifact approval; Boss coordinates only.' : '',
    'Example shape only: replace all example values with current facts and choose the status/action supported by the evidence:',
    '```json', JSON.stringify(example), '```',
    ...(mode === 'recovery' ? [] : [
      'If unable to continue, state what you tried, what is missing and the exact question. Use this help shape; use request.kind permission for an actual authorization blocker:',
      '```json', JSON.stringify({ kind: 'megacorps-report', status: 'input_required', summary: 'Explain the blocker and methods already attempted.', request: { kind: 'help', question: 'State the precise decision or missing information needed to continue.' } }), '```',
    ]),
    ...(['execution', 'management'].includes(mode) ? [
      'If this owned card needs another department, Staff or a department Head may submit one collaboration request alone. It directly creates a required child under the original card with the target department Head as assignee; there is no preapproval. Staff prefers source Head plus requester as reviewers; Head uses the source Head. Reviewer shortage records one reason and may downgrade to one reviewer, while a busy reviewer waits. Accepted results return here and the original owner resumes integration:',
      '```json', JSON.stringify(collaboration), '```',
    ] : []),
    'MegaCorps routes help to the assigned reviewer or responsible superior. A formatting correction asks you to repair the report only, without repeating completed task actions. It does not authorize a denied task action or remove a real permission blocker.',
  ].filter(Boolean).join('\n\n');
}
