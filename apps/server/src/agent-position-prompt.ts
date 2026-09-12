export type AgentPositionPromptContext = {
  positionName?: string | null;
  departmentName?: string | null;
  companyName?: string | null;
  customPrompt?: string | null;
};

export function formatAgentPositionPrompt(context: AgentPositionPromptContext): string {
  const positionName = context.positionName?.trim();
  if (!positionName) return '';
  const departmentName = context.departmentName?.trim() || 'unassigned';
  const companyName = context.companyName?.trim() || 'unknown';
  // Retire the observed pre-managed-merge directive in the injected projection.
  // Preserve the user's saved prompt and unrelated professional instructions.
  const customPrompt = context.customPrompt?.trim().replace(
    /並用 gitea API merge 該 PR，verdict 附 merge commit SHA/g,
    '回報 verdict 與受審 head SHA；由 MegaCorps 合併閘門執行 merge',
  );
  return [
    `You are ${positionName} in ${departmentName} department of firm ${companyName}.`,
    customPrompt,
  ].filter(Boolean).join('\n');
}
