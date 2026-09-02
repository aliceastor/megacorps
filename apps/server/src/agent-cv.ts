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

export type TeamMemberView = {
  name: string;
  slug: string;
  positionName: string | null;
  departmentName: string | null;
  capabilities: string[];
  liveCards: number;
  isBusy: boolean;
  cv: DomainCv[];
  lastRejectReason: string | null;
};

// The department head's resource view: who is free, what each member says
// they can do, and what reviewers have actually verified they can do.
export function formatTeamResourceView(members: TeamMemberView[]): string {
  if (members.length === 0) return '';
  return [
    'Your team (resource view — use it to decide who gets what):',
    ...members.map((member) => [
      `- ${member.name} (slug: ${member.slug}${member.positionName ? `, ${member.positionName}` : ''}${member.departmentName ? `, ${member.departmentName}` : ''})`,
      `  load: ${member.liveCards} live card(s)${member.isBusy ? ', busy right now' : ', free'}`,
      `  declared capabilities: ${member.capabilities.length ? member.capabilities.join(', ') : 'none declared'}`,
      `  verified track record: ${formatCv(member.cv)}`,
      member.lastRejectReason ? `  last rejection: ${member.lastRejectReason}` : '',
    ].filter(Boolean).join('\n')),
    'Prefer members whose verified track record matches the work; declared capabilities are a hint, reviews are evidence. Balance load — a busy member finishes later, not faster.',
  ].join('\n');
}

export const REVIEW_SCORE_RUBRIC = [
  'Score the work 0-10 in your report ("score": N) using this rubric, independent of the verdict:',
  '9-10: everything green and beyond the brief; 7-8: green with minor blemishes; 5-6: barely acceptable; 3-4: rejected, fixable; 0-2: rejected, fundamentally off.',
  'The verdict drives the workflow (merge or send back); the score drives the author\'s track record. Score consistently over time — your 8 today must mean what your 8 meant last month.',
].join('\n');
