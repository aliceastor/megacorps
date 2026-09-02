import type { AgentReportCheckpoint } from '@megacorps/shared';
import { extractAgentReport } from './agent-report.ts';

// Client checkpoints: the point in the company pipeline where the CEO or a
// department head stops and asks the client — for a direction decision or a
// look at interim output. Blocking by design: the card (and so its subtree)
// waits until the client answers; unrelated cards keep running. This module is
// the pure part (parsing, eligibility, reminder timing, wording); dispatch.ts
// does the database side.

export const CLIENT_CHECKPOINT_APPROVAL_TYPE = 'client_checkpoint';
export const CLIENT_CHECKPOINT_REMINDER_REPEAT_HOURS = 24;

export type ClientCheckpointRequest = {
  kind: 'direction' | 'interim';
  question: string;
  options: string[];
  recommendation: string | null;
  artifactRefs: string[];
};

export function normalizeCheckpoint(input: AgentReportCheckpoint): ClientCheckpointRequest {
  return {
    kind: input.kind,
    question: input.question,
    options: (input.options ?? []).map((option) => option.trim()).filter(Boolean).slice(0, 6),
    recommendation: input.recommendation?.trim() || null,
    artifactRefs: (input.artifactRefs ?? []).map((ref) => ref.trim()).filter(Boolean).slice(0, 20),
  };
}

export function checkpointFromOutput(output: string | null | undefined, report?: { checkpoint?: AgentReportCheckpoint | null } | null): ClientCheckpointRequest | null {
  if (report?.checkpoint) return normalizeCheckpoint(report.checkpoint);
  const extraction = extractAgentReport(output);
  if (extraction && 'report' in extraction && extraction.report.checkpoint) return normalizeCheckpoint(extraction.report.checkpoint);
  return null;
}

// An A2A input_required question from an eligible asker on a client-reviewed
// card is a direction checkpoint in all but name.
export function checkpointFromQuestion(question: string): ClientCheckpointRequest {
  return { kind: 'direction', question: question.trim(), options: [], recommendation: null, artifactRefs: [] };
}

export type CheckpointEligibility = {
  isOwner: boolean;
  isCompanyBoss: boolean;
  isDepartmentHead: boolean;
  alreadyPending: boolean;
};

export function checkpointEligibilityError(input: CheckpointEligibility): string | null {
  if (input.alreadyPending) return 'client_checkpoint_already_pending: a checkpoint on this card is still waiting for the client; wait for that answer instead of asking again.';
  if (!input.isOwner) return 'client_checkpoint_not_owner: only the owner of this card may ask the client.';
  if (!input.isCompanyBoss && !input.isDepartmentHead) {
    return 'client_checkpoint_not_allowed: only the CEO or a department head may ask the client directly. Ask your reviewer instead (status "needs_review") or a peer (report.mentions).';
  }
  return null;
}

export function checkpointReminderDue(input: { createdAt: Date | null; lastRemindedAt: string | null }, now: Date, remindHours: number): boolean {
  const created = input.createdAt ?? now;
  const last = input.lastRemindedAt ? new Date(input.lastRemindedAt) : null;
  const anchor = last && !Number.isNaN(last.getTime()) ? last : created;
  const hours = last ? CLIENT_CHECKPOINT_REMINDER_REPEAT_HOURS : remindHours;
  return now.getTime() - anchor.getTime() >= hours * 3_600_000;
}

export function formatCheckpointMessage(request: ClientCheckpointRequest, askedBy: string): string {
  const lines = [
    `${askedBy} is asking the client (${request.kind === 'direction' ? 'direction decision' : 'interim output review'}):`,
    request.question,
  ];
  if (request.options.length) lines.push('Options:', ...request.options.map((option, index) => `${index + 1}. ${option}`));
  if (request.recommendation) lines.push(`Recommendation: ${request.recommendation}`);
  if (request.artifactRefs.length) lines.push('Artifacts:', ...request.artifactRefs.map((ref) => `- ${ref}`));
  lines.push('This card is parked as waiting_on_client until the client answers.');
  return lines.join('\n');
}

export function formatCheckpointAnswer(input: { question: string; answer: string | null; selectedOption: string | null; decidedBy: string }): string {
  const lines = [`Client answer from ${input.decidedBy}:`];
  if (input.selectedOption) lines.push(`Selected: ${input.selectedOption}`);
  if (input.answer) lines.push(input.answer);
  lines.push(`(to: ${input.question.slice(0, 200)})`);
  return lines.join('\n');
}

export function combineCheckpointAnswer(input: { answer?: string | null; selectedOption?: string | null }): string {
  return [input.selectedOption ? `Selected: ${input.selectedOption}` : '', input.answer?.trim() ?? ''].filter(Boolean).join('\n');
}
