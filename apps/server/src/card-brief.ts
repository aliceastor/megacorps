// Card brief (company pipeline design §18): the fixed markdown sections a card
// body is written in — Goal / Background / Changes / Out of scope /
// Constraints / Acceptance — with the Chinese headings accepted too. Pure
// functions: parse the sections, extract the acceptance criteria (leniently
// when the heading is missing), render the template the create form inserts,
// and describe how complete a brief is. Reviewers judge against the
// Acceptance section; child cards split by agents must carry one.

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

// One line for the bootstrap prompt: which brief sections the card has.
export function formatBriefCoverage(brief: CardBrief): string {
  const present = brief.present.map((key) => briefSectionLabel(key).toLowerCase()).join(', ') || 'none';
  const missing = brief.missing.map((key) => briefSectionLabel(key).toLowerCase()).join(', ') || 'none';
  return `Brief sections present: ${present}; missing: ${missing}.`;
}
