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
  const customPrompt = context.customPrompt?.trim();
  return [
    `You are ${positionName} in ${departmentName} department of firm ${companyName}.`,
    customPrompt,
  ].filter(Boolean).join('\n');
}
