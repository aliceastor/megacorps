import type { AgentReportChild, DecisionMode } from '@megacorps/shared';

// Org-shaped card splitting: the pure rule set that decides whether an agent's
// request to split a card into child cards is allowed. No database access, so
// the rules are unit-testable in isolation; dispatch.ts feeds it the facts and
// performs the writes.
//
// Why these rules exist: child cards were once banned outright because a lead
// agent fragmented tasks into an unbounded pile of them. The tree is now
// bounded by the org chart itself — you can only split to your direct reports,
// only a few live children at a time, and only one round until those are
// integrated — so an explosion is structurally impossible.

export const SPLIT_HARD_FANOUT_CAP = 5;
export const SPLIT_MAX_ROUNDS = 3;

export type SplitAgentRef = { id: string; slug: string; name: string; departmentId: string | null };

export type SplitContext = {
  parent: { id: string; splitRound: number; decisionMode: string | null };
  splitter: SplitAgentRef;
  splitterIsCompanyBoss: boolean;
  directReports: SplitAgentRef[];
  // Any active agent in the company, by slug (for reviewers).
  resolveAgent: (slug: string) => SplitAgentRef | null;
  liveChildren: number;
  maxChildrenPerCard: number;
  maxRounds?: number;
};

export type SplitCandidate = {
  index: number;
  child: AgentReportChild;
  assignee: SplitAgentRef;
  reviewer: SplitAgentRef;
  dependsOn: number[];
};

export type SplitEvaluation =
  | { ok: true; candidates: SplitCandidate[]; round: number }
  | { ok: false; errors: string[] };

export function effectiveFanoutCap(configured: number | null | undefined): number {
  const value = Number(configured ?? 3);
  if (!Number.isFinite(value)) return 3;
  return Math.min(SPLIT_HARD_FANOUT_CAP, Math.max(1, Math.trunc(value)));
}

function hasDependencyCycle(edges: Map<number, number[]>): boolean {
  const state = new Map<number, 'visiting' | 'done'>();
  const visit = (node: number): boolean => {
    const current = state.get(node);
    if (current === 'visiting') return true;
    if (current === 'done') return false;
    state.set(node, 'visiting');
    for (const next of edges.get(node) ?? []) if (visit(next)) return true;
    state.set(node, 'done');
    return false;
  };
  for (const node of edges.keys()) if (visit(node)) return true;
  return false;
}

export function evaluateSplitPlan(context: SplitContext, children: AgentReportChild[]): SplitEvaluation {
  const errors: string[] = [];
  const mode = (context.parent.decisionMode ?? 'auto') as DecisionMode | string;

  if (children.length === 0) return { ok: false, errors: ['split_empty: no child cards were requested.'] };
  if (mode === 'solo') {
    errors.push('split_forbidden_solo: this card is in solo mode; do the work yourself or ask to change the mode.');
  }
  if (context.liveChildren > 0) {
    errors.push(`split_round_in_progress: this card already has ${context.liveChildren} live child card(s). Wait for all of them to close, integrate their output, and only then open a new round.`);
  }
  const maxRounds = context.maxRounds ?? SPLIT_MAX_ROUNDS;
  if (context.parent.splitRound >= maxRounds) {
    errors.push(`split_rounds_exhausted: this card has already opened ${context.parent.splitRound} round(s) of child cards (limit ${maxRounds}). Escalate to a human instead of splitting again.`);
  }
  if (context.directReports.length === 0) {
    errors.push('split_no_direct_reports: you have no active direct reports, so you cannot split this card. Do the work yourself or use needs_review.');
  }

  const reportBySlug = new Map(context.directReports.map((report) => [report.slug, report]));
  const candidates: SplitCandidate[] = [];
  const seenDepartments = new Map<string, number>();

  children.forEach((child, index) => {
    const assignee = reportBySlug.get(child.assigneeSlug);
    if (!assignee) {
      errors.push(`split_not_direct_report[${index}]: "${child.assigneeSlug}" is not one of your active direct reports (${context.directReports.map((r) => r.slug).join(', ') || 'none'}). Cards can only be split downward along the boss chain.`);
      return;
    }
    let reviewer: SplitAgentRef | null = context.splitter;
    if (child.reviewerSlug) {
      reviewer = context.resolveAgent(child.reviewerSlug);
      if (!reviewer) {
        errors.push(`split_reviewer_unknown[${index}]: "${child.reviewerSlug}" is not an active agent in this company.`);
        return;
      }
    }
    if (reviewer.id === assignee.id) {
      errors.push(`split_reviewer_is_assignee[${index}]: the reviewer of "${child.title}" must not be its assignee.`);
      return;
    }
    if (context.splitterIsCompanyBoss) {
      // The company boss splits by department: one card per department per round.
      if (!assignee.departmentId) {
        errors.push(`split_department_missing[${index}]: "${assignee.slug}" belongs to no department; the company boss splits one card per department.`);
        return;
      }
      const priorIndex = seenDepartments.get(assignee.departmentId);
      if (priorIndex !== undefined) {
        errors.push(`split_department_duplicate[${index}]: children ${priorIndex} and ${index} both target the same department; give that department one card that covers both.`);
        return;
      }
      seenDepartments.set(assignee.departmentId, index);
    }
    candidates.push({ index, child, assignee, reviewer, dependsOn: (child.dependsOn ?? []).filter((dep) => dep !== index) });
  });

  // Fan-out cap: the boss is bounded by "one per department" above; everyone
  // else by the company setting (default 3, hard cap 5).
  if (!context.splitterIsCompanyBoss) {
    const cap = effectiveFanoutCap(context.maxChildrenPerCard);
    if (children.length > cap) {
      errors.push(`split_fanout_exceeded: ${children.length} child cards requested but the limit is ${cap} live children per card. Merge slices into fewer, larger cards or plan a second round after these are integrated.`);
    }
  }

  // Dependencies: indexes must exist, and the graph must be acyclic.
  const edges = new Map<number, number[]>();
  for (const candidate of candidates) {
    const invalid = candidate.dependsOn.filter((dep) => dep < 0 || dep >= children.length);
    if (invalid.length) errors.push(`split_dependency_invalid[${candidate.index}]: dependsOn references ${invalid.join(', ')}, outside this request.`);
    edges.set(candidate.index, candidate.dependsOn);
  }
  if (hasDependencyCycle(edges)) errors.push('split_dependency_cycle: the dependsOn graph among these children contains a cycle.');

  if (errors.length > 0) return { ok: false, errors };
  return { ok: true, candidates, round: context.parent.splitRound + 1 };
}

export function formatSplitAnnouncement(round: number, created: Array<{ title: string; assignee: SplitAgentRef; reviewer: SplitAgentRef; cardId: string }>): string {
  return [
    `Round ${round}: split into ${created.length} child card(s):`,
    ...created.map((item, i) => `${i + 1}. ${item.title} → ${item.assignee.name} (reviewer ${item.reviewer.name}) [${item.cardId}]`),
    'This card is now waiting on its children. When all of them close, it returns to its owner for integration before review.',
  ].join('\n');
}

export function formatChildOpening(parentTitle: string, round: number, reviewer: SplitAgentRef): string {
  return `Split from parent card "${parentTitle}" (round ${round}). Reviewer: ${reviewer.name}. Deliver exactly what this card describes; your reviewer judges quality, the parent owner judges whether the goal was met.`;
}
