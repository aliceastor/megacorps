import { and, eq } from 'drizzle-orm';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { requireAuth, type AuthUser } from './auth.ts';
import { db } from './db/client.ts';
import { companyMemberships } from './db/schema.ts';

export type CompanyRole = 'viewer' | 'operator' | 'admin';

const roleRank: Record<CompanyRole, number> = { viewer: 0, operator: 1, admin: 2 };

function normalizeRole(value: string | null | undefined): CompanyRole {
  return value === 'admin' || value === 'operator' ? value : 'viewer';
}

export function hasCompanyRole(actual: string | null | undefined, required: CompanyRole): boolean {
  return roleRank[normalizeRole(actual)] >= roleRank[required];
}

export async function visibleCompanyIds(user: AuthUser): Promise<string[]> {
  const rows = await db.select({ companyId: companyMemberships.companyId })
    .from(companyMemberships)
    .where(and(eq(companyMemberships.userId, user.id), eq(companyMemberships.status, 'active')));
  return rows.map((row) => row.companyId);
}

export async function membershipRole(user: AuthUser, companyId: string): Promise<CompanyRole | null> {
  const [membership] = await db.select({ role: companyMemberships.role })
    .from(companyMemberships)
    .where(and(
      eq(companyMemberships.userId, user.id),
      eq(companyMemberships.companyId, companyId),
      eq(companyMemberships.status, 'active'),
    ))
    .limit(1);
  return membership ? normalizeRole(membership.role) : null;
}

export async function requireCompanyRole(request: FastifyRequest, reply: FastifyReply, companyId: string, minimumRole: CompanyRole): Promise<AuthUser | null> {
  const user = await requireAuth(request, reply);
  if (!user) return null;
  const role = await membershipRole(user, companyId);
  if (!role) {
    await reply.code(403).send({ error: 'company_access_denied', companyId, requiredRole: minimumRole });
    return null;
  }
  if (!hasCompanyRole(role, minimumRole)) {
    await reply.code(403).send({ error: 'company_role_required', companyId, requiredRole: minimumRole, actualRole: role });
    return null;
  }
  return user;
}

export async function requireAnyVisibleCompany(request: FastifyRequest, reply: FastifyReply): Promise<{ user: AuthUser; companyIds: string[] } | null> {
  const user = await requireAuth(request, reply);
  if (!user) return null;
  const companyIds = await visibleCompanyIds(user);
  return { user, companyIds };
}

export async function requireVisibleCompany(request: FastifyRequest, reply: FastifyReply, companyId: string): Promise<AuthUser | null> {
  return requireCompanyRole(request, reply, companyId, 'viewer');
}
