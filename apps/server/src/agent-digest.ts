import { createHash } from 'node:crypto';
import { and, desc, eq, inArray, isNotNull, isNull } from 'drizzle-orm';
import { db } from './db/client.ts';
import { agentNotes, kanbanCards } from './db/schema.ts';

// The cross-surface "one agent, one memory" digest. Direct Chat sessions and
// Kanban runs are separate adapter sessions, so without this an agent's
// morning chat and its afternoon card run know nothing about each other. The
// digest is assembled from database facts (cheap, deterministic, no LLM) plus
// the notes the agent left for itself, and is injected at session bootstrap
// and re-injected only when its hash moves.

const OPEN_CARD_LIMIT = 6;
const DONE_CARD_LIMIT = 4;
const NOTE_LIMIT = 8;
const REJECTION_LIMIT = 3;
const LINE_CLIP = 160;

export type AgentDigestInput = {
  openCards: Array<{ title: string; status: string | null; updatedAt: Date | null }>;
  doneCards: Array<{ title: string; completedAt: Date | null }>;
  rejections: Array<{ title: string; feedback: string }>;
  notes: Array<{ body: string; createdAt: Date | null }>;
};

function clip(value: string): string {
  const flat = value.replace(/\s+/g, ' ').trim();
  return flat.length > LINE_CLIP ? `${flat.slice(0, LINE_CLIP)}…` : flat;
}

function shortDate(value: Date | null): string {
  return value ? value.toISOString().slice(0, 10) : 'recently';
}

export function formatAgentDigest(input: AgentDigestInput): string {
  const sections: string[] = [];
  if (input.openCards.length) {
    sections.push(['Your open Kanban cards:', ...input.openCards.map((card) => `- [${card.status ?? 'todo'}] ${clip(card.title)}`)].join('\n'));
  }
  if (input.doneCards.length) {
    sections.push(['Recently completed by you:', ...input.doneCards.map((card) => `- ${clip(card.title)} (${shortDate(card.completedAt)})`)].join('\n'));
  }
  if (input.rejections.length) {
    sections.push(['Recent review feedback on your work (do not repeat these mistakes):', ...input.rejections.map((item) => `- ${clip(item.title)}: ${clip(item.feedback)}`)].join('\n'));
  }
  if (input.notes.length) {
    sections.push(['Your own notes from recent conversations:', ...input.notes.map((note) => `- (${shortDate(note.createdAt)}) ${clip(note.body)}`)].join('\n'));
  }
  if (sections.length === 0) return '';
  return ['=== Your Recent Activity (all MegaCorps surfaces) ===', ...sections].join('\n\n');
}

export function agentDigestHash(digest: string): string {
  return createHash('sha256').update(digest).digest('hex');
}

export async function buildAgentDigest(agentId: string, companyId: string): Promise<{ text: string; hash: string }> {
  const [openCards, doneCards, rejectedCards, notes] = await Promise.all([
    db.select({ title: kanbanCards.title, status: kanbanCards.columnStatus, updatedAt: kanbanCards.updatedAt })
      .from(kanbanCards)
      .where(and(
        eq(kanbanCards.companyId, companyId),
        eq(kanbanCards.assigneeId, agentId),
        isNull(kanbanCards.deletedAt),
        inArray(kanbanCards.columnStatus, ['todo', 'in_progress', 'in_review', 'needs_review', 'waiting_on_external', 'blocked']),
      ))
      .orderBy(desc(kanbanCards.updatedAt)).limit(OPEN_CARD_LIMIT),
    db.select({ title: kanbanCards.title, completedAt: kanbanCards.completedAt })
      .from(kanbanCards)
      .where(and(
        eq(kanbanCards.companyId, companyId),
        eq(kanbanCards.assigneeId, agentId),
        isNull(kanbanCards.deletedAt),
        eq(kanbanCards.columnStatus, 'done'),
      ))
      .orderBy(desc(kanbanCards.completedAt)).limit(DONE_CARD_LIMIT),
    db.select({ title: kanbanCards.title, feedback: kanbanCards.reviewFeedback })
      .from(kanbanCards)
      .where(and(
        eq(kanbanCards.companyId, companyId),
        eq(kanbanCards.assigneeId, agentId),
        isNull(kanbanCards.deletedAt),
        isNotNull(kanbanCards.reviewFeedback),
      ))
      .orderBy(desc(kanbanCards.updatedAt)).limit(REJECTION_LIMIT),
    db.select({ body: agentNotes.body, createdAt: agentNotes.createdAt })
      .from(agentNotes)
      .where(eq(agentNotes.agentId, agentId))
      .orderBy(desc(agentNotes.createdAt)).limit(NOTE_LIMIT),
  ]);

  const text = formatAgentDigest({
    openCards,
    doneCards,
    rejections: rejectedCards.filter((card): card is { title: string; feedback: string } => Boolean(card.feedback)),
    notes,
  });
  return { text, hash: agentDigestHash(text) };
}
