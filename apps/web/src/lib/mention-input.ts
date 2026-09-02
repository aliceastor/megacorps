// Caret-side helpers for the composer's @mention autocomplete: which `@token`
// the caret is in, and how to replace it. Pure and React-free so node:test can
// pin the rule down; the composer only calls these. The lead rule matches the
// server's mention regex: "@" at the start or after whitespace / punctuation,
// so "a@b.com" is never a mention.

const TOKEN_CHAR = /[\p{L}\p{N}_.-]/u;
const LEAD_CHAR = /[\s\p{P}]/u;

/** Longest query the popover reacts to; longer tokens are ordinary text. */
export const MENTION_QUERY_MAX = 20;

export type MentionQuery = {
  /** Index of the "@". */
  start: number;
  /** Index just past the last token char; the caret may sit before it. */
  end: number;
  /** Characters between the "@" and the caret. */
  query: string;
};
export type MentionEdit = { text: string; caret: number };

function clampCaret(text: string, caret: number): number {
  const position = Number.isFinite(caret) ? Math.floor(caret) : text.length;
  return Math.max(0, Math.min(position, text.length));
}

function isTokenChar(char: string | undefined): boolean {
  return char !== undefined && TOKEN_CHAR.test(char);
}

function splice(text: string, start: number, end: number, replacement: string): MentionEdit {
  return { text: `${text.slice(0, start)}${replacement}${text.slice(end)}`, caret: start + replacement.length };
}

/** The `@query` token the caret ends (or sits inside), or null when the caret is not in one. */
export function mentionQueryAtCaret(text: string, caret: number): MentionQuery | null {
  const position = clampCaret(text, caret);
  let index = position;
  while (index > 0 && isTokenChar(text[index - 1])) index -= 1;
  if (index === 0 || text[index - 1] !== '@') return null;
  const start = index - 1;
  if (start > 0 && !LEAD_CHAR.test(text[start - 1]!)) return null;
  const query = text.slice(index, position);
  if (query.length > MENTION_QUERY_MAX) return null;
  let end = position;
  while (end < text.length && isTokenChar(text[end])) end += 1;
  return { start, end, query };
}

/**
 * Replaces the token at the caret with `@slug ` and returns the caret after
 * it. Without a token it inserts one at the caret (with a leading space when
 * the previous char would break the lead rule); an existing following space
 * is reused instead of doubled.
 */
export function insertMention(text: string, caret: number, slug: string): MentionEdit {
  const position = clampCaret(text, caret);
  const token = mentionQueryAtCaret(text, position);
  const start = token ? token.start : position;
  const end = token ? token.end : position;
  const previous = start > 0 ? text[start - 1] : undefined;
  const lead = !token && previous !== undefined && !LEAD_CHAR.test(previous) ? ' ' : '';
  const reusesSpace = text[end] === ' ';
  const edited = splice(text, start, end, `${lead}@${slug}${reusesSpace ? '' : ' '}`);
  return { text: edited.text, caret: edited.caret + (reusesSpace ? 1 : 0) };
}

/** Inserts `snippet` at the caret; a snippet starting with "@" gets a leading space when the lead rule needs one. Used by the @ button. */
export function insertText(text: string, caret: number, snippet: string): MentionEdit {
  const position = clampCaret(text, caret);
  const previous = position > 0 ? text[position - 1] : undefined;
  const lead = snippet.startsWith('@') && previous !== undefined && !LEAD_CHAR.test(previous) ? ' ' : '';
  return splice(text, position, position, `${lead}${snippet}`);
}
