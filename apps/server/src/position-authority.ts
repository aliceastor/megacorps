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
};

/** API normalization mirrors the database trigger; Staff reporting is independent
 * of Position.managerPositionId and is deliberately preserved. */
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
  return result;
}

export function validatePositionRole(value: {
  rank: number;
  isCompanyBoss?: boolean | null;
  isDepartmentHead?: boolean | null;
  defaultDepartmentId?: string | null;
  managerPositionId?: string | null;
}) {
  if (value.isCompanyBoss) {
    if (value.isDepartmentHead || value.rank !== 0 || value.defaultDepartmentId || value.managerPositionId) {
      throw new Error('organization_boss_position_invalid');
    }
  } else if (value.isDepartmentHead) {
    if (value.rank !== 1 || !value.defaultDepartmentId) throw new Error('organization_head_position_invalid');
  } else if (value.rank < 2 || value.rank > 9 || !value.defaultDepartmentId) {
    throw new Error('organization_staff_position_invalid');
  }
}
