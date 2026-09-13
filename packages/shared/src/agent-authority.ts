export type AuthorityAgent = {
  id: string;
  companyId: string;
  positionId?: string | null;
  departmentId?: string | null;
  isActive?: boolean | null;
  deletedAt?: unknown | null;
};

export type AuthorityPosition = {
  id: string;
  companyId: string;
  rank?: number | null;
  isCompanyBoss?: boolean | null;
  isDepartmentHead?: boolean | null;
  isActive?: boolean | null;
  defaultDepartmentId?: string | null;
};

export type AgentAuthority = { boss: boolean; departmentHead: boolean; staff: boolean; active: boolean };

const inactiveAuthority: AgentAuthority = { boss: false, departmentHead: false, staff: false, active: false };

export function agentAuthority(agent: AuthorityAgent | null | undefined, position: AuthorityPosition | null | undefined): AgentAuthority {
  const active = Boolean(agent && position
    && agent.isActive !== false
    && !agent.deletedAt
    && position.isActive !== false
    && agent.positionId === position.id
    && agent.companyId === position.companyId);
  if (!active || !agent || !position) return { ...inactiveAuthority };

  const boss = position.isCompanyBoss === true
    && position.isDepartmentHead !== true
    && position.rank === 0
    && position.defaultDepartmentId == null;
  const departmentHead = boss || (position.isCompanyBoss !== true
    && position.isDepartmentHead === true
    && position.rank === 1
    && Boolean(position.defaultDepartmentId)
    && agent.departmentId === position.defaultDepartmentId);
  return { boss, departmentHead, staff: true, active: true };
}
