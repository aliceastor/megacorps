// Free-text @mentions on the card conversation: the pure parsing and
// resolution half. dispatch.ts feeds it the company roster and performs the
// writes (peer_question rows, notifications).
//
// Why a separate channel from report.mentions: a report mention is a
// structured { to, question } pair that only an agent finishing a run can
// emit. A human typing "@ben can you check this?" into the message board, or
// an agent leaving a note from any runtime, has no report to attach it to.
// The same @slug convention now works in both places and lands in the same
// peer-question pipeline.

export const MENTIONS_PER_MESSAGE = 3;
const MENTION_SCAN_LIMIT = 8;
const CLIENT_ALIASES = new Set(['client', 'owner', 'you', '客戶', '老闆']);

// "@" must open the text or follow whitespace / light punctuation so that an
// email address (a@b.com) is never read as a mention of "b.com".
const MENTION_PATTERN = /(?:^|[\s(（,，:：;；「\[])@([\p{L}\p{N}_.-]{1,64})/gu;

export type MentionAgent = { id: string; slug: string; name: string; isActive?: boolean | null };
export type ResolvedMentionAgent = { id: string; slug: string; name: string };
export type ResolvedMentions = {
  agents: ResolvedMentionAgent[];
  client: boolean;
  unresolved: string[];
  overflow: string[];
};

export function extractMentionTokens(text: string): string[] {
  const tokens: string[] = [];
  const seen = new Set<string>();
  let scanned = 0;
  for (const match of (text ?? '').matchAll(MENTION_PATTERN)) {
    if (scanned >= MENTION_SCAN_LIMIT) break;
    scanned += 1;
    const token = (match[1] ?? '').replace(/[.,]+$/, '');
    if (!token) continue;
    const key = token.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    tokens.push(token);
  }
  return tokens;
}

export function resolveMentions(
  tokens: string[],
  agents: MentionAgent[],
  options: { excludeAgentId?: string | null } = {},
): ResolvedMentions {
  const result: ResolvedMentions = { agents: [], client: false, unresolved: [], overflow: [] };
  const candidates = agents.filter((agent) => agent.isActive !== false);
  const seenIds = new Set<string>();
  for (const raw of tokens) {
    const token = raw.trim();
    if (!token) continue;
    const lower = token.toLowerCase();
    if (CLIENT_ALIASES.has(lower)) {
      result.client = true;
      continue;
    }
    const match = candidates.find((agent) => agent.slug.toLowerCase() === lower)
      ?? candidates.find((agent) => agent.name.toLowerCase().replace(/\s+/g, '') === lower);
    if (!match) {
      result.unresolved.push(token);
      continue;
    }
    // Mentioning yourself is noise, not a question: drop it silently.
    if (options.excludeAgentId && match.id === options.excludeAgentId) continue;
    if (seenIds.has(match.id)) continue;
    seenIds.add(match.id);
    if (result.agents.length >= MENTIONS_PER_MESSAGE) {
      result.overflow.push(token);
      continue;
    }
    result.agents.push({ id: match.id, slug: match.slug, name: match.name });
  }
  return result;
}

export type MentionQuestionMetadata = {
  peerQuestion: true;
  mention: true;
  targetSlug: string;
  sourceCommentId: string | null;
  authorName: string;
  authorKind: 'user' | 'agent';
};

// Stored on the peer_question row so the sweep can name a human asker (there
// is no agent row to look up) and the UI can thread the question under the
// comment that carried the mention.
export function mentionQuestionMetadata(input: { targetSlug: string; sourceCommentId: string | null; authorName: string; authorKind: 'user' | 'agent' }): MentionQuestionMetadata {
  return {
    peerQuestion: true,
    mention: true,
    targetSlug: input.targetSlug,
    sourceCommentId: input.sourceCommentId,
    authorName: input.authorName,
    authorKind: input.authorKind,
  };
}
