import { randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';

const approvedReport = JSON.stringify({ kind: 'megacorps-report', status: 'completed', verdict: 'approved', summary: 'A separate reviewer inspected the exact candidate.' });

export async function seedManagerMergeReview(companyId: string, projectId: string, cardId: string, headSha: string) {
  const { db } = await import('../db/client.ts');
  const { agents, departments, kanbanCards, positions, taskRuns } = await import('../db/schema.ts');
  const suffix = randomUUID();
  const [department] = await db.insert(departments).values({ companyId, name: 'Merge Engineering', slug: `merge-engineering-${suffix}` }).returning();
  const [bossPosition] = await db.insert(positions).values({ companyId, name: 'Merge Boss', slug: `merge-boss-${suffix}`, rank: 0, isCompanyBoss: true, isCompanyLeadership: true, defaultDepartmentId: null }).returning();
  const [staffPosition] = await db.insert(positions).values({ companyId, name: 'Merge Staff', slug: `merge-staff-${suffix}`, rank: 2, defaultDepartmentId: department!.id, managerPositionId: bossPosition!.id }).returning();
  const [boss] = await db.insert(agents).values({ companyId, positionId: bossPosition!.id, slug: `merge-boss-${suffix}`, name: 'Merge Boss', role: 'manager', giteaUsername: `merge-boss-${suffix}`, isActive: true }).returning();
  const [author] = await db.insert(agents).values({ companyId, departmentId: department!.id, positionId: staffPosition!.id, slug: `merge-author-${suffix}`, name: 'Merge Author', role: 'worker', bossId: boss!.id, giteaUsername: `merge-author-${suffix}`, isActive: true }).returning();
  const [reviewer] = await db.insert(agents).values({ companyId, departmentId: department!.id, positionId: staffPosition!.id, slug: `merge-reviewer-${suffix}`, name: 'Merge Reviewer', role: 'worker', bossId: boss!.id, giteaUsername: `merge-reviewer-${suffix}`, isActive: true }).returning();
  const identity = { id: randomUUID(), scope: randomUUID(), projectId, repoUrl: 'https://gitea.test/org/repo', defaultBranch: 'main', headSha, externalId: '12', candidateKey: '["v2","pull_request",12]', capturedAt: new Date().toISOString() };
  await db.update(kanbanCards).set({ departmentId: department!.id, assigneeId: author!.id, reviewerId: reviewer!.id, reviewIdentity: identity }).where(eq(kanbanCards.id, cardId));
  await db.insert(taskRuns).values({ id: identity.scope, companyId, cardId, agentId: reviewer!.id, kind: 'review', status: 'success', reviewIdentity: identity, output: approvedReport });
  return { boss: boss!, author: author!, reviewer: reviewer!, department: department!, identity };
}

export async function authorizeManagerMerge(companyId: string, bossId: string, intent: { id: string; headSha: string }) {
  const { requestManagerMerge } = await import('../manager-merge.ts');
  return requestManagerMerge(
    { companyId, agentId: bossId, source: 'management' },
    { action: 'merge_pr', intentId: intent.id, headSha: intent.headSha, reason: 'Independent review accepted the exact candidate and all completion gates are satisfied.' },
  );
}
