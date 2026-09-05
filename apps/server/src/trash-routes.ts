import { retryMergeGateWrite } from './db/merge-gate-write.ts';
import { and, desc, eq, inArray, isNotNull, isNull } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { requireAnyVisibleCompany, requireCompanyRole } from './access.ts';
import { db } from './db/client.ts';
import { activityLog, agents, kanbanCards, machineRunners, projects } from './db/schema.ts';
import { publishLiveEvent } from './live.ts';

// Cards, agents, runtimes, and projects are all archived rather than destroyed,
// but until now nothing could read a deleted row back out — the data sat in the
// database with no way to reach it. These routes are that way back.

export const trashEntityTypes = ['card', 'project', 'agent', 'machineRunner'] as const;
export type TrashEntityType = (typeof trashEntityTypes)[number];

const trashQuerySchema = z.object({
  companyId: z.string().uuid().optional(),
  type: z.enum(trashEntityTypes).optional(),
  limit: z.coerce.number().int().min(1).max(300).default(100),
});

const trashRestoreSchema = z.object({
  type: z.enum(trashEntityTypes),
  id: z.string().uuid(),
});

export type TrashItem = {
  type: TrashEntityType;
  id: string;
  companyId: string;
  label: string;
  detail: string | null;
  deletedAt: Date | null;
};

export async function listTrash(companyIds: string[], options: { companyId?: string; type?: TrashEntityType; limit: number }): Promise<TrashItem[]> {
  if (companyIds.length === 0) return [];
  const scope = options.companyId ? [options.companyId] : companyIds;
  const wanted = (type: TrashEntityType) => !options.type || options.type === type;
  const items: TrashItem[] = [];

  if (wanted('card')) {
    const rows = await db.select({ id: kanbanCards.id, companyId: kanbanCards.companyId, title: kanbanCards.title, status: kanbanCards.columnStatus, deletedAt: kanbanCards.deletedAt })
      .from(kanbanCards).where(and(inArray(kanbanCards.companyId, scope), isNotNull(kanbanCards.deletedAt)))
      .orderBy(desc(kanbanCards.deletedAt)).limit(options.limit);
    items.push(...rows.map((row) => ({ type: 'card' as const, id: row.id, companyId: row.companyId, label: row.title, detail: `stage ${row.status ?? 'todo'}`, deletedAt: row.deletedAt })));
  }
  if (wanted('project')) {
    const rows = await db.select({ id: projects.id, companyId: projects.companyId, name: projects.name, description: projects.description, deletedAt: projects.deletedAt })
      .from(projects).where(and(inArray(projects.companyId, scope), isNotNull(projects.deletedAt)))
      .orderBy(desc(projects.deletedAt)).limit(options.limit);
    items.push(...rows.map((row) => ({ type: 'project' as const, id: row.id, companyId: row.companyId, label: row.name, detail: row.description?.slice(0, 200) ?? null, deletedAt: row.deletedAt })));
  }
  if (wanted('agent')) {
    const rows = await db.select({ id: agents.id, companyId: agents.companyId, name: agents.name, slug: agents.slug, deletedAt: agents.deletedAt })
      .from(agents).where(and(inArray(agents.companyId, scope), isNotNull(agents.deletedAt)))
      .orderBy(desc(agents.deletedAt)).limit(options.limit);
    items.push(...rows.map((row) => ({ type: 'agent' as const, id: row.id, companyId: row.companyId, label: row.name, detail: `slug ${row.slug}`, deletedAt: row.deletedAt })));
  }
  if (wanted('machineRunner')) {
    const rows = await db.select({ id: machineRunners.id, companyId: machineRunners.companyId, name: machineRunners.name, slug: machineRunners.slug, status: machineRunners.status, deletedAt: machineRunners.deletedAt })
      .from(machineRunners).where(and(inArray(machineRunners.companyId, scope), isNotNull(machineRunners.deletedAt)))
      .orderBy(desc(machineRunners.deletedAt)).limit(options.limit);
    items.push(...rows.filter((row) => row.companyId).map((row) => ({ type: 'machineRunner' as const, id: row.id, companyId: row.companyId as string, label: row.name, detail: `slug ${row.slug} / ${row.status}`, deletedAt: row.deletedAt })));
  }

  return items.sort((a, b) => (b.deletedAt?.getTime() ?? 0) - (a.deletedAt?.getTime() ?? 0)).slice(0, options.limit);
}

// Agents and runtimes are unique on (companyId, slug), so a name freed up after
// deletion may already be taken. Report that instead of failing on a constraint.
async function slugTaken(type: 'agent' | 'machineRunner', companyId: string, slugValue: string, selfId: string): Promise<boolean> {
  if (type === 'agent') {
    const rows = await db.select({ id: agents.id }).from(agents)
      .where(and(eq(agents.companyId, companyId), eq(agents.slug, slugValue), isNull(agents.deletedAt))).limit(1);
    return Boolean(rows[0] && rows[0].id !== selfId);
  }
  const rows = await db.select({ id: machineRunners.id }).from(machineRunners)
    .where(and(eq(machineRunners.companyId, companyId), eq(machineRunners.slug, slugValue), isNull(machineRunners.deletedAt))).limit(1);
  return Boolean(rows[0] && rows[0].id !== selfId);
}

export async function registerTrashRoutes(app: FastifyInstance): Promise<void> {
  app.get('/api/trash', async (request, reply) => {
    const access = await requireAnyVisibleCompany(request, reply); if (!access) return reply;
    const query = trashQuerySchema.parse(request.query);
    if (query.companyId && !access.companyIds.includes(query.companyId)) return [];
    return listTrash(access.companyIds, query);
  });

  app.post('/api/trash/restore', async (request, reply) => {
    const input = trashRestoreSchema.parse(request.body);
    const now = new Date();

    if (input.type === 'card') {
      const [existing] = await db.select().from(kanbanCards).where(eq(kanbanCards.id, input.id)).limit(1);
      if (!existing) return reply.code(404).send({ error: 'card_not_found' });
      if (!existing.deletedAt) return reply.code(409).send({ error: 'card_not_deleted' });
      const user = await requireCompanyRole(request, reply, existing.companyId, 'operator'); if (!user) return reply;
      // A card restored into an archived project would be invisible again, so
      // say so rather than appearing to succeed.
      if (existing.projectId) {
        const [project] = await db.select({ deletedAt: projects.deletedAt, name: projects.name }).from(projects).where(eq(projects.id, existing.projectId)).limit(1);
        if (project?.deletedAt) return reply.code(409).send({ error: 'project_archived', detail: `Restore the project "${project.name}" first.` });
      }
      // Restore into a resting stage: the run that was cancelled on delete is
      // gone, so resuming mid-flight would strand the card.
      const restingStatus = existing.columnStatus === 'in_progress' ? 'todo' : existing.columnStatus ?? 'todo';
      const [card] = await db.update(kanbanCards).set({ deletedAt: null, columnStatus: restingStatus, updatedAt: now }).where(eq(kanbanCards.id, input.id)).returning();
      await db.insert(activityLog).values({ companyId: existing.companyId, actorType: 'user', actorId: user.id, userId: user.id, action: 'card.restored', entityType: 'card', entityId: input.id, details: { title: existing.title, stage: restingStatus } });
      publishLiveEvent({ type: 'card.created', companyId: existing.companyId, entityType: 'card', entityId: input.id, cardId: input.id, projectId: existing.projectId });
      return { ok: true, type: 'card', item: card };
    }

    if (input.type === 'project') {
      const [existing] = await db.select().from(projects).where(eq(projects.id, input.id)).limit(1);
      if (!existing) return reply.code(404).send({ error: 'project_not_found' });
      if (!existing.deletedAt) return reply.code(409).send({ error: 'project_not_deleted' });
      const user = await requireCompanyRole(request, reply, existing.companyId, 'operator'); if (!user) return reply;
      const [project] = await retryMergeGateWrite(() => db.update(projects).set({ deletedAt: null, updatedAt: now }).where(eq(projects.id, input.id)).returning());
      await db.insert(activityLog).values({ companyId: existing.companyId, actorType: 'user', actorId: user.id, userId: user.id, action: 'project.restored', entityType: 'project', entityId: input.id, details: { name: existing.name } });
      publishLiveEvent({ type: 'project.updated', companyId: existing.companyId, entityType: 'project', entityId: input.id });
      return { ok: true, type: 'project', item: project };
    }

    if (input.type === 'agent') {
      const [existing] = await db.select().from(agents).where(eq(agents.id, input.id)).limit(1);
      if (!existing) return reply.code(404).send({ error: 'agent_not_found' });
      if (!existing.deletedAt) return reply.code(409).send({ error: 'agent_not_deleted' });
      const user = await requireCompanyRole(request, reply, existing.companyId, 'operator'); if (!user) return reply;
      if (await slugTaken('agent', existing.companyId, existing.slug, existing.id)) {
        return reply.code(409).send({ error: 'agent_slug_taken', slug: existing.slug, detail: `An active agent already uses the slug "${existing.slug}". Rename it before restoring this one.` });
      }
      // Restore idle: whatever it was busy with when archived is long finished.
      const [agent] = await db.update(agents).set({ deletedAt: null, isBusy: false }).where(eq(agents.id, input.id)).returning();
      await db.insert(activityLog).values({ companyId: existing.companyId, actorType: 'user', actorId: user.id, userId: user.id, agentId: input.id, action: 'agent.restored', entityType: 'agent', entityId: input.id, details: { name: existing.name, slug: existing.slug } });
      publishLiveEvent({ type: 'agent.updated', companyId: existing.companyId, entityType: 'agent', entityId: input.id });
      return { ok: true, type: 'agent', item: agent };
    }

    const [existing] = await db.select().from(machineRunners).where(eq(machineRunners.id, input.id)).limit(1);
    if (!existing) return reply.code(404).send({ error: 'machine_runner_not_found' });
    if (!existing.deletedAt) return reply.code(409).send({ error: 'machine_runner_not_deleted' });
    if (!existing.companyId) return reply.code(400).send({ error: 'machine_runner_company_missing' });
    const user = await requireCompanyRole(request, reply, existing.companyId, 'operator'); if (!user) return reply;
    if (existing.slug && await slugTaken('machineRunner', existing.companyId, existing.slug, existing.id)) {
      return reply.code(409).send({ error: 'machine_runner_slug_taken', slug: existing.slug, detail: `An active machine runner already uses the slug "${existing.slug}". Rename it before restoring this one.` });
    }
    const [runtime] = await db.update(machineRunners).set({ deletedAt: null, updatedAt: now }).where(eq(machineRunners.id, input.id)).returning();
    await db.insert(activityLog).values({ companyId: existing.companyId, actorType: 'user', actorId: user.id, userId: user.id, action: 'machine_runner.restored', entityType: 'machineRunner', entityId: input.id, details: { name: existing.name } });
    publishLiveEvent({ type: 'machine_runner.updated', companyId: existing.companyId, entityType: 'machineRunner', entityId: input.id });
    return { ok: true, type: 'machineRunner', item: runtime };
  });
}
