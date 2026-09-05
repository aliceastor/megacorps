import { randomUUID } from 'node:crypto';
import { agents, companies, departments, positions } from '../db/schema.ts';
import type { memoryDb } from './memory-db.ts';

/** Explicit minimum structure for tests whose subject is an unrelated member run. */
export function readyCompany(state: ReturnType<typeof memoryDb>, companyId: string) {
  const bossId = randomUUID(), headId = randomUUID(), departmentId = randomUUID(), positionId = randomUUID();
  state.rows(companies).push({ id: companyId, name: 'Fixture company' });
  state.rows(positions).push({ id: positionId, companyId, name: 'Boss', isCompanyBoss: true });
  state.rows(departments).push({ id: departmentId, companyId, name: 'Fixture department', headAgentId: headId });
  state.rows(agents).push({ id: bossId, companyId, name: 'Boss', slug: 'fixture-boss', positionId, adapterType: 'webhook', isActive: true, isBusy: false }, { id: headId, companyId, name: 'Head', slug: 'fixture-head', departmentId, adapterType: 'webhook', isActive: true, isBusy: false });
  return { bossId, headId, departmentId, positionId };
}
