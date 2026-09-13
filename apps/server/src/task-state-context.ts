type StateSection = { title: string; entries: string[] };
type TaskStateInput = {
  id: string; title: string; status: string; assignee?: string; reviewer?: string;
  updatedAt?: string; since?: string | null; priority?: number; decisionMode?: string | null;
  requiresApproval?: boolean; sections: StateSection[];
};
const oneLine = (value: string) => value.replace(/\s+/g, ' ').trim();

/** Current state and new evidence are distinct; absent optional fields are not evidence. */
export function formatTaskState(input: TaskStateInput): string {
  const metadata = [
    `- Task: ${oneLine(input.title)}`, `- Card ID: ${input.id}`, `- Stage: ${input.status}`,
    input.assignee ? `- Assignee: ${oneLine(input.assignee)}` : '',
    input.reviewer ? `- Reviewer: ${oneLine(input.reviewer)}` : '',
    input.priority ? `- Priority: ${input.priority}` : '',
    input.decisionMode ? `- Decision mode: ${input.decisionMode}` : '',
    input.requiresApproval ? '- Approval required: yes' : '',
    input.updatedAt ? `- Updated: ${input.updatedAt}` : '',
  ].filter(Boolean).join('\n');
  return [
    '## Task state', metadata,
    input.since ? `Changes since ${input.since}; task state and dependencies below are current.` : '',
    ...input.sections.filter(section => section.entries.length).map(section => `### ${section.title}\n${section.entries.join('\n')}`),
  ].filter(Boolean).join('\n\n').replace('## Task state\n\n', '## Task state\n');
}

export function taskStateReference(card: { id: string; title: string; columnStatus?: string | null }, assignee?: string): string {
  return `- ${oneLine(card.title)} [${card.columnStatus ?? 'todo'}]\n  Card ID: ${card.id}${assignee ? `; assignee: ${oneLine(assignee)}` : ''}`;
}
