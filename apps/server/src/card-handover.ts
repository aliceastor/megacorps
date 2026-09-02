// Handover digest for the next hand on a card: the pure formatting half.
// dispatch.ts gathers the rows (previous runs, ownership changes, latest
// review, fresh human instructions, open questions, work products) and this
// module turns them into a short section for the bootstrap prompt.
//
// It is deliberately a digest, not another dump: the Kanban context snapshot
// already carries the latest message board, actions and lifecycle logs. What
// a new assignee lacked was one place that says "here is what the previous
// person actually produced, here is who told you what since, do not start
// over".
//
// Sections are emitted in priority order (open questions, human instructions,
// latest review, ownership changes, previous runs, work products) so that when
// the digest has to be clipped it is the bulky, lowest-priority tail that goes;
// the closing "do not redo finished work" sentence is always kept.

export type HandoverRun = {
  agentId: string | null;
  agentName: string;
  kind: string;
  status: string;
  completedAt: Date | null;
  durationSeconds: number | null;
  output: string | null;
};

export type HandoverInput = {
  assigneeId: string | null;
  runs: HandoverRun[];
  handoffs: Array<{ at: Date | null; fromName: string; body: string }>;
  reviewFeedback: string | null;
  latestReview: { at: Date | null; reviewerName: string; action: string; body: string } | null;
  humanInstructions: Array<{ at: Date | null; authorName: string; action: string; body: string }>;
  openQuestions: Array<{ at: Date | null; fromName: string; body: string }>;
  products: Array<{ type: string; title: string; url: string | null }>;
};

export const HANDOVER_CHAR_LIMIT = 3500;
export const HANDOVER_LIMITS = { runs: 3, handoffs: 3, instructions: 5, questions: 5, products: 6 } as const;
const HANDOVER_RUN_OUTPUT_CHARS = 700;
const HANDOVER_TRUNCATED_TAIL = '\n[handover truncated]';

function flatten(text: string | null | undefined, maxChars: number): string {
  const flat = (text ?? '').replace(/\s+/g, ' ').trim();
  if (flat.length <= maxChars) return flat;
  return `${flat.slice(0, maxChars).trimEnd()}...`;
}

function stamp(value: Date | null | undefined): string {
  if (!value) return 'n/a';
  const time = new Date(value).getTime();
  if (!Number.isFinite(time)) return 'n/a';
  return new Date(time).toISOString().slice(0, 16).replace('T', ' ');
}

function timeOf(value: Date | null | undefined): number {
  const time = value ? new Date(value).getTime() : Number.NaN;
  return Number.isFinite(time) ? time : Number.NEGATIVE_INFINITY;
}

export function formatHandoverSection(input: HandoverInput): string {
  const runs = [...input.runs].sort((a, b) => timeOf(b.completedAt) - timeOf(a.completedAt)).slice(0, HANDOVER_LIMITS.runs);
  const handoffs = input.handoffs.slice(0, HANDOVER_LIMITS.handoffs);
  const instructions = input.humanInstructions.slice(0, HANDOVER_LIMITS.instructions);
  const questions = input.openQuestions.slice(0, HANDOVER_LIMITS.questions);
  const products = input.products.slice(0, HANDOVER_LIMITS.products);
  const reviewFeedback = input.reviewFeedback?.trim() ?? '';
  const latestReview = input.latestReview;
  if (runs.length === 0 && handoffs.length === 0 && instructions.length === 0 && questions.length === 0 && products.length === 0 && !reviewFeedback && !latestReview) return '';

  const workedBefore = Boolean(input.assigneeId) && runs.some((run) => run.agentId === input.assigneeId);
  const lines: string[] = ['=== Handover: what happened on this card before this run ==='];
  if (questions.length > 0) {
    lines.push('Questions colleagues asked you on this card (MegaCorps answers each one for you in a separate short turn - do not answer them in your notes and do not re-mention the asker; just take them into account):');
    for (const question of questions) lines.push(`- from ${question.fromName}: ${flatten(question.body, 400)}`);
  }
  if (instructions.length > 0) {
    lines.push('Instructions from humans since the previous run:');
    for (const item of instructions) lines.push(`- ${stamp(item.at)} | ${item.authorName} (${item.action}): ${flatten(item.body, 600)}`);
  }
  if (latestReview) {
    lines.push(`Latest review: ${latestReview.reviewerName} (${latestReview.action}, ${stamp(latestReview.at)}): ${flatten(latestReview.body, 800)}`);
  }
  if (reviewFeedback && (!latestReview || flatten(latestReview.body, 800) !== flatten(reviewFeedback, 800))) {
    lines.push(`Current review feedback on the card: ${flatten(reviewFeedback, 800)}`);
  }
  if (handoffs.length > 0) {
    lines.push('Ownership changes:');
    for (const handoff of handoffs) lines.push(`- ${stamp(handoff.at)} | ${handoff.fromName} handed off: ${flatten(handoff.body, 400)}`);
  }
  if (runs.length > 0) {
    lines.push('Previous runs (newest first):');
    for (const run of runs) {
      const who = input.assigneeId && run.agentId === input.assigneeId ? 'you' : run.agentName;
      const duration = run.durationSeconds === null || run.durationSeconds === undefined ? 'n/a' : `${run.durationSeconds}s`;
      lines.push(`- ${stamp(run.completedAt)} | ${who} | ${run.kind}/${run.status} | ${duration} | ${flatten(run.output, HANDOVER_RUN_OUTPUT_CHARS) || 'no output captured'}`);
    }
  }
  if (products.length > 0) {
    lines.push('Work products so far:');
    for (const product of products) lines.push(`- ${product.type}: ${product.title}${product.url ? ` (${product.url})` : ''}`);
  }
  const closing = workedBefore
    ? 'You worked this card before; continue from your last output. Do not redo finished work: build on the outputs above, and say explicitly in your report what you changed relative to the previous run.'
    : 'Do not redo finished work: build on the outputs above, and say explicitly in your report what you changed relative to the previous run.';

  const body = lines.join('\n');
  const text = `${body}\n${closing}`;
  if (text.length <= HANDOVER_CHAR_LIMIT) return text;
  // Priority cut: clip the tail of the body (the bulky, lowest-priority
  // sections come last) but always keep the truncation marker and the closing
  // instruction, so open questions, human instructions and the "do not redo"
  // line survive however long the previous run outputs were.
  const tail = `${HANDOVER_TRUNCATED_TAIL}\n${closing}`;
  return `${body.slice(0, Math.max(0, HANDOVER_CHAR_LIMIT - tail.length)).trimEnd()}${tail}`;
}
