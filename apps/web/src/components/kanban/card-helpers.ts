// Pure helpers moved verbatim out of kanban-board.tsx. No React here: the
// conversation model and its node:test suite import from this file.
import type { Agent, Card, CardComment, CardPriority, Goal } from './card-types';

export function isDelegationReviewComment(comment: CardComment): boolean {
  const action = comment.action.toLowerCase();
  return Boolean(
    comment.delegationStatus ||
    comment.assigneeAgentId ||
    comment.reviewerAgentId ||
    comment.reviewerScope ||
    action.startsWith('delegate_') ||
    action.includes('review'),
  );
}

export function delegationReviewTone(comment: CardComment): 'system' | 'error' | 'product' {
  const token = `${comment.action} ${comment.delegationStatus ?? ''}`.toLowerCase();
  if (token.includes('failed') || token.includes('error') || token.includes('rejected') || token.includes('blocked')) return 'error';
  if (token.includes('approved') || token.includes('submitted')) return 'product';
  return 'system';
}

export function statusColor(status: string) {
  if (status === 'done') return '#16a34a';
  if (status === 'blocked') return '#dc2626';
  if (status === 'cancelled') return '#64748b';
  if (status === 'in_progress') return '#2563eb';
  if (status === 'in_review') return '#9333ea';
  if (status === 'needs_review') return '#ca8a04';
  if (status === 'waiting_on_external') return '#0d9488';
  if (status === 'waiting_on_client') return '#f59e0b';
  if (status === 'waiting_on_brainstorm') return '#0891b2';
  return 'var(--border)';
}

export function goalScope(goal: Goal): string {
  if (goal.projectId) return 'Project';
  if (goal.departmentId) return 'Department';
  return 'Company';
}

export function scopedGoalOptions(goals: Goal[], input: { companyId?: string; departmentId?: string | null; projectId?: string | null }) {
  return goals.filter((goal) => {
    if (input.companyId && goal.companyId !== input.companyId) return false;
    if (!goal.departmentId && !goal.projectId) return true;
    if (goal.departmentId && input.departmentId && goal.departmentId === input.departmentId) return true;
    if (goal.projectId && input.projectId && goal.projectId === input.projectId) return true;
    return false;
  });
}

export function priorityValue(priority: number): CardPriority {
  if (priority >= 3) return 'urgent';
  if (priority >= 2) return 'high';
  if (priority <= -1) return 'low';
  return 'normal';
}

export function priorityNumber(priority: string | number | undefined): number {
  if (typeof priority === 'number') return priority;
  if (priority === 'urgent') return 3;
  if (priority === 'high') return 2;
  if (priority === 'low') return -1;
  return 0;
}

export function parseCsv(value: string): string[] {
  return value.split(',').map((item) => item.trim()).filter(Boolean);
}

export function agentDisplayName(agent: Agent | undefined): string | null {
  if (!agent) return null;
  return [agent.name, agent.role].filter(Boolean).join(' / ');
}

// The fields the edit form owns, in the same shape kanban-board.tsx seeds
// `draft` with. The close guard compares these and nothing else.
export function draftFromCard(card: Card): Partial<Card> {
  return {
    title: card.title,
    body: card.body,
    columnStatus: card.columnStatus,
    assigneeId: card.assigneeId ?? null,
    reviewerId: card.reviewerId ?? null,
    departmentId: card.departmentId ?? null,
    projectId: card.projectId ?? null,
    goalId: card.goalId ?? null,
    priority: card.priority,
    tags: card.tags ?? [],
    dependencyCardIds: card.dependencyCardIds ?? [],
    decisionMode: card.decisionMode ?? null,
    requiresApproval: card.requiresApproval ?? false,
    maxRetries: card.maxRetries ?? 3,
  };
}

function sameValue(a: unknown, b: unknown): boolean {
  if (Array.isArray(a) || Array.isArray(b)) return JSON.stringify(a ?? []) === JSON.stringify(b ?? []);
  return (a ?? null) === (b ?? null);
}

/** True when the edit draft differs from the card it was seeded from; a null draft is never dirty. */
export function isDraftDirty(draft: Partial<Card> | null | undefined, card: Card): boolean {
  if (!draft) return false;
  const base = draftFromCard(card);
  return (Object.keys(base) as Array<keyof Card>).some((key) => key in draft && !sameValue(draft[key], base[key]));
}
