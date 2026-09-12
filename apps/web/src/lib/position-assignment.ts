export type AuthorityPosition = { id: string; isCompanyBoss?: boolean | null; isDepartmentHead?: boolean | null; defaultDepartmentId?: string | null };
export function positionAssignment(position: AuthorityPosition | undefined, staffBossId: string | null | undefined, companyBossId: string | null | undefined) {
  return {
    departmentId: position?.isCompanyBoss ? null : position?.defaultDepartmentId || null,
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
