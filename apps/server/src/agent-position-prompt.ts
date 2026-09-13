import { agentAuthority, type AuthorityAgent, type AuthorityPosition } from '@megacorps/shared';

export type AgentPositionPromptContext = {
  positionName?: string | null;
  departmentName?: string | null;
  companyName?: string | null;
  customPrompt?: string | null;
  isCompanyLeadership?: boolean;
  agent?: AuthorityAgent | null;
  position?: AuthorityPosition | null;
};

export function formatAgentPositionPrompt(context: AgentPositionPromptContext): string {
  const positionName = context.positionName?.trim();
  if (!positionName) return '';
  const departmentName = context.departmentName?.trim() || 'unassigned';
  const companyName = context.companyName?.trim() || 'unknown';
  // Retire the observed pre-managed-merge directive in the injected projection.
  // Preserve the user's saved prompt and unrelated professional instructions.
  const customPrompt = context.customPrompt?.trim().replace(/^\s*Authority:\s*rank\s+[^\r\n]*(?:\r?\n|$)/gim, '').trim().replace(
    /並用 gitea API merge 該 PR，verdict 附 merge commit SHA/g,
    '回報 verdict 與受審 head SHA；由 MegaCorps 合併閘門執行 merge',
  );
  const authority = context.agent && context.position ? agentAuthority(context.agent, context.position) : null;
  return [
    context.isCompanyLeadership
      ? `You are ${positionName} in company leadership of firm ${companyName}.`
      : `You are ${positionName} in ${departmentName} department of firm ${companyName}.`,
    customPrompt,
    authority ? `Authority: rank ${context.position?.rank ?? 'unknown'}; boss=${authority.boss ? 'yes' : 'no'}; department_head=${authority.departmentHead ? 'yes' : 'no'}; staff=${authority.staff ? 'yes' : 'no'}; active=${authority.active ? 'yes' : 'no'}.` : '',
  ].filter(Boolean).join('\n');
}
