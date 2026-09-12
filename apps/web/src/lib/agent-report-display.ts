import { agentReportSchema, type AgentReport } from '@megacorps/shared';

export function reportArtifactHref(value: string | null | undefined): string | null {
  if (!value) return null;
  try {
    const url = new URL(value);
    return ['http:', 'https:'].includes(url.protocol) ? url.href : null;
  } catch { return null; }
}

function balancedCandidates(text: string): Array<{ json: string; end: number }> {
  const candidates: Array<{ json: string; end: number }> = [];
  let depth = 0;
  let start = -1;
  let inString = false;
  let escaped = false;
  for (let index = 0; index < text.length; index += 1) {
    const char = text[index];
    if (inString) {
      if (escaped) escaped = false;
      else if (char === '\\') escaped = true;
      else if (char === '"') inString = false;
      continue;
    }
    if (char === '"') { inString = true; continue; }
    if (char === '{') { if (depth === 0) start = index; depth += 1; }
    if (char === '}' && depth > 0) {
      depth -= 1;
      if (depth === 0 && start >= 0) {
        const json = text.slice(start, index + 1);
        if (json.includes('megacorps-report')) candidates.push({ json, end: index + 1 });
        start = -1;
      }
    }
  }
  return candidates;
}

/** Read-only projection for a completed run. The actual terminal envelope must be the last output. */
export function projectTerminalAgentReport(output: string | null | undefined): AgentReport | null {
  const text = output ?? '';
  if (!text.includes('megacorps-report')) return null;
  const candidates = balancedCandidates(text);
  const candidate = candidates.at(-1);
  if (!candidate || text.lastIndexOf('megacorps-report') >= candidate.end) return null;
  const suffix = text.slice(candidate.end).trim();
  if (suffix && suffix !== '```') return null;
  try {
    const parsed = agentReportSchema.safeParse(JSON.parse(candidate.json));
    if (!parsed.success || !['completed', 'failed', 'rejected'].includes(parsed.data.status)) return null;
    return parsed.data;
  } catch {
    return null;
  }
}
