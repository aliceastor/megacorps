// Card brief (company pipeline design §18), the client copy of
// apps/server/src/card-brief.ts: the six fixed markdown sections a card body
// is written in (Goal / Background / Changes / Out of scope / Constraints /
// Acceptance, Chinese headings accepted), the template the create and edit
// forms insert, and the acceptance checklist the overview renders. Pure and
// React-free; card-brief.test.ts compares the template and the heading tables
// with the server file read from disk so the two copies cannot drift.

export type BriefSectionKey = 'goal' | 'background' | 'changes' | 'outOfScope' | 'constraints' | 'acceptance';

export type BriefSection = { key: BriefSectionKey; label: string; headings: readonly string[] };

export const BRIEF_SECTIONS: readonly BriefSection[] = [
  { key: 'goal', label: 'Goal', headings: ['goal', '目標', '目标'] },
  { key: 'background', label: 'Background', headings: ['background', '背景'] },
  { key: 'changes', label: 'Changes', headings: ['changes', 'change', '變更', '变更'] },
  { key: 'outOfScope', label: 'Out of scope', headings: ['out of scope', 'out-of-scope', 'non-goals', '範圍外', '范围外'] },
  { key: 'constraints', label: 'Constraints', headings: ['constraints', 'constraint', '限制'] },
  { key: 'acceptance', label: 'Acceptance', headings: ['acceptance', 'acceptance criteria', '驗收', '驗收標準', '驗收條件', '验收', '验收标准'] },
];

export type CardBrief = {
  goal: string | null;
  background: string | null;
  changes: string | null;
  outOfScope: string | null;
  constraints: string | null;
  acceptance: string | null;
  present: BriefSectionKey[];
  missing: BriefSectionKey[];
};

// `#`, `##` and `###` headings; a trailing colon or closing hashes are ignored.
const HEADING_LINE = /^\s{0,3}#{1,3}\s+(.+?)\s*#*\s*$/;
// `- [ ] text` / `- [x] text`; an unticked box with nothing after it is empty.
const CHECKLIST_LINE = /^\s*[-*+]\s*\[( |x|X)\]\s*\S/;
const CHECKBOX_ITEM = /^[-*+]\s*\[( |x|X)\]\s*(.*)$/;

function headingKey(text: string): BriefSectionKey | null {
  const normalized = text.trim().replace(/[*_`]/g, '').replace(/[:：]\s*$/, '').replace(/\s+/g, ' ').trim().toLowerCase();
  for (const section of BRIEF_SECTIONS) if (section.headings.includes(normalized)) return section.key;
  return null;
}

function meaningful(text: string | null | undefined): boolean {
  return /[\p{L}\p{N}]/u.test((text ?? '').replace(/\[( |x|X)\]/g, ''));
}

export function parseCardBrief(body: string | null | undefined): CardBrief {
  const collected = new Map<BriefSectionKey, string[]>();
  let current: BriefSectionKey | null = null;
  for (const line of (body ?? '').split(/\r?\n/)) {
    const heading = HEADING_LINE.exec(line);
    if (heading) {
      // Any heading ends the current section; only brief headings open one.
      current = headingKey(heading[1] ?? '');
      if (current && !collected.has(current)) collected.set(current, []);
      continue;
    }
    if (current) collected.get(current)?.push(line);
  }
  const text = (key: BriefSectionKey): string | null => {
    const lines = collected.get(key);
    return lines ? lines.join('\n').trim() : null;
  };
  const keys = BRIEF_SECTIONS.map((section) => section.key);
  return {
    goal: text('goal'),
    background: text('background'),
    changes: text('changes'),
    outOfScope: text('outOfScope'),
    constraints: text('constraints'),
    acceptance: text('acceptance'),
    present: keys.filter((key) => collected.has(key)),
    missing: keys.filter((key) => !collected.has(key)),
  };
}

// The acceptance criteria: the Acceptance section when the brief has one,
// otherwise (lenient) the checklist lines, otherwise a paragraph that talks
// about acceptance. null when the body states none.
export function acceptanceOf(body: string | null | undefined): string | null {
  const brief = parseCardBrief(body);
  if (brief.acceptance && meaningful(brief.acceptance)) return brief.acceptance;
  const text = body ?? '';
  const checklist = text.split(/\r?\n/).filter((line) => CHECKLIST_LINE.test(line)).map((line) => line.trim());
  if (checklist.length > 0) return checklist.join('\n');
  // Heading lines are dropped first so a bare "## Acceptance" with nothing
  // under it does not count as criteria.
  const paragraph = text.split(/\r?\n\s*\r?\n/)
    .map((part) => part.split(/\r?\n/).filter((line) => !HEADING_LINE.test(line)).join('\n').trim())
    .find((part) => meaningful(part) && /acceptance|驗收|验收/i.test(part));
  return paragraph ?? null;
}

export function hasAcceptance(body: string | null | undefined): boolean {
  return acceptanceOf(body) !== null;
}

export function briefTemplate(): string {
  return ['## Goal', '', '## Background', '', '## Changes', '- ', '', '## Out of scope', '- ', '', '## Constraints', '- ', '', '## Acceptance', '- [ ] ', ''].join('\n');
}

export function briefSectionLabel(key: BriefSectionKey): string {
  return BRIEF_SECTIONS.find((section) => section.key === key)?.label ?? key;
}

/** The template on an empty body, or appended after a blank line: existing text is never overwritten. */
export function insertBriefTemplate(body: string | null | undefined): string {
  const current = (body ?? '').replace(/\s+$/, '');
  return current ? `${current}\n\n${briefTemplate()}` : briefTemplate();
}

/**
 * The sections the overview flags as missing: absent headings, plus
 * Acceptance when its heading is there but states nothing (the server's
 * hasAcceptance rule, which reviewers and the split gate judge by).
 */
export function briefGaps(body: string | null | undefined): BriefSectionKey[] {
  const brief = parseCardBrief(body);
  const gaps = new Set<BriefSectionKey>(brief.missing);
  if (!hasAcceptance(body)) gaps.add('acceptance');
  return BRIEF_SECTIONS.map((section) => section.key).filter((key) => gaps.has(key));
}

export type AcceptanceItem = { text: string; /** null = a plain line, not a checkbox */ checked: boolean | null };

/** The Acceptance section as a checklist: `- [ ]` / `- [x]` lines become boxes, other lines plain items; empty boxes are dropped. */
export function acceptanceItems(acceptance: string | null | undefined): AcceptanceItem[] {
  return (acceptance ?? '').split(/\r?\n/).map((line) => line.trim()).filter(Boolean).map((line) => {
    const box = CHECKBOX_ITEM.exec(line);
    if (box) return { text: (box[2] ?? '').trim(), checked: box[1] !== ' ' };
    return { text: line.replace(/^[-*+]\s+/, '').trim(), checked: null };
  }).filter((item) => item.text.length > 0);
}
