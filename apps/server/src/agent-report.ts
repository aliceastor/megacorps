import { agentReportSchema, type AgentReport, type AgentReportDelegation } from '@megacorps/shared';

const REPORT_MARKER = 'megacorps-report';
const DELEGATION_LINE_MAX = 500;

export type AgentReportExtraction = { report: AgentReport } | { error: string };

function balancedJsonCandidates(text: string, marker: string): string[] {
  // Collect top-level {...} spans that contain the marker. A simple depth
  // counter is enough here: the JSON is machine-written and the marker check
  // filters out prose braces before any parse attempt.
  const candidates: string[] = [];
  let depth = 0;
  let start = -1;
  let inString = false;
  let escaped = false;
  for (let i = 0; i < text.length; i += 1) {
    const char = text[i];
    if (inString) {
      if (escaped) escaped = false;
      else if (char === '\\') escaped = true;
      else if (char === '"') inString = false;
      continue;
    }
    if (char === '"') { inString = true; continue; }
    if (char === '{') {
      if (depth === 0) start = i;
      depth += 1;
    } else if (char === '}') {
      if (depth > 0) depth -= 1;
      if (depth === 0 && start >= 0) {
        const span = text.slice(start, i + 1);
        if (span.includes(marker)) candidates.push(span);
        start = -1;
      }
    }
  }
  return candidates;
}

// Fenced blocks first, then the bare text: agents that wrap their JSON in
// ```json fences are the common case, and scanning fences alone keeps
// surrounding prose braces out of the candidate list.
export function markedJsonCandidates(output: string | null | undefined, marker: string): string[] {
  const text = output ?? '';
  if (!text.includes(marker)) return [];
  const candidates: string[] = [];
  const fencePattern = /```(?:json)?\s*\n?([\s\S]*?)```/gi;
  for (const match of text.matchAll(fencePattern)) {
    const body = match[1]?.trim() ?? '';
    if (body.includes(marker)) candidates.push(...balancedJsonCandidates(body, marker));
  }
  if (candidates.length === 0) candidates.push(...balancedJsonCandidates(text, marker));
  return candidates;
}

export function extractAgentReport(output: string | null | undefined): AgentReportExtraction | null {
  const candidates = markedJsonCandidates(output, REPORT_MARKER);
  if (candidates.length === 0) return null;

  let lastError: string | null = null;
  // Prefer the last candidate: agents that revise mid-output put the final
  // report at the end.
  for (const candidate of candidates.reverse()) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(candidate);
    } catch {
      lastError = 'report_json_parse_failed';
      continue;
    }
    const result = agentReportSchema.safeParse(parsed);
    if (result.success) return { report: result.data };
    lastError = `report_schema_invalid: ${result.error.issues.map((issue) => `${issue.path.join('.')}: ${issue.message}`).join('; ').slice(0, 500)}`;
  }
  return lastError ? { error: lastError } : null;
}

export type StructuredDelegationPlan = {
  handoff: AgentReportDelegation | null;
  subroutineLines: string[];
  mixed: boolean;
};

// Splits a structured report's delegations into ownership-transfer (handoff)
// vs subroutine work. `mixed` flags plans that combine a handoff with anything
// else — ambiguous ownership, rejected by callers.
export function structuredDelegationPlan(output: string | null | undefined): StructuredDelegationPlan | null {
  const extraction = extractAgentReport(output);
  if (!extraction || !('report' in extraction)) return null;
  const delegations = extraction.report.delegations ?? [];
  if (delegations.length === 0) return null;
  const handoffs = delegations.filter((item) => item.mode === 'handoff');
  const subroutines = delegations.filter((item) => item.mode !== 'handoff');
  return {
    handoff: handoffs[0] ?? null,
    subroutineLines: subroutines.map(delegationLineFromReportItem),
    mixed: handoffs.length > 1 || (handoffs.length > 0 && subroutines.length > 0),
  };
}

export function delegationLineFromReportItem(item: AgentReportDelegation): string {
  const parts = [item.objective];
  if (item.outputFormat) parts.push(`output: ${item.outputFormat}`);
  if (item.boundaries) parts.push(`boundaries: ${item.boundaries}`);
  if (item.effort) parts.push(`effort: ${item.effort}`);
  const line = `${item.to ? `${item.to}: ` : ''}${parts.join(' — ')}`;
  return line.length > DELEGATION_LINE_MAX ? line.slice(0, DELEGATION_LINE_MAX) : line;
}
