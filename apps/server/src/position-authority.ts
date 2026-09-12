import { and, eq, isNull } from 'drizzle-orm';
import { db } from './db/client.ts';
import { agents, positions } from './db/schema.ts';

type Database = Pick<typeof db, 'select'>;
type OrganizationInput = {
  id?: string;
  positionId?: string | null;
  departmentId?: string | null;
  bossId?: string | null;
  isActive?: boolean | null;
  deletedAt?: Date | null;
  autoSelect?: boolean;
  resetIneligibleBoss?: boolean;
};

/** API normalization mirrors database eligibility and preserves a still-eligible supervisor. */
export async function resolveAgentOrganization(database: Database, companyId: string, value: OrganizationInput) {
  if (!value.positionId) return { departmentId: value.departmentId, bossId: value.bossId };
  const [position] = await database.select().from(positions)
    .where(and(eq(positions.id, value.positionId), eq(positions.companyId, companyId))).limit(1);
  if (!position) throw new Error('position_company_mismatch');
  const result = {
    departmentId: position.isCompanyBoss ? null : position.defaultDepartmentId ?? null,
    bossId: value.bossId,
  };
  if (position.isCompanyBoss) result.bossId = null;
  if (position.isDepartmentHead) {
    const roles = await database.select().from(positions).where(eq(positions.companyId, companyId));
    const members = await database.select().from(agents)
      .where(and(eq(agents.companyId, companyId), isNull(agents.deletedAt)));
    const boss = members.find(agent => agent.isActive !== false && roles.some(role =>
      role.id === agent.positionId && role.isCompanyBoss && role.isActive !== false));
    if (!boss && value.isActive !== false && !value.deletedAt) {
      throw new Error('organization_boss_required');
    }
    result.bossId = boss?.id ?? null;
  }
  if (!position.isCompanyBoss && !position.isDepartmentHead) {
    const [manager] = position.managerPositionId ? await database.select().from(positions)
      .where(and(eq(positions.id, position.managerPositionId), eq(positions.companyId, companyId))).limit(1) : [];
    const candidates = manager?.isActive !== false && manager ? (await database.select().from(agents)
      .where(and(eq(agents.companyId, companyId), eq(agents.positionId, manager.id), isNull(agents.deletedAt))))
      .filter(agent => agent.id !== value.id && agent.isActive !== false) : [];
    if (result.bossId && !candidates.some(agent => agent.id === result.bossId)) {
      if (value.resetIneligibleBoss) result.bossId = null;
      else throw new Error('organization_supervisor_ineligible');
    }
    if (!result.bossId && value.autoSelect && value.isActive !== false && !value.deletedAt) {
      if (candidates.length > 1) throw new Error('organization_supervisor_choice_required');
      result.bossId = candidates[0]?.id ?? null;
    }
  }
  return result;
}

export function validatePositionRole(value: {
  rank: number;
  isCompanyBoss?: boolean | null;
  isDepartmentHead?: boolean | null;
  isCompanyLeadership?: boolean | null;
  defaultDepartmentId?: string | null;
  managerPositionId?: string | null;
}) {
  if (value.isCompanyBoss) {
    if (value.isDepartmentHead || value.rank !== 0 || value.defaultDepartmentId || value.managerPositionId) {
      throw new Error('organization_boss_position_invalid');
    }
  } else if (value.isDepartmentHead) {
    if (value.isCompanyLeadership || value.rank !== 1 || !value.defaultDepartmentId) throw new Error('organization_head_position_invalid');
  } else if (value.rank < 2 || value.rank > 9 || (value.isCompanyLeadership ? Boolean(value.defaultDepartmentId) : !value.defaultDepartmentId)) {
    throw new Error('organization_staff_position_invalid');
  }
}
