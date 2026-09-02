import type { AgentReportBroadcast } from '@megacorps/shared';
import { extractAgentReport } from './agent-report.ts';

// Brainstorm rounds: before decomposing a goal, the CEO (or a department head)
// broadcasts one question to the heads of the departments it names, collects
// their proposals, and only then plans. Departments are named explicitly —
// most of a company is irrelevant to any given task, and pulling everyone in
// only burns tokens. Pure parts here; dispatch.ts owns the database side and
// reuses the peer-question answer pipeline for the individual replies.

export type BrainstormRequest = { departments: string[]; question: string };

export type BrainstormDepartment = { id: string; slug: string; name: string; headAgentId: string | null; description: string | null };

export type BrainstormTarget = { department: BrainstormDepartment; headAgentId: string };

export function brainstormFromOutput(output: string | null | undefined, report?: { broadcast?: AgentReportBroadcast | null } | null): BrainstormRequest | null {
  const raw = report?.broadcast ?? (() => {
    const extraction = extractAgentReport(output);
    return extraction && 'report' in extraction ? extraction.report.broadcast ?? null : null;
  })();
  if (!raw) return null;
  const departments = Array.from(new Set(raw.departments.map((slug) => slug.trim().toLowerCase()).filter(Boolean)));
  if (departments.length === 0) return null;
  return { departments, question: raw.question.trim() };
}

export type BrainstormPlanInput = {
  request: BrainstormRequest;
  departments: BrainstormDepartment[];
  askerId: string;
  askerIsCompanyBoss: boolean;
  askerIsDepartmentHead: boolean;
  isOwner: boolean;
  alreadyPending: boolean;
  // Departments the client pre-selected at card creation: the floor the asker cannot go below.
  clientMinimumIds: string[];
};

export type BrainstormPlan = { ok: true; targets: BrainstormTarget[] } | { ok: false; errors: string[] };

export function planBrainstormTargets(input: BrainstormPlanInput): BrainstormPlan {
  const errors: string[] = [];
  if (!input.isOwner) errors.push('brainstorm_not_owner: only the owner of this card may open a brainstorm round.');
  if (!input.askerIsCompanyBoss && !input.askerIsDepartmentHead) errors.push('brainstorm_not_allowed: only the CEO or a department head may broadcast to department heads.');
  if (input.alreadyPending) errors.push('brainstorm_round_in_progress: a brainstorm round on this card is still collecting answers; wait for it to close.');

  const bySlug = new Map(input.departments.map((department) => [department.slug, department]));
  const targets: BrainstormTarget[] = [];
  for (const slug of input.request.departments) {
    const department = bySlug.get(slug);
    if (!department) {
      errors.push(`brainstorm_department_unknown: "${slug}" is not a department of this company (known: ${input.departments.map((d) => d.slug).join(', ') || 'none'}).`);
      continue;
    }
    if (!department.headAgentId) {
      errors.push(`brainstorm_department_headless: "${department.name}" has no department head to answer; ask the human to assign one.`);
      continue;
    }
    if (department.headAgentId === input.askerId) {
      // Asking yourself is pointless; skip silently, the asker already has their own view.
      continue;
    }
    targets.push({ department, headAgentId: department.headAgentId });
  }

  const covered = new Set(targets.map((target) => target.department.id));
  const missing = input.clientMinimumIds.filter((id) => !covered.has(id)).map((id) => input.departments.find((d) => d.id === id)?.name ?? id);
  if (missing.length) errors.push(`brainstorm_client_minimum: the client asked for these departments to take part and they are missing: ${missing.join(', ')}.`);

  if (targets.length === 0 && errors.length === 0) errors.push('brainstorm_no_targets: no department head could be addressed; name at least one other department with a head.');
  if (errors.length) return { ok: false, errors };
  return { ok: true, targets };
}

// A round closes when every addressed head has answered (or failed), or when
// the timeout passes with some still silent — the CEO then works with what
// came back and the silent departments are recorded as such.
export function brainstormRoundComplete(input: { statuses: Array<string | null>; openedAt: Date; now: Date; timeoutMinutes: number }): { complete: boolean; reason: 'all_answered' | 'timeout' | null } {
  const open = input.statuses.filter((status) => status === 'queued' || status === 'running');
  if (open.length === 0) return { complete: true, reason: 'all_answered' };
  if (input.now.getTime() - input.openedAt.getTime() >= input.timeoutMinutes * 60_000) return { complete: true, reason: 'timeout' };
  return { complete: false, reason: null };
}

export function formatBrainstormOpened(round: number, question: string, targets: Array<{ departmentName: string; headName: string }>): string {
  return [
    `Brainstorm round ${round} opened. Question to department heads:`,
    question,
    'Consulted:',
    ...targets.map((target) => `- ${target.departmentName} (head: ${target.headName})`),
    'This card waits (waiting_on_brainstorm) until every head answers or the round times out. A head that considers its department irrelevant may answer "not participating" with a reason.',
  ].join('\n');
}

export function formatBrainstormClosed(round: number, reason: 'all_answered' | 'timeout', answered: string[], silent: string[]): string {
  return [
    `Brainstorm round ${round} closed (${reason === 'timeout' ? 'timed out' : 'all heads answered'}).`,
    `Answered: ${answered.join(', ') || 'none'}`,
    silent.length ? `Consulted but silent: ${silent.join(', ')}` : '',
    'Returning to the owner to synthesize the proposals into a plan.',
  ].filter(Boolean).join('\n');
}
