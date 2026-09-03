// Blind review panel (company pipeline design §17): the pure rule set. Who
// sits on the panel, how findings from independent reviewers are merged, how a
// round is decided, what a valid author disposition looks like, how the verify
// round is judged, when the card is taken over along the boss chain, and who
// takes it. No database access: review-rounds.ts feeds it rows and performs
// the writes, so every rule is unit-testable in isolation.

export type FindingSeverity = 'P0' | 'P1' | 'P2';
export type ReviewVerdict = 'approved' | 'revision_requested' | 'escalate';
export type RoundDecision = 'approved' | 'revision_requested';
export type FindingDisposition = 'adopted' | 'rejected' | 'merged';
export type VerificationStatus = 'verified' | 'still_open';
export type TakeoverTrigger = 'escalation' | 'rounds_exhausted' | 'reassign_flagged';

export type FindingRow = {
  key: string;
  reviewerId: string | null;
  severity: FindingSeverity;
  file: string | null;
  line: number | null;
  title: string;
  evidence: string;
  requiredFix: string;
  reassign: boolean;
  disposition?: string | null;
  dispositionReason?: string | null;
  mergedInto?: string | null;
  codeEvidence?: string | null;
  testEvidence?: string | null;
  verification?: string | null;
  verificationNote?: string | null;
};

export type MergedFinding = FindingRow & { reviewerIds: string[]; mergedKeys: string[]; reassignedBy: string[] };

export type DispositionInput = { findingKey: string; disposition: FindingDisposition; reason?: string | null; mergedInto?: string | null; codeEvidence?: string | null; testEvidence?: string | null };
export type VerificationInput = { findingKey: string; status: VerificationStatus; note?: string | null };

export const PANEL_SIZE = 2;
export const REJECT_REASON_MIN_CHARS = 20;
const SEVERITY_RANK: Record<FindingSeverity, number> = { P0: 0, P1: 1, P2: 2 };

export function normalizeSeverity(value: string | null | undefined): FindingSeverity {
  const upper = (value ?? '').trim().toUpperCase();
  return upper === 'P0' || upper === 'P1' || upper === 'P2' ? upper : 'P2';
}

export function isBlockingSeverity(value: string | null | undefined): boolean {
  const severity = normalizeSeverity(value);
  return severity === 'P0' || severity === 'P1';
}

export function normalizeFindingKey(value: string | null | undefined): string {
  return (value ?? '').trim().toUpperCase();
}

// A finding still needs the author's attention: never answered, or answered
// but the verify round said the answer does not hold.
export function findingIsOpen(finding: Pick<FindingRow, 'disposition' | 'verification'>): boolean {
  return !finding.disposition || finding.verification === 'still_open';
}

function unique<T>(values: T[]): T[] {
  return [...new Set(values)];
}

function flat(text: string | null | undefined, maxChars = 400): string {
  const value = (text ?? '').replace(/\s+/g, ' ').trim();
  return value.length <= maxChars ? value : `${value.slice(0, maxChars).trimEnd()}...`;
}

function location(finding: Pick<FindingRow, 'file' | 'line'>): string {
  if (!finding.file) return '';
  return finding.line === null || finding.line === undefined ? finding.file : `${finding.file}:${finding.line}`;
}

// --- Who reviews -------------------------------------------------------------

// panel when the card asks for it, when the company always panels, or when
// the company panels critical work and this card is critical.
export function panelRequired(card: { reviewMode?: string | null; critical?: boolean | null }, companyDefault: string | null | undefined): boolean {
  if (card.reviewMode === 'panel') return true;
  const setting = companyDefault ?? 'critical_only';
  if (setting === 'always') return true;
  if (setting === 'critical_only') return Boolean(card.critical);
  return false;
}

export type PanelAgent = { id: string; isActive: boolean | null; departmentId: string | null; bossId: string | null; positionId: string | null };
export type PanelPosition = { id: string; reviewDomain: string | null; isCompanyBoss: boolean | null };
export type PanelDepartment = { id: string; headAgentId: string | null };
export type PanelComposition = { reviewerIds: string[]; degraded: boolean; reason: string };

// Eligible = active, not the author, not the company boss (the CEO judges
// goals, never code or content). Order: the reviewers named on the card, the
// author's department head, same department + same domain, any department +
// same domain, then the author's boss chain. Two seats; one is a degraded
// (single-blind) panel; none is "unavailable" and the caller decides.
export function composeReviewPanel(input: {
  authorId: string | null;
  explicitReviewerIds?: string[];
  agents: PanelAgent[];
  positions: PanelPosition[];
  departments: PanelDepartment[];
  cardDomain?: string | null;
  size?: number;
}): PanelComposition {
  const size = Math.max(1, input.size ?? PANEL_SIZE);
  const positionById = new Map(input.positions.map((position) => [position.id, position]));
  const agentById = new Map(input.agents.map((agent) => [agent.id, agent]));
  const author = input.authorId ? agentById.get(input.authorId) ?? null : null;
  const domain = input.cardDomain?.trim().toLowerCase() || null;
  const domainOf = (agent: PanelAgent): string | null => (agent.positionId ? positionById.get(agent.positionId)?.reviewDomain?.trim().toLowerCase() || null : null);
  const isCompanyBoss = (agent: PanelAgent): boolean => Boolean(agent.positionId && positionById.get(agent.positionId)?.isCompanyBoss);
  const eligible = (agent: PanelAgent | undefined): agent is PanelAgent => Boolean(agent) && agent!.isActive !== false && agent!.id !== input.authorId && !isCompanyBoss(agent!);
  const chosen: string[] = [];
  const steps: string[] = [];
  const take = (agent: PanelAgent | undefined, step: string): void => {
    if (chosen.length >= size || !eligible(agent) || chosen.includes(agent.id)) return;
    chosen.push(agent.id);
    steps.push(`${step}:${agent.id}`);
  };
  for (const id of input.explicitReviewerIds ?? []) take(agentById.get(id), 'explicit');
  const authorDepartment = author?.departmentId ? input.departments.find((department) => department.id === author.departmentId) : undefined;
  if (authorDepartment?.headAgentId) take(agentById.get(authorDepartment.headAgentId), 'department_head');
  if (domain) {
    if (author?.departmentId) {
      for (const agent of input.agents) if (agent.departmentId === author.departmentId && domainOf(agent) === domain) take(agent, 'same_department_domain');
    }
    for (const agent of input.agents) if (domainOf(agent) === domain) take(agent, 'cross_department_domain');
  }
  const visited = new Set<string>();
  let cursor = author?.bossId ?? null;
  while (cursor && !visited.has(cursor) && chosen.length < size) {
    visited.add(cursor);
    const boss = agentById.get(cursor);
    take(boss, 'boss_chain');
    cursor = boss?.bossId ?? null;
  }
  const reason = chosen.length === 0
    ? 'no eligible reviewer: needs an active agent other than the author and the company boss who matches the domain, heads the department, or sits on the boss chain'
    : steps.join(', ');
  return { reviewerIds: chosen, degraded: chosen.length === 1, reason };
}

// --- Findings ----------------------------------------------------------------

function normalizeTitle(title: string): string {
  return title.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').replace(/\s+/g, ' ').trim();
}

function normalizeFile(file: string | null | undefined): string {
  return (file ?? '').trim().replace(/\\/g, '/').replace(/^\.\//, '').toLowerCase();
}

// Two reviewers who point at the same file, line and (normalized) title
// found the same thing: keep the harsher severity, remember both authors.
export function mergeFindings(rows: FindingRow[]): MergedFinding[] {
  const groups = new Map<string, FindingRow[]>();
  for (const row of rows) {
    const key = `${normalizeFile(row.file)}|${row.line ?? ''}|${normalizeTitle(row.title)}`;
    const group = groups.get(key) ?? [];
    group.push(row);
    groups.set(key, group);
  }
  return [...groups.values()].map((group) => {
    const primary = [...group].sort((a, b) => SEVERITY_RANK[normalizeSeverity(a.severity)] - SEVERITY_RANK[normalizeSeverity(b.severity)])[0]!;
    return {
      ...primary,
      severity: normalizeSeverity(primary.severity),
      reviewerIds: unique(group.map((row) => row.reviewerId).filter((id): id is string => Boolean(id))),
      mergedKeys: group.filter((row) => row.key !== primary.key).map((row) => row.key),
      reassignedBy: unique(group.filter((row) => row.reassign && row.reviewerId).map((row) => row.reviewerId as string)),
      reassign: group.every((row) => row.reassign),
    };
  }).sort((a, b) => SEVERITY_RANK[a.severity] - SEVERITY_RANK[b.severity] || a.key.localeCompare(b.key));
}

// A panel round passes only when every reviewer who answered approved and no
// open P0/P1 finding survives the merge. No answers at all cannot approve.
export function roundDecision(input: { findings: Array<Pick<FindingRow, 'severity' | 'disposition' | 'verification'>>; verdicts: ReviewVerdict[] }): RoundDecision {
  if (input.verdicts.length === 0) return 'revision_requested';
  if (!input.verdicts.every((verdict) => verdict === 'approved')) return 'revision_requested';
  const blockingOpen = input.findings.some((finding) => isBlockingSeverity(finding.severity) && findingIsOpen(finding));
  return blockingOpen ? 'revision_requested' : 'approved';
}

// --- The author's answer -----------------------------------------------------

function dispositionFor(dispositions: DispositionInput[], key: string): DispositionInput | undefined {
  const wanted = normalizeFindingKey(key);
  return dispositions.find((item) => normalizeFindingKey(item.findingKey) === wanted);
}

// Hard rules: every finding answered; P0/P1 rejected only with a reason that
// says why (unreachable, already covered); merged only into another finding
// of the round. Anything else is the author's judgement.
export function dispositionErrors(findings: FindingRow[], dispositions: DispositionInput[]): string[] {
  const errors: string[] = [];
  const keys = new Set(findings.map((finding) => normalizeFindingKey(finding.key)));
  for (const finding of findings) {
    const answer = dispositionFor(dispositions, finding.key);
    if (!answer) {
      errors.push(`disposition_missing: finding ${finding.key} (${finding.severity}: ${flat(finding.title, 120)}) has no disposition; every finding needs adopted | rejected | merged.`);
      continue;
    }
    if (answer.disposition === 'rejected' && isBlockingSeverity(finding.severity) && (answer.reason?.trim().length ?? 0) < REJECT_REASON_MIN_CHARS) {
      errors.push(`disposition_reason_required: ${finding.key} is ${finding.severity} and may only be rejected with a reason of at least ${REJECT_REASON_MIN_CHARS} characters explaining why it is unreachable or already covered by another fix.`);
    }
    if (answer.disposition === 'merged') {
      const target = normalizeFindingKey(answer.mergedInto);
      if (!target || target === normalizeFindingKey(finding.key) || !keys.has(target)) {
        errors.push(`disposition_merge_target_invalid: ${finding.key} is marked merged but mergedInto must name another finding key of this round.`);
      }
    }
  }
  return errors;
}

// Soft rules: an adopted finding should come with code and test evidence.
export function dispositionWarnings(findings: FindingRow[], dispositions: DispositionInput[]): string[] {
  const warnings: string[] = [];
  for (const finding of findings) {
    const answer = dispositionFor(dispositions, finding.key);
    if (answer?.disposition === 'adopted' && !answer.codeEvidence?.trim() && !answer.testEvidence?.trim()) {
      warnings.push(`evidence_missing: ${finding.key} was adopted without code or test evidence; the verify round will look harder.`);
    }
  }
  return warnings;
}

// --- The verify round --------------------------------------------------------

// Approved when every adopted finding was verified and no rejection or merge
// was contested; otherwise the contested keys go back to the author. An
// adopted finding nobody verified is still open.
export function verificationDecision(findings: FindingRow[], verifications: VerificationInput[]): { decision: RoundDecision; openKeys: string[] } {
  const openKeys: string[] = [];
  for (const finding of findings) {
    const wanted = normalizeFindingKey(finding.key);
    const entries = verifications.filter((item) => normalizeFindingKey(item.findingKey) === wanted);
    const stillOpen = entries.some((item) => item.status === 'still_open');
    const verified = entries.some((item) => item.status === 'verified');
    if (finding.disposition === 'adopted' ? (stillOpen || !verified) : stillOpen) openKeys.push(finding.key);
  }
  return { decision: openKeys.length === 0 ? 'approved' : 'revision_requested', openKeys };
}

// --- Takeover ----------------------------------------------------------------

// The card leaves the author when they escalate, when this level has used
// its revision budget, or when every reviewer of the round flagged the same
// P0 for reassignment.
export function takeoverTrigger(input: {
  escalation?: boolean | { reason: string } | null;
  revisionCount: number;
  maxRevisions: number;
  findings: Array<Pick<FindingRow, 'severity' | 'reassign'> & { reassignedBy?: string[] }>;
  reviewerIds?: string[];
}): TakeoverTrigger | null {
  if (input.escalation) return 'escalation';
  if (input.maxRevisions > 0 && input.revisionCount >= input.maxRevisions) return 'rounds_exhausted';
  const reviewers = input.reviewerIds ?? [];
  const flagged = input.findings.some((finding) => normalizeSeverity(finding.severity) === 'P0' && (
    reviewers.length > 0
      ? reviewers.every((id) => (finding.reassignedBy ?? []).includes(id))
      : finding.reassign === true
  ));
  return flagged ? 'reassign_flagged' : null;
}

export type FixOwnerAgent = { id: string; bossId: string | null; isActive: boolean | null; isCompanyBoss?: boolean };

// The author's boss inside the department takes over; a department head who
// cannot fix it goes to a human, and the CEO is never on the code chain.
export function nextFixOwner(input: { authorId: string | null; agents: FixOwnerAgent[]; departmentHeadId: string | null }): string | null {
  if (!input.authorId) return null;
  if (input.departmentHeadId && input.departmentHeadId === input.authorId) return null;
  const author = input.agents.find((agent) => agent.id === input.authorId);
  const boss = author?.bossId ? input.agents.find((agent) => agent.id === author.bossId) : undefined;
  if (!boss || boss.id === input.authorId || boss.isActive === false || boss.isCompanyBoss) return null;
  return boss.id;
}

// --- Prompt and message formatting -------------------------------------------

export function formatFindingsForPrompt(findings: Array<FindingRow & Partial<Pick<MergedFinding, 'reviewerIds'>>>): string {
  if (findings.length === 0) return 'No open findings.';
  return findings.map((finding) => {
    const where = location(finding);
    const raisedBy = finding.reviewerIds && finding.reviewerIds.length > 1 ? ` (raised independently by ${finding.reviewerIds.length} reviewers)` : '';
    return [
      `- [${finding.severity}] ${finding.key}${where ? ` ${where}` : ''} - ${flat(finding.title, 200)}${raisedBy}${finding.reassign ? ' [reassign flagged]' : ''}`,
      `  evidence: ${flat(finding.evidence)}`,
      `  required fix: ${flat(finding.requiredFix)}`,
      finding.disposition ? `  your previous disposition: ${finding.disposition}${finding.dispositionReason ? ` - ${flat(finding.dispositionReason)}` : ''}` : '',
      finding.verification === 'still_open' ? `  verifier says still open${finding.verificationNote ? `: ${flat(finding.verificationNote)}` : ''}` : '',
    ].filter(Boolean).join('\n');
  }).join('\n');
}

export function formatDispositionRules(): string {
  return [
    'Disposition rules (every finding key above must appear in your report):',
    '"dispositions": [{ "findingKey": "R1-AB1-1", "disposition": "adopted" | "rejected" | "merged", "reason": "...", "mergedInto": "<other key, merged only>", "codeEvidence": "<commit, file or diff that fixes it>", "testEvidence": "<test or check that proves it>" }]',
    '- adopted: you fixed it; attach codeEvidence and testEvidence.',
    `- rejected: only when the finding is unreachable in practice or already covered by another fix; P0 and P1 need a reason of at least ${REJECT_REASON_MIN_CHARS} characters saying why.`,
    '- merged: this finding is covered by another finding of the same round; mergedInto names that key.',
    'A report that skips a finding, or rejects a P0/P1 without a reason, is returned to you unprocessed. Push your changes before reporting; the same reviewers then verify each disposition.',
    'If the fix is beyond your ability or authority, report "escalation": { "reason": "..." } instead of dispositions and the card is handed up your boss chain.',
  ].join('\n');
}

export function formatVerifyInstructions(findings: FindingRow[]): string {
  return [
    'Findings and the author dispositions to verify:',
    ...findings.map((finding) => {
      const where = location(finding);
      return [
        `- [${finding.severity}] ${finding.key}${where ? ` ${where}` : ''} - ${flat(finding.title, 200)}`,
        `  finding: ${flat(finding.evidence)} | required fix: ${flat(finding.requiredFix)}`,
        `  disposition: ${finding.disposition ?? 'none'}${finding.dispositionReason ? ` - ${flat(finding.dispositionReason)}` : ''}${finding.mergedInto ? ` (merged into ${finding.mergedInto})` : ''}`,
        `  code evidence: ${finding.codeEvidence ? flat(finding.codeEvidence) : 'none given'}`,
        `  test evidence: ${finding.testEvidence ? flat(finding.testEvidence) : 'none given'}`,
      ].join('\n');
    }),
    'Return in your structured report: "verifications": [{ "findingKey": "...", "status": "verified" | "still_open", "note": "..." }] covering every key above (verified = the adopted fix is real and complete, or the rejection or merge reasoning holds; still_open = it does not), plus "verdict" (approved only when nothing is still open) and "score" for the fix work. Do not re-review the whole card; judge only these items.',
  ].join('\n');
}

function decisionLabel(decision: string): string {
  if (decision === 'approved') return 'approved';
  if (decision === 'revision_requested') return 'revision requested';
  if (decision === 'unavailable') return 'no reviewer answered';
  if (decision === 'cancelled') return 'cancelled';
  return decision;
}

function cell(value: string | null | undefined): string {
  return flat(value, 160).replace(/\|/g, '/') || '-';
}

export function formatRoundClosedMessage(round: {
  round: number;
  kind: string;
  decision: string;
  reviewerNames: string[];
  absentNames: string[];
  degraded?: boolean;
  openKeys?: string[];
}, findings: Array<FindingRow & Partial<Pick<MergedFinding, 'reviewerIds'>>>): string {
  const lines = [
    `Blind ${round.kind} review round ${round.round} closed: ${decisionLabel(round.decision)}.`,
    `Reviewers: ${round.reviewerNames.join(', ') || 'none'}${round.degraded ? ' (panel_degraded: only one eligible reviewer)' : ''}`,
  ];
  if (round.absentNames.length > 0) lines.push(`Absent (no answer before the timeout): ${round.absentNames.join(', ')}`);
  if (findings.length === 0) {
    lines.push('Findings: none.');
  } else if (round.kind === 'verify') {
    lines.push(`Dispositions verified (${findings.length}):`, '| Key | Sev | Disposition | Verification | Title |', '|---|---|---|---|---|');
    for (const finding of findings) lines.push(`| ${finding.key} | ${finding.severity} | ${cell(finding.disposition)} | ${cell(finding.verification)}${finding.verificationNote ? ` (${cell(finding.verificationNote)})` : ''} | ${cell(finding.title)} |`);
  } else {
    lines.push(`Findings (${findings.length}, merged across reviewers):`, '| Key | Sev | Location | Title | Raised by |', '|---|---|---|---|---|');
    for (const finding of findings) lines.push(`| ${finding.key} | ${finding.severity} | ${cell(location(finding))} | ${cell(finding.title)}${finding.reassign ? ' [reassign]' : ''} | ${finding.reviewerIds?.length ?? 1} |`);
  }
  if (round.decision === 'revision_requested') {
    const open = round.openKeys ?? findings.filter((finding) => findingIsOpen(finding)).map((finding) => finding.key);
    lines.push(`Back to the author. Open findings to answer: ${open.join(', ') || 'see the verdicts above'}.`);
  } else if (round.decision === 'approved') {
    lines.push('Nothing blocking remains; the card proceeds.');
  }
  return lines.join('\n');
}
