import { randomUUID } from 'node:crypto';
import { and, eq, isNull } from 'drizzle-orm';
import { z } from 'zod';
import type { FastifyInstance } from 'fastify';
import { requireAuth } from './auth.ts';
import { requireCompanyRole } from './access.ts';
import { db } from './db/client.ts';
import { agents, companies, projects, kanbanCards, chatMessages } from './db/schema.ts';
import { buildExecutionAgent, buildTaskPrompt, buildCompanyKanbanContext } from './dispatch.ts';
import { buildChatPrompt, buildDirectChatGoalContext } from './chat.ts';
import { buildAgentDigest } from './agent-digest.ts';
import { structuralAssignment } from './company-workflow.ts';
import { promptSnapshotForAdapter } from './prompt-logs.ts';
import { sanitizeCompanyOutput } from './output-secrets.ts';
import type { TaskContext } from './adapters/hermes.ts';

export const promptPreviewSchema = z.object({
  kind: z.enum(['task', 'chat']),
  projectId: z.string().uuid().nullable().optional(),
  title: z.string().max(1000).optional(),
  body: z.string().min(1).max(100_000),
}).strict();

/** Fresh invocation only. The synthetic identifiers are never persisted. */
export async function buildPromptPreview(agent: typeof agents.$inferSelect, input: z.infer<typeof promptPreviewSchema>) {
  const id = randomUUID();
  const now = new Date();
  const projectId = input.projectId ?? null;
  const title = input.title?.trim() || (input.kind === 'chat' ? `Chat with ${agent.name}` : 'New task');
  let task: TaskContext;
  if (input.kind === 'chat') {
    const [company] = await db.select().from(companies).where(eq(companies.id, agent.companyId)).limit(1);
    const kanban = await buildCompanyKanbanContext(agent.companyId, {
      focusAgentId: agent.id, projectId, budgetChars: 20_000, includeGoals: false, includeInvocationPositionPrompt: false,
    });
    const goals = await buildDirectChatGoalContext(agent.companyId, agent, projectId);
    const digest = await buildAgentDigest(agent.id, agent.companyId);
    const history = [{ id, body: input.body, authorType: 'user', createdAt: now }] as (typeof chatMessages.$inferSelect)[];
    task = { id: `chat-${id}`, title, kind: 'chat', body: buildChatPrompt(company, agent, history, kanban, goals, false, '', '', digest.text) };
  } else {
    const card = {
      id, companyId: agent.companyId, projectId, departmentId: agent.departmentId, assigneeId: agent.id,
      title, body: input.body, columnStatus: 'todo', tags: [], dependencyCardIds: [], reviewerIds: [],
      coordinationOnly: false, requiresApproval: false, forceBrainstorm: false, brainstormDepartmentIds: [],
      createdAt: now, updatedAt: now, protocolRepairState: {}, runRetryState: {},
    } as unknown as typeof kanbanCards.$inferSelect;
    task = { id, title, body: await buildTaskPrompt(card, { continuation: false, kind: 'dispatch' }),
      reportingMode: (await structuralAssignment(agent.companyId, agent.id)).delegationRequired ? 'management' : 'execution' };
  }
  // This builder only SELECTs runtime/configuration and reads existing tokens.
  const executionAgent = await buildExecutionAgent(agent, null);
  return sanitizeCompanyOutput(agent.companyId, {
    kind: input.kind, prompt: promptSnapshotForAdapter(executionAgent, task), generatedAt: now.toISOString(),
    redacted: true, contextMode: 'full_bootstrap',
    adapterEnvelope: { adapterType: executionAgent.adapterType, format: ['a2a', 'hermes-ssh', 'hermes-gateway', 'codex-app'].includes(executionAgent.adapterType) ? 'prompt' : 'json', a2aChatResponseEnvelope: executionAgent.adapterType === 'a2a' && input.kind === 'chat' },
    previewInvocationId: id,
    runtimeContextNotice: 'Fresh invocation preview. Hermes/runtime-owned system instructions, tools and runtime memory are not visible to MegaCorps. Invocation IDs are preview placeholders; no task, chat, run or model call is created.',
  });
}

export async function registerPromptPreviewRoutes(app: FastifyInstance) {
  app.post('/api/agents/:id/prompt-preview', async (request, reply) => {
    if (!await requireAuth(request, reply)) return;
    const id = z.string().uuid().safeParse((request.params as { id: string }).id);
    const input = promptPreviewSchema.safeParse(request.body);
    if (!id.success || !input.success) return reply.code(400).send({ error: 'invalid_prompt_preview' });
    const [agent] = await db.select().from(agents).where(and(eq(agents.id, id.data), isNull(agents.deletedAt))).limit(1);
    if (!agent) return reply.code(404).send({ error: 'agent_not_found' });
    if (!await requireCompanyRole(request, reply, agent.companyId, 'viewer')) return;
    if (input.data.projectId) {
      const [project] = await db.select({ id: projects.id }).from(projects).where(and(eq(projects.id, input.data.projectId), eq(projects.companyId, agent.companyId), isNull(projects.deletedAt))).limit(1);
      if (!project) return reply.code(404).send({ error: 'project_not_found' });
    }
    return buildPromptPreview(agent, input.data);
  });
}
