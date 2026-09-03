// External wait polling (company pipeline design §13 item 1).
//
// An agent that parks a card with status="waiting_on_external" may name a
// pollIntervalSeconds: how often somebody should go and look. Until now the
// column had no consumer, so a card only ever woke on an inbound event (the
// Gitea receiver, a manual POST /api/external-events) or on its timeout. That
// is enough for systems that call back and useless for the ones that do not:
// a CI without a webhook, an export job, a third-party approval page.
//
// These are the pure rules the sweep runs on; the DB work lives in
// external-events.ts. Everything here is arithmetic on a wait row so the
// budget, the schedule and the wording can be pinned by node:test.

/** A wait polls at most this many times before the sweep gives up and says so. */
export const EXTERNAL_POLL_MAX = 24;
/** Floor on the interval, matching the schema bound agents report against. */
export const EXTERNAL_POLL_MIN_SECONDS = 30;

export type PollableWait = {
  pollIntervalSeconds: number | null;
  status: string;
  createdAt: Date | null;
  lastPolledAt: Date | null;
  pollCount: number;
};

export type PollDecision =
  | { poll: false; reason: 'not_polled' | 'not_waiting' | 'budget_spent' | 'too_soon' }
  | { poll: true; attempt: number; final: boolean };

function startedAt(wait: PollableWait): number {
  return (wait.lastPolledAt ?? wait.createdAt)?.getTime() ?? 0;
}

/** When the next check is due, or null when this wait is not polled at all. */
export function nextPollAt(wait: PollableWait): Date | null {
  if (!wait.pollIntervalSeconds) return null;
  const seconds = Math.max(EXTERNAL_POLL_MIN_SECONDS, wait.pollIntervalSeconds);
  return new Date(startedAt(wait) + seconds * 1000);
}

/**
 * Whether the sweep should ask the card owner to check now. The first check
 * waits one full interval after the card parked, not immediately: the agent
 * has just looked.
 */
export function pollDecision(wait: PollableWait, now: number): PollDecision {
  if (!wait.pollIntervalSeconds) return { poll: false, reason: 'not_polled' };
  if (wait.status !== 'waiting') return { poll: false, reason: 'not_waiting' };
  const spent = Math.max(0, wait.pollCount);
  if (spent >= EXTERNAL_POLL_MAX) return { poll: false, reason: 'budget_spent' };
  const due = nextPollAt(wait);
  if (!due || due.getTime() > now) return { poll: false, reason: 'too_soon' };
  const attempt = spent + 1;
  return { poll: true, attempt, final: attempt >= EXTERNAL_POLL_MAX };
}

export type PollPromptInput = {
  provider: string;
  waitingFor: string;
  externalUrl: string | null;
  externalId: string | null;
  attempt: number;
  max: number;
  final: boolean;
  intervalSeconds: number;
};

/**
 * The section the polled owner gets on top of its task prompt. It has to be
 * blunt: the card looks like a normal in_progress dispatch by the time the
 * agent sees it, and redoing the work instead of checking is the failure mode
 * this whole mechanism would otherwise introduce.
 */
export function formatPollPrompt(input: PollPromptInput): string {
  const minutes = Math.max(1, Math.round(input.intervalSeconds / 60));
  return [
    '=== External check, not new work ===',
    `This card is waiting on ${input.provider}: ${input.waitingFor}`,
    input.externalUrl ? `Where to look: ${input.externalUrl}` : '',
    input.externalId ? `Reference: ${input.externalId}` : '',
    `Check ${input.attempt} of ${input.max}, roughly every ${minutes} minute${minutes === 1 ? '' : 's'}.`,
    'Do exactly one thing: look at that external system and report what you see. Do not redo the work, do not start anything new, do not open a pull request.',
    '- Finished successfully: report status="done" (or "in_review" when it needs review) with the evidence you found.',
    '- Finished badly: report status="in_progress" with what failed, and fix it on the next run.',
    '- Still running: report status="waiting_on_external" again with the same pollIntervalSeconds, and say in one line what you saw.',
    input.final
      ? `This is the last automatic check; after it MegaCorps stops polling and leaves the card parked for a human. Say plainly whether it is still running.`
      : '',
    'If you cannot reach the external system at all, say so and report status="waiting_on_external" again.',
  ].filter(Boolean).join('\n');
}

export function formatPollExhaustedMessage(input: { provider: string; waitingFor: string; max: number }): string {
  return [
    `Stopped polling ${input.provider} after ${input.max} checks: ${input.waitingFor}`,
    'The card stays parked on its external wait. Answer it with an external event, resume it by hand, or let its timeout block it.',
  ].join('\n');
}
