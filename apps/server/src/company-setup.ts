import { createHash } from 'node:crypto';
import { and, eq, isNull, sql } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { db } from './db/client.ts';
import {
  companies,
  companyMemberships,
  positions,
  agents,
  departments,
  agentRuntimes,
  activityLog,
  type CompanySetupDraft,
} from './db/schema.ts';
import { requireCompanyRole } from './access.ts';
import { requireRole } from './auth.ts';
import { CEO_POSITION_PROMPT } from './role-playbooks.ts';
import { companyExecutionReadiness } from './company-workflow.ts';
import { fetchAgentCard } from './a2a-client.ts';
import { assertAdapterTargetAllowed } from './adapters/config.ts';

type Store = Pick<typeof db, 'select' | 'insert' | 'update' | 'execute'>;
const text = z.string().trim().min(1).max(200);
const slug = z
  .string()
  .trim()
  .min(1)
  .max(80)
  .regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/);
const startInput = z.object({
  setupKey: z.string().uuid(),
  name: text,
  slug,
  mission: z.string().max(10000).optional(),
});
const stepInput = z.discriminatedUnion('step', [
  z.object({ step: z.literal('company'), name: text, slug, mission: z.string().max(10000).optional() }),
  z.object({
    step: z.literal('boss'),
    name: text,
    slug,
    agentId: z.string().uuid().optional(),
    prompt: z.string().max(8000).optional(),
  }),
  z.object({
    step: z.literal('department'),
    name: text,
    slug,
    description: z.string().max(10000).optional(),
  }),
  z.object({
    step: z.literal('head'),
    name: text,
    slug,
    agentId: z.string().uuid().optional(),
    prompt: z.string().max(8000).optional(),
  }),
  z.object({
    step: z.literal('runtime'),
    runtimeId: z.string().uuid().optional(),
    name: text.optional(),
    a2aBaseUrl: z.string().url().optional(),
  }),
  z.object({ step: z.literal('finish') }),
]);
function databaseCode(error: unknown): string | undefined {
  let current = error;
  for (let depth = 0; depth < 4 && current && typeof current === 'object'; depth++) {
    const value = current as { code?: string; cause?: unknown };
    if (value.code) return value.code;
    current = value.cause;
  }
  return undefined;
}
function failure(message: string, statusCode = 400): never {
  throw Object.assign(new Error(message), { statusCode });
}

async function setupState(store: Store, companyId: string) {
  const [company] = await store.select().from(companies).where(eq(companies.id, companyId)).limit(1);
  if (!company) failure('company_not_found', 404);
  const roles = await store.select().from(positions).where(eq(positions.companyId, companyId));
  const members = await store
    .select()
    .from(agents)
    .where(and(eq(agents.companyId, companyId), isNull(agents.deletedAt)));
  const divisions = await store.select().from(departments).where(eq(departments.companyId, companyId));
  const draft: CompanySetupDraft = { ...(company.setupDraft ?? {}) };
  const boss =
    members.find((a) => a.id === draft.bossId) ??
    members.find((a) => roles.some((p) => p.id === a.positionId && p.isCompanyBoss));
  const department =
    divisions.find((d) => d.id === draft.departmentId) ??
    divisions.find((d) => d.headAgentId) ??
    divisions[0];
  const head = members.find((a) => a.id === (draft.headId ?? department?.headAgentId));
  if (boss) draft.bossId = boss.id;
  if (department) draft.departmentId = department.id;
  if (head) draft.headId = head.id;
  return { company, draft, boss, department, head, roles, members, divisions };
}
function publicState(state: Awaited<ReturnType<typeof setupState>>) {
  const agent = (row: typeof agents.$inferSelect | undefined) =>
    row
      ? {
          id: row.id,
          name: row.name,
          slug: row.slug,
          departmentId: row.departmentId,
          runtimeId: row.runtimeId,
          adapterType: row.adapterType,
        }
      : null;
  return {
    company: state.company,
    draft: state.draft,
    boss: agent(state.boss),
    department: state.department ?? null,
    head: agent(state.head),
  };
}
async function runtimeSnapshot(store: Store, agentId: string) {
  const [agent] = await store
    .select()
    .from(agents)
    .where(and(eq(agents.id, agentId), isNull(agents.deletedAt)))
    .limit(1);
  const [runtime] = agent?.runtimeId
    ? await store.select().from(agentRuntimes).where(eq(agentRuntimes.id, agent.runtimeId)).limit(1)
    : [];
  if (
    !agent ||
    !runtime ||
    runtime.companyId !== agent.companyId ||
    runtime.isActive === false ||
    agent.adapterType !== runtime.adapterType
  )
    return null;
  const fingerprint = createHash('sha256')
    .update(
      JSON.stringify({
        agentId,
        runtimeId: runtime.id,
        adapterType: agent.adapterType,
        profile: agent.hermesProfile,
        config: agent.adapterConfig,
        runtimeConfig: runtime.config,
        runtimeUpdatedAt: runtime.updatedAt,
      }),
    )
    .digest('hex');
  return { agent, runtime, fingerprint };
}
export async function recordSetupConnectionCheck(
  agentId: string,
  fingerprint: string,
  success: boolean,
  method: 'probe' | 'execution',
) {
  const snapshot = await runtimeSnapshot(db, agentId);
  if (!snapshot || snapshot.fingerprint !== fingerprint) return;
  await db.transaction(async (tx) => {
    const [company] = await tx
      .select()
      .from(companies)
      .where(eq(companies.id, snapshot.agent.companyId))
      .for('update');
    if (!company?.setupDraft) return;
    const draft = {
      ...company.setupDraft,
      connectionChecks: {
        ...company.setupDraft.connectionChecks,
        [agentId]: { fingerprint, checkedAt: new Date().toISOString(), success, method },
      },
    };
    await tx.update(companies).set({ setupDraft: draft }).where(eq(companies.id, company.id));
  });
}
export async function setupConnectionFingerprint(agentId: string) {
  return (await runtimeSnapshot(db, agentId))?.fingerprint ?? null;
}
async function connectionIssues(store: Store, state: Awaited<ReturnType<typeof setupState>>) {
  const issues: string[] = [];
  for (const agent of [state.boss, state.head]) {
    if (!agent) continue;
    const current = await runtimeSnapshot(store, agent.id);
    const check = state.draft.connectionChecks?.[agent.id];
    if (
      !current ||
      !check?.success ||
      current.fingerprint !== check.fingerprint ||
      Date.now() - Date.parse(check.checkedAt) > 15 * 60_000
    )
      issues.push(`Check the current runtime connection for ${agent.name}.`);
  }
  return issues;
}

export async function registerCompanySetupRoutes(app: FastifyInstance) {
  app.post('/api/company-setup', async (request, reply) => {
    const user = await requireRole(request, reply, 'operator');
    if (!user) return reply;
    const input = startInput.parse(request.body);
    try {
      const result = await db.transaction(async (tx) => {
        await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtextextended(${input.setupKey}, 0))`);
        const [existing] = await tx
          .select()
          .from(companies)
          .where(eq(companies.setupKey, input.setupKey))
          .limit(1);
        if (existing) {
          const [membership] = await tx
            .select()
            .from(companyMemberships)
            .where(
              and(
                eq(companyMemberships.companyId, existing.id),
                eq(companyMemberships.userId, user.id),
                eq(companyMemberships.status, 'active'),
              ),
            )
            .limit(1);
          if (!membership || !['admin', 'operator'].includes(membership.role))
            failure('company_access_denied', 403);
          return publicState(await setupState(tx, existing.id));
        }
        const [company] = await tx
          .insert(companies)
          .values({
            setupKey: input.setupKey,
            name: input.name,
            slug: input.slug,
            mission: input.mission ?? null,
            autoDispatchEnabled: false,
            setupDraft: { stage: 'boss' },
          })
          .returning();
        if (!company) failure('company_create_failed', 500);
        await tx
          .insert(companyMemberships)
          .values({ companyId: company.id, userId: user.id, role: 'admin', status: 'active' });
        await tx
          .insert(positions)
          .values({
            companyId: company.id,
            name: 'Boss',
            slug: 'boss',
            prompt: CEO_POSITION_PROMPT,
            rank: 0,
            isCompanyBoss: true,
            canDelegateAcrossDepartments: true,
            isActive: true,
          });
        await tx
          .insert(activityLog)
          .values({
            companyId: company.id,
            actorType: 'user',
            actorId: user.id,
            userId: user.id,
            action: 'company.created',
            entityType: 'company',
            entityId: company.id,
            details: { name: company.name },
          });
        return publicState(await setupState(tx, company.id));
      });
      return reply.code(201).send(result);
    } catch (error) {
      if (databaseCode(error) === '23505')
        return reply
          .code(409)
          .send({
            error: 'setup_slug_taken',
            message: 'This slug is already used. Choose a different slug and save again.',
          });
      throw error;
    }
  });
  app.get('/api/companies/:id/setup', async (request, reply) => {
    const id = z
      .string()
      .uuid()
      .parse((request.params as { id: string }).id);
    const user = await requireCompanyRole(request, reply, id, 'operator');
    if (!user) return reply;
    const state = await setupState(db, id);
    return {
      ...publicState(state),
      readiness: await companyExecutionReadiness(id),
      connectionIssues: await connectionIssues(db, state),
    };
  });
  app.put('/api/companies/:id/setup', async (request, reply) => {
    const id = z
      .string()
      .uuid()
      .parse((request.params as { id: string }).id);
    const user = await requireCompanyRole(request, reply, id, 'operator');
    if (!user) return reply;
    const input = stepInput.parse(request.body);
    // No network work under setup locks. This is configuration/admission readiness only.
    const readiness = input.step === 'finish' ? await companyExecutionReadiness(id) : null;
    try {
      return await db.transaction(async (tx) => {
        await tx.select().from(companies).where(eq(companies.id, id)).for('update');
        const state = await setupState(tx, id);
        const draft = state.draft;
        if (input.step === 'company') {
          await tx
            .update(companies)
            .set({ name: input.name, slug: input.slug, mission: input.mission, autoDispatchEnabled: false })
            .where(eq(companies.id, id));
          draft.stage = 'boss';
        } else if (input.step === 'boss' || input.step === 'head') {
          const bossStep = input.step === 'boss';
          if (!bossStep && (!state.boss || !state.department))
            failure('setup_create_boss_and_department_first');
          const existing = bossStep ? state.boss : state.head;
          const selected = input.agentId ? state.members.find((a) => a.id === input.agentId) : existing;
          if (input.agentId && !selected) failure('agent_company_mismatch');
          if (bossStep && selected && state.divisions.some((d) => d.headAgentId === selected.id))
            failure('boss_and_head_must_be_distinct');
          if (
            !bossStep &&
            selected &&
            state.roles.some((p) => p.id === selected.positionId && p.isCompanyBoss)
          )
            failure('boss_and_head_must_be_distinct');
          if (!bossStep && selected?.id === state.boss?.id) failure('boss_and_head_must_be_distinct');
          if (bossStep && existing && selected?.id !== existing.id)
            failure('existing_boss_configured_use_agent_editor');
          if (!bossStep && selected?.departmentId && selected.departmentId !== state.department?.id)
            failure('head_department_mismatch');
          let position = state.roles.find((p) =>
            bossStep ? p.isCompanyBoss : !p.isCompanyBoss && p.slug === 'department-head',
          );
          if (!position)
            [position] = await tx
              .insert(positions)
              .values({
                companyId: id,
                name: bossStep ? 'Boss' : 'Department head',
                slug: bossStep ? 'boss' : 'department-head',
                isCompanyBoss: bossStep,
                rank: bossStep ? 0 : 10,
                prompt: bossStep ? CEO_POSITION_PROMPT : null,
                isActive: true,
              })
              .returning();
          const values = {
            name: input.name,
            slug: input.slug,
            positionId: position!.id,
            departmentId: bossStep ? null : state.department!.id,
            bossId: bossStep ? null : state.boss!.id,
          };
          const [saved] = selected
            ? await tx.update(agents).set(values).where(eq(agents.id, selected.id)).returning()
            : await tx
                .insert(agents)
                .values({
                  ...values,
                  companyId: id,
                  role: bossStep ? 'Boss' : 'Department head',
                  adapterType: 'a2a',
                  runtimeId: null,
                  adapterConfig: {},
                  isActive: true,
                })
                .returning();
          if (!saved) failure('agent_save_failed', 500);
          if (bossStep) {
            draft.bossId = saved.id;
            draft.stage = 'department';
            if (input.prompt !== undefined)
              await tx
                .update(companies)
                .set({ bossRolePrompt: input.prompt || null })
                .where(eq(companies.id, id));
          } else {
            draft.headId = saved.id;
            draft.stage = 'runtime';
            await tx
              .update(departments)
              .set({
                headAgentId: saved.id,
                ...(input.prompt !== undefined ? { headRolePrompt: input.prompt || null } : {}),
              })
              .where(eq(departments.id, state.department!.id));
          }
        } else if (input.step === 'department') {
          if (!state.boss) failure('setup_create_boss_first');
          const values = { name: input.name, slug: input.slug, description: input.description };
          const [saved] = state.department
            ? await tx
                .update(departments)
                .set(values)
                .where(eq(departments.id, state.department.id))
                .returning()
            : await tx
                .insert(departments)
                .values({ ...values, companyId: id })
                .returning();
          draft.departmentId = saved!.id;
          draft.stage = 'head';
        } else if (input.step === 'runtime') {
          const requested = input.runtimeId ?? (input.a2aBaseUrl ? draft.runtimeId : undefined);
          let [runtime] = requested
            ? await tx.select().from(agentRuntimes).where(eq(agentRuntimes.id, requested)).limit(1)
            : [];
          if (requested && (!runtime || runtime.companyId !== id || runtime.isActive === false))
            failure('runtime_company_mismatch');
          if (!state.boss || !state.head) failure('setup_create_boss_and_head_first');
          if (!runtime) {
            if (!input.a2aBaseUrl || !input.name) failure('setup_choose_runtime_or_add_connection');
            assertAdapterTargetAllowed(input.a2aBaseUrl, 'a2aBaseUrl');
            [runtime] = await tx
              .insert(agentRuntimes)
              .values({
                companyId: id,
                name: input.name,
                adapterType: 'a2a',
                config: { a2aBaseUrl: input.a2aBaseUrl },
                isActive: true,
              })
              .returning();
          }
          if (
            runtime!.adapterType === 'hermes-ssh' &&
            ![state.boss, state.head].every((a) => a?.runtimeId === runtime!.id)
          )
            failure('legacy_runtime_use_existing_configuration');
          if (input.a2aBaseUrl && runtime!.id === draft.runtimeId)
            await tx
              .update(agentRuntimes)
              .set({
                name: input.name ?? runtime!.name,
                config: { ...(runtime!.config as Record<string, unknown>), a2aBaseUrl: input.a2aBaseUrl },
                updatedAt: new Date(),
              })
              .where(eq(agentRuntimes.id, runtime!.id));
          for (const agent of [state.boss, state.head])
            await tx
              .update(agents)
              .set({ runtimeId: runtime!.id, adapterType: runtime!.adapterType })
              .where(eq(agents.id, agent.id));
          draft.runtimeId = runtime!.id;
          draft.stage = 'runtime';
        } else {
          const currentBosses = state.members.filter((a) =>
            state.roles.some((p) => p.id === a.positionId && p.isCompanyBoss),
          );
          const issues = [
            ...(readiness?.issues ?? []),
            ...(readiness?.runtimeIssues ?? []),
            ...(await connectionIssues(tx, state)),
          ];
          if (
            currentBosses.length !== 1 ||
            currentBosses[0]?.id !== state.boss?.id ||
            [state.boss, state.head].some((a) => a?.isActive === false || a?.isBusy) ||
            !state.boss ||
            !state.head ||
            state.boss.id === state.head.id ||
            state.head.departmentId !== state.department?.id ||
            state.department?.headAgentId !== state.head.id
          )
            issues.push('Finish the distinct Boss and department head setup.');
          if (issues.length)
            return reply.code(409).send({ error: 'setup_not_ready', message: issues.join(' '), issues });
          draft.completed = true;
          draft.stage = 'complete';
        }
        if (input.step !== 'finish') draft.completed = false;
        await tx
          .update(companies)
          .set({ setupDraft: draft, autoDispatchEnabled: input.step === 'finish' })
          .where(eq(companies.id, id));
        return publicState(await setupState(tx, id));
      });
    } catch (error) {
      if (databaseCode(error) === '23505')
        return reply
          .code(409)
          .send({
            error: 'setup_slug_taken',
            message: 'This slug is already used. Choose a different slug and save again.',
          });
      if (['40001', '40P01', '55P03'].includes(databaseCode(error) ?? ''))
        return reply
          .code(409)
          .send({
            error: 'setup_changed',
            message: 'Setup changed while saving. Refresh this draft and retry.',
          });
      if ((error as { statusCode?: number }).statusCode)
        return reply
          .code((error as { statusCode: number }).statusCode)
          .send({ error: (error as Error).message });
      throw error;
    }
  });
  app.post('/api/companies/:id/setup/probe', async (request, reply) => {
    const id = z
      .string()
      .uuid()
      .parse((request.params as { id: string }).id);
    const user = await requireCompanyRole(request, reply, id, 'operator');
    if (!user) return reply;
    const state = await setupState(db, id);
    const results = [];
    for (const agent of [state.boss, state.head]) {
      if (!agent) continue;
      const snapshot = await runtimeSnapshot(db, agent.id);
      const config = {
        ...((snapshot?.runtime.config as Record<string, unknown>) ?? {}),
        ...((snapshot?.agent.adapterConfig as Record<string, unknown>) ?? {}),
      };
      if (!snapshot || agent.adapterType !== 'a2a' || typeof config.a2aBaseUrl !== 'string') {
        results.push({
          agentId: agent.id,
          success: false,
          message: 'Use the explicit connection test for this runtime; it may execute a billable task.',
        });
        continue;
      }
      let success = false;
      try {
        const base = assertAdapterTargetAllowed(config.a2aBaseUrl, 'a2aBaseUrl').replace(/\/+$/, '');
        const path =
          typeof config.a2aAgentPath === 'string'
            ? config.a2aAgentPath
            : agent.hermesProfile
              ? `/${agent.hermesProfile}`
              : '';
        const card = await fetchAgentCard(`${base}${path.startsWith('/') ? path : `/${path}`}`, {
          timeoutMs: 5000,
          fetchImpl: (url, init) => fetch(url, { ...init, redirect: 'error' }),
        });
        success = Boolean(card && typeof card.name === 'string');
      } catch {
        success = false;
      }
      await recordSetupConnectionCheck(agent.id, snapshot.fingerprint, success, 'probe');
      results.push({
        agentId: agent.id,
        success,
        message: success
          ? 'A2A agent-card endpoint responded. No task was executed.'
          : 'The agent-card endpoint did not respond. Check the runtime URL and retry.',
      });
    }
    return { results };
  });
}
