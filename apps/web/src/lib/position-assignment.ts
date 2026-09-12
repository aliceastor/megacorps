export type AuthorityPosition = { id: string; companyId?: string; isActive?: boolean | null; managerPositionId?: string | null; isCompanyLeadership?: boolean | null; isCompanyBoss?: boolean | null; isDepartmentHead?: boolean | null; defaultDepartmentId?: string | null };
export function positionAssignment(position: AuthorityPosition | undefined, staffBossId: string | null | undefined, companyBossId: string | null | undefined) {
  return {
    departmentId: position?.isCompanyBoss || position?.isCompanyLeadership ? null : position?.defaultDepartmentId || null,
    bossId: position?.isCompanyBoss ? null : position?.isDepartmentHead ? companyBossId || null : staffBossId || null,
  };
}

type AgentOrganization = { positionId?: string | null; departmentId?: string | null; bossId?: string | null };
export function positionEditPatch(previous: AgentOrganization, position: AuthorityPosition | undefined, nextPositionId: string | null | undefined, nextBossId: string | null | undefined, companyBossId: string | null | undefined): AgentOrganization {
  const assignment = positionAssignment(position, nextBossId, companyBossId);
  const patch: AgentOrganization = {};
  if ((previous.positionId || null) !== (nextPositionId || null)) {
    patch.positionId = nextPositionId || null;
    patch.departmentId = assignment.departmentId;
  }
  if ((previous.bossId || null) !== assignment.bossId) patch.bossId = assignment.bossId;
  return patch;
}

export type SupervisorAgent = { id: string; companyId: string; positionId?: string | null; isActive?: boolean | null; deletedAt?: string | null };
export function eligibleSupervisors<T extends SupervisorAgent>(position: AuthorityPosition | undefined, agentId: string | undefined, companyId: string, agents: T[], positions: AuthorityPosition[]): T[] {
  if (!position || position.isCompanyBoss) return [];
  const manager = position.isDepartmentHead
    ? positions.find(candidate => candidate.companyId === companyId && candidate.isCompanyBoss && candidate.isActive !== false)
    : positions.find(candidate => candidate.id === position.managerPositionId && candidate.companyId === companyId && candidate.isActive !== false);
  if (!manager) return [];
  return agents.filter(agent => agent.id !== agentId && agent.companyId === companyId && agent.positionId === manager.id && agent.isActive !== false && !agent.deletedAt);
}
export function selectSupervisor(candidates: { id: string }[], currentId: string | null | undefined): string | null {
  if (currentId && candidates.some(candidate => candidate.id === currentId)) return currentId;
  return candidates.length === 1 ? candidates[0]!.id : null;
}
export function supervisorHint(position: AuthorityPosition | undefined, candidates: { id: string }[]) {
  if (position?.isCompanyBoss) return 'Company Boss has no superior.';
  if (!position) return 'Choose a position to configure reporting.';
  return candidates.length === 0 ? 'Manager position is vacant or unconfigured. No eligible supervisor.' : candidates.length > 1 ? 'Choose one occupant of the manager position.' : 'Supervisor is the eligible occupant of the manager position.';
}
