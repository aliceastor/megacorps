export type AgentOperationSurface = 'chat' | 'execution' | 'management' | 'review';

export const agentApiDiscovery = [
  'Discovery: the complete public catalog is GET /api/help or GET /api/help?format=markdown.',
  'Public Help authentication: none. Reading the catalog grants no management permissions.',
  'Authentication boundary: browser session management routes are not available to a runtime token unless an authenticated user session or admin-created direct API token was explicitly supplied. Runner keys and agent-session JWTs work only on their dedicated runner or agent-session routes. Never infer credentials or broader permission from this guide.',
].join('\n');

/** Runtime discovery uses a configured origin; relative catalog paths are documentation only. */
export function buildAgentApiDiscovery(apiOrigin: string | null): string {
  return [
    apiOrigin ? `MegaCorps API origin: ${apiOrigin}` : 'MegaCorps API origin: unavailable — no valid runtime-reachable HTTP(S) origin is configured. Ask the operator for the runtime-reachable API origin before making HTTP calls.',
    apiOrigin ? `Full public API Help: GET ${apiOrigin}/api/help or GET ${apiOrigin}/api/help?format=markdown.` : '',
    agentApiDiscovery,
  ].filter(Boolean).join('\n');
}
const catalogPointer = agentApiDiscovery;

const mergeDecisionGuide = [
  'Manager merge decision (`merge_pr`) — BOSS: available companywide. DEPARTMENT HEAD: available only for a card in the formal Head’s own department. STAFF: unavailable.',
  'Use a candidate supplied in the manager prompt/chat context; session users discover candidates with GET /api/cards/:id/merge-intents. This records a manager decision; provider execution remains server-owned.',
  '```megacorps-chat-actions',
  JSON.stringify({ kind: 'megacorps-chat-actions', actions: [{ action: 'merge_pr', intentId: '123e4567-e89b-12d3-a456-426614174000', headSha: '0123456789abcdef0123456789abcdef01234567', reason: 'The reviewed candidate satisfies the release criteria.' }] }),
  '```',
  'Exact fields: intentId is a UUID; headSha is 40 lowercase hexadecimal characters; reason is nonempty, 1–2000 characters. Independent review, exact head, human approvals, accepted children and provider checks still gate merge. No force merge. Ordinary worker reports cannot merge. Errors include role/scope denial, unknown intent, stale head, missing gates and provider failure.',
].join('\n');

const roleLabels: Record<AgentOperationSurface, string> = {
  chat: 'Applicability — BOSS: chat actions allowed within server-validated authority. DEPARTMENT HEAD: same, limited to own department where role scope applies. STAFF: ordinary chat actions allowed; manager-only actions unavailable.',
  execution: 'Applicability — BOSS: coordination only, never ordinary code/docs implementation. DEPARTMENT HEAD: available when assigned. STAFF: available when assigned.',
  management: 'Applicability — BOSS: companywide. DEPARTMENT HEAD: management in the formal Head’s own department. STAFF: management and merge authorization unavailable.',
  review: 'Applicability — BOSS: professional review unavailable; goal assessment is a separate management operation. DEPARTMENT HEAD: available when independently assigned. STAFF: same. Evidence remains required.',
};

const reportRules = [
  'Native result: return one flat `megacorps-report` JSON object in the final response; no HTTP call is needed. Valid states are completed, progress, input_required, failed, rejected. Use `input_required` with one singular request: request.kind help or permission and one concrete question. MegaCorps preserves review, approval, client and merge gates.',
  'Use only current facts and omit unused fields. A completed report records an outcome; it does not by itself mark a card Done or bypass any permission.',
].join('\n');

const collaborationRules = [
  'For another department, an owning Staff member or Head may submit only request.kind `collaboration` with departmentSlug, question and 1–10 acceptance strings. It creates a required child with the original card as parent; the formal target department Head owns it. Busy reviewers wait. Accepted work returns to the original owner, who resumes integration.',
  '```megacorps-report',
  JSON.stringify({ kind: 'megacorps-report', version: 1, status: 'input_required', summary: 'Product input is required to continue this owned card.', request: { kind: 'collaboration', departmentSlug: 'product', question: 'Provide the approved interface wording needed by this card.', acceptance: ['Cover every visible error state.', 'Return the approved wording with its source.'] } }),
  '```',
].join('\n');

const guides: Record<AgentOperationSurface, string> = {
  execution: [
    '## Available MegaCorps operations — execution',
    roleLabels.execution,
    reportRules,
    'Execute the assigned scope. Report real work products and verification on completion. Use progress for a durable interim result. Ask for help when blocked by knowledge or coordination; ask for permission when the missing step requires authority. Do not issue a review verdict or create child assignments unless the prompt explicitly gives that role and eligible reports.',
    '```megacorps-report',
    JSON.stringify({ kind: 'megacorps-report', version: 1, status: 'input_required', summary: 'Implementation is blocked on the documented deployment choice.', request: { kind: 'help', question: 'Which supported deployment target should this task use?' } }),
    '```',
    collaborationRules,
    catalogPointer,
  ].join('\n'),
  management: [
    '## Available MegaCorps operations — management',
    roleLabels.management,
    reportRules,
    'Delegate with top-level `children` only to eligible direct reports from the prompt. Each child needs title, complete body and assigneeSlug. Use progress while children remain. Do not invent reports or treat delegation as acceptance.',
    'The empty children example assigns nobody; real children require title, body and assigneeSlug.',
    '```megacorps-report',
    JSON.stringify({ kind: 'megacorps-report', version: 1, status: 'progress', summary: 'Replace with current coordination facts.', children: [] }),
    '```',
    collaborationRules,
    mergeDecisionGuide,
    catalogPointer,
  ].join('\n'),
  review: [
    '## Available MegaCorps operations — review',
    roleLabels.review,
    reportRules,
    'Review the actual artifact against its acceptance criteria. Set verdict to approved, revision_requested, or escalate. Score is an integer from 0 through 10 for the work under review. Approval must be supported by current evidence; a verdict does not mark the card Done or waive client, merge, independence, or permission gates. For missing authority or a decision, use verdict escalate or a concrete help request as directed by the review contract; do not combine approval with a help request.',
    '```megacorps-report',
    JSON.stringify({ kind: 'megacorps-report', version: 1, status: 'completed', summary: 'Acceptance checks passed against the submitted revision.', verdict: 'approved', score: 8, workProducts: [{ type: 'report', title: 'Review evidence', summary: 'Validated the required checks against the submitted revision.' }] }),
    '```',
    catalogPointer,
  ].join('\n'),
  chat: [
    '## Available MegaCorps operations — Direct Chat',
    roleLabels.chat,
    'Answer conversationally. On an explicit work request, append one `megacorps-chat-actions` block. MegaCorps validates it on the requesting user’s authority; the runtime does not call browser APIs. Ordinary actions are create_card, update_card and note; merge_pr is manager-only as described below. Use only supplied IDs/slugs. Cross-company and permission gates remain enforced.',
    '```megacorps-chat-actions',
    JSON.stringify({ kind: 'megacorps-chat-actions', actions: [{ action: 'create_card', title: 'Verify release notes', body: 'Compare the release notes with the accepted changes.', priority: 'normal' }, { action: 'update_card', cardId: '123e4567-e89b-12d3-a456-426614174000', status: 'in_progress' }, { action: 'note', body: 'The user selected the staged rollout.' }] }),
    '```',
    'Do not emit this block for examples or ordinary discussion. The server may reject individual actions that exceed the requesting user’s authority.',
    mergeDecisionGuide,
    catalogPointer,
  ].join('\n'),
};

/** Bounded, surface-specific operations help suitable for inclusion in an agent prompt. */
export function agentOperationGuide(surface: AgentOperationSurface, apiOrigin?: string | null): string {
  return apiOrigin === undefined ? guides[surface] : guides[surface].replace(catalogPointer, buildAgentApiDiscovery(apiOrigin));
}
