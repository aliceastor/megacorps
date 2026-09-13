import { createHash, randomUUID } from 'node:crypto';
import { and, eq, isNull } from 'drizzle-orm';
import { agentReportRequestSchema, type AgentReport } from '@megacorps/shared';
import { db } from './db/client.ts';
import { agents, cardComments, departments, kanbanCards, positions, taskLogs, taskRuns } from './db/schema.ts';
import { lockResultAuthority } from './completion-guard.ts';
import { retryMergeGateWrite } from './db/merge-gate-write.ts';
import { SPLIT_MAX_ROUNDS } from './card-splitting.ts';
import { publishLiveEvent } from './live.ts';
import { sanitizeCompanyOutput } from './output-secrets.ts';

export type CollaborationRequest = Extract<NonNullable<AgentReport['request']>, { kind: 'collaboration' }>;
type Card = typeof kanbanCards.$inferSelect;
type Agent = typeof agents.$inferSelect;

/** Creates ordinary required children; collaboration never expands the reporting hierarchy. */
export async function processCollaborationRequest(
  card: Card,
  requester: Agent,
  input: CollaborationRequest,
  taskRunId?: string | null,
): Promise<{ created: string[]; errors: string[] }> {
  const parsed = agentReportRequestSchema.safeParse(input);
  if (!parsed.success || parsed.data.kind !== 'collaboration')
    return {
      created: [],
      errors: ['collaboration_request_invalid: Provide departmentSlug, question and nonempty acceptance criteria.'],
    };
  const request = await sanitizeCompanyOutput(card.companyId, parsed.data);
  const key =
    'collaboration:' +
    createHash('sha256')
      .update(JSON.stringify([card.companyId, card.id, requester.id, request]))
      .digest('hex');
  try {
    const result = await retryMergeGateWrite(() =>
      db.transaction(async (tx) => {
        const current = await lockResultAuthority(card, taskRunId, tx, requester.id);
        if (!current || current.assigneeId !== requester.id || requester.companyId !== current.companyId)
          throw new Error(
            'collaboration_authority_changed: Only the current owner of the original request card can request its collaboration child. Return to the owned card context.',
          );
        if (taskRunId) {
          const [run] = await tx.select().from(taskRuns).where(eq(taskRuns.id, taskRunId)).limit(1);
          if (run?.kind !== 'dispatch' || run.agentId !== requester.id || run.companyId !== current.companyId)
            throw new Error(
              'collaboration_dispatch_required: Submit the request from the original card owner task, not a reviewer or another message assignment.',
            );
        }
        const [previous] = await tx
          .select()
          .from(kanbanCards)
          .where(
            and(
              eq(kanbanCards.splitRequestKey, key),
              eq(kanbanCards.companyId, current.companyId),
              eq(kanbanCards.parentCardId, current.id),
            ),
          )
          .limit(1);
        if (previous) {
          if (previous.deletedAt || previous.columnStatus === 'cancelled')
            throw new Error(
              'collaboration_request_cancelled: This request was cancelled or deleted. Resolve its cancellation through the original card recovery flow before retrying it.',
            );
          return { child: previous, repeated: true };
        }
        const members = await tx
          .select()
          .from(agents)
          .where(and(eq(agents.companyId, current.companyId), isNull(agents.deletedAt)));
        const divisions = await tx.select().from(departments).where(eq(departments.companyId, current.companyId));
        const roles = await tx.select().from(positions).where(eq(positions.companyId, current.companyId));
        const actor = members.find((member) => member.id === requester.id);
        if (!actor || actor.isActive === false)
          throw new Error(
            'collaboration_requester_unavailable: Restore the original requesting agent before requesting collaboration.',
          );
        const actorRole = roles.find((role) => role.id === actor.positionId);
        if (actorRole?.isCompanyBoss)
          throw new Error(
            'collaboration_boss_assignment: Boss uses normal department child assignments; collaboration requests are for department Heads and Staff.',
          );
        const source = divisions.find((department) => department.id === actor.departmentId);
        const target = divisions.find((department) => department.slug === request.departmentSlug);
        if (!source)
          throw new Error(
            'collaboration_source_department_missing: The requesting owner needs a configured source department.',
          );
        if (!target)
          throw new Error(
            'collaboration_target_department_unknown: Choose a target department slug from this company.',
          );
        if (target.id === source.id)
          throw new Error(
            'collaboration_same_department: Use ordinary in-department work or delegation for this scope.',
          );
        const targetHead = members.find(
          (member) => member.id === target.headAgentId && member.departmentId === target.id,
        );
        const targetRole = roles.find((role) => role.id === targetHead?.positionId);
        if (
          !targetHead ||
          targetHead.isActive === false ||
          !targetRole?.isDepartmentHead ||
          targetRole.isActive === false
        )
          throw new Error(
            'collaboration_target_head_unavailable: Restore or assign the target department Head; collaboration cannot assign an arbitrary employee instead.',
          );
        if (current.decisionMode === 'solo')
          throw new Error(
            'collaboration_forbidden_solo: This card forbids child work. Request a mode change through the existing help flow.',
          );
        if (current.forceBrainstorm && !(current.brainstormRound ?? 0))
          throw new Error(
            'collaboration_brainstorm_required: Complete the explicitly required brainstorm before creating a child.',
          );
        const children = await tx
          .select()
          .from(kanbanCards)
          .where(and(eq(kanbanCards.parentCardId, current.id), isNull(kanbanCards.deletedAt)));
        if (children.some((child) => !['done', 'cancelled'].includes(child.columnStatus ?? 'todo')))
          throw new Error(
            'collaboration_round_in_progress: Wait for the current child round and integrate its accepted results before requesting another round.',
          );
        if ((current.splitRound ?? 0) >= SPLIT_MAX_ROUNDS)
          throw new Error(
            'collaboration_round_limit: The existing child-round limit has been reached. Use the original card recovery flow to resolve the remaining scope.',
          );
        const visited = new Set<string>();
        let cursor: Card | undefined = current;
        let depth = 0;
        const configuredDepth = Number(process.env.DELEGATION_MAX_DEPTH ?? 3);
        const maxDepth = Number.isFinite(configuredDepth) ? Math.max(1, configuredDepth) : 3;
        while (cursor) {
          if (visited.has(cursor.id) || visited.size >= 64)
            throw new Error(
              'collaboration_ancestor_cycle: The original card chain is invalid; repair it before requesting collaboration.',
            );
          visited.add(cursor.id);
          if (cursor.departmentId === target.id)
            throw new Error(
              'collaboration_department_cycle: This request would return work to a department already waiting in its ancestor chain. Resolve the scope with the original owner instead.',
            );
          if (cursor.splitRequestKey?.startsWith('collaboration:')) depth++;
          if (depth >= maxDepth)
            throw new Error(
              'collaboration_depth_limit: The existing delegation depth limit has been reached. Resolve the scope through the original owner.',
            );
          cursor = cursor.parentCardId
            ? (
                await tx
                  .select()
                  .from(kanbanCards)
                  .where(
                    and(
                      eq(kanbanCards.id, cursor.parentCardId),
                      eq(kanbanCards.companyId, current.companyId),
                      isNull(kanbanCards.deletedAt),
                    ),
                  )
                  .limit(1)
              )[0]
            : undefined;
        }
        const sourceHead = members.find(
          (member) => member.id === source.headAgentId && member.departmentId === source.id,
        );
        const headRequest = sourceHead?.id === actor.id;
        const reviewerIds = [
          ...new Set(
            [sourceHead?.id, headRequest ? undefined : actor.id].filter((id): id is string =>
              Boolean(id && id !== targetHead.id),
            ),
          ),
        ];
        const reviewerId = reviewerIds[0] ?? null;
        const childId = randomUUID();
        const metadata = {
          sourceCardId: current.id,
          requesterAgentId: actor.id,
          sourceDepartmentId: source.id,
          targetDepartmentId: target.id,
          requestedReviewerIds: reviewerIds,
          sourceTaskRunId: taskRunId ?? null,
        };
        const [child] = await tx
          .insert(kanbanCards)
          .values({
            id: childId,
            companyId: current.companyId,
            projectId: current.projectId,
            goalId: current.goalId,
            parentCardId: current.id,
            departmentId: target.id,
            title: `${source.name} → ${target.name}: ${current.title}`.slice(0, 200),
            body: `Cross-department collaboration requested by ${actor.name} from original card ${current.id}.\n\n## Scope\n${request.question}\n\n## Acceptance\n${request.acceptance.map((item) => '- ' + item).join('\n')}\n\n## Return\nReturn the accepted artifacts and verification to the original card. Preserve its scope and original owner.`,
            assigneeId: targetHead.id,
            reviewerId,
            reviewerIds,
            reviewMode: !headRequest || current.critical ? 'panel' : 'single',
            critical: current.critical ?? false,
            columnStatus: 'todo',
            priority: current.priority,
            decisionMode: 'auto',
            splitRequestKey: key,
            childRequirementLevel: 'required',
            requiredChildPolicy: 'all_required_accepted',
            maxRetries: current.maxRetries,
            timeoutSeconds: current.timeoutSeconds,
            createdBy: current.createdBy,
          })
          .returning();
        if (!child) throw new Error('collaboration_child_insert_failed');
        await tx.insert(cardComments).values([
          {
            cardId: child.id,
            authorType: 'system',
            agentId: actor.id,
            action: 'collaboration_requested',
            body: `Requested by ${actor.name} on original card ${current.id}; assigned to ${targetHead.name}. Reviewers: ${reviewerIds.map((id) => members.find((member) => member.id === id)?.name ?? id).join(', ')}. Existing reviewer-shortage downgrade rules apply.`,
            metadata,
            deduplicationKey: key + ':child',
          },
          {
            cardId: current.id,
            authorType: 'system',
            agentId: actor.id,
            action: 'collaboration_requested',
            body: `Collaboration child ${child.id} is assigned to ${targetHead.name}. Accepted results return here to ${actor.name}.`,
            metadata: { ...metadata, childCardId: child.id },
            deduplicationKey: key + ':source',
          },
        ]);
        await tx
          .insert(taskLogs)
          .values({
            cardId: current.id,
            agentId: actor.id,
            type: 'children',
            status: 'queued',
            message: `Waiting for collaboration child ${child.id}; original owner and card remain unchanged.`,
          });
        await tx
          .update(kanbanCards)
          .set({
            splitRound: (current.splitRound ?? 0) + 1,
            requiredChildPolicy:
              current.requiredChildPolicy && current.requiredChildPolicy !== 'manual'
                ? current.requiredChildPolicy
                : 'all_required_accepted',
            rollupStatus: 'waiting_on_children',
            updatedAt: new Date(),
          })
          .where(eq(kanbanCards.id, current.id));
        return { child, repeated: false };
      }),
    );
    if (!result.repeated) {
      publishLiveEvent({
        type: 'card.created',
        companyId: card.companyId,
        entityType: 'card',
        entityId: result.child.id,
        cardId: result.child.id,
        projectId: card.projectId,
        action: 'collaboration.requested',
      });
      publishLiveEvent({
        type: 'card.updated',
        companyId: card.companyId,
        entityType: 'card',
        entityId: card.id,
        cardId: card.id,
        projectId: card.projectId,
        action: 'collaboration.waiting',
      });
    }
    return { created: [result.child.id], errors: [] };
  } catch (error) {
    return { created: [], errors: [error instanceof Error ? error.message : 'collaboration_request_failed'] };
  }
}
