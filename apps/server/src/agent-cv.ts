// Agent CV: performance derived from reviewer verdicts, not from anyone's
// opinion. Reviewers score each piece of work 0-10 against a fixed rubric; the
// CV is the sliding-window average per review domain (code, content, ...).
// A department head reads the CVs of its members to decide who gets what. No
// LLM is involved in producing a CV — it is arithmetic over recorded reviews.

export const CV_WINDOW = 20;
export const CV_MIN_SAMPLES = 5;

export type ReviewScoreRow = { domain: string; score: number; verdict: string; createdAt: Date | null };

export type DomainCv = { domain: string; average: number; samples: number; approvedRate: number; thin: boolean };

// Structured report first; a conservative "Score: N/10" line as fallback so
// reviewers that forget the JSON field still count.
export function parseReviewScore(report: { score?: number | null } | null | undefined, output: string | null | undefined): number | null {
  if (typeof report?.score === 'number' && Number.isInteger(report.score) && report.score >= 0 && report.score <= 10) return report.score;
  const match = /\bscore\s*[:=]\s*(10|[0-9])\s*(?:\/\s*10)?\b/i.exec(output ?? '');
  if (!match) return null;
  return Number(match[1]);
}

export function summarizeCv(rows: ReviewScoreRow[], window = CV_WINDOW): DomainCv[] {
  const byDomain = new Map<string, ReviewScoreRow[]>();
  for (const row of [...rows].sort((a, b) => (b.createdAt?.getTime() ?? 0) - (a.createdAt?.getTime() ?? 0))) {
    const list = byDomain.get(row.domain) ?? [];
    if (list.length < window) list.push(row);
    byDomain.set(row.domain, list);
  }
  return Array.from(byDomain.entries()).map(([domain, list]) => {
    const total = list.reduce((sum, row) => sum + row.score, 0);
    const approved = list.filter((row) => row.verdict === 'approved').length;
    return {
      domain,
      average: Math.round((total / list.length) * 10) / 10,
      samples: list.length,
      approvedRate: Math.round((approved / list.length) * 100),
      thin: list.length < CV_MIN_SAMPLES,
    };
  }).sort((a, b) => b.samples - a.samples);
}

export function formatCv(cv: DomainCv[]): string {
  if (cv.length === 0) return 'no reviewed work yet';
  return cv.map((item) => `${item.domain} ${item.average}/10 over ${item.samples}${item.thin ? ' (thin sample)' : ''}, ${item.approvedRate}% approved`).join('; ');
}

export const TEAM_DIRECTORY_LIMIT = 40;
export const RECENT_SCORE_LIMIT = 3;
const DOMAIN_DISPLAY_LIMIT = 8;
const compact = (value: string, limit = 120) => {
  const text = value.replace(/\s+/g, ' ').trim();
  return text.length > limit ? `${text.slice(0, limit)}…` : text;
};
export type StoredScoreView = ReviewScoreRow & { id: string; cardId: string; reviewerId: string | null; reviewerName: string | null };
export type TeamMemberView = {
  id: string; name: string; slug: string; positionName: string | null; departmentName: string | null;
  bossName: string | null; bossId: string | null; isActive: boolean; eligibleForDelegation: boolean;
  capabilities: string[]; liveCards: number; isBusy: boolean; maxConcurrent: number; cv: DomainCv[];
  recentScores: StoredScoreView[]; scoreCount: number;
};

export function formatTeamResourceView(members: TeamMemberView[], options: { totalMembers?: number; eligibleSlugs?: string[] } = {}): string {
  if (members.length === 0) return '';
  const shown = members.slice(0, TEAM_DIRECTORY_LIMIT);
  const omitted = Math.max(0, (options.totalMembers ?? members.length) - shown.length);
  const recipients = options.eligibleSlugs ?? members.filter(member => member.eligibleForDelegation).map(member => member.slug);
  return [
    '## Company directory (informational; all non-deleted members, including inactive members)',
    'Directory visibility grants no assignment or delegation authority. Reporting lines and current delegation availability are separate.',
    `Eligible delegation recipients for you now: ${recipients.slice(0, TEAM_DIRECTORY_LIMIT).map(slug => compact(slug)).join(', ') || 'none currently'}${recipients.length > TEAM_DIRECTORY_LIMIT ? `; ${recipients.length - TEAM_DIRECTORY_LIMIT} additional eligible recipients omitted` : ''}.`,
    'Open assigned cards are backlog, not active execution slots. Idle does not guarantee runtime availability. CV uses the latest 20 stored scores per domain; thin sample means fewer than 5.',
    ...shown.map(member => {
      const recent = member.recentScores.slice(0, RECENT_SCORE_LIMIT);
      const older = Math.max(0, member.scoreCount - recent.length);
      return [
        `- ${compact(member.name)} (slug: ${compact(member.slug)}${member.positionName ? `, ${compact(member.positionName)}` : ''}${member.departmentName ? `, ${compact(member.departmentName)}` : ''}); ${member.isActive ? 'active' : 'inactive'}; agent ID: ${member.id}`,
        member.bossId ? `  reports to: ${compact(member.bossName ?? member.bossId)} (agent ID: ${member.bossId})` : '',
        `  open assigned cards: ${member.liveCards}; execution: ${member.isBusy ? 'busy' : 'idle'}; configured concurrency: ${member.maxConcurrent}`,
        member.capabilities.length ? `  declared capabilities: ${member.capabilities.slice(0, 12).map(value => compact(value, 80)).join(', ')}${member.capabilities.length > 12 ? `; ${member.capabilities.length - 12} more omitted` : ''}` : '',
        `  verified CV: ${formatCv(member.cv.slice(0, DOMAIN_DISPLAY_LIMIT).map(item => ({ ...item, domain: compact(item.domain, 80) })))}${member.cv.length > DOMAIN_DISPLAY_LIMIT ? `; ${member.cv.length - DOMAIN_DISPLAY_LIMIT} domains omitted` : ''}`,
        recent.length ? '  Recent stored score records:' : '  No stored score records.',
        ...recent.map(score => `  - ${score.createdAt?.toISOString() ?? 'date not recorded'} | ${compact(score.domain, 80)} | ${score.score}/10 | ${compact(score.verdict, 80)}; reviewer: ${compact(score.reviewerName ?? 'name unavailable')} (agent ID: ${score.reviewerId ?? 'not recorded'}); card ID: ${score.cardId}; score record ID: ${score.id}; source: /api/cards/${score.cardId}/review-scores (session-authenticated; newest 20 per card)`),
        older ? `  ${older} older score records omitted.` : '',
      ].filter(Boolean).join('\n');
    }),
    omitted ? `${omitted} company members omitted from this bounded directory.` : '',
    'Use verified CV and stored score records as evidence; declared capabilities are a hint. Balance open work and execution availability within your existing delegation scope.',
  ].filter(Boolean).join('\n');
}
export const REVIEW_SCORE_RUBRIC = [
  'Score the work 0-10 in your report ("score": N) using this rubric, independent of the verdict:',
  '9-10: everything green and beyond the brief; 7-8: green with minor blemishes; 5-6: barely acceptable; 3-4: rejected, fixable; 0-2: rejected, fundamentally off.',
  'The verdict drives the workflow (merge or send back); the score drives the author\'s track record. Score consistently over time — your 8 today must mean what your 8 meant last month.',
].join('\n');
