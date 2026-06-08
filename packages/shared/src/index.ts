import { z } from 'zod';

export const cardStatuses = ['todo', 'in_progress', 'in_review', 'needs_review', 'done', 'blocked', 'cancelled'] as const;
export type CardStatus = (typeof cardStatuses)[number];
export const legacyCardStatusAliases = { backlog: 'todo' } as const;
const cardStatusInputs = ['backlog', ...cardStatuses] as const;
export const agentAdapterTypes = ['hermes', 'hermes-ssh', 'hermes-gateway', 'openclaw', 'webhook', 'mock'] as const;
export type AgentAdapterType = (typeof agentAdapterTypes)[number];

const allowedTransitions: Record<CardStatus, CardStatus[]> = {
  todo: ['in_progress', 'blocked', 'cancelled'],
  in_progress: ['in_review', 'needs_review', 'done', 'blocked', 'cancelled'],
  in_review: ['done', 'in_progress', 'blocked', 'cancelled'],
  needs_review: ['todo', 'in_progress', 'done', 'blocked', 'cancelled'],
  done: [],
  blocked: ['todo', 'cancelled'],
  cancelled: ['todo'],
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
  companyId: z.string().uuid().optional(),
  name: z.string().trim().min(1).max(120),
  adapterType: z.enum(agentAdapterTypes),
  config: z.record(z.string(), z.unknown()).default({}),
  isActive: z.boolean().default(true),
});

export const companyMemberRoleSchema = z.enum(['viewer', 'operator', 'admin']);
const emailSchema = z.string().email().transform((value) => value.toLowerCase());

export const createCompanyMembershipSchema = z.object({
  companyId: z.string().uuid(),
  userId: z.string().uuid().optional(),
  email: emailSchema.optional(),
  role: companyMemberRoleSchema.default('viewer'),
  status: z.enum(['active', 'disabled']).default('active'),
}).refine((value) => value.userId || value.email, { message: 'userId or email is required', path: ['userId'] });

export const updateCompanyMembershipSchema = z.object({
  role: companyMemberRoleSchema.optional(),
  status: z.enum(['active', 'disabled']).optional(),
});

export const createCardCommentSchema = z.object({
  body: z.string().trim().min(1).max(5000),
  action: z.enum(['comment', 'agent_note', 'pause_agent', 'send_to_agent', 'continue_run', 'escalate_to_reviewer']).default('comment'),
  agentId: z.string().uuid().nullable().optional(),
});

export const createChatSessionSchema = z.object({
  companyId: z.string().uuid(),
  agentId: z.string().uuid(),
  projectId: z.string().uuid().nullable().optional(),
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
  repoProvider: z.enum(['github', 'gitlab', 'gitea', 'generic']).default('github'),
  repoUrl: z.string().trim().max(1000).nullable().optional(),
  defaultBranch: z.string().trim().min(1).max(120).default('main'),
  protectedBranches: z.array(z.string().trim().min(1).max(120)).default(['main', 'master']),
  workBranchPattern: z.string().trim().min(1).max(200).default('megacorps/card-{cardId}-{agentSlug}'),
  pullBeforeRun: z.boolean().default(true),
  pushAfterRun: z.boolean().default(true),
  completionPolicy: z.enum(['push_branch', 'pull_request', 'push_or_pr', 'manual']).default('push_or_pr'),
  setupCommand: z.string().trim().max(2000).nullable().optional(),
  testCommand: z.string().trim().max(2000).nullable().optional(),
  runtimeServices: z.record(z.string(), z.unknown()).default({}),
  workspacePathHint: z.string().trim().max(1000).nullable().optional(),
});

export const createGoalSchema = z.object({
  companyId: z.string().uuid().optional(),
  departmentId: z.string().uuid().nullable().optional(),
  projectId: z.string().uuid().nullable().optional(),
  title: z.string().trim().min(1).max(160),
  body: z.string().trim().max(4000).optional(),
});

export const workProductTypes = ['report', 'file', 'preview_url', 'pull_request', 'commit', 'screenshot', 'artifact', 'external'] as const;
export type WorkProductType = (typeof workProductTypes)[number];

export const createWorkProductSchema = z.object({
  cardId: z.string().uuid().optional(),
  projectId: z.string().uuid().nullable().optional(),
  agentId: z.string().uuid().nullable().optional(),
  taskRunId: z.string().uuid().nullable().optional(),
  type: z.enum(workProductTypes).default('external'),
  title: z.string().trim().min(1).max(200),
  summary: z.string().trim().max(4000).nullable().optional(),
  url: z.string().trim().max(2000).nullable().optional(),
  repoProvider: z.string().trim().max(80).nullable().optional(),
  repoUrl: z.string().trim().max(1000).nullable().optional(),
  branch: z.string().trim().max(240).nullable().optional(),
  commitSha: z.string().trim().max(80).nullable().optional(),
  pullRequestUrl: z.string().trim().max(2000).nullable().optional(),
  metadata: z.record(z.string(), z.unknown()).default({}),
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

export const taskLogTypes = ['dispatch', 'retry', 'review', 'escalation', 'decomposition', 'cascade', 'webhook', 'manual', 'stage', 'comment', 'lock', 'lock_expired', 'recovery', 'cancel', 'budget', 'approval', 'queue'] as const;
export type TaskLogType = (typeof taskLogTypes)[number];

export const taskLogSchema = z.object({
  cardId: z.string().uuid(),
  agentId: z.string().uuid().nullable().optional(),
  type: z.enum(taskLogTypes),
  status: z.enum(['queued', 'running', 'success', 'warning', 'failed']),
  message: z.string().trim().min(1).max(2000),
  output: z.string().optional(),
  costUsd: z.number().nonnegative().optional(),
  durationSeconds: z.number().nonnegative().optional(),
});

export const signupSchema = z.object({
  email: emailSchema,
  name: z.string().trim().min(1).max(120),
  password: z.string().min(8).max(200),
});

export const loginSchema = z.object({
  email: emailSchema,
  password: z.string().min(1),
});

export const userStatusSchema = z.enum(['active', 'disabled']);

export const adminUpdateUserSchema = z.object({
  name: z.string().trim().min(1).max(120).optional(),
  role: z.enum(['viewer', 'operator', 'admin']).optional(),
  status: userStatusSchema.optional(),
  password: z.string().min(8).max(200).optional(),
});

export const adminUpdateSettingsSchema = z.object({
  signupEnabled: z.boolean().optional(),
});

export const createInviteSchema = z.object({
  companyId: z.string().uuid(),
  email: emailSchema,
  name: z.string().trim().min(1).max(120).optional(),
  role: companyMemberRoleSchema.default('viewer'),
  expiresInDays: z.number().int().min(1).max(30).default(7),
});

export const acceptInviteSchema = z.object({
  token: z.string().trim().min(32).max(300),
  name: z.string().trim().min(1).max(120).optional(),
  password: z.string().min(12).max(200),
});

export type CreateCardInput = z.infer<typeof createCardSchema>;
export type UpdateCardInput = z.infer<typeof updateCardSchema>;
export type CreateAgentInput = z.infer<typeof createAgentSchema>;
export type CreateAgentRuntimeInput = z.infer<typeof createAgentRuntimeSchema>;
export type CreateCompanyMembershipInput = z.infer<typeof createCompanyMembershipSchema>;
export type UpdateCompanyMembershipInput = z.infer<typeof updateCompanyMembershipSchema>;
export type AdminUpdateUserInput = z.infer<typeof adminUpdateUserSchema>;
export type AdminUpdateSettingsInput = z.infer<typeof adminUpdateSettingsSchema>;
export type CreateInviteInput = z.infer<typeof createInviteSchema>;
export type AcceptInviteInput = z.infer<typeof acceptInviteSchema>;
export type CreateCompanyInput = z.infer<typeof createCompanySchema>;
export type CreateDepartmentInput = z.infer<typeof createDepartmentSchema>;
export type CreateCardCommentInput = z.infer<typeof createCardCommentSchema>;
export type CreateChatSessionInput = z.infer<typeof createChatSessionSchema>;
export type CreateChatMessageInput = z.infer<typeof createChatMessageSchema>;
export type CreateKnowledgeDocInput = z.infer<typeof createKnowledgeDocSchema>;
export type CreateProjectInput = z.infer<typeof createProjectSchema>;
export type CreateGoalInput = z.infer<typeof createGoalSchema>;
export type CreateWorkProductInput = z.infer<typeof createWorkProductSchema>;
export type CreateBudgetPolicyInput = z.infer<typeof createBudgetPolicySchema>;
export type ApprovalDecisionInput = z.infer<typeof approvalDecisionSchema>;
export type TaskLogInput = z.infer<typeof taskLogSchema>;
