export type AgentOperationSurface = 'chat' | 'execution' | 'management' | 'review';

export const agentApiDiscovery = [
  'Discovery: the complete public catalog is GET /api/help or GET /api/help?format=markdown.',
  'Authentication boundary: browser session management routes are not available to a runtime token unless an authenticated user session or admin-created direct API token was explicitly supplied. Runner keys and agent-session JWTs work only on their dedicated runner or agent-session routes. Never infer credentials or broader permission from this guide.',
].join('\n');
const catalogPointer = agentApiDiscovery;

const reportRules = [
  'Native result: return one flat `megacorps-report` JSON object in the final response; no HTTP call is needed. Valid states are completed, progress, input_required, failed, rejected. Use `input_required` with `request.kind` help or permission and one concrete question. MegaCorps preserves review, approval, client and merge gates.',
  'Use only current facts and omit unused fields. A completed report records an outcome; it does not by itself mark a card Done or bypass any permission.',
].join('\n');

const guides: Record<AgentOperationSurface, string> = {
  execution: [
    '## Available MegaCorps operations — execution',
    reportRules,
    'Execute the assigned scope. Report real work products and verification on completion. Use progress for a durable interim result. Ask for help when blocked by knowledge or coordination; ask for permission when the missing step requires authority. Do not issue a review verdict or create child assignments unless the prompt explicitly gives that role and eligible reports.',
    '```megacorps-report',
    JSON.stringify({ kind: 'megacorps-report', version: 1, status: 'input_required', summary: 'Implementation is blocked on the documented deployment choice.', request: { kind: 'help', question: 'Which supported deployment target should this task use?' } }),
    '```',
    catalogPointer,
  ].join('\n'),
  management: [
    '## Available MegaCorps operations — management',
    reportRules,
    'Delegate bounded work with top-level `children` only to eligible direct reports supplied in the prompt. Each child needs a title, complete body and assigneeSlug. Use progress while children are outstanding. You may also request help or permission with the same singular request contract. Do not invent reports, expand an assignee’s authority, or treat delegation as acceptance evidence.',
    '```megacorps-report',
    JSON.stringify({ kind: 'megacorps-report', version: 1, status: 'progress', summary: 'Delegated the bounded verification task and will wait for its evidence.', children: [{ title: 'Verify the release candidate', body: 'Run the required checks against the assigned release candidate.\n\nAcceptance:\n- Report exact commands and observed results.', assigneeSlug: 'qa-lead' }] }),
    '```',
    catalogPointer,
  ].join('\n'),
  review: [
    '## Available MegaCorps operations — review',
    reportRules,
    'Review the actual artifact against its acceptance criteria. Set verdict to approved, revision_requested, or escalate. Score is an integer from 0 through 10 for the work under review. Approval must be supported by current evidence; a verdict does not mark the card Done or waive client, merge, independence, or permission gates. For missing authority or a decision, use verdict escalate or a concrete help request as directed by the review contract; do not combine approval with a help request.',
    '```megacorps-report',
    JSON.stringify({ kind: 'megacorps-report', version: 1, status: 'completed', summary: 'Acceptance checks passed against the submitted revision.', verdict: 'approved', score: 8, workProducts: [{ type: 'report', title: 'Review evidence', summary: 'Validated the required checks against the submitted revision.' }] }),
    '```',
    catalogPointer,
  ].join('\n'),
  chat: [
    '## Available MegaCorps operations — Direct Chat',
    'Answer conversationally. When the requesting user explicitly asks to track or change board work, append one `megacorps-chat-actions` block. MegaCorps validates and applies accepted actions on the requesting user’s authority; the runtime does not call browser APIs. Supported actions are create_card, update_card, and note. Use IDs and assignee slugs only from the supplied company context. Cross-company access and permission gates remain enforced.',
    '```megacorps-chat-actions',
    JSON.stringify({ kind: 'megacorps-chat-actions', actions: [{ action: 'create_card', title: 'Verify release notes', body: 'Compare the release notes with the accepted changes.', priority: 'normal' }, { action: 'update_card', cardId: '123e4567-e89b-12d3-a456-426614174000', status: 'in_progress' }, { action: 'note', body: 'The user selected the staged rollout.' }] }),
    '```',
    'Do not emit this block for examples or ordinary discussion. The server may reject individual actions that exceed the requesting user’s authority.',
    catalogPointer,
  ].join('\n'),
};

/** Bounded, surface-specific operations help suitable for inclusion in an agent prompt. */
export function agentOperationGuide(surface: AgentOperationSurface): string {
  return guides[surface];
}
