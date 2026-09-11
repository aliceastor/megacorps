/** The same identity must be used for usage recovery and remote submission. */
export function a2aExecutionScope(agentId: string, task: { id: string; kind?: string; reportingMode?: string }): string {
  return JSON.stringify([agentId, task.kind ?? 'task', task.id, task.reportingMode ?? null]);
}
