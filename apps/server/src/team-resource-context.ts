import { and, eq, inArray, isNull, sql } from 'drizzle-orm';
import { db } from './db/client.ts';
import { agentReviewScores, kanbanCards } from './db/schema.ts';
import { structuralAssignment } from './company-workflow.ts';
import { CV_WINDOW, TEAM_DIRECTORY_LIMIT, formatTeamResourceView, summarizeCv, type TeamMemberView } from './agent-cv.ts';

/** Read-only, company-scoped directory. Delegation availability remains owned by structuralAssignment. */
export async function buildTeamResourceContext(companyId: string, viewerId: string): Promise<string> {
  const assignment = await structuralAssignment(companyId, viewerId);
  if (!assignment.members.some(member => member.id === viewerId)) return '';
  const available = new Set(assignment.available.map(member => member.id));
  const roster = [...assignment.members].sort((a, b) => Number(b.id === viewerId) - Number(a.id === viewerId)
    || Number(available.has(b.id)) - Number(available.has(a.id)) || a.slug.localeCompare(b.slug));
  const shown = roster.slice(0, TEAM_DIRECTORY_LIMIT);
  const ids = shown.map(member => member.id);
  const liveRows = await db.select({ assigneeId: kanbanCards.assigneeId, count: sql<number>`count(*)::int` }).from(kanbanCards)
    .where(and(eq(kanbanCards.companyId, companyId), inArray(kanbanCards.assigneeId, ids), isNull(kanbanCards.deletedAt), inArray(kanbanCards.columnStatus, ['todo', 'in_progress', 'in_review', 'needs_review', 'waiting_on_external', 'waiting_on_client', 'waiting_on_brainstorm'])))
    .groupBy(kanbanCards.assigneeId);
  // One set-based read supplies every displayed member's complete domain windows
  // and lifetime count. Rank only after applying tenant + visible-member scope.
  const rankedScores = await db.execute<{
    id: string; agentId: string; cardId: string; reviewerId: string | null;
    domain: string; score: number; verdict: string; createdAt: string | Date | null; scoreCount: number | string;
  }>(sql`
    SELECT * FROM (
      SELECT id, agent_id AS "agentId", card_id AS "cardId", reviewer_id AS "reviewerId",
        domain, score, verdict, created_at AS "createdAt",
        count(*) OVER (PARTITION BY agent_id) AS "scoreCount",
        row_number() OVER (PARTITION BY agent_id, domain ORDER BY created_at DESC NULLS LAST, id DESC) AS domain_rank
      FROM ${agentReviewScores}
      WHERE ${and(eq(agentReviewScores.companyId, companyId), inArray(agentReviewScores.agentId, ids))}
    ) AS team_ranked_scores
    WHERE domain_rank <= ${CV_WINDOW}
    ORDER BY "agentId", "createdAt" DESC NULLS LAST, id DESC
  `);
  const scoresByAgent = new Map<string, Array<(typeof rankedScores)[number] & { createdAt: Date | null }>>();
  for (const row of rankedScores) {
    const list = scoresByAgent.get(row.agentId) ?? [];
    list.push({ ...row, createdAt: row.createdAt ? new Date(row.createdAt) : null });
    scoresByAgent.set(row.agentId, list);
  }
  const members: TeamMemberView[] = [];
  for (const member of shown) {
    // The first three rows in the union of latest-twenty domain windows are
    // also this person's latest three scores across all domains.
    const scores = scoresByAgent.get(member.id) ?? [];
    const boss = assignment.members.find(person => person.id === member.bossId);
    members.push({
      id: member.id, name: member.name, slug: member.slug,
      positionName: assignment.roles.find(position => position.id === member.positionId)?.name ?? null,
      departmentName: assignment.divisions.find(department => department.id === member.departmentId)?.name ?? null,
      bossName: boss?.name ?? null, bossId: boss?.id ?? null,
      isActive: member.isActive !== false, eligibleForDelegation: available.has(member.id),
      capabilities: member.capabilities ?? [], liveCards: Number(liveRows.find(row => row.assigneeId === member.id)?.count ?? 0),
      isBusy: Boolean(member.isBusy), maxConcurrent: member.maxConcurrent ?? 1,
      cv: summarizeCv(scores), scoreCount: Number(scores[0]?.scoreCount ?? 0),
      recentScores: scores.slice(0, 3).map(score => ({ ...score, reviewerName: assignment.members.find(person => person.id === score.reviewerId)?.name ?? null })),
    });
  }
  return formatTeamResourceView(members, { totalMembers: roster.length, eligibleSlugs: assignment.available.map(member => member.slug) });
}
