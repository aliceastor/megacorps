import { z } from 'zod';

export const cardStatuses = ['todo', 'in_progress', 'in_review', 'done', 'blocked'] as const;
export type CardStatus = (typeof cardStatuses)[number];
export const legacyCardStatusAliases = { backlog: 'todo' } as const;
const cardStatusInputs = ['backlog', ...cardStatuses] as const;
export const agentAdapterTypes = ['hermes', 'hermes-gateway', 'openclaw', 'webhook', 'mock'] as const;
export type AgentAdapterType = (typeof agentAdapterTypes)[number];

const allowedTransitions: Record<CardStatus, CardStatus[]> = {
  todo: ['in_progress', 'blocked'],
  in_progress: ['in_review', 'blocked'],
  in_review: ['done', 'in_progress', 'blocked'],
  done: [],
  blocked: ['todo'],
};

export function canTransitionCard(from: CardStatus, to: CardStatus): boolean {
  if (from === to) return true;
  return allowedTransitions[from].includes(to);
}

export function normalizeCardStatus(value: string | null | undefined): CardStatus | undefined {
  if (!value) return undefined;
  if (value === 'backlog') return 'todo';
  return (cardStatuses as readonly string[]).includes(value) ? value as CardStatus : undefined;
}

export const prioritySchema = z.enum(['urgent', 'high', 'normal', 'low']);
export const cardStatusSchema = z.enum(cardStatusInputs).transform((status) => normalizeCardStatus(status) ?? 'todo');

export const createCardSchema = z.object({
  title: z.string().trim().min(1).max(160),
  body: z.string().trim().min(1, 'body must not be empty'),
  priority: prioritySchema.default('normal'),
  tags: z.array(z.string().trim().min(1).max(40)).default([]),
  companyId: z.string().uuid().optional(),
  assigneeId: z.string().uuid().nullable().optional(),
  reviewerId: z.string().uuid().nullable().optional(),
  departmentId: z.string().uuid().nullable().optional(),
  projectId: z.string().uuid().nullable().optional(),
  goalId: z.string().uuid().nullable().optional(),
  parentCardId: z.string().uuid().nullable().optional(),
  dependencyCardIds: z.array(z.string().uuid()).default([]),
  requiresApproval: z.boolean().default(false),
  maxRetries: z.number().int().min(1).max(10).default(3),
});

export const createCompanySchema = z.object({
  name: z.string().trim().min(1).max(160),
  slug: z.string().trim().regex(/^[a-z0-9-]+$/).max(80),
  mission: z.string().trim().max(2000).optional(),
  dispatchIntervalSeconds: z.number().int().min(5).max(3600).default(10),
  autoDispatchEnabled: z.boolean().default(true),
});

export const createDepartmentSchema = z.object({
  companyId: z.string().uuid(),
  name: z.string().trim().min(1).max(120),
  slug: z.string().trim().regex(/^[a-z0-9-]+$/).max(80),
});

export const updateCardSchema = createCardSchema.partial().extend({
  columnStatus: cardStatusSchema.optional(),
  updatedAt: z.string().datetime().optional(),
});

export const createAgentSchema = z.object({
  name: z.string().trim().min(1).max(120),
  slug: z.string().trim().regex(/^[a-z0-9-]+$/).max(80),
  role: z.string().trim().min(1).max(80),
  companyId: z.string().uuid().optional(),
  title: z.string().trim().max(120).optional(),
  adapterType: z.enum(agentAdapterTypes).default('hermes'),
  adapterConfig: z.record(z.string(), z.unknown()).optional(),
  runtimeId: z.string().uuid().nullable().optional(),
  hermesProfile: z.string().trim().min(1).max(80).optional(),
  bossId: z.string().uuid().nullable().optional(),
  departmentId: z.string().uuid().nullable().optional(),
  budgetPerTask: z.number().nonnegative().optional(),
  budgetMonthly: z.number().nonnegative().optional(),
});

export const createAgentRuntimeSchema = z.object({
  name: z.string().trim().min(1).max(120),
  adapterType: z.enum(agentAdapterTypes),
  config: z.record(z.string(), z.unknown()).default({}),
  isActive: z.boolean().default(true),
});

export const createCardCommentSchema = z.object({
  body: z.string().trim().min(1).max(5000),
  action: z.enum(['comment', 'agent_note', 'pause_agent', 'send_to_agent', 'continue_run']).default('comment'),
  agentId: z.string().uuid().nullable().optional(),
});

export const createChatSessionSchema = z.object({
  companyId: z.string().uuid(),
  agentId: z.string().uuid(),
  title: z.string().trim().min(1).max(160).optional(),
});

export const createChatMessageSchema = z.object({
  body: z.string().trim().min(1).max(10000),
});

export const createKnowledgeDocSchema = z.object({
  companyId: z.string().uuid(),
  title: z.string().trim().min(1).max(160),
  tags: z.array(z.string().trim().min(1).max(40)).default([]),
  body: z.string().trim().min(1).max(20000),
});

export const createProjectSchema = z.object({
  companyId: z.string().uuid().optional(),
  name: z.string().trim().min(1).max(160),
  description: z.string().trim().max(4000).optional(),
});

export const createGoalSchema = z.object({
  companyId: z.string().uuid().optional(),
  title: z.string().trim().min(1).max(160),
  body: z.string().trim().max(4000).optional(),
});

export const createBudgetPolicySchema = z.object({
  companyId: z.string().uuid(),
  agentId: z.string().uuid().nullable().optional(),
  name: z.string().trim().min(1).max(160),
  monthlyLimitUsd: z.number().nonnegative().nullable().optional(),
  perTaskLimitUsd: z.number().nonnegative().nullable().optional(),
  warnAtPercent: z.number().int().min(1).max(100).default(80),
  hardStop: z.boolean().default(true),
  isActive: z.boolean().default(true),
});

export const approvalDecisionSchema = z.object({
  status: z.enum(['approved', 'rejected', 'revision_requested', 'cancelled']),
  decisionNote: z.string().trim().max(4000).optional(),
});

export const taskLogTypes = ['dispatch', 'retry', 'review', 'decomposition', 'cascade', 'webhook', 'manual', 'stage', 'comment', 'lock', 'recovery', 'budget', 'approval'] as const;
export type TaskLogType = (typeof taskLogTypes)[number];

export const taskLogSchema = z.object({
  cardId: z.string().uuid(),
  agentId: z.string().uuid().nullable().optional(),
  type: z.enum(taskLogTypes),
  status: z.enum(['queued', 'running', 'success', 'failed']),
  message: z.string().trim().min(1).max(2000),
  output: z.string().optional(),
  costUsd: z.number().nonnegative().optional(),
  durationSeconds: z.number().nonnegative().optional(),
});

export const signupSchema = z.object({
  email: z.string().email(),
  name: z.string().trim().min(1).max(120),
  password: z.string().min(8).max(200),
});

export const loginSchema = z.object({
  email: z.string().email(),
  password: z.string().min(1),
});

export type CreateCardInput = z.infer<typeof createCardSchema>;
export type UpdateCardInput = z.infer<typeof updateCardSchema>;
export type CreateAgentInput = z.infer<typeof createAgentSchema>;
export type CreateAgentRuntimeInput = z.infer<typeof createAgentRuntimeSchema>;
export type CreateCompanyInput = z.infer<typeof createCompanySchema>;
export type CreateDepartmentInput = z.infer<typeof createDepartmentSchema>;
export type CreateCardCommentInput = z.infer<typeof createCardCommentSchema>;
export type CreateChatSessionInput = z.infer<typeof createChatSessionSchema>;
export type CreateChatMessageInput = z.infer<typeof createChatMessageSchema>;
export type CreateKnowledgeDocInput = z.infer<typeof createKnowledgeDocSchema>;
export type CreateProjectInput = z.infer<typeof createProjectSchema>;
export type CreateGoalInput = z.infer<typeof createGoalSchema>;
export type CreateBudgetPolicyInput = z.infer<typeof createBudgetPolicySchema>;
export type ApprovalDecisionInput = z.infer<typeof approvalDecisionSchema>;
export type TaskLogInput = z.infer<typeof taskLogSchema>;
